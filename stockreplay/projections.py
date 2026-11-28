"""Reproducible, exchange-dated price scenarios from observed daily closes."""

from __future__ import annotations

import hashlib
import math
import threading
from datetime import UTC, date, datetime, timedelta
from functools import lru_cache
from itertools import pairwise
from zoneinfo import ZoneInfo

import exchange_calendars as xc
import numpy as np
import pandas as pd

from .desk import parallel
from .price_ranges import US_EQUITY_EXCHANGES
from .symbols import ticker

HORIZONS = {
    "1d": None,
    "1w": pd.DateOffset(weeks=1),
    "1mo": pd.DateOffset(months=1),
    "6mo": pd.DateOffset(months=6),
    "1y": pd.DateOffset(years=1),
    "5y": pd.DateOffset(years=5),
}
MODEL = "historical-blocks-v1"
PATHS = 1024
BLOCK = 5
MIN_RETURNS = 63
# Yahoo exchange identifiers. Use a named venue calendar when the provider identifies one.
VENUES = {
    "LSE": "XLON",
    "JPX": "XTKS",
    "TOR": "XTSE",
    "HKG": "XHKG",
    "ASX": "XASX",
    "GER": "XETR",
    "PAR": "XPAR",
    "AMS": "XAMS",
    "BRU": "XBRU",
    "EBS": "XSWX",
    "MIL": "XMIL",
    "STO": "XSTO",
    "OSL": "XOSL",
    "CPH": "XCSE",
    "HEL": "XHEL",
    "SES": "XSES",
    "SHH": "XSHG",
    "KSC": "XKRX",
    "TAI": "XTAI",
}
_calendar_lock = threading.Lock()


class MissingClose(ValueError):
    """A previously cached history can span a market close."""


def venue(data):
    if data.get("exchange") in US_EQUITY_EXCHANGES:
        return "XNYS"
    if data.get("instrument_type") == "CRYPTOCURRENCY":
        return "24/7"
    name = VENUES.get(data.get("exchange"))
    if not name:
        raise ValueError("A verified trading calendar is unavailable for this instrument.")
    return name


@lru_cache(maxsize=32)
def exchange_calendar(name, first_year, end):
    # The exchange-calendars registry updates its internal cache when its bounds change.
    with _calendar_lock:
        try:
            return xc.get_calendar(name, start=f"{first_year}-01-01", end=end)
        except (TypeError, ValueError, KeyError, xc.errors.CalendarError) as exc:
            raise ValueError("Published exchange sessions do not cover this horizon.") from exc


def latest_session(cal, day, instant):
    session = cal.date_to_session(day, direction="previous")
    if cal.session_close(session) > pd.Timestamp(instant):
        session = cal.previous_session(session)
    return session


def observed_closes(bars, sessions):
    by_date = {}
    first, last = sessions[0].date().isoformat(), sessions[-1].date().isoformat()
    for bar in bars:
        day = bar.get("date")
        price = bar.get("raw_close")
        if (
            isinstance(day, str)
            and first <= day <= last
            and isinstance(price, (int, float))
            and math.isfinite(price)
            and price > 0
        ):
            by_date[day] = float(price)
    return tuple(by_date.get(s.date().isoformat()) for s in sessions)


def calibration(returns):
    finite = returns[np.isfinite(returns)]
    if finite.size < MIN_RETURNS:
        raise ValueError("At least 63 observed consecutive-session price changes are needed.")
    blocks = np.lib.stride_tricks.sliding_window_view(returns, BLOCK)
    blocks = blocks[np.isfinite(blocks).all(axis=1)]
    if len(blocks) < 30:
        raise ValueError("Too few complete five-session blocks of observed prices are available.")
    # Center each block position to remove the long-run sample drift without erasing
    # observed cross-day dependence. Apply recent volatility, with a bounded ratio.
    recent = finite[-63:]
    recent_std = np.std(recent, ddof=1)
    full_std = np.std(finite, ddof=1)
    if full_std <= np.finfo(float).eps:
        raise ValueError("Observed price changes have too little variation to estimate a range.")
    scale = np.clip(recent_std / full_std, 0.5, 2.0)
    shocks = (blocks - blocks.mean(axis=0)) * scale
    drift = np.clip(0.25 * recent.mean(), -0.0015, 0.0015)
    return shocks, float(drift), float(recent_std)


