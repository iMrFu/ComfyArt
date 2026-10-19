from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SAMPLERS = {"KSampler", "SamplerCustomAdvanced"}

NODES_USED_BY_SRC = {
    "cutout-birefnet.api.json": ["17", "18"],
    "edit-qwen-image-2.1.api.json": ["6", "7", "8", "9", "11"],
    "erase-lama.api.json": ["1", "2", "5", "6"],
    "i2v-minimax-h3.api.json": ["92", "114", "105:10", "105:11", "105:14", "105:15", "105:16", "105:23", "105:24", "105:91", "105:104", "105:107", "105:111"],
    "image-to-3d-trellis2.api.json": ["1", "30"],
    "layers-qwen-image-layered.api.json": ["60", "74", "82", "83:3", "83:118", "116"],
    "mockup-surface.api.json": ["1", "3", "7"],
    "multiangle-qwen-image-2.1.api.json": ["6", "7", "9", "11"],
    "music-ace-step.api.json": ["3", "5", "6", "8"],
    "outpaint-qwen-image-2.1.api.json": ["7", "9", "11", "25"],
    "qwen-image-2.1-t2i.api.json": ["3", "4"],
    "r2v-minimax-h3.api.json": ["92", "129", "132", "136", "137"],
    "sfx-stable-audio.api.json": ["3", "5", "6", "8"],
    "speech-kokoro.api.json": ["1", "2", "3"],
    "speech-qwen3tts.api.json": ["1", "2"],
    "t2v-minimax-h3.api.json": ["92", "129", "131", "133"],
    "transcribe-gemma4.api.json": ["2", "3"],
    "upscale-ultrasharp-4x.api.json": ["1", "3", "4"],
    "voice-clone-indextts.api.json": ["1", "3", "4"],
    "voice-clone-qwen3tts.api.json": ["1", "2", "3"],
}


def _workflow(name: str) -> dict:
    return json.loads((ROOT / "workflows" / name).read_text(encoding="utf-8"))


def _image_models() -> list[dict]:
    src = (ROOT / "src" / "models.ts").read_text(encoding="utf-8")
    block = src[src.index("export const IMAGE_MODELS"):src.index("export const VIDEO_MODELS")]
    models = []
    for entry in re.findall(r"\{\s*id: '([^']+)'(.*?)\n  \}", block, re.S):
        name, rest = entry
        ids = re.findall(r"sizes: \[([^\]]*)\]", rest)
        models.append({
            "id": name,
            "sizes": re.findall(r"'([^']+)'", ids[0]) if ids else [],
            "vae": re.findall(r"vae: '([^']+)'", rest),
            "steps": re.findall(r"steps: \['([^']+)'", rest),
            "negative": re.findall(r"negative: \['([^']+)'", rest),
            "prompt": re.findall(r"prompt: '([^']+)'", rest),
        })
    return models


def test_nodes_patched_by_the_frontend_exist():
    for name, ids in NODES_USED_BY_SRC.items():
        graph = _workflow(name)
        assert [i for i in ids if i not in graph] == [], name


def test_image_model_workflows_follow_the_generator_layout():
    models = _image_models()
    assert len(models) >= 5
    for m in models:
        graph = _workflow(m["id"])
        for node in ["1", "5", "6", "7", "8", "9", *m["sizes"], *m["vae"], *m["steps"], *m["negative"]]:
            assert node in graph, (m["id"], node)
        assert graph["7"]["class_type"] in SAMPLERS, m["id"]
        assert "latent_image" in graph["7"]["inputs"], m["id"]
        assert "batch_size" in graph["5"]["inputs"], m["id"]
        assert graph["9"]["class_type"].startswith("Save"), m["id"]
        assert m["prompt"][0] in graph["6"]["inputs"], m["id"]
