"""Serve photos declared by StockReplay's public news feeds from the local origin."""

import hashlib
import re
import time
from threading import Lock
from urllib.parse import urlsplit

import httpx
from fastapi.responses import Response

IMAGE_HOSTS = {
    "s.yimg.com",
    "media.zenfs.com",
    "d29szjachogqwa.cloudfront.net",
    "www.federalreserve.gov",
}
MAX_PHOTO = 4 * 1024 * 1024
CACHE_LIMIT = 48 * 1024 * 1024
SIGNATURES = {
    "image/jpeg": b"\xff\xd8\xff",
    "image/png": b"\x89PNG\r\n\x1a\n",
    "image/gif": b"GIF8",
    "image/webp": b"RIFF",
}


def image_url(value):
    if not isinstance(value, str) or len(value) > 3000:
        return None
    try:
        url = urlsplit(value)
        if (
            url.scheme == "https"
            and url.hostname in IMAGE_HOSTS
            and url.port in (None, 443)
            and url.username is None
            and url.password is None
        ):
            return value
    except ValueError:
        pass
    return None


def retrieve(url):
    if not image_url(url):
        return None
    # Some hosts block direct embedding. Keep TLS verification, never follow redirects,
    # and use the exact media URL and host supplied by the public feed.
    try:
        with httpx.Client(timeout=httpx.Timeout(8, connect=4), follow_redirects=False) as client:
            with client.stream(
                "GET",
                url,
                headers={
                    "Accept": "image/jpeg,image/png,image/webp,image/gif",
                    "Accept-Encoding": "identity",
                },
            ) as response:
                mime = response.headers.get("content-type", "").partition(";")[0].strip().lower()
                if (
                    response.status_code != 200
                    or mime not in SIGNATURES
                    or int(response.headers.get("content-length", "0")) > MAX_PHOTO
                ):
                    return None
                data = bytearray()
                deadline = time.monotonic() + 12
                for chunk in response.iter_bytes(chunk_size=64 * 1024):
                    if len(data) + len(chunk) > MAX_PHOTO or time.monotonic() > deadline:
                        return None
                    data.extend(chunk)
                if not data.startswith(SIGNATURES[mime]) or (
                    mime == "image/webp" and data[8:12] != b"WEBP"
                ):
                    return None
                return mime, bytes(data)
    except (httpx.HTTPError, ValueError):
        return None


class NewsImages:
    def __init__(self, db):
        self.db = db
        self.locks = [Lock() for _ in range(12)]
        with db.connect() as conn:
            conn.execute(
                "create table if not exists news_images(id text primary key, url text not null, mime text, photo blob, fetched integer, retry_after integer)"
            )

    def attach(self, evidence):
        """Register feed references together before handing opaque photo paths to the browser."""
        refs = {}
        for item in evidence:
            preview = item.get("preview")
            if not preview:
                continue
            paths = []
            for url in preview.get("images", [])[:2]:
                if not image_url(url):
                    continue
                key = hashlib.sha256(url.encode()).hexdigest()
                refs[key] = url
                paths.append("/api/news/images/" + key)
            item["preview"] = {**preview, "images": paths}
        if refs:
            with self.db.connect() as conn:
                conn.executemany(
                    "insert or ignore into news_images(id,url) values(?,?)",
                    refs.items(),
                )

    def response(self, key: str):
        missing = Response(status_code=404, headers={"Cache-Control": "no-store"})
        if not re.fullmatch(r"[0-9a-f]{64}", key):
            return missing
        with self.locks[int(key[:2], 16) % len(self.locks)]:
            with self.db.connect() as conn:
                row = conn.execute("select * from news_images where id=?", (key,)).fetchone()
            now = int(time.time())
            if row is None or (row["retry_after"] or 0) > now:
                return missing
            mime, data = row["mime"], row["photo"]
            if data is None:
                loaded = retrieve(row["url"])
                with self.db.connect() as conn:
                    if not loaded:
                        conn.execute(
                            "update news_images set retry_after=? where id=?",
                            (now + 600, key),
                        )
                        return missing
                    mime, data = loaded
                    conn.execute(
                        "update news_images set photo=?,mime=?,fetched=?,retry_after=null where id=?",
                        (data, mime, now, key),
                    )
                    conn.execute(
                        """update news_images set photo=null,mime=null where id in (
                        select id from (select id,sum(length(photo)) over(order by fetched desc,rowid desc) as bytes
                        from news_images where photo is not null) where bytes > ?)""",
                        (CACHE_LIMIT,),
                    )
        return Response(
            data,
            media_type=mime,
            headers={
                "X-Content-Type-Options": "nosniff",
                "Cache-Control": "private, max-age=86400",
            },
        )
