import json
import csv
import io
import re
import threading
from contextlib import asynccontextmanager
from datetime import date as Date
from typing import Literal
from uuid import uuid4

from fastapi import APIRouter
from pydantic import Field, field_validator

from . import assistant
from .market import read_csv
from .desk import Desk, INTERVALS, SCREENS, safe_url, screen
from .holdings import AccountInput, Holdings, Position, Statement
from .openai_research import KeySettings, ModelLookup, OpenAIResearch
from .schema import Model
from .store import now


def ticker(raw):
    value = raw.strip().upper()
    if not re.fullmatch(r"[A-Z0-9^][A-Z0-9.^=\-]{0,19}", value):
        raise ValueError("Enter a valid market symbol.")
    return value


class Preferences(Model):
    appearance: Literal["system", "light", "dark"] | None = None
    accent: Literal["forest", "ocean", "violet", "amber"] | None = None
    advanced: bool | None = None
    home_symbol: str | None = None

    @field_validator("home_symbol")
    @classmethod
    def valid_ticker(cls, value):
        return ticker(value) if value is not None else None


class ListImport(Model):
    content: str = Field(min_length=1, max_length=1_000_000)


class ListName(Model):
    name: str = Field(min_length=1, max_length=80)


class SymbolInput(Model):
    symbol: str = Field(min_length=1, max_length=20)


class AlertInput(SymbolInput):
    direction: Literal["above", "below"]
    threshold: float = Field(gt=0, le=1e12)


class Drawing(Model):
    kind: Literal["horizontal", "trend", "box"]
    time: int = Field(ge=0)
    price: float
    end_time: int | None = None
    end_price: float | None = None


class Layout(Model):
    interval: str
    span: str
    style: Literal["Candles", "Line", "OHLC", "Area"]
    studies: list[
        Literal[
            "Volume",
            "SMA 20",
            "EMA 50",
            "Bollinger 20",
            "RSI 14",
            "MACD",
            "Dividends & splits",
        ]
    ] = Field(max_length=7)
    compare: str = Field(default="", max_length=20)
    scale: Literal["Linear", "Logarithmic", "Percentage", "Indexed to 100"] = "Linear"
    panels: list[str] = Field(default_factory=list, max_length=3)
    drawings: list[Drawing] = Field(default_factory=list, max_length=100)


class PublicGrade(Model):
    firm: str = Field(min_length=1, max_length=120)
    grade: str = Field(min_length=1, max_length=100)
    date: Date
    url: str = Field(min_length=4, max_length=1600)

    @field_validator("url")
    @classmethod
    def check_url(cls, v):
        if not safe_url(v):
            raise ValueError("Use a public HTTP or HTTPS source URL.")
        return v


