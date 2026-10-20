from __future__ import annotations

import asyncio

import folder_paths
import pytest
from aiohttp import web
from aiohttp.test_utils import TestServer
from conftest import SENT

from ComfyArt.api import remote

UNETS = ["qwen/qwen_image_2512_fp8_e4m3fn.safetensors", "z_image_turbo_bf16.safetensors"]


def fake_comfy(classes: dict):
    state = {"pending": [], "running": [], "history": {}, "prompts": [], "uploads": [], "posts": [], "sockets": []}

    async def queue(request: web.Request):
        if request.method == "POST":
            state["posts"].append(("queue", await request.json()))
            return web.json_response({})
        return web.json_response({"queue_running": [[0, p] for p in state["running"]], "queue_pending": [[1, p] for p in state["pending"]]})

    async def object_info(request: web.Request):
        name = request.match_info["cls"]
        return web.json_response({name: classes[name]} if name in classes else {})

    async def upload(request: web.Request):
        data = await request.post()
        state["uploads"].append((data["subfolder"], data["image"].filename))
        return web.json_response({"name": data["image"].filename, "subfolder": data["subfolder"], "type": "input"})

    async def prompt(request: web.Request):
        body = await request.json()
        if body["prompt"].get("bad"):
            return web.json_response({"error": {"message": "Prompt outputs failed validation"}, "node_errors": {}}, status=400)
        pid = f"p{len(state['prompts']) + 1}"
        state["prompts"].append((pid, body))
        state["pending"].append(pid)
        for ws in state["sockets"]:
            await ws.send_json({"type": "progress", "data": {"prompt_id": pid, "value": 2, "max": 8}})
        return web.json_response({"prompt_id": pid})

    async def ws(request: web.Request):
        sock = web.WebSocketResponse()
        await sock.prepare(request)
        state["sockets"].append(sock)
        async for _ in sock:
            pass
        return sock

    async def history(request: web.Request):
        pid = request.match_info["pid"]
        return web.json_response({pid: state["history"][pid]} if pid in state["history"] else {})

    async def view(request: web.Request):
        return web.Response(body=f"bytes:{request.query['filename']}".encode())

    async def interrupt(request: web.Request):
        state["posts"].append(("interrupt", await request.json()))
        return web.json_response({})

    async def models(_request: web.Request):
        return web.json_response(UNETS)

    app = web.Application()
    app.router.add_route("*", "/queue", queue)
    app.router.add_get("/object_info/{cls}", object_info)
    app.router.add_post("/upload/image", upload)
    app.router.add_post("/prompt", prompt)
    app.router.add_get("/ws", ws)
    app.router.add_get("/history/{pid}", history)
    app.router.add_get("/view", view)
    app.router.add_post("/interrupt", interrupt)
    app.router.add_get("/models/diffusion_models", models)
    return app, state


UNET = {"input": {"required": {"unet_name": [UNETS], "weight_dtype": [["default", "fp8_e4m3fn"]]}}}
COMMON = {
    "UNETLoader": UNET,
    "LoadImage": {"input": {"required": {"image": [["other.png"], {"image_upload": True}]}}},
    "SaveImage": {"input": {"required": {"images": ["IMAGE"], "filename_prefix": ["STRING", {}]}}},
}

GRAPH = {
    "1": {"class_type": "ComfyArtPreciseUNETLoader", "inputs": {"unet_name": "qwen_image_2512_fp8_e4m3fn.safetensors"}},
    "3": {"class_type": "LoadImage", "inputs": {"image": "comfyart/ref.png [input]"}},
    "4": {"class_type": "SaveImage", "inputs": {"images": ["3", 0], "filename_prefix": "comfyart/image"}},
}


