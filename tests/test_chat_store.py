from __future__ import annotations

import os
import sqlite3

from sqlalchemy import func, select

from ComfyArt.api import chat_store, db

OLD_SCHEMA = """
CREATE TABLE comfyart_chats (
    id TEXT PRIMARY KEY, user TEXT NOT NULL, project TEXT NOT NULL, title TEXT NOT NULL DEFAULT '',
    provider TEXT NOT NULL, resume_token TEXT, run_mode TEXT NOT NULL DEFAULT 'auto',
    pinned INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0, created_at REAL NOT NULL, updated_at REAL NOT NULL);
CREATE INDEX ix_comfyart_chats_user_project ON comfyart_chats (user, project);
CREATE TABLE comfyart_messages (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
    chat_id TEXT NOT NULL REFERENCES comfyart_chats (id) ON DELETE CASCADE, parent_id TEXT, role TEXT NOT NULL,
    blocks TEXT NOT NULL, status TEXT NOT NULL, resume_token_after TEXT, usage TEXT, created_at REAL NOT NULL);
CREATE INDEX ix_comfyart_messages_chat ON comfyart_messages (chat_id, seq);
"""


def test_chats_are_scoped_by_user_and_project():
    a = chat_store.create_chat(user="default", project="p1", provider="claude-code")
    chat_store.create_chat(user="alice", project="p1", provider="claude-code")
    chat_store.create_chat(user="default", project="p2", provider="codex")
    assert [c["id"] for c in chat_store.list_chats("default", "p1")] == [a["id"]]
    assert len(chat_store.list_chats("alice", "p1")) == 1


def test_database_lives_in_the_system_user_dir(fresh_user_dir):
    chat_store.create_chat(user="alice", project="p", provider="codex")
    assert os.path.isfile(fresh_user_dir / "user" / "__comfyart" / "data.db")


def test_reopen_keeps_owner_and_messages():
    chat = chat_store.create_chat(user="alice", project="p", provider="codex")
    chat_store.create_message(chat_id=chat["id"], role="user", blocks=[{"type": "text", "text": "hi"}])
    for engine in db._engines.values():
        engine.dispose()
    db._engines.clear()
    reloaded = chat_store.get_chat(chat["id"])
    assert reloaded["user"] == "alice"
    assert chat_store.list_messages(chat["id"])[0]["blocks"][0]["text"] == "hi"


def test_branch_copies_up_to_message_and_resume_token():
    chat = chat_store.create_chat(user="default", project="p", provider="claude-code")
    first = chat_store.create_message(chat_id=chat["id"], role="user", blocks=[])
    reply = chat_store.create_message(chat_id=chat["id"], role="assistant", blocks=[], parent_id=first["id"])
    chat_store.update_message(chat["id"], reply["id"], resume_token_after="tok-1")
    chat_store.create_message(chat_id=chat["id"], role="user", blocks=[])
    branch = chat_store.branch_chat(chat["id"], reply["id"])
    messages = chat_store.list_messages(branch["id"])
    assert len(messages) == 2
    assert branch["resume_token"] == "tok-1"
    assert messages[1]["parent_id"] == messages[0]["id"]


def test_update_ignores_none_and_delete_cascades_messages():
    chat = chat_store.create_chat(user="default", project="p", provider="codex", title="t")
    chat_store.create_message(chat_id=chat["id"], role="user", blocks=[])
    chat_store.update_chat(chat["id"], title=None, run_mode="ask")
    assert chat_store.get_chat(chat["id"])["title"] == "t"
    assert chat_store.get_chat(chat["id"])["run_mode"] == "ask"
    assert chat_store.delete_chat(chat["id"]) is True
    assert chat_store.get_chat(chat["id"]) is None
    assert chat_store.list_messages(chat["id"]) == []
    with db.session() as s:
        assert s.scalar(select(func.count()).select_from(db.Message)) == 0


def test_a_database_from_the_raw_sqlite_version_is_used_as_is(fresh_user_dir):
    path = fresh_user_dir / "user" / "__comfyart" / "data.db"
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    conn.executescript(OLD_SCHEMA)
    conn.execute("INSERT INTO comfyart_chats (id, user, project, provider, created_at, updated_at) VALUES ('c1', 'alice', 'p', 'codex', 1, 2)")
    conn.execute("INSERT INTO comfyart_messages (id, chat_id, role, blocks, status, created_at) VALUES ('m1', 'c1', 'user', '[]', 'done', 1)")
    conn.commit()
    conn.close()
    assert chat_store.get_chat("c1")["pinned"] is False
    chat_store.create_message(chat_id="c1", role="assistant", blocks=[{"type": "text", "text": "ok"}])
    assert [m["id"] for m in chat_store.list_messages("c1")][0] == "m1"
    assert chat_store.delete_chat("c1") and chat_store.list_messages("c1") == []


def test_abort_unfinished_marks_streaming_and_queued():
    chat = chat_store.create_chat(user="default", project="p", provider="codex")
    done = chat_store.create_message(chat_id=chat["id"], role="user", blocks=[])
    chat_store.create_message(chat_id=chat["id"], role="user", blocks=[], status="queued")
    chat_store.create_message(chat_id=chat["id"], role="assistant", blocks=[], status="streaming")
    chat_store.abort_unfinished()
    assert [m["status"] for m in chat_store.list_messages(chat["id"])] == ["done", "aborted", "aborted"]
    assert chat_store.list_messages(chat["id"])[0]["id"] == done["id"]
