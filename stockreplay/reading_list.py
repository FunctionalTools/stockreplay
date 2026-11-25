"""Store public article references in the local workspace, independently of the news cache."""

from datetime import datetime
from hashlib import sha256
from ipaddress import ip_address
from urllib.parse import urldefrag

from fastapi import APIRouter
from pydantic import AnyHttpUrl, Field, field_validator

from .schema import Model
from .store import now


class Article(Model):
    url: AnyHttpUrl
    title: str = Field(min_length=1, max_length=1500)
    source: str = Field(min_length=1, max_length=300)
    published: str = Field(min_length=10, max_length=50)
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

    @field_validator("published")
    @classmethod
    def published_date(cls, stamp):
        try:
            datetime.fromisoformat(stamp)
        except ValueError:
            raise ValueError("Use a published date in ISO format.") from None
        return stamp


def register_reading_list(app, store):
    with store.connect() as conn:
        conn.execute(
            """create table if not exists reading_list(
                id text primary key, url text not null, title text not null, source text not null,
                published text not null, excerpt text, saved_at text not null)"""
        )
    router = APIRouter(prefix="/api/reading-list")

    @router.get("")
    def saved_articles():
        with store.connect() as conn:
            return [
                dict(row)
                for row in conn.execute(
                    "select * from reading_list order by saved_at desc,rowid desc"
                )
            ]

    @router.put("")
    def save_article(article: Article):
        url = urldefrag(str(article.url)).url
        key = sha256(url.encode()).hexdigest()
        with store.connect() as conn:
            # Several cards, tabs or retried requests can refer to the same article.
            conn.execute(
                """insert into reading_list(id,url,title,source,published,excerpt,saved_at)
                   values(?,?,?,?,?,?,?) on conflict(id) do nothing""",
                (
                    key,
                    url,
                    article.title,
                    article.source,
                    article.published,
                    article.excerpt,
                    now(),
                ),
            )
            return dict(conn.execute("select * from reading_list where id=?", (key,)).fetchone())

    @router.delete("/{article_id}")
    def remove_article(article_id: str):
        with store.connect() as conn:
            conn.execute("delete from reading_list where id=?", (article_id,))
        return {"removed": article_id}

    app.include_router(router)