def check_one_session(returns):
    # Expanding-window checks use only observations known before each test close.
    tested = covered = 0
    for index in range(max(MIN_RETURNS, len(returns) - 63), len(returns)):
        if not np.isfinite(returns[index]):
            continue
        try:
            shocks, drift, _ = calibration(returns[:index])
        except ValueError:
            continue
        lo, hi = np.quantile(shocks[:, 0] + drift, [0.1, 0.9])
        tested += 1
        covered += int(lo <= returns[index] <= hi)
    return {
        "tested_sessions": tested,
        "inside_band_sessions": covered,
        "observed_coverage_pct": 100 * covered / tested if tested else None,
    }


@lru_cache(maxsize=32)
def simulate(symbol, seed, as_of, closes, steps, sessions_per_year):
    values = np.asarray(closes, dtype=float)
    returns = np.diff(np.log(values))
    shocks, initial_drift, recent_std = calibration(returns)
    rng_key = hashlib.sha256(f"{MODEL}|{symbol}|{seed}|{as_of}".encode()).digest()
    rng = np.random.default_rng(int.from_bytes(rng_key[:16], "big"))
    # Block-major sampling makes overlapping forecast dates reproducible across horizons.
    picks = rng.integers(len(shocks), size=(math.ceil(steps / BLOCK), PATHS))
    increments = shocks[picks].transpose(0, 2, 1).reshape(-1, PATHS)[:steps]
    drift = initial_drift * np.exp2(-np.arange(steps) / 20)
    cumulative = np.cumsum(increments + drift[:, None], axis=0)
    with np.errstate(over="ignore", under="ignore"):
        bands = values[-1] * np.exp(np.quantile(cumulative, [0.1, 0.5, 0.9], axis=1).T)
    if not np.isfinite(bands).all() or (bands <= 0).any():
        raise ValueError("The observed price swings are too large to estimate this horizon.")
    return bands, float(100 * recent_std * np.sqrt(sessions_per_year)), check_one_session(returns)


def horizon_end(day, horizon, custom_end):
    if horizon == "custom":
        if not custom_end or custom_end > (pd.Timestamp(day) + pd.DateOffset(years=10)).date():
            raise ValueError("Choose a future end date within ten years of the anchor.")
        return pd.Timestamp(custom_end)
    if horizon == "ytd":
        return pd.Timestamp(date(day.year, 12, 31))
    additional = {
        "5d": pd.DateOffset(days=14),
        "3mo": pd.DateOffset(months=3),
        "2y": pd.DateOffset(years=2),
        "10y": pd.DateOffset(years=10),
        "max": pd.DateOffset(years=10),
    }
    return pd.Timestamp(day) + (
        additional.get(horizon) or HORIZONS[horizon] or pd.DateOffset(days=1)
    )