class Terminal:
    def __init__(self, db):
        self.db = db
        self.desk = Desk(db)
        self.holdings = Holdings(db)
        self.openai = OpenAIResearch(db)
        self.check_lock = threading.Lock()
        with db.connect() as c:
            c.executescript("""
              create table if not exists watchlists(id text primary key,name text not null unique);
              create table if not exists watch_members(list_id text references watchlists(id) on delete cascade,symbol text not null,primary key(list_id,symbol));
              create table if not exists price_alerts(id text primary key,symbol text not null,direction text not null,threshold real not null,created text not null,triggered text,price real,observed integer);
              create table if not exists chart_layouts(symbol text primary key,payload text not null);
              create table if not exists market_recommendations(id text primary key, symbol text not null, created text not null,payload text not null);
              create index if not exists recommendations_by_symbol on market_recommendations(symbol,created);
              create table if not exists public_grades(id text primary key,symbol text not null,firm text not null,grade text not null,date text not null,url text not null,unique(symbol,firm,grade,date,url));
              create table if not exists preferences(id integer primary key,payload text not null);
              create table if not exists terminal_init(id integer primary key);
            """)
            if c.execute("insert or ignore into terminal_init values(1)").rowcount:
                c.execute("insert into watchlists values('default','Watchlist')")

    def update(self, sql, args, missing=None):
        import sqlite3

        try:
            with self.db.connect() as c:
                result = c.execute(sql, args)
                if not result.rowcount and missing:
                    raise KeyError(missing)
        except sqlite3.IntegrityError:
            raise ValueError(
                "This name already exists or the selected list no longer exists."
            ) from None

    def query(self, sql, args=()):
        with self.db.connect() as c:
            return [dict(r) for r in c.execute(sql, args)]

    def latest_price(self, symbol, refresh=False):
        result = self.desk.chart(symbol, "5m", "5d", refresh)
        series = result["data"]
        if not series:
            return {**result, "data": None}
        bar = series["bars"][-1]
        return {
            **result,
            "data": {
                "symbol": symbol,
                "currency": series.get("currency"),
                "price": bar["raw_close"],
                "time": bar["time"],
                "date": bar["date"],
                "url": series["url"],
                "previous": next(
                    (b["raw_close"] for b in reversed(series["bars"]) if b["date"] < bar["date"]),
                    None,
                ),
            },
        }

    def check_alerts(self):
        # Use only price observations at or after the alert's creation.
        from datetime import datetime

        if not self.check_lock.acquire(blocking=False):
            return
        try:
            open_alerts = self.query("select * from price_alerts where triggered is null")
            for symbol in sorted({a["symbol"] for a in open_alerts}):
                quote = self.latest_price(symbol, True)
                if quote["stale"] or not quote["data"]:
                    continue
                q = quote["data"]
                for a in (r for r in open_alerts if r["symbol"] == symbol):
                    if q["time"] < datetime.fromisoformat(a["created"]).timestamp():
                        continue
                    crossed = (
                        q["price"] >= a["threshold"]
                        if a["direction"] == "above"
                        else q["price"] <= a["threshold"]
                    )
                    with self.db.connect() as c:
                        c.execute(
                            "update price_alerts set price=?,observed=?,triggered=? where id=? and triggered is null",
                            (
                                q["price"],
                                q["time"],
                                now() if crossed else None,
                                a["id"],
                            ),
                        )
        finally:
            self.check_lock.release()


