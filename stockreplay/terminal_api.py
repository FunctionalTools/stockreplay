import json
import csv
import hashlib
import zlib
import io
import threading
from contextlib import asynccontextmanager
from datetime import date as Date
from typing import Literal
from uuid import uuid4

from fastapi import APIRouter, HTTPException
from pydantic import Field, field_validator

from . import assistant
from .local_ai import LocalModel, ProviderChoice, Providers
from .chat_history import register_chat_history
from .market import read_csv
from .ollama_web import search_access
from .desk import Desk, INTERVALS, SCREENS, parallel, safe_url, screen
from .holdings import AccountInput, Holdings, Position, Statement
from .home import portfolio_context
from .ollama_cloud import CloudKeySettings, SearchKeySettings
from .openai_research import KeySettings, ModelLookup, OpenAIResearch
from .custom_tabs import register_tabs
from .schema import Model
from .store import now
from .market_events import register_events
from .ai_forecasts import register_forecasts
from .symbols import ticker
from .price_ranges import price_range, validate_range
from .projections import project_symbols


class Preferences(Model):
    appearance: Literal["system", "light", "dark"] | None = None
    accent: Literal["forest", "ocean", "violet", "amber"] | None = None
    advanced: bool | None = None
    home_mode: Literal["portfolio", "ticker"] | None = None
    home_symbol: str | None = None

    @field_validator("home_symbol")
    @classmethod
    def valid_ticker(cls, value):
        return ticker(value) if value is not None else None


class ListImport(Model):
    content: str = Field(min_length=1, max_length=1_000_000)