@pytest.fixture
async def comfies(monkeypatch, fresh_user_dir):
    servers = []

    async def start(classes):
        app, state = fake_comfy(classes)
        server = TestServer(app)
        await server.start_server()
        servers.append(server)
        return {"host": server.host, "port": server.port}, state

    local, local_state = await start({**COMMON, "ComfyArtPreciseUNETLoader": UNET})
    monkeypatch.setattr(remote, "_local", lambda: {"id": "local", "label": "local", **local})
    image = fresh_user_dir / "input" / "comfyart" / "ref.png"
    image.parent.mkdir(parents=True)
    image.write_bytes(b"ref")
    monkeypatch.setattr(folder_paths, "get_annotated_filepath", lambda name: str(fresh_user_dir / "input" / name.rsplit(" [", 1)[0]), raising=False)
    yield start, local_state
    for task in list(remote._relays):
        task.cancel()
    await asyncio.gather(*remote._relays, return_exceptions=True)
    for server in servers:
        await server.close()


async def add(client, addr, label):
    res = await client.post("/comfyart/instances", json={"label": label, **addr})
    return (await res.json())["instance"]


async def test_instance_crud(bot_client, comfies):
    start, _ = comfies
    addr, _ = await start(COMMON)
    inst = await add(bot_client, addr, "spark")
    assert inst == {"id": inst["id"], "label": "spark", "enabled": True, **addr}
    res = await bot_client.patch(f"/comfyart/instances/{inst['id']}", json={"enabled": False})
    assert (await res.json())["instance"]["enabled"] is False
    assert (await (await bot_client.get("/comfyart/instances/status")).json()) == {"statuses": []}
    await bot_client.patch(f"/comfyart/instances/{inst['id']}", json={"enabled": True})
    status = (await (await bot_client.get("/comfyart/instances/status")).json())["statuses"]
    assert status == [{"id": inst["id"], "online": True, "queue": 0, "models": ["qwen_image_2512_fp8_e4m3fn.safetensors", "z_image_turbo_bf16.safetensors"]}]
    assert (await bot_client.post("/comfyart/instances", json={"label": "x"})).status == 400
    assert (await bot_client.delete(f"/comfyart/instances/{inst['id']}")).status == 200
    assert (await (await bot_client.get("/comfyart/instances")).json()) == {"instances": []}


async def test_named_instance_gets_uploads_model_paths_and_progress(bot_client, comfies):
    start, _ = comfies
    addr, state = await start({**COMMON, "ComfyArtPreciseUNETLoader": UNET})
    inst = await add(bot_client, addr, "spark")
    res = await bot_client.post("/comfyart/remote/prompt", json={"prompt": GRAPH, "target": inst["id"], "client_id": "c1"})
    assert (await res.json()) == {"prompt_id": f"srv:{inst['id']}:p1", "instance": "spark"}
    sent = state["prompts"][0][1]["prompt"]
    assert sent["1"] == {"class_type": "ComfyArtPreciseUNETLoader", "inputs": {"unet_name": "qwen/qwen_image_2512_fp8_e4m3fn.safetensors"}}
    assert state["uploads"] == [("comfyart", state["uploads"][0][1])]
    assert sent["3"]["inputs"]["image"] == f"comfyart/{state['uploads'][0][1]} [input]"
    assert sent["4"] == GRAPH["4"]
    for _ in range(50):
        if any(e == "progress" for e, _ in SENT):
            break
        await asyncio.sleep(0.02)
    assert ("progress", {"prompt_id": f"srv:{inst['id']}:p1", "value": 2, "max": 8}) in SENT


async def test_rejected_prompt_passes_remote_error_through(bot_client, comfies):
    start, _ = comfies
    addr, _ = await start(COMMON)
    inst = await add(bot_client, addr, "spark")
    res = await bot_client.post("/comfyart/remote/prompt", json={"prompt": {"bad": {"class_type": "SaveImage", "inputs": {}}}, "target": inst["id"]})
    assert res.status == 400
    assert (await res.json())["error"]["message"] == "Prompt outputs failed validation"


