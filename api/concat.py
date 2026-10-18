import asyncio
import glob
import json
import os
import shutil
import uuid

import folder_paths
from aiohttp import web

from ._common import routes
from .bot_media import view_path

_CONCAT_SUB = "comfyart/concat"


def _find_bin(name: str) -> str:
    """Locate ffmpeg/ffprobe: prefer a bundled copy, then the WinGet install, then PATH."""
    roots = [
        r"C:\Users\MrFu\AppData\Local\Microsoft\WinGet\Packages",
        r"F:\ComfyUI_windows_portable_H3_Lab",
        r"F:\ComfyUI_windows_portable_H3_Lab\ComfyUI",
        r"F:\ComfyUI_windows_portable_H3_Lab\python_embeded",
    ]
    candidates = [shutil.which(name) or ""]
    for root in roots:
        if os.path.isdir(root):
            candidates += glob.glob(os.path.join(root, "**", name + ".exe"), recursive=True)
    for c in candidates:
        if c and os.path.isfile(c):
            return c
    raise web.HTTPInternalServerError(
        text=json.dumps({"error": f"{name} not found; install ffmpeg and make it reachable from the ComfyUI process"}))


async def _probe(ffprobe: str, path: str) -> dict:
    proc = await asyncio.create_subprocess_exec(
        ffprobe, "-v", "error", "-print_format", "json",
        "-show_entries", "stream=width,height,codec_type:format=duration",
        path, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    out, err = await proc.communicate()
    if proc.returncode != 0:
        raise web.HTTPBadRequest(text=json.dumps(
            {"error": f"cannot probe {os.path.basename(path)}: {err.decode('utf-8', 'ignore')[:300]}"}))
    data = json.loads(out.decode("utf-8") or "{}")
    width = height = None
    has_audio = False
    for s in data.get("streams", []):
        if s.get("codec_type") == "video":
            width = s.get("width") or width
            height = s.get("height") or height
        elif s.get("codec_type") == "audio":
            has_audio = True
    duration = (data.get("format") or {}).get("duration")
    if duration is None:
        for s in data.get("streams", []):
            if s.get("codec_type") == "video" and s.get("duration"):
                duration = s["duration"]
                break
    return {"width": width, "height": height, "duration": float(duration) if duration else 0.0, "has_audio": has_audio}


def _to_sec(v) -> float | None:
    """Parse a seconds value (number or numeric string) or None; reject anything else."""
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return float(v)
    if isinstance(v, str) and v.strip():
        try:
            return float(v)
        except ValueError:
            pass
    raise web.HTTPBadRequest(text=json.dumps({"error": f"invalid time value {v!r}; expected seconds (number)"}))


@routes.post("/comfyart/concat")
async def concat_videos(request: web.Request) -> web.Response:
    """Join two or more canvas video clips into one, in order, server-side via ffmpeg."""
    try:
        body = await request.json()
    except ValueError:
        raise web.HTTPBadRequest(text=json.dumps({"error": "invalid JSON body"}))
    if not isinstance(body, dict):
        raise web.HTTPBadRequest(text=json.dumps({"error": "body must be an object"}))

    raw = body.get("clips")
    if not isinstance(raw, list):
        # 兼容 v1 的 urls / sources 字段（整段）
        legacy = body.get("urls") or body.get("sources")
        if isinstance(legacy, list):
            raw = [{"url": u} for u in legacy]
    if not isinstance(raw, list) or len(raw) < 2:
        raise web.HTTPBadRequest(text=json.dumps(
            {"error": "concat needs at least 2 clips in 'clips' (each a url string or {url|source, in?, out?})"}))

    audio = body.get("audio", "none")
    if audio not in ("concat", "first", "none"):
        audio = "none"

    ffmpeg = _find_bin("ffmpeg")
    ffprobe = _find_bin("ffprobe")

    paths = []
    trims = []  # (in_sec, out_sec) per clip; None = whole clip (resolved below)
    for c in raw:
        if isinstance(c, str):
            url, ti, to = c, None, None
        elif isinstance(c, dict):
            url = c.get("url") or c.get("source")
            ti = _to_sec(c.get("in"))
            to = _to_sec(c.get("out"))
        else:
            raise web.HTTPBadRequest(text=json.dumps(
                {"error": "each clip must be a string url or {url|source, in?, out?}"}))
        if not isinstance(url, str):
            raise web.HTTPBadRequest(text=json.dumps({"error": "each clip needs a string 'url' or 'source'"}))
        try:
            paths.append(view_path(url))
        except (ValueError, OSError) as e:
            raise web.HTTPBadRequest(text=json.dumps({"error": f"bad source url {url!r}: {e}"}))
        trims.append((ti, to))

    probes = [await _probe(ffprobe, p) for p in paths]
    for p, path in zip(probes, paths):
        if not p["width"] or not p["height"]:
            raise web.HTTPBadRequest(text=json.dumps({"error": f"{os.path.basename(path)} is not a video"}))

    # 解析并 clamp 每段裁剪区间（秒）；越界截到合法范围，非法区间报错
    eff = []
    for i, (ti, to) in enumerate(trims):
        dur = probes[i]["duration"] or 0.0
        ti = 0.0 if ti is None else max(0.0, float(ti))
        to = dur if to is None else min(float(to), dur)
        if to <= ti:
            raise web.HTTPBadRequest(text=json.dumps(
                {"error": f"clip {i}: 'in' ({ti:.3f}) must be < 'out' ({to:.3f}); clip duration {dur:.3f}s"}))
        trims[i] = (ti, to)
        eff.append(to - ti)

    n = len(paths)
    W = probes[0]["width"]
    H = probes[0]["height"]
    need_scale = any(p["width"] != W or p["height"] != H for p in probes)

    vfilters = []
    afilters = []
    for i in range(n):
        ti, to = trims[i]
        trim_v = f"trim=start={ti:.3f}:end={to:.3f},setpts=PTS-STARTPTS"
        if need_scale:
            vfilters.append(
                f"[{i}:v]{trim_v},scale={W}:{H}:force_original_aspect_ratio=decrease,"
                f"pad={W}:{H}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p[v{i}]")
        else:
            vfilters.append(f"[{i}:v]{trim_v},format=yuv420p[v{i}]")

    fc_parts = list(vfilters)
    audio_map = None
    note = None

    if audio == "none":
        fc_parts.append("".join(f"[v{i}]" for i in range(n)) + f"concat=n={n}:v=1:a=0[v]")
    elif audio == "concat" and all(p["has_audio"] for p in probes):
        for i in range(n):
            ti, to = trims[i]
            afilters.append(
                f"[{i}:a]atrim=start={ti:.3f}:end={to:.3f},asetpts=PTS-STARTPTS,"
                f"aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo[a{i}]")
        audio_map = "[a]"
        fc_parts += afilters
        fc_parts.append("".join(f"[v{i}][a{i}]" for i in range(n)) + f"concat=n={n}:v=1:a=1[v][a]")
    elif audio == "first" and probes[0]["has_audio"] and sum(eff) > 0:
        t0, t1 = trims[0]
        total = sum(eff)
        afilters.append(
            f"[0:a]atrim=start={t0:.3f}:end={t1:.3f},asetpts=PTS-STARTPTS,"
            f"aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo,apad[a0]")
        afilters.append(f"[a0]atrim=0:{total:.3f}[a]")
        audio_map = "[a]"
        fc_parts += afilters
        fc_parts.append("".join(f"[v{i}]" for i in range(n)) + f"concat=n={n}:v=1:a=0[v]")
    else:
        if audio == "concat":
            note = "some clips have no audio; joined without sound"
        elif audio == "first":
            note = "first clip has no audio; joined without sound"
        fc_parts.append("".join(f"[v{i}]" for i in range(n)) + f"concat=n={n}:v=1:a=0[v]")

    out_dir = os.path.join(folder_paths.get_output_directory(), _CONCAT_SUB)
    os.makedirs(out_dir, exist_ok=True)
    name = f"concat-{uuid.uuid4().hex[:12]}.mp4"
    out_path = os.path.join(out_dir, name)

    cmd = [ffmpeg, "-y", "-loglevel", "error"]
    for p in paths:
        cmd += ["-i", p]
    cmd += ["-filter_complex", ";".join(fc_parts),
            "-map", "[v]", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18",
            "-preset", "veryfast", "-movflags", "+faststart"]
    if audio_map:
        cmd += ["-map", audio_map, "-c:a", "aac", "-b:a", "192k"]
    else:
        cmd += ["-an"]
    cmd += [out_path]

    proc = await asyncio.create_subprocess_exec(*cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    _, err = await proc.communicate()
    if proc.returncode != 0:
        raise web.HTTPInternalServerError(text=json.dumps(
            {"error": f"ffmpeg failed: {err.decode('utf-8', 'ignore')[:500]}"}))

    out_probe = await _probe(ffprobe, out_path)
    url = f"/api/view?filename={name}&subfolder={_CONCAT_SUB}&type=output"
    return web.json_response({
        "url": url,
        "filename": name,
        "subfolder": _CONCAT_SUB,
        "type": "output",
        "width": out_probe["width"],
        "height": out_probe["height"],
        "duration": out_probe["duration"],
        "num_segments": n,
        "segments": [{"in": ti, "out": to, "duration": to - ti} for ti, to in trims],
        "audio": audio if audio_map else "none",
        **({"note": note} if note else {}),
    })