class ChartCapture(Model):
    symbols: list[str] = Field(min_length=1, max_length=4)
    span: str = Field(min_length=2, max_length=21)


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
        with db.connect() as c:
            legacy_table = c.execute("select 1 from sqlite_master where type='table' and name='openai_settings'").fetchone()
            legacy = bool(legacy_table and c.execute("select 1 from openai_settings where remember=1").fetchone())
        self.openai = OpenAIResearch(db)
        self.ai = Providers(db,self.openai,legacy)
        self.desk.web.search_access = lambda: search_access(self.ai)
        self.check_lock = threading.Lock()
        with db.connect() as c:
            c.executescript("""
              create table if not exists watchlists(id text primary key,name text not null unique);
              create table if not exists watch_members(list_id text references watchlists(id) on delete cascade,symbol text not null,primary key(list_id,symbol));
              create table if not exists price_alerts(id text primary key,symbol text not null,direction text not null,threshold real not null,created text not null,triggered text,price real,observed integer);
              create table if not exists chat_charts(id text primary key, captured text not null, payload blob not null);
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
            t.openai.close()
            t.ai.ollama_cloud.close()

    r = APIRouter(prefix="/api", lifespan=lifespan)

    register_chat_history(r, db, t.ai.reject_credentials)
    register_events(r, t.desk, ticker)
    register_forecasts(r,t)

    defaults = {
        "appearance": "system",
        "accent": "forest",
        "advanced": False,
        "home_mode": "portfolio",
        "home_symbol": "SPY",
    }

    def read_prefs(payload):
        saved = json.loads(payload) if payload else {}
        if "home_mode" not in saved:
            # Previous releases wrote NVDA even when only appearance was changed.
            if saved.get("home_symbol") in (None, "NVDA"):
                saved.pop("home_symbol", None)
            else:
                saved["home_mode"] = "ticker"
        return {**defaults, **saved}

    @r.get("/preferences")
    def prefs():
        rows = t.query("select payload from preferences where id=1")
        return read_prefs(rows[0]["payload"] if rows else None)

    @r.get("/home")
    def home():
        context = portfolio_context(t.holdings.all())
        settings = prefs()
        symbol = (
            settings["home_symbol"]
            if settings["home_mode"] == "ticker"
            else context["portfolio_symbol"] or "SPY"
        )
        return {**context, "symbol": symbol}

    @r.patch("/preferences")
    def save_prefs(item: Preferences):
        updates = item.model_dump(exclude_none=True)
        if "home_symbol" in updates:
            updates.setdefault("home_mode", "ticker")
        with db.connect() as c:
            c.execute("begin immediate")
            row = c.execute("select payload from preferences where id=1").fetchone()
            result = {**read_prefs(row[0] if row else None), **updates}
            c.execute("insert or replace into preferences values(1,?)", (json.dumps(result),))
        return result

    @r.get("/ai")
    def active_ai():
        return t.ai.active().status()

    @r.patch("/ai")
    def select_ai(choice: ProviderChoice):
        return t.ai.select(choice.provider)

    @r.get("/ai/ollama/models")
    def local_models():
        return t.ai.ollama.models()

    @r.put("/ai/ollama")
    def configure_local(item: LocalModel):
        return t.ai.configure_ollama(item.model)

    @r.get("/ai/ollama-cloud")
    def cloud_status():
        return t.ai.ollama_cloud.status()

    @r.put("/ai/ollama-cloud")
    def configure_cloud(item: CloudKeySettings):
        return t.ai.configure_hosted(t.ai.ollama_cloud,item)

    @r.post("/ai/ollama-cloud/test")
    def verify_cloud():
        return t.ai.ollama_cloud.test()

    @r.delete("/ai/ollama-cloud")
    def forget_cloud():
        return t.ai.ollama_cloud.forget()

    @r.get("/ai/ollama-cloud/models")
    def hosted_ollama_models():
        return t.ai.ollama_cloud.models()

    @r.post("/ai/ollama-cloud/models")
    def discover_hosted_ollama_models(item: ModelLookup):
        return t.ai.ollama_cloud.models(candidate=item.key)

    @r.get("/ai/ollama-search")
    def search_key_status():
        return t.ai.ollama_search.status()

    @r.put("/ai/ollama-search")
    def enable_web_search(item: SearchKeySettings):
        return t.ai.ollama_search.configure(item)

    @r.delete("/ai/ollama-search")
    def forget_search_key():
        return t.ai.ollama_search.forget()

    @r.get("/openai/models")
    def models(discover: bool = False):
        return t.openai.models(discover)

    @r.post("/openai/models")
    def lookup_models(item: ModelLookup):
        return t.openai.models(candidate=item.key)

    @r.post("/assistant/check-message")
    def check_chat_message(item: assistant.Message):
        t.ai.reject_credentials(item.text)
        return {"ok": True}

    @r.post("/assistant")
    def assistant_plan(chat: assistant.Chat):
        chat.symbol = ticker(chat.symbol)
        t.ai.reject_credentials("\n".join([chat.symbol, *(message.text for message in chat.messages)]))
        return assistant.plan(t.ai.active(), chat)

    @r.post("/assistant/research/{symbol}")
    def answer_question(symbol: str, item: assistant.Question):
        t.ai.reject_credentials(item.question)
        gateway = t.ai.active()
        symbol = ticker(symbol)
        if assistant.asks_for_sources(item.question):
            brief = t.desk.web_research(symbol, item.question)
            if not brief["evidence"] or not gateway.status()["configured"]:
                return assistant.source_reply(brief, item.question)
        else:
            credentials = gateway.credentials()
            return assistant.research_question(
                gateway, t.desk.briefing(symbol), item.question, credentials
            )
        try:
            return assistant.research_question(gateway, brief, item.question)
        except HTTPException as exc:
            if getattr(gateway, "provider", "") != "ollama_cloud" or exc.status_code not in (403, 429, 503):
                raise
            reply = assistant.source_reply(brief, item.question)
            reason = {
                403: "Ollama denied access to generation.",
                429: "Ollama generation limit reached.",
                503: "Ollama generation is busy.",
            }[exc.status_code]
            return {**reply, "text": reason + " " + reply["text"]}

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

    @r.post("/assistant/charts")
    def capture_chart(item: ChartCapture):
        symbols = list(dict.fromkeys(ticker(s) for s in item.symbols))
        parts = item.span.split("/")
        preset = "custom" if len(parts) == 2 else item.span
        start, end = validate_range(preset, *(parts if len(parts) == 2 else []))
        packets = parallel({
            s: lambda s=s: price_range(t.desk, s, preset, start, end) for s in symbols
        })
        series, errors = [], []
        for symbol, packet in packets.items():
            data = packet["data"]
            if not data or not data["bars"]:
                errors.append(f"{symbol} · {packet['error'] or 'Price history unavailable.'}")
                continue
            series.append(
                {
                    **{name: data[name] for name in ("symbol", "as_of", "currency", "url")},
                    **{name: data[name] for name in ("interval", "timezone", "performance", "price_basis") if name in data},
                    "source": data["source"] + (" (cached)" if packet["stale"] else ""),
                    "bars": [
                        {key: bar[key] for key in ("date", "time", "raw_close", "close")}
                        for bar in data["bars"]
                    ],
                }
            )
        if not series:
            raise ValueError(" ".join(errors))
        raw = json.dumps(
            {"series": series, "span": item.span, "errors": errors},
            separators=(",", ":"),
            allow_nan=False,
        ).encode()
        key = hashlib.sha256(raw).hexdigest()
        t.update(
            "insert or ignore into chat_charts values(?,?,?)",
            (key, now(), zlib.compress(raw, 3)),
        )
        return {"id": key}

    @r.get("/assistant/charts/{key}")
    def saved_chart(key: str):
        rows = t.query("select captured,payload from chat_charts where id=?", (key,))
        if not rows:
            raise KeyError("This saved chart is unavailable on this Mac.")
        return {
            "captured": rows[0]["captured"],
            **json.loads(zlib.decompress(rows[0]["payload"])),
        }

    r.add_api_route("/news/images/{key}", t.desk.photos.response, methods=["GET"])

    @r.get("/desk/chart/{symbol}")
    def chart(symbol: str, interval: str = "1d", span: str = "2y", refresh: bool = False):
        return t.desk.chart(ticker(symbol), interval, span, refresh)

    @r.get("/desk/projections")
    def projections(
        symbols: str,
        horizon: str = "1mo",
        seed: int = 42,
        refresh: bool = False,
        as_of: Date | None = None,
    ):
        return project_symbols(t.desk, symbols.split(","), horizon, seed, refresh, as_of)

    @r.get("/desk/range/{symbol}")
    def selected_range(
        symbol: str,
        range: str = "6mo",
        start: Date | None = None,
        end: Date | None = None,
        refresh: bool = False,
    ):
        return price_range(t.desk, ticker(symbol), range, start, end, refresh)

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

    @r.post("/desk/web-research/{symbol}")
    def search_public_sources(symbol: str, item: assistant.Question):
        t.ai.reject_credentials(item.question)
        return t.desk.web_research(ticker(symbol), item.question, public_topic=True)

    @r.get("/desk/brief/{symbol}")
    def brief(symbol: str, refresh: bool = False):
        return t.desk.briefing(ticker(symbol), refresh)

    @r.post("/desk/recommend/{symbol}")
    def recommend(symbol: str):
        gateway=t.ai.active()
        credentials=gateway.credentials()
        symbol = ticker(symbol)
        answer = gateway.recommend(t.desk.briefing(symbol),credentials)
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
        return t.ai.configure_hosted(t.openai,settings)

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
            (i for i, v in enumerate(head) if v in {"ticker", "symbol", "ticker symbol"}),
            None,
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

    register_tabs(r, db)
    app.include_router(r)
