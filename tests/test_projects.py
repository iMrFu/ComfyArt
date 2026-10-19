from __future__ import annotations

import json

from ComfyArt.api import chat_store, project_store

ALICE = {"comfy-user": "alice"}


def _snapshot(name: str, shapes: int = 0) -> dict:
    store = {"document:document": {"id": "document:document", "typeName": "document", "name": name}}
    for i in range(shapes):
        store[f"shape:s{i}"] = {"id": f"shape:s{i}", "typeName": "shape"}
    return {"document": {"store": store, "schema": {}}, "session": {}}


def _write_json_projects(base):
    root = base / "user" / "default" / "comfyart"
    (root / "projects").mkdir(parents=True)
    (root / "projects" / "aaaa1111.json").write_text(json.dumps(_snapshot("Poster", 2)), encoding="utf-8")
    (root / "projects" / "bbbb2222.json").write_text(json.dumps(_snapshot("Logo")), encoding="utf-8")
    (root / "projects" / "broken00.json").write_text("{not json", encoding="utf-8")
    (root / "index.json").write_text(json.dumps({
        "aaaa1111": {"name": "Poster", "updated": 1_700_000_000_000, "covers": ["/view?filename=a.png"]},
        "bbbb2222": {"name": "Logo", "updated": 1_600_000_000_000, "pinned": True},
        "gone0000": {"name": "Missing file", "updated": 1},
    }), encoding="utf-8")
    (root / "history" / "aaaa1111").mkdir(parents=True)
    (root / "history" / "aaaa1111" / "1700000000000-2.json").write_text(json.dumps(_snapshot("Poster old")), encoding="utf-8")
    return root


async def test_json_projects_are_imported_once_and_files_kept(bot_client, fresh_user_dir):
    root = _write_json_projects(fresh_user_dir)
    listed = (await (await bot_client.get("/comfyart/projects")).json())["projects"]
    assert [p["id"] for p in listed] == ["bbbb2222", "aaaa1111"]
    assert listed[0]["pinned"] is True and listed[0]["covers"] is None
    assert listed[1] == {"id": "aaaa1111", "name": "Poster", "updated": 1_700_000_000_000, "covers": ["/view?filename=a.png"], "pinned": False}
    snapshot = await (await bot_client.get("/comfyart/projects/aaaa1111")).json()
    assert len(snapshot["document"]["store"]) == 3
    versions = (await (await bot_client.get("/comfyart/projects/aaaa1111/versions")).json())["versions"]
    assert versions == [{"time": 1_700_000_000_000, "count": 2}]
    old = await (await bot_client.get("/comfyart/projects/aaaa1111/versions/1700000000000")).json()
    assert old["document"]["store"]["document:document"]["name"] == "Poster old"
    assert (await bot_client.get("/comfyart/projects/broken00")).status == 404
    assert (root / "projects" / "aaaa1111.json").exists() and (root / "index.json").exists()
    (root / "projects" / "cccc3333.json").write_text(json.dumps(_snapshot("Late")), encoding="utf-8")
    again = (await (await bot_client.get("/comfyart/projects")).json())["projects"]
    assert [p["id"] for p in again] == ["bbbb2222", "aaaa1111"]


async def test_users_without_json_files_start_empty_and_stay_separate(bot_client, fresh_user_dir):
    _write_json_projects(fresh_user_dir)
    assert (await (await bot_client.get("/comfyart/projects", headers=ALICE)).json())["projects"] == []
    assert (await bot_client.get("/comfyart/projects/aaaa1111", headers=ALICE)).status == 404
    await bot_client.put("/comfyart/projects/aaaa1111", json={"snapshot": _snapshot("Alice"), "name": "Alice", "covers": []}, headers=ALICE)
    mine = await (await bot_client.get("/comfyart/projects/aaaa1111")).json()
    assert mine["document"]["store"]["document:document"]["name"] == "Poster"


async def test_save_rename_pin_duplicate_and_delete(bot_client):
    saved = await (await bot_client.put("/comfyart/projects/p1", json={"snapshot": _snapshot("One", 1), "name": "One", "covers": ["/c.png"]})).json()
    assert saved["name"] == "One" and saved["covers"] == ["/c.png"]
    await bot_client.put("/comfyart/projects/p2", json={"snapshot": _snapshot("Two"), "name": "Two", "covers": []})
    assert [p["id"] for p in (await (await bot_client.get("/comfyart/projects")).json())["projects"]] == ["p2", "p1"]
    await bot_client.patch("/comfyart/projects/p1", json={"pinned": True, "name": "Renamed"})
    listed = (await (await bot_client.get("/comfyart/projects")).json())["projects"]
    assert listed[0]["id"] == "p1" and listed[0]["name"] == "Renamed"
    snapshot = await (await bot_client.get("/comfyart/projects/p1")).json()
    assert snapshot["document"]["store"]["document:document"]["name"] == "Renamed"
    copy = await (await bot_client.post("/comfyart/projects/p1/duplicate", json={"id": "p3", "name": "Renamed copy"})).json()
    assert copy["pinned"] is False and copy["covers"] == ["/c.png"]
    assert (await (await bot_client.get("/comfyart/projects/p3")).json())["document"]["store"]["document:document"]["name"] == "Renamed copy"
    await bot_client.post("/comfyart/projects/p1/versions", json={"snapshot": _snapshot("v"), "count": 1})
    assert (await bot_client.delete("/comfyart/projects/p1")).status == 200
    assert (await bot_client.get("/comfyart/projects/p1")).status == 404
    assert project_store.list_versions("default", "p1") == []
    assert (await bot_client.patch("/comfyart/projects/nope", json={"name": "x"})).status == 404
    assert (await bot_client.put("/comfyart/projects/p4", json={"name": "no snapshot"})).status == 400


async def test_versions_keep_the_latest_thirty(bot_client, monkeypatch):
    await bot_client.put("/comfyart/projects/p1", json={"snapshot": _snapshot("One"), "name": "One", "covers": []})
    clock = iter(range(1, 100))
    monkeypatch.setattr(project_store.time, "time", lambda: next(clock))
    for i in range(project_store.KEEP_VERSIONS + 3):
        project_store.save_version("default", "p1", json.dumps(_snapshot(f"v{i}")), i)
    versions = project_store.list_versions("default", "p1")
    assert len(versions) == project_store.KEEP_VERSIONS
    assert versions[0]["count"] == project_store.KEEP_VERSIONS + 2 and versions[-1]["count"] == 3
    assert (await bot_client.post("/comfyart/projects/nope/versions", json={"snapshot": _snapshot("x")})).status == 404


async def test_deleting_a_project_deletes_its_chats(bot_client):
    await bot_client.put("/comfyart/projects/p1", json={"snapshot": _snapshot("One"), "name": "One", "covers": []})
    gone = chat_store.create_chat(user="default", project="p1", provider="codex")
    archived = chat_store.create_chat(user="default", project="p1", provider="codex")
    chat_store.update_chat(archived["id"], archived=True)
    kept = chat_store.create_chat(user="default", project="p2", provider="codex")
    other_user = chat_store.create_chat(user="alice", project="p1", provider="codex")
    await bot_client.delete("/comfyart/projects/p1")
    assert chat_store.get_chat(gone["id"]) is None and chat_store.get_chat(archived["id"]) is None
    assert chat_store.get_chat(kept["id"]) and chat_store.get_chat(other_user["id"])
