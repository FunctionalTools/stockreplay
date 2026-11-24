import csv
import io
import os
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from pathlib import Path

import numpy as np
import pandas as pd
import yfinance as yf

from .symbols import NAMES
from .trading_calendar import calendar, latest_session

yf.set_tz_cache_location(
    str(Path(os.environ.get("STOCKREPLAY_HOME", ".stockreplay")) / "provider-cache")
)
COLUMNS = [
    "Open",
    "High",
    "Low",
    "Close",
    "Adj Close",
    "Volume",
    "Dividends",
    "Stock Splits",
]


class MarketError(ValueError):
    pass


def sessions(start, end):
    return calendar().sessions_in_range(pd.Timestamp(start), pd.Timestamp(end)).tz_localize(None)


def normalize(frame):
    data = frame.copy()
    if data.empty:
        raise MarketError("The dataset contains no prices.")
    if len(data) > 15000:
        raise MarketError("Import at most 15,000 daily rows per symbol.")
    data.columns = [str(c).strip().casefold().replace("_", " ") for c in data.columns]
    if "date" in data:
        data = data.set_index("date")
    try:
        data.index = pd.to_datetime(data.index, errors="raise").tz_localize(None).normalize()
    except (TypeError, ValueError) as e:
        raise MarketError("Dates must be valid daily dates in YYYY-MM-DD format.") from e
    if data.index.has_duplicates or data.index.hasnans or data.columns.has_duplicates:
        raise MarketError("Each trading date and column must appear exactly once.")
    data = data.rename(columns={c.lower(): c for c in COLUMNS})
    missing = set(COLUMNS[:6]) - set(data)
    if missing:
        raise MarketError(
            "Missing columns: " + ", ".join(sorted(missing)) + ". Supply adjusted close explicitly."
        )
    for name in COLUMNS[6:]:
        if name not in data:
            data[name] = 0.0
    data = data[COLUMNS].apply(pd.to_numeric, errors="coerce").astype(float).sort_index()
    if not np.isfinite(data.to_numpy()).all():
        raise MarketError("Prices, volume and corporate actions must contain finite numbers.")
    if (data[COLUMNS[:5]] <= 0).any().any() or (data[COLUMNS[5:]] < 0).any().any():
        raise MarketError("Prices must be positive and volume and actions must be nonnegative.")
    if (
        (data.High < data[["Open", "Close", "Low"]].max(axis=1))
        | (data.Low > data[["Open", "Close", "High"]].min(axis=1))
    ).any():
        raise MarketError("High and low prices must contain the open and close.")
    data.index.name = "Date"
    return data


def read_csv(text):
    try:
        header = next(csv.reader(io.StringIO(text)), [])
        fields = [name.strip().casefold().replace("_", " ") for name in header]
        if len(set(fields)) != len(fields):
            raise MarketError("Each CSV column must appear exactly once.")
        frame = pd.read_csv(io.StringIO(text))
        if "date" not in [str(c).strip().lower() for c in frame]:
            raise MarketError("A Date column is required.")
        column = next(c for c in frame if str(c).strip().lower() == "date")
        if not frame[column].astype(str).str.fullmatch(r"\d{4}-\d{2}-\d{2}").all():
            raise MarketError("CSV dates must use YYYY-MM-DD.")
        return normalize(frame)
    except (pd.errors.ParserError, UnicodeError) as e:
        raise MarketError("Could not parse a daily OHLCV CSV file.") from e


def store_frame(db, ticker, source, frame):
    return db.put_frame(
        ticker,
        source,
        frame.to_csv(lineterminator="\n", date_format="%Y-%m-%d"),
        frame.index.strftime("%Y-%m-%d").tolist(),
    )


def yahoo(ticker, start, end):
    try:
        options = {}
        if hasattr(yf, "config") and hasattr(yf.config, "debug"):
            yf.config.debug.hide_exceptions = False
        else:
            options["raise_errors"] = True
        frame = yf.Ticker(ticker).history(
            start=str(start),
            end=str(end + timedelta(days=1)),
            interval="1d",
            auto_adjust=False,
            actions=True,
            timeout=18,
            **options,
        )
        return normalize(frame)
    except Exception as e:
        message = str(e)[:240]
        raise MarketError(
            f"Yahoo Finance could not supply {ticker} ({message}). Retry later, select a cached range, or import CSV data."
        ) from e


def require_sessions(frame, expected, ticker):
    missing = expected.difference(frame.index)
    if len(missing):
        dates = ", ".join(missing[:4].strftime("%Y-%m-%d"))
        raise MarketError(
            f"{ticker} is missing {len(missing)} required US trading sessions, including {dates}. Narrow the range or repair the data."
        )


def load_one(db, config, ticker, expected, pin=None, refresh=False):
    first, last = [x.date().isoformat() for x in [expected[0], expected[-1]]]
    key = pin or (None if refresh else db.find(ticker, config.source, first, last))
    if not key:
        if config.source == "csv":
            raise MarketError(f"Import a CSV for {ticker} covering {first} through {last}.")
        else:
            frame = yahoo(ticker, config.start, config.end)
        require_sessions(frame, expected, ticker)
        key = store_frame(db, ticker, config.source, frame)
    meta, csv = db.snapshot(key)
    if meta["source"] != config.source or meta["ticker"] != ticker:
        raise MarketError("A pinned snapshot has the wrong symbol or data source.")
    frame = read_csv(csv)
    require_sessions(frame, expected, ticker)
    return ticker, frame.loc[expected], meta


def load_market(db, config, pins=None, refresh=False):
    expected = sessions(config.start, config.end)
    if not len(expected):
        raise MarketError("The range contains no trading sessions.")
    if config.source == "demo" and not pins:
        raise MarketError("Legacy synthetic experiments require their original pinned snapshots.")
    if config.source == "yahoo" and expected[-1].date() > latest_session():
        raise MarketError("Choose an end date through the latest completed US trading session.")
    if pins is not None and set(pins) != set(config.symbols()):
        raise MarketError("Pinned snapshots must match all required symbols.")

    def get(symbol):
        return load_one(db, config, symbol, expected, (pins or {}).get(symbol), refresh)

    # Limit provider traffic. Yahoo is fetched sequentially to respect shared rate limits.
    if config.source == "yahoo":
        results = [get(t) for t in config.symbols()]
    else:
        with ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(get, config.symbols()))
    return {t: f for t, f, _ in results}, {t: m for t, _, m in results}


def adjusted(frame):
    factor = frame["Adj Close"] / frame.Close
    result = frame.copy()
    for col in ["Open", "High", "Low", "Close"]:
        result[col] = frame[col] * factor
    result["Close"] = frame["Adj Close"]
    return result


def search_symbols(query, online=False):
    q = query.strip().upper()
    hits = {s: n for s, n in NAMES.items() if q in s or q in n.upper()}
    if online and q:
        try:
            for item in yf.Search(q, max_results=8, timeout=6).quotes:
                if item.get("quoteType") in {"ETF", "EQUITY"}:
                    hits[item["symbol"]] = item.get("shortname") or item["symbol"]
        except Exception as e:
            if not hits:
                raise MarketError(
                    "Online symbol search is unavailable. Enter an exchange symbol directly."
                ) from e
    return [{"symbol": s, "name": n} for s, n in list(hits.items())[:12]]