def project_one(data, symbol, horizon, seed, instant, cutoff, *, start_date=None, end_date=None):
    name = venue(data)
    zone = data.get("timezone") or ("UTC" if name == "24/7" else "")
    try:
        local_today = instant.astimezone(ZoneInfo(zone)).date()
    except (ValueError, KeyError):
        raise ValueError("The exchange time zone is unavailable.") from None
    day = cutoff or local_today
    if day > local_today:
        raise ValueError("Choose an observation date that has already occurred on this exchange.")
    if horizon == "custom" and (not start_date or not end_date or end_date < start_date):
        raise ValueError("Choose ordered start and end dates.")
    if horizon == "custom" and end_date < day - timedelta(days=31):
        raise ValueError("Choose custom dates after the latest completed close.")
    target = horizon_end(day, horizon, end_date)
    cal = exchange_calendar(name, day.year - 6, (target + timedelta(days=10)).date().isoformat())
    anchor = latest_session(cal, day, instant)
    as_of = anchor.date().isoformat()
    start = anchor - pd.DateOffset(years=5)
    sessions = cal.sessions_in_range(start, anchor)
    closes = observed_closes(data["bars"], sessions)
    if closes[-1] is None:
        raise MissingClose(
            f"The latest completed close on {as_of} is missing from the price source."
        )
    first = cal.next_session(anchor)
    if horizon == "1d":
        future = pd.DatetimeIndex([first])
    elif horizon == "5d":
        future = cal.sessions_window(first, 5)
    else:
        if horizon == "custom" and start_date <= anchor.date():
            raise ValueError("Choose custom dates after the latest completed close.")
        end = target if horizon in {"ytd", "custom"} else horizon_end(anchor.date(), horizon, None)
        future = cal.sessions_in_range(first, end) if end >= first else []
        if horizon == "custom" and not any(s.date() >= start_date for s in future):
            raise ValueError("The custom dates contain no scheduled trading session.")
    if not len(future):
        raise ValueError("The selected horizon contains no scheduled future session.")
    observations = [
        {"date": s.date().isoformat(), "price": v}
        for s, v in zip(sessions, closes)
        if v is not None
    ]
    lookback = cal.sessions_in_range(anchor - pd.DateOffset(years=1) + timedelta(days=1), anchor)
    bands, volatility, validation = simulate(
        symbol, seed, as_of, closes, len(future), len(lookback)
    )
    last = closes[-1]
    points = [{"date": as_of, "low": last, "median": last, "high": last}]
    points.extend(
        {
            "date": s.date().isoformat(),
            "low": float(low),
            "median": float(median),
            "high": float(high),
        }
        for s, (low, median, high) in zip(future, bands)
    )
    digest = hashlib.sha256(
        "|".join(row["date"] + "=" + float.hex(row["price"]) for row in observations).encode()
    ).hexdigest()
    return {
        "symbol": symbol,
        "source": data["source"],
        "url": data.get("url"),
        "currency": data.get("currency"),
        "timezone": zone,
        "calendar": name,
        "as_of": as_of,
        "history": observations[-63:],
        "points": points,
        "coverage": {
            "start": observations[0]["date"],
            "end": as_of,
            "observations": len(observations),
            "returns": sum(a is not None and b is not None for a, b in pairwise(closes)),
        },
        "annualized_volatility_pct": volatility,
        "annualization_sessions": len(lookback),
        "validation_1d": validation,
        "method": "Historical five-session block simulation",
        "model_version": MODEL,
        "data_digest": digest,
        "assumptions": [
            "Prices begin at the last completed close. History uses reported share prices without dividend reinvestment.",
            "1,024 scenarios resample consecutive five-session blocks. The band shows the 10th and 90th percentiles of those scenarios.",
            "The last 63 price changes set recent volatility. The simulation limits its scaling to half or twice the historical level.",
            "One quarter of the recent daily trend, capped at ±0.15% per session, fades by half every 20 sessions.",
            "Future splits, distributions and unexpected events can move the quoted price outside the band.",
        ],
    }


def project_symbols(desk, symbols, horizon, seed=42, refresh=False, as_of: date | None = None):
    symbols = list(dict.fromkeys(s.strip().upper() for s in symbols))
    if not 1 <= len(symbols) <= 8:
        raise ValueError("Choose between one and eight symbols.")
    if horizon not in HORIZONS:
        raise ValueError("Choose a supported projection horizon.")
    if not isinstance(seed, int) or not 0 <= seed <= 2147483647:
        raise ValueError("Choose a seed between 0 and 2147483647.")
    instant = datetime.now(UTC)
    if as_of and as_of > instant.date() + timedelta(days=1):
        raise ValueError("Choose an observation date that has already occurred.")

    def read(symbol, force):
        if as_of:
            return desk.date_chart(
                symbol,
                (pd.Timestamp(as_of) - pd.DateOffset(years=5, months=1)).date(),
                as_of,
                force,
            )
        # Both live and dated requests must contain the full five-year session window,
        # including when the wall-clock day and the last session fall on different dates.
        return desk.chart(symbol, "1d", "10y", force)

    def one(symbol):
        try:
            ticker(symbol)
            packet = read(symbol, refresh)
            if not packet.get("data"):
                raise ValueError(packet.get("error") or "No published daily prices available.")
            try:
                result = project_one(packet["data"], symbol, horizon, seed, instant, as_of)
            except MissingClose:
                if refresh or as_of or packet.get("stale"):
                    raise
                packet = read(symbol, True)
                if not packet.get("data"):
                    raise ValueError(packet.get("error") or "The latest close is unavailable.")
                result = project_one(packet["data"], symbol, horizon, seed, instant, as_of)
            return {**result, "fetched": packet.get("fetched"), "stale": bool(packet.get("stale"))}
        except (ValueError, KeyError, OverflowError, xc.errors.CalendarError) as exc:
            return {"symbol": symbol, "error": str(exc)}

    rows = parallel({s: lambda s=s: one(s) for s in symbols}).values()
    return {
        "horizon": horizon,
        "seed": seed,
        "series": [r for r in rows if "error" not in r],
        "errors": [r for r in rows if "error" in r],
    }