def register(app, db):
    t = Terminal(db)
    app.state.terminal = t

    @asynccontextmanager
    async def lifespan(router):
        stopping = threading.Event()

        def monitor():
            while not stopping.wait(120):
                try:
                    t.check_alerts()
                except Exception:
                    import logging

                    logging.getLogger("stockreplay").warning(
                        "An alert price check could not complete."
                    )

        thread = threading.Thread(target=monitor, daemon=True, name="local-price-alerts")
        thread.start()
        try:
            yield
        finally:
            stopping.set()

    r = APIRouter(prefix="/api", lifespan=lifespan)

    defaults = {
        "appearance": "system",
        "accent": "forest",
        "advanced": False,
        "home_symbol": "NVDA",
    }

    @r.get("/preferences")
    def prefs():
        rows = t.query("select payload from preferences where id=1")
        return {**defaults, **(json.loads(rows[0]["payload"]) if rows else {})}

    @r.patch("/preferences")
    def save_prefs(item: Preferences):
        updates = item.model_dump(exclude_none=True)
        with db.connect() as c:
            c.execute("begin immediate")
            row = c.execute("select payload from preferences where id=1").fetchone()
            result = {**defaults, **(json.loads(row[0]) if row else {}), **updates}
            c.execute("insert or replace into preferences values(1,?)", (json.dumps(result),))
        return result

    @r.get("/openai/models")
    def models(discover: bool = False):
        return t.openai.models(discover)

    @r.post("/openai/models")
    def lookup_models(item: ModelLookup):
        return t.openai.models(candidate=item.key)

    @r.post("/assistant")
    def assistant_plan(chat: assistant.Chat):
        chat.symbol = ticker(chat.symbol)
        return assistant.plan(t.openai, chat)

    @r.post("/assistant/research/{symbol}")
    def answer_question(symbol: str, item: assistant.Question):
        t.openai.credentials()
        assistant.reject_key(item.question)
        return assistant.research_question(t.openai, t.desk.briefing(ticker(symbol)), item.question)

    @r.get("/prices/imports")
    def imports():
        return [row for row in db.catalog() if row["source"] == "csv"]

    @r.get("/prices/imports/{key}")
    def imported_prices(key: str):
        meta, raw = db.snapshot(key)
        if meta["source"] != "csv":
            raise ValueError("Select an imported price file.")
        bars = [
            {
                "date": d.date().isoformat(),
                "time": int(d.tz_localize("UTC").timestamp()),
                "close": row["Adj Close"],
                "raw_close": row["Close"],
            }
            for d, row in read_csv(raw).iterrows()
        ]
        return {
            "symbol": meta["ticker"],
            "bars": bars,
            "as_of": meta["last"],
            "source": "Imported file",
            "currency": None,
            "url": None,
        }

    @r.get("/desk/chart/{symbol}")
    def chart(symbol: str, interval: str = "1d", span: str = "2y", refresh: bool = False):
        return t.desk.chart(ticker(symbol), interval, span, refresh)

    @r.get("/desk/quote/{symbol}")
    def quote(symbol: str, refresh: bool = False):
        return t.latest_price(ticker(symbol), refresh)

    @r.get("/desk/ratings/{symbol}")
    def ratings(symbol: str, refresh: bool = False):
        s = ticker(symbol)
        v = t.desk.ratings(s, refresh)
        result = {k: val for k, val in v.items() if k not in {"chart", "benchmark"}}
        result["price_issues"] = [v[k]["error"] for k in ("chart", "benchmark") if v[k]["error"]]
        result["disclosures"] = t.query(
            "select * from public_grades where symbol=? order by date desc", (s,)
        )
        return result

    @r.post("/desk/ratings/{symbol}/disclosures")
    def add_grade(symbol: str, item: PublicGrade):
        t.update(
            "insert or ignore into public_grades values(?,?,?,?,?,?)",
            (
                uuid4().hex,
                ticker(symbol),
                item.firm,
                item.grade,
                item.date.isoformat(),
                item.url,
            ),
        )
        return {"saved": True}

    @r.delete("/desk/disclosures/{key}")
    def remove_grade(key: str):
        t.update("delete from public_grades where id=?", (key,), "Disclosure not found.")
        return {"deleted": key}

    @r.get("/desk/brief/{symbol}")
    def brief(symbol: str, refresh: bool = False):
        return t.desk.briefing(ticker(symbol), refresh)

    @r.post("/desk/recommend/{symbol}")
    def recommend(symbol: str):
        t.openai.credentials()
        symbol = ticker(symbol)
        answer = t.openai.recommend(t.desk.briefing(symbol))
        key = uuid4().hex
        t.update(
            "insert into market_recommendations values(?,?,?,?)",
            (key, symbol, answer["created"], json.dumps(answer, allow_nan=False)),
        )
        return {**answer, "id": key}

    @r.get("/desk/recommend/{symbol}")
    def history(symbol: str):
        return [
            {"id": row["id"], **json.loads(row["payload"])}
            for row in t.query(
                "select id,payload from market_recommendations where symbol=? order by created desc,rowid desc",
                (ticker(symbol),),
            )
        ]

    @r.get("/desk/screener")
    def screener(screen_name: str = "most_actives", refresh: bool = False):
        if screen_name not in SCREENS:
            raise ValueError("Unknown screen.")
        return t.desk.cache.get("screen:" + screen_name, 180, lambda: screen(screen_name), refresh)

    @r.get("/openai")
    def key_status():
        return t.openai.status()

    @r.put("/openai")
    def key_set(settings: KeySettings):
        return t.openai.set(settings)

    @r.delete("/openai")
    def key_forget():
        return t.openai.forget()

    @r.post("/openai/test")
    def key_test():
        return t.openai.test()

    @r.get("/watchlists")
    def lists():
        rows = t.query("select * from watchlists order by rowid")
        members = t.query("select * from watch_members order by rowid")
        return [
            {**x, "symbols": [m["symbol"] for m in members if m["list_id"] == x["id"]]}
            for x in rows
        ]

    @r.post("/watchlists", status_code=201)
    def new_list(item: ListName):
        key = uuid4().hex
        t.update("insert into watchlists values(?,?)", (key, item.name))
        return {"id": key}

    @r.patch("/watchlists/{key}")
    def rename(key: str, item: ListName):
        t.update(
            "update watchlists set name=? where id=?",
            (item.name, key),
            "List not found.",
        )
        return {"id": key}

    @r.delete("/watchlists/{key}")
    def delete_list(key: str):
        t.update("delete from watchlists where id=?", (key,), "List not found.")
        return {"deleted": key}

    @r.post("/watchlists/{key}/symbols")
    def add(key: str, item: SymbolInput):
        s = ticker(item.symbol)
        t.update("insert into watch_members values(?,?) on conflict do nothing", (key, s))
        return {"symbol": s}

    @r.post("/watchlists/{key}/import")
    def import_list(key: str, item: ListImport):
        reader = csv.reader(io.StringIO(item.content.lstrip("\ufeff")))
        rows = (row for row in reader if any(cell.strip() for cell in row))
        first = next(rows, [])
        head = [v.strip().casefold() for v in first]
        col = next(
            (i for i, v in enumerate(head) if v in {"ticker", "symbol", "ticker symbol"}), None
        )
        if col is None:
            if len(first) != 1:
                raise ValueError("Include a Symbol or Ticker column, or one ticker per line.")
            col = 0
            import itertools

            rows = itertools.chain([first], rows)
        symbols = set()
        for row in rows:
            if col >= len(row):
                raise ValueError("A row is missing its symbol.")
            symbols.add(ticker(row[col]))
            if len(symbols) > 2000:
                raise ValueError("Import up to 2,000 symbols at once.")
        if not symbols:
            raise ValueError("The file contains no symbols.")
        with db.connect() as c:
            c.execute("begin immediate")
            if not c.execute("select 1 from watchlists where id=?", (key,)).fetchone():
                raise KeyError("List not found.")
            inserted = c.executemany(
                "insert or ignore into watch_members values(?,?)",
                [(key, s) for s in sorted(symbols)],
            ).rowcount
        return {"added": inserted, "existing": len(symbols) - inserted}

    @r.delete("/watchlists/{key}/symbols/{symbol}")
    def remove_symbol(key: str, symbol: str):
        t.update(
            "delete from watch_members where list_id=? and symbol=?",
            (key, ticker(symbol)),
            "Symbol not found.",
        )
        return {"deleted": symbol}

    @r.get("/alerts")
    def alerts():
        return t.query("select * from price_alerts order by created desc")

    @r.post("/alerts", status_code=201)
    def alert(item: AlertInput):
        key = uuid4().hex
        t.update(
            "insert into price_alerts(id,symbol,direction,threshold,created) values(?,?,?,?,?)",
            (key, ticker(item.symbol), item.direction, item.threshold, now()),
        )
        return {"id": key}

    @r.post("/alerts/check")
    def check():
        t.check_alerts()
        return alerts()

    @r.delete("/alerts/{key}")
    def delete_alert(key: str):
        t.update("delete from price_alerts where id=?", (key,), "Alert not found.")
        return {"deleted": key}

    @r.get("/desk/layout/{symbol}")
    def layout(symbol: str):
        rows = t.query("select payload from chart_layouts where symbol=?", (ticker(symbol),))
        return json.loads(rows[0]["payload"]) if rows else None

    @r.put("/desk/layout/{symbol}")
    def save_layout(symbol: str, item: Layout):
        if item.interval not in INTERVALS or item.span not in INTERVALS[item.interval]:
            raise ValueError("Unsupported chart period.")
        item.panels = list(
            dict.fromkeys(ticker(s) for s in item.panels if ticker(s) != ticker(symbol))
        )
        if item.compare:
            item.compare = ticker(item.compare)
        t.update(
            "insert into chart_layouts values(?,?) on conflict(symbol) do update set payload=excluded.payload",
            (ticker(symbol), item.model_dump_json()),
        )
        return {"saved": True}

    @r.get("/holdings")
    def holdings():
        return t.holdings.all()

    @r.post("/holdings/accounts", status_code=201)
    def account(item: AccountInput):
        return t.holdings.create(item)

    @r.delete("/holdings/accounts/{key}")
    def remove_account(key: str):
        return t.holdings.remove(key)

    @r.post("/holdings/import/preview")
    def preview(item: Statement):
        return t.holdings.import_statement(item)

    @r.post("/holdings/import/apply")
    def apply(item: Statement):
        return t.holdings.import_statement(item, True)

    @r.post("/holdings/accounts/{key}/positions", status_code=201)
    def position(key: str, item: Position):
        return t.holdings.position(key, item)

    @r.put("/holdings/accounts/{key}/positions/{pid}")
    def edit_position(key: str, pid: str, item: Position):
        return t.holdings.position(key, item, pid)

    @r.delete("/holdings/accounts/{key}/positions/{pid}")
    def remove_position(key: str, pid: str):
        return t.holdings.remove(key, pid)

    app.include_router(r)
