import asyncio
import json
import os
import uuid

import folder_paths
from aiohttp import web

from ._common import json_body, routes
from .bot_media import view_path
from .concat import _find_bin, _probe, _to_sec

_MIX_SUB = "comfyart/mix"


def _norm_clip(c, audio_dur: float):
    """Parse one audio_clips item into (in_sec, out_sec, at_sec), filling defaults.

    Each item may be a dict with optional in / out / at (seconds). Missing in defaults
    to 0, out defaults to the audio length, at defaults to 0 (placed at video start).
    """
    if isinstance(c, dict):
        ti = _to_sec(c.get("in"))
        to = _to_sec(c.get("out"))
        at = _to_sec(c.get("at"))
    else:
        ti = to = at = None
    if ti is None:
        ti = 0.0
    if to is None:
        to = float(audio_dur) if audio_dur else 0.0
    if at is None:
        at = 0.0
    return ti, to, at


@routes.post("/comfyart/mix_audio")
async def mix_audio_video(request: web.Request) -> web.Response:
    """Merge a narration audio track into a (trimmed) video, with optional audio cutting.

    - mode 'replace': swap the video's audio for the narration (gaps are silent).
    - mode 'mix': keep the original audio and overlay the narration on top (volume adjustable).
    audio_clips: optional ordered list of {in?, out?, at?}; each cuts the audio sub-range
    [in, out] and places it at second 'at' on the video timeline. Omit to use the whole
    audio from 0. video_in / video_out optionally trim the video first.
    """
    body = await json_body(request)
    video_url = body.get("video")
    audio_url = body.get("audio")
    if not isinstance(video_url, str) or not isinstance(audio_url, str):
        raise web.HTTPBadRequest(text=json.dumps({"error": "video and audio (view URLs) are required"}))

    try:
        vpath = view_path(video_url)
        apath = view_path(audio_url)
    except (ValueError, OSError) as e:
        raise web.HTTPBadRequest(text=json.dumps({"error": f"bad media url: {e}"}))

    mode = body.get("mode", "replace")
    if mode not in ("replace", "mix"):
        mode = "replace"
    try:
        volume = max(0.0, float(body.get("volume", 1.0)))
        bg_volume = max(0.0, float(body.get("bg_volume", 1.0)))
    except (TypeError, ValueError):
        raise web.HTTPBadRequest(text=json.dumps({"error": "volume / bg_volume must be numbers"}))

    ffmpeg = _find_bin("ffmpeg")
    ffprobe = _find_bin("ffprobe")

    vprobe = await _probe(ffprobe, vpath)
    aprobe = await _probe(ffprobe, apath)
    if not vprobe["width"] or not vprobe["height"]:
        raise web.HTTPBadRequest(text=json.dumps({"error": f"{os.path.basename(vpath)} is not a video"}))

    # 视频裁剪区间
    v_dur_total = vprobe["duration"] or 0.0
    v_in = max(0.0, _to_sec(body.get("video_in")) or 0.0)
    v_out = _to_sec(body.get("video_out"))
    v_out = min(v_out, v_dur_total) if v_out is not None else v_dur_total
    if v_out is None or v_out <= v_in:
        raise web.HTTPBadRequest(text=json.dumps(
            {"error": f"video trim invalid: in={v_in:.3f} out={v_out}"}))
    v_dur = v_out - v_in

    # 旁白切割片段
    raw_clips = body.get("audio_clips")
    if raw_clips is None:
        segs = [{"in": 0.0, "out": float(aprobe["duration"] or 0.0), "at": 0.0}]
    elif isinstance(raw_clips, list):
        segs = []
        for c in raw_clips:
            ti, to, at = _norm_clip(c, aprobe["duration"] or 0.0)
            if ti < 0 or at < 0:
                raise web.HTTPBadRequest(text=json.dumps(
                    {"error": f"audio clip invalid: in={ti} out={to} at={at} (in/out>=0, at>=0)"}))
            if to <= ti:
                raise web.HTTPBadRequest(text=json.dumps(
                    {"error": f"audio clip needs in<out: in={ti:.3f} out={to:.3f}"}))
            segs.append({"in": ti, "out": to, "at": at})
    else:
        raise web.HTTPBadRequest(text=json.dumps({"error": "audio_clips must be a list of {in?, out?, at?}"}))

    # 视频流：裁剪 + 格式归一
    parts = [f"[0:v]trim=start={v_in:.3f}:end={v_out:.3f},setpts=PTS-STARTPTS,format=yuv420p[v]"]

    used = []  # 实际进入混音的旁白段（at 落在视频时长内才有效）
    seg_meta = []
    for i, s in enumerate(segs):
        ti, to, at = s["in"], s["out"], s["at"]
        seg_len = to - ti
        pad = v_dur - at
        if pad <= 0:
            # 该段起始点已超出视频长度，跳过
            seg_meta.append({"in": ti, "out": to, "at": at, "duration": seg_len, "placed": False})
            continue
        at_ms = int(round(at * 1000))
        parts.append(
            f"[1:a]atrim=start={ti:.3f}:end={to:.3f},asetpts=PTS-STARTPTS,"
            f"aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo,"
            f"apad=whole_dur={pad:.3f},adelay={at_ms}:all=1,volume={volume:.3f}[a{i}]")
        used.append(f"[a{i}]")
        seg_meta.append({"in": ti, "out": to, "at": at, "duration": seg_len, "placed": True})

    note = None
    if mode == "mix" and vprobe["has_audio"]:
        parts.append(
            f"[0:a]atrim=start={v_in:.3f}:end={v_out:.3f},asetpts=PTS-STARTPTS,"
            f"aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo,"
            f"volume={bg_volume:.3f}[orig]")
        used.append("[orig]")
    elif mode == "mix" and not vprobe["has_audio"]:
        note = "video has no audio; mixed as narration only"
    # mode == replace: 仅旁白段，段间静音（不加入原始音轨）

    if not used:
        raise web.HTTPBadRequest(text=json.dumps(
            {"error": "no audio segment falls within the video timeline (check 'at' values)"}))

    n = len(used)
    fc = ";".join(parts)
    fc += ";" + "".join(used) + f"amix=inputs={n}:normalize=0[aout];[aout]atrim=0:{v_dur:.3f}[a]"

    out_dir = os.path.join(folder_paths.get_output_directory(), _MIX_SUB)
    os.makedirs(out_dir, exist_ok=True)
    name = f"mix-{uuid.uuid4().hex[:12]}.mp4"
    out_path = os.path.join(out_dir, name)

    cmd = [ffmpeg, "-y", "-loglevel", "error", "-i", vpath, "-i", apath,
           "-filter_complex", fc,
           "-map", "[v]", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18",
           "-preset", "veryfast", "-movflags", "+faststart",
           "-map", "[a]", "-c:a", "aac", "-b:a", "192k",
           out_path]

    proc = await asyncio.create_subprocess_exec(*cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    _, err = await proc.communicate()
    if proc.returncode != 0:
        raise web.HTTPInternalServerError(text=json.dumps(
            {"error": f"ffmpeg failed: {err.decode('utf-8', 'ignore')[:500]}", "filter_complex": fc}))

    out_probe = await _probe(ffprobe, out_path)
    url = f"/api/view?filename={name}&subfolder={_MIX_SUB}&type=output"
    return web.json_response({
        "url": url,
        "filename": name,
        "subfolder": _MIX_SUB,
        "type": "output",
        "width": out_probe["width"],
        "height": out_probe["height"],
        "duration": out_probe["duration"],
        "mode": mode,
        "num_segments": len(segs),
        "segments": seg_meta,
        **({"note": note} if note else {}),
    })
