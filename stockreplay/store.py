import hashlib
import json
import os
import sqlite3
import uuid
import zlib
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def encode(value):
    return json.dumps(value, allow_nan=False, ensure_ascii=False, separators=(",", ":"))


class Store:
    def __init__(self, root=None):
        parent = Path(root or os.environ.get("STOCKREPLAY_HOME", ".stockreplay"))
        parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.path = parent / "lab.sqlite3"
        with self.connect() as db:
            db.execute("pragma journal_mode=WAL")
            db.executescript("""
                create table if not exists snapshots(
                    id text primary key, ticker text, source text, first text, last text,
                    rows integer, fetched text, payload blob);
                create index if not exists lookup on snapshots(source,ticker,first,last,fetched);
                create table if not exists runs(id text primary key, created text, payload blob);
                create table if not exists library(id text primary key, run_id text references runs(id),
                    name text, notes text, created text, updated text);
                create table if not exists settings(id integer primary key check(id=1), model text);
                create table if not exists comparisons(id text primary key, name text, created text, payload text);
            """)

        for filename in (
            self.path,
            Path(str(self.path) + "-wal"),
            Path(str(self.path) + "-shm"),
        ):
            try:
                filename.chmod(0o600)
            except FileNotFoundError:
                pass

    @contextmanager
    def connect(self):
        conn = sqlite3.connect(self.path, timeout=30)
        conn.row_factory = sqlite3.Row
        conn.execute("pragma foreign_keys=ON")
        try:
            with conn:
                yield conn
        finally:
            conn.close()

    def put_frame(self, ticker, source, csv, dates):
        key = hashlib.sha256((source + "|" + ticker + "|" + csv).encode()).hexdigest()
        with self.connect() as db:
            db.execute(
                "insert into snapshots values(?,?,?,?,?,?,?,?) on conflict(id) do update set fetched=excluded.fetched",
                (
                    key,
                    ticker,
                    source,
                    dates[0],
                    dates[-1],
                    len(dates),
                    now(),
                    zlib.compress(csv.encode()),
                ),
            )
        return key

    def snapshot(self, key):
        with self.connect() as db:
            row = db.execute("select * from snapshots where id=?", (key,)).fetchone()
        if row is None:
            raise ValueError("This data snapshot is unavailable on this computer.")
        meta = dict(row)
        return meta, zlib.decompress(meta.pop("payload")).decode()

    def catalog(self):
        with self.connect() as db:
            return [
                dict(r)
                for r in db.execute(
                    "select id,ticker,source,first,last,rows,fetched from snapshots order by fetched desc, rowid desc"
                )
            ]

    def find(self, ticker, source, start, end):
        with self.connect() as db:
            row = db.execute(
                """select id from snapshots where ticker=? and source=? and first<=?
                              and last>=? order by fetched desc,rowid desc limit 1""",
                (ticker, source, start, end),
            ).fetchone()
            return row["id"] if row else None

    def run(self, result):
        key = uuid.uuid4().hex
        with self.connect() as db:
            db.execute(
                "insert into runs values(?,?,?)",
                (key, now(), zlib.compress(encode(result).encode())),
            )
        return key

    def result(self, key):
        with self.connect() as db:
            row = db.execute("select payload from runs where id=?", (key,)).fetchone()
        if row is None:
            raise KeyError("Run not found.")
        return json.loads(zlib.decompress(row[0]))

    def save(self, run_id, name, notes):
        self.result(run_id)
        key, stamp = uuid.uuid4().hex, now()
        with self.connect() as db:
            db.execute(
                "insert into library values(?,?,?,?,?,?)",
                (key, run_id, name, notes, stamp, stamp),
            )
        return key

    def library(self):
        with self.connect() as db:
            return [
                dict(r)
                for r in db.execute("select * from library order by updated desc,rowid desc")
            ]

    def edit(self, key, name, notes, run_id=None):
        if run_id:
            self.result(run_id)
        with self.connect() as db:
            if not db.execute(
                "update library set name=?,notes=?,updated=?,run_id=coalesce(?,run_id) where id=?",
                (name, notes, now(), run_id, key),
            ).rowcount:
                raise KeyError("Saved experiment not found.")

    def delete(self, key):
        with self.connect() as db:
            if not db.execute("delete from library where id=?", (key,)).rowcount:
                raise KeyError("Saved experiment not found.")

    def add_comparison(self, name, data):
        key = uuid.uuid4().hex
        with self.connect() as db:
            db.execute(
                "insert into comparisons values(?,?,?,?)",
                (key, name, now(), encode(data)),
            )
        return key

    def comparisons(self):
        with self.connect() as db:
            return [
                {**dict(r), "payload": json.loads(r["payload"])}
                for r in db.execute("select * from comparisons order by created desc,rowid desc")
            ]
