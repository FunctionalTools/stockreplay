"""Store public article references in the local workspace, independently of the news cache."""

from datetime import datetime
from hashlib import sha256
from ipaddress import ip_address
from urllib.parse import urldefrag

from fastapi import APIRouter
from pydantic import AnyHttpUrl, Field, field_validator, model_validator

from .schema import Model
from .store import now


class Article(Model):
    url: AnyHttpUrl
    title: str = Field(min_length=1, max_length=1500)
    source: str = Field(min_length=1, max_length=300)
    published: str | None = Field(default=None, min_length=10, max_length=50)
    indexed_at: str | None = Field(default=None, min_length=10, max_length=50)
    checked_at: str | None = Field(default=None, min_length=10, max_length=50)
    excerpt: str | None = Field(default=None, max_length=3500)

    @field_validator("url")
    @classmethod
    def published_link(cls, value):
        host = (value.host or "").strip("[]").rstrip(".").lower()
        if len(str(value)) > 8192 or value.username is not None or value.password is not None:
            raise ValueError("Use the publisher’s public article link.")
        try:
            public = ip_address(host).is_global
        except ValueError:
            public = "." in host and not host.endswith(
                (".localhost", ".local", ".internal", ".lan")
            )
        if not public:
            raise ValueError("Use the publisher’s public article link.")
        return value

    @field_validator("published", "indexed_at", "checked_at")
    @classmethod
    def article_date(cls, stamp):
        if stamp is None:
            return None
        try:
            datetime.fromisoformat(stamp)
        except ValueError:
            raise ValueError("Use an article date in ISO format.") from None
        return stamp

    @model_validator(mode="after")
    def dated(self):
        if not (self.published or self.indexed_at or self.checked_at):
            raise ValueError("Supply the publication, indexing or retrieval date.")
        return self


def register_reading_list(app, store):
    with store.connect() as conn:
        conn.execute("begin immediate")
        conn.execute(
            """create table if not exists reading_list(
                id text primary key, url text not null, title text not null, source text not null,
                published text not null, excerpt text, saved_at text not null, indexed_at text)"""
        )
        existing = {c["name"] for c in conn.execute("pragma table_info(reading_list)")}
        for column in ("indexed_at", "checked_at"):
            if column not in existing:
                conn.execute(f"alter table reading_list add column {column} text")
    router = APIRouter(prefix="/api/reading-list")
    # Older workspaces require a non-null published column. Expose an unknown publication date as null.
    columns = "id, url, title, source, nullif(published, '') as published, indexed_at, checked_at, excerpt, saved_at"

    @router.get("")
    def saved_articles():
        with store.connect() as conn:
            return [
                dict(row)
                for row in conn.execute(
                    f"select {columns} from reading_list order by saved_at desc,rowid desc"
                )
            ]

    @router.put("")
    def save_article(article: Article):
        url = urldefrag(str(article.url)).url
        key = sha256(url.encode()).hexdigest()
        with store.connect() as conn:
            # Several cards, tabs or retried requests can refer to the same article.
            conn.execute(
                """insert into reading_list(id,url,title,source,published,indexed_at,checked_at,excerpt,saved_at)
                   values(?,?,?,?,?,?,?,?,?) on conflict(id) do nothing""",
                (
                    key,
                    url,
                    article.title,
                    article.source,
                    article.published or "",
                    article.indexed_at,
                    article.checked_at,
                    article.excerpt,
                    now(),
                ),
            )
            return dict(
                conn.execute(f"select {columns} from reading_list where id=?", (key,)).fetchone()
            )

    @router.delete("/{article_id}")
    def remove_article(article_id: str):
        with store.connect() as conn:
            conn.execute("delete from reading_list where id=?", (article_id,))
        return {"removed": article_id}

    app.include_router(router)
