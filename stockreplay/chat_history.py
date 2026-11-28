"""Local snapshots of conversations, including their rendered results and planner context."""

import hashlib
import json
import zlib
from datetime import datetime, timezone
from typing import Annotated, Literal
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import ConfigDict, Field, JsonValue, model_validator

from .assistant import Message
from .schema import Model

Title = Annotated[str, Field(min_length=1, max_length=120)]
Revision = Annotated[int, Field(ge=0, strict=True)]


class RenameChat(Model):
    title: Title
    revision: Revision


class Entry(Model):
    """Rich result fields are client-owned, versioned by the saved UI representation."""

    model_config = ConfigDict(extra="allow", str_strip_whitespace=False)
    __pydantic_extra__: dict[str, JsonValue] = Field(init=False)
    id: int | str
    role: Literal["user", "assistant"]
    text: str


class Transcript(Model):
    entries: list[Entry]
    context: list[Message]

    @model_validator(mode="after")
    def unique_ids(self):
        if len({row.id for row in self.entries}) != len(self.entries):
            raise ValueError("Each message must have its own ID.")
        return self

    def pack(self, check):
        return packed(check=check, **self.model_dump(include={"entries", "context"}, mode="json"))


class NewChat(Transcript):
    title: Title = "New chat"
    id: UUID | None = None
    entries: list[Entry] = Field(default_factory=list)
    context: list[Message] = Field(default_factory=list)


class SaveChat(Transcript):
    title: Title | None = None
    revision: Revision


def packed(entries, context, check):
    data = json.dumps(
        {"entries": entries, "context": context},
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    )
    check(data)
    return zlib.compress(data.encode(), level=3)


def stamp():
    return datetime.now(timezone.utc).isoformat(timespec="microseconds")


def required(conn, key):
    row = conn.execute("select * from assistant_chats where id=?", (str(key),)).fetchone()
    if row is None:
        raise HTTPException(404, "This conversation was removed.")
    return row


def full(row):
    chat = dict(row)
    chat.update(json.loads(zlib.decompress(chat.pop("transcript"))))
    return chat


def check_revision(row, revision):
    if revision != row["revision"]:
        raise HTTPException(
            409, "This conversation changed in another window. Reopen it from History."
        )


def private_response(response: Response):
    response.headers["Cache-Control"] = "no-store"


def register_chat_history(parent, db, check):
    with db.connect() as conn:
        conn.execute(
            """create table if not exists assistant_chats (
               id text primary key, title text not null, created text not null, updated text not null,
               revision integer not null, transcript blob not null)"""
        )
        conn.execute("create index if not exists chat_recency on assistant_chats(updated desc)")
        conn.execute("""create table if not exists assistant_chat_copies (
            id text primary key references assistant_chats(id) on delete cascade, fingerprint blob not null
        )""")
    r = APIRouter(prefix="/assistant/chats", dependencies=[Depends(private_response)])

    @r.get("")
    def recent():
        with db.connect() as conn:
            return [
                dict(row)
                for row in conn.execute(
                    "select id,title,created,updated,revision from assistant_chats order by updated desc, rowid desc"
                )
            ]

    @r.post("", status_code=201)
    def create(request: NewChat):
        check(request.title)
        key = str(request.id or uuid4())
        ts = stamp()
        blob = request.pack(check)
        copy = bool(request.entries or request.context)
        fingerprint = (
            hashlib.sha256(request.title.encode() + b"\0" + blob).digest() if copy else None
        )
        with db.connect() as conn:
            created = conn.execute(
                """insert into assistant_chats(id,title,created,updated,revision,transcript)
                   values(?,?,?,?,0,?) on conflict(id) do nothing""",
                (key, request.title, ts, ts, blob),
            ).rowcount
            if copy and created:
                conn.execute("insert into assistant_chat_copies values(?,?)", (key, fingerprint))
            elif copy:
                original = conn.execute(
                    "select fingerprint from assistant_chat_copies where id=?", (key,)
                ).fetchone()
                if not original or original["fingerprint"] != fingerprint:
                    raise HTTPException(
                        409, "This copy ID is already in use for a different conversation."
                    )
            return full(required(conn, key))

    @r.get("/{key}")
    def get(key: UUID):
        with db.connect() as conn:
            return full(required(conn, key))

    def update(key, revision, title, transcript=None):
        if title is not None:
            check(title)
        with db.connect() as conn:
            conn.execute("begin immediate")
            row = required(conn, key)
            new_title = title if title is not None else row["title"]
            blob = transcript if transcript is not None else row["transcript"]
            if new_title == row["title"] and blob == row["transcript"]:
                return full(row)
            check_revision(row, revision)
            conn.execute(
                """update assistant_chats set title=?,updated=?,revision=revision+1,transcript=?
                   where id=?""",
                (new_title, stamp(), blob, str(key)),
            )
            return full(required(conn, key))

    @r.put("/{key}")
    def save(key: UUID, request: SaveChat):
        return update(key, request.revision, request.title, request.pack(check))

    @r.patch("/{key}")
    def rename(key: UUID, request: RenameChat):
        return update(key, request.revision, request.title)

    @r.delete("/{key}")
    def delete(key: UUID, revision: int | None = None):
        with db.connect() as conn:
            conn.execute("begin immediate")
            if revision is not None:
                check_revision(required(conn, key), revision)
            conn.execute("delete from assistant_chats where id=?", (str(key),))
        return {"deleted": str(key)}

    parent.include_router(r)
