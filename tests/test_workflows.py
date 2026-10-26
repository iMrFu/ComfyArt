from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SAMPLERS = {"KSampler", "SamplerCustomAdvanced"}
MODEL_FILE = "model.id"
MUSIC_FILE = "spec.model"


def _workflow(name: str) -> dict:
    return json.loads((ROOT / "workflows" / name).read_text(encoding="utf-8"))


def _tags(node: dict) -> list[str]:
    return [w for w in re.split(r"[\s,]+", node.get("_meta", {}).get("title", "").lower()) if w.startswith("@")]


def _named(graph: dict, name: str) -> list[str]:
    return [k for k, node in graph.items() if f"@{name.lower()}" in _tags(node)]


def _args(src: str, start: int) -> list[str]:
    depth, arg, args = 0, "", []
    for c in src[start:]:
        if c in "([{":
            depth += 1
        elif c in ")]}":
            if depth == 0:
                return [*args, arg.strip()]
            depth -= 1
        if c == "," and depth == 0:
            args.append(arg.strip())
            arg = ""
        else:
            arg += c
    raise AssertionError("unclosed loadNamed call")


def _const(src: str, name: str) -> str:
    found = re.search(rf"const {name} = (\[[^\]]*\]|'[^']*')", src)
    assert found, name
    return found.group(1)


def _calls() -> list[tuple[str, str, list[str]]]:
    calls = []
    for path in sorted((ROOT / "src").rglob("*.ts*")):
        src = path.read_text(encoding="utf-8")
        for m in re.finditer(r"\bloadNamed\(", src):
            file, *rest = _args(src, m.end())
            if re.fullmatch(r"[A-Z_]+", file):
                file = _const(src, file)
            names = []
            for arg in rest:
                if arg.startswith("..."):
                    names += re.findall(r"'([^']+)'", _const(src, arg[3:]) if re.fullmatch(r"[A-Z_]+", arg[3:]) else "")
                else:
                    names.append(arg.strip("'"))
            calls.append((path.name, file.strip("'"), names))
    return calls


def _image_models() -> list[dict]:
    src = (ROOT / "src" / "models.ts").read_text(encoding="utf-8")
    block = src[src.index("export const IMAGE_MODELS"):src.index("export const VIDEO_MODELS")]
    models = []
    for name, rest in re.findall(r"\{\s*id: '([^']+)'(.*?)\n  \}", block, re.S):
        sizes = re.findall(r"sizes: \[([^\]]*)\]", rest)
        models.append({
            "id": name,
            "sizes": re.findall(r"'([^']+)'", sizes[0]) if sizes else [],
            "steps": re.findall(r"steps: \['([^']+)'", rest),
            "negative": re.findall(r"negative: \['([^']+)', '([^']+)'\]", rest),
            "prompt": re.findall(r"prompt: '([^']+)'", rest),
            "refs": re.findall(r"refs: '([^']+)'", rest),
        })
    return models


def test_every_named_lookup_finds_one_node():
    calls = _calls()
    assert len(calls) > 20
    assert [src for src, file, _ in calls if file == MODEL_FILE] == ["generate.ts"]
    for src, file, names in calls:
        if file in (MODEL_FILE, MUSIC_FILE):
            continue
        graph = _workflow(file)
        for name in names:
            assert len(_named(graph, name)) == 1, (src, file, name)


def test_workflow_titles_are_unique_and_name_the_output():
    for path in sorted((ROOT / "workflows").glob("*.api.json")):
        graph = json.loads(path.read_text(encoding="utf-8"))
        tags = [t for node in graph.values() for t in _tags(node)]
        assert len(tags) == len(set(tags)), path.name
        assert "@save" in tags, path.name


def test_image_model_workflows_follow_the_generator_layout():
    models = _image_models()
    assert len(models) >= 5
    [shared] = [names for src, file, names in _calls() if file == MODEL_FILE]
    for m in models:
        graph = _workflow(m["id"])
        names = [*shared, *m["sizes"], *m["steps"], *(n for n, _ in m["negative"]), *(["guider"] if m["refs"] == ["latent"] else [])]
        for name in names:
            assert len(_named(graph, name)) == 1, (m["id"], name)
        node = {name: graph[_named(graph, name)[0]] for name in names}
        assert node["sampler"]["class_type"] in SAMPLERS, m["id"]
        assert "latent_image" in node["sampler"]["inputs"], m["id"]
        assert "batch_size" in node["size"]["inputs"], m["id"]
        assert node["save"]["class_type"].startswith("Save"), m["id"]
        assert m["prompt"][0] in node["prompt"]["inputs"], m["id"]
        for name in m["sizes"]:
            assert {"width", "height"} <= set(node[name]["inputs"]), (m["id"], name)
        for name in m["steps"]:
            assert "steps" in node[name]["inputs"], (m["id"], name)
        for name, key in m["negative"]:
            assert key in node[name]["inputs"], (m["id"], name)


def test_music_model_workflows_take_the_music_fields():
    src = (ROOT / "src" / "assetGen.ts").read_text(encoding="utf-8")
    ids = re.findall(r"\{ id: '([^']+)', label:", src[src.index("export const MUSIC_MODELS"):])
    assert len(ids) >= 2
    [names] = [names for src, file, names in _calls() if file == MUSIC_FILE]
    for model in ids:
        graph = _workflow(model)
        node = {name: graph[_named(graph, name)[0]] for name in names}
        assert node["prompt"]["class_type"] in {"MiniMaxMusic3TextEncode", "TextEncodeAceStepAudio1.5"}, model
        assert {"lyrics", "seed"} <= set(node["prompt"]["inputs"]), model
        assert {"max_duration", "seconds"} & set(node["seconds"]["inputs"]), model
        assert node["sampler"]["class_type"] in SAMPLERS, model
