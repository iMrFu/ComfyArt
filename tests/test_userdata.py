from __future__ import annotations

from urllib.parse import quote


def _url(path: str) -> str:
    return "/comfyart/userdata/" + quote(path, safe="")


async def test_missing_file_is_no_content(bot_client, fresh_user_dir):
    res = await bot_client.get(_url("comfyart/schedules.json"))
    assert res.status == 204


async def test_existing_file_is_returned_as_text(bot_client, fresh_user_dir):
    path = fresh_user_dir / "user" / "default" / "comfyart" / "schedules.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text('[{"id": "a"}]', encoding="utf-8")
    res = await bot_client.get(_url("comfyart/schedules.json"))
    assert res.status == 200 and await res.text() == '[{"id": "a"}]'
    assert res.headers["X-Content-Type-Options"] == "nosniff" and res.headers["Content-Disposition"] == "attachment"


async def test_paths_outside_the_user_folder_and_unknown_users_are_forbidden(bot_client, fresh_user_dir):
    (fresh_user_dir / "user" / "alice").mkdir(parents=True, exist_ok=True)
    (fresh_user_dir / "user" / "alice" / "secret.json").write_text("{}")
    assert (await bot_client.get(_url("../alice/secret.json"))).status == 403
    assert (await bot_client.get(_url("comfyart/schedules.json"), headers={"Comfy-User": "mallory"})).status == 403