async def test_auto_sends_to_least_busy_instance_that_has_the_models(bot_client, comfies):
    start, local = comfies
    local["pending"] = ["x", "y"]
    busy_addr, busy = await start({**COMMON, "ComfyArtPreciseUNETLoader": UNET})
    busy["pending"] = ["z"]
    idle_addr, idle = await start({**COMMON, "ComfyArtPreciseUNETLoader": {"input": {"required": {"unet_name": [["other.safetensors"]]}}}})
    plain_addr, plain = await start(COMMON)
    await add(bot_client, busy_addr, "busy")
    await add(bot_client, idle_addr, "lacks-model")
    await add(bot_client, plain_addr, "no-comfyart")
    res = await bot_client.post("/comfyart/remote/prompt", json={"prompt": GRAPH, "client_id": "c1"})
    assert (await res.json())["instance"] == "busy"
    assert not idle["prompts"] and not plain["prompts"]
    res = await bot_client.post("/comfyart/remote/prompt", json={"prompt": GRAPH, "client_id": "c1"})
    assert (await res.json())["instance"] == "local"


async def test_auto_prefers_this_computer_on_a_tie_and_keeps_client_id(bot_client, comfies):
    start, local = comfies
    addr, other = await start({**COMMON, "ComfyArtPreciseUNETLoader": UNET})
    await add(bot_client, addr, "spark")
    res = await bot_client.post("/comfyart/remote/prompt", json={"prompt": GRAPH, "client_id": "c1"}, headers={"Comfy-User": "alice"})
    assert (await res.json()) == {"prompt_id": "p1", "instance": "local"}
    pid, body = local["prompts"][0]
    assert body["client_id"] == "c1"
    assert body["prompt"]["1"]["class_type"] == "ComfyArtPreciseUNETLoader"
    assert body["prompt"]["1"]["inputs"]["unet_name"] == "qwen/qwen_image_2512_fp8_e4m3fn.safetensors"
    assert body["prompt"]["3"]["inputs"]["image"] == "comfyart/ref.png [input]"
    assert not other["prompts"]
    res = await bot_client.post("/comfyart/remote/prompt", json={"prompt": GRAPH, "client_id": "c1"})
    assert (await res.json())["instance"] == "spark"


async def test_history_reports_queue_then_downloads_outputs(bot_client, comfies, fresh_user_dir):
    start, _ = comfies
    addr, state = await start(COMMON)
    inst = await add(bot_client, addr, "Spark Box")
    url = f"/comfyart/remote/history/{inst['id']}/p1"
    pid = f"srv:{inst['id']}:p1"
    assert (await (await bot_client.get(url)).json()) == {}
    state["pending"] = ["p1"]
    assert (await (await bot_client.get(url)).json())[pid]["status"] == {"completed": False, "status_str": "running", "messages": []}
    state["pending"] = []
    state["history"]["p1"] = {"status": {"completed": True, "status_str": "success", "messages": []}, "outputs": {
        "4": {"images": [{"filename": "image_00001_.png", "subfolder": "comfyart", "type": "output"}]},
        "9": {"text": ["hello"]},
    }}
    body = (await (await bot_client.get(url)).json())[pid]
    assert body["outputs"]["4"]["images"] == [{"filename": "image_00001_Spark_Box-p1.png", "subfolder": "comfyart", "type": "output"}]
    assert body["outputs"]["9"] == {"text": ["hello"]}
    assert (fresh_user_dir / "output" / "comfyart" / "image_00001_Spark_Box-p1.png").read_bytes() == b"bytes:image_00001_.png"


async def test_cancel_deletes_pending_and_interrupts_running(bot_client, comfies):
    start, _ = comfies
    addr, state = await start(COMMON)
    inst = await add(bot_client, addr, "spark")
    state["pending"], state["running"] = ["p1"], ["p2"]
    await bot_client.post(f"/comfyart/remote/cancel/{inst['id']}/p1")
    await bot_client.post(f"/comfyart/remote/cancel/{inst['id']}/p2")
    assert state["posts"] == [("queue", {"delete": ["p1"]}), ("interrupt", {"prompt_id": "p2"})]


async def test_unknown_instance_is_a_clear_error(bot_client, comfies):
    res = await bot_client.get("/comfyart/remote/history/gone/p1")
    assert res.status == 404
    assert "no longer registered" in (await res.json())["error"]["message"]
