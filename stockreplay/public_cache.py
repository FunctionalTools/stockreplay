from datetime import datetime, timezone
import json
from threading import Lock
import httpx

from .store import encode, now


class PublicCache:
    """Cache public provider responses, with explicit retrieval times and stale/error states."""

    def __init__(self, db):
        self.db = db
        self.locks = [Lock() for _ in range(37)]
        with db.connect() as conn:
            conn.execute(
                "create table if not exists public_data(key text primary key, fetched text not null, payload text not null)"
            )

    def read(self, key):
        with self.db.connect() as conn:
            row = conn.execute(
                "select fetched,payload from public_data where key=?", (key,)
            ).fetchone()
        return (
            {
                "data": json.loads(row["payload"]),
                "fetched": row["fetched"],
                "stale": False,
                "error": None,
            }
            if row
            else None
        )

    def get(self, key, ttl, loader, refresh=False, *, required_field=None):
        with self.locks[hash(key) % len(self.locks)]:
            old = self.read(key)
            if (
                old
                and not refresh
                and (required_field is None or required_field in old["data"])
                and (
                    datetime.now(timezone.utc) - datetime.fromisoformat(old["fetched"])
                ).total_seconds()
                < ttl
            ):
                return old
            try:
                data = loader()
                stamp = now()
                with self.db.connect() as conn:
                    conn.execute(
                        "insert into public_data values(?,?,?) on conflict(key) do update set fetched=excluded.fetched,payload=excluded.payload",
                        (key, stamp, encode(data)),
                    )
                return {"data": data, "fetched": stamp, "stale": False, "error": None}
            except Exception as exc:
                # Sources are independent; retain their last observed timestamp on failure.
                if isinstance(exc, httpx.HTTPStatusError):
                    msg = (
                        "The publisher is currently limiting access."
                        if exc.response.status_code in (403, 429)
                        else "The publisher has no available response for this symbol."
                    )
                elif isinstance(exc, ValueError):
                    msg = str(exc).splitlines()[0][:160] or "No published data available."
                else:
                    msg = "The publisher could not be reached."
                return {
                    **(old or {"data": None, "fetched": None}),
                    "stale": bool(old),
                    "error": msg,
                }
