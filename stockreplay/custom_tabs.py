"""User-composed views. SQLite stores layout descriptions, never executable content."""

import json
import re
import sqlite3
from datetime import date
from typing import Literal
from uuid import uuid4

from fastapi import APIRouter, HTTPException, Query
from pydantic import Field, model_validator
from .price_ranges import RANGE_PRESETS, validate_range
from .schema import Model
from .store import encode, now


class TabBlock(Model):
    view: Literal["chart", "news", "ratings", "scores", "watchlist", "portfolio", "note"]
    value: str = Field(default="", max_length=2500)
    span: str = Field(default="1y", max_length=21)

    @model_validator(mode="after")
    def validate_content(self):
        if self.span not in RANGE_PRESETS or self.span == "custom":
            if self.view != "chart" or not re.fullmatch(
                r"\d{4}-\d{2}-\d{2}/\d{4}-\d{2}-\d{2}", self.span
            ):
                raise ValueError("Choose a chart period or enter a start and end date.")
            start, _ = validate_range("custom", *self.span.split("/"))
            if start > date.today():
                raise ValueError("Choose a range that includes past or current observations.")
        if self.view in {"chart", "news", "ratings", "scores"}:
            symbols = list(dict.fromkeys(s.strip().upper() for s in self.value.split(",")))
            if len(symbols) > (4 if self.view == "chart" else 1) or any(
                not re.fullmatch(r"[A-Z0-9^][A-Z0-9.^=-]{0,19}", s) for s in symbols
            ):
                raise ValueError("Enter one ticker for a stock block or up to four for a chart.")
            self.value = ", ".join(symbols)
        elif self.view == "portfolio":
            self.value = ""
        elif self.view == "watchlist" and len(self.value) > 80:
            raise ValueError("Choose a watchlist name of up to 80 characters.")
        elif self.view == "note" and not self.value:
            raise ValueError("Enter some text for the note.")
        return self


class TabContent(Model):
    title: str = Field(min_length=1, max_length=70)
    blocks: list[TabBlock] = Field(default_factory=list, max_length=20)


class TabUpdate(TabContent):
    revision: int = Field(ge=1)


def register_tabs(router: APIRouter, store):
    with store.connect() as conn:
        conn.execute("""create table if not exists custom_tabs(
            id text primary key, title text collate nocase unique not null,
            blocks text not null, revision integer not null, updated text not null)""")

    def expanded(row):
        return {**dict(row), "blocks": json.loads(row["blocks"])}

    def assert_revision(conn, key, revision):
        row = conn.execute("select revision from custom_tabs where id=?", (key,)).fetchone()
        if not row:
            raise HTTPException(404, "This saved tab has been removed.")
        if row["revision"] != revision:
            raise HTTPException(
                409,
                "This tab changed elsewhere. Reopen the editor to use the latest version.",
            )

    @router.get("/tabs")
    def list_tabs():
        with store.connect() as conn:
            return [
                dict(row)
                for row in conn.execute(
                    "select id,title,revision,updated from custom_tabs order by title collate nocase"
                )
            ]

    @router.get("/tabs/{key}")
    def read_tab(key: str):
        with store.connect() as conn:
            row = conn.execute("select * from custom_tabs where id=?", (key,)).fetchone()
            if not row:
                raise HTTPException(404, "This saved tab has been removed.")
            return expanded(row)

    @router.post("/tabs", status_code=201)
    def create_tab(tab: TabContent):
        key = uuid4().hex
        try:
            with store.connect() as conn:
                conn.execute(
                    "insert into custom_tabs values(?,?,?,1,?)",
                    (
                        key,
                        tab.title,
                        encode([b.model_dump() for b in tab.blocks]),
                        now(),
                    ),
                )
                return expanded(
                    conn.execute("select * from custom_tabs where id=?", (key,)).fetchone()
                )
        except sqlite3.IntegrityError:
            raise HTTPException(409, "A tab already has that name. Choose another name.") from None

    @router.put("/tabs/{key}")
    def edit_tab(key: str, tab: TabUpdate):
        try:
            with store.connect() as conn:
                conn.execute("begin immediate")
                assert_revision(conn, key, tab.revision)
                conn.execute(
                    "update custom_tabs set title=?,blocks=?,revision=revision+1,updated=? where id=?",
                    (
                        tab.title,
                        encode([b.model_dump() for b in tab.blocks]),
                        now(),
                        key,
                    ),
                )
                return expanded(
                    conn.execute("select * from custom_tabs where id=?", (key,)).fetchone()
                )
        except sqlite3.IntegrityError:
            raise HTTPException(409, "A tab already has that name. Choose another name.") from None

    @router.delete("/tabs/{key}")
    def remove_tab(key: str, revision: int = Query(ge=1)):
        with store.connect() as conn:
            conn.execute("begin immediate")
            assert_revision(conn, key, revision)
            conn.execute("delete from custom_tabs where id=?", (key,))
        return {"removed": True}
