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
import pandas as pd

from .desk import parallel
from .price_ranges import RANGE_PRESETS, US_EQUITY_EXCHANGES, validate_range
from .price_scenario import MIN_RETURNS, scenario
from .symbols import ticker

HORIZONS = {
    "1d": None,
    "1w": pd.DateOffset(weeks=1),
    "1mo": pd.DateOffset(months=1),
    "6mo": pd.DateOffset(months=6),
    "1y": pd.DateOffset(years=1),
    "5y": pd.DateOffset(years=5),
}
MODEL = "conditional-history-v2"
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
        if bar.get("partial") or bar.get("provisional") or bar.get("complete") is False:
            continue
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


def regular_quote(packet, daily, calendar, zone, instant, confirmed):
    series = packet.get("data") or {}
    if series.get("currency") != daily.get("currency") or series.get("symbol") != daily.get(
        "symbol"
    ):
        return None
    if series.get("timezone") != daily.get("timezone"):
        return None
    for bar in reversed(series.get("bars", [])):
        day, ts, price = bar.get("date"), bar.get("time"), bar.get("raw_close")
        if (
            not day
            or day <= confirmed
            or not isinstance(ts, (int, float))
            or not math.isfinite(ts)
            or ts > instant.timestamp()
        ):
            continue
        if not isinstance(price, (int, float)) or not math.isfinite(price) or price <= 0:
            continue
        stamp = datetime.fromtimestamp(ts, zone)
        if stamp.date().isoformat() != day or not calendar.is_session(day):
            continue
        if calendar.session_open(day).timestamp() <= ts < calendar.session_close(day).timestamp():
            return {"date": day, "price": price, "time": stamp.isoformat(), "kind": "intraday"}
    return None


def project_one(
    data,
    symbol,
    horizon,
    seed,
    instant,
    cutoff,
    *,
    start_date=None,
    end_date=None,
    intraday_loader=None,
    daily_fetched=None,
    full_path=False,
):
    name = venue(data)
    zone = data.get("timezone") or ("UTC" if name == "24/7" else "")
    try:
        exchange_zone = ZoneInfo(zone)
        local_today = instant.astimezone(exchange_zone).date()
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
    cal = exchange_calendar(name, day.year - 6, (target + timedelta(days=14)).date().isoformat())
    expected = latest_session(cal, day, instant)
    sessions = cal.sessions_in_range(expected - pd.DateOffset(years=5), expected)
    closes = observed_closes(data["bars"], sessions)
    # A cached in-progress daily candle cannot turn into an official close simply
    # because time passed since it was downloaded.
    fetched = pd.Timestamp(daily_fetched) if daily_fetched else None
    if fetched is not None and fetched.tz is not None and fetched < cal.session_close(expected):
        last_publishable = latest_session(cal, fetched.tz_convert(exchange_zone).date(), fetched)
        closes = tuple(p if d <= last_publishable else None for d, p in zip(sessions, closes))
    last_index = next((i for i in range(len(closes) - 1, -1, -1) if closes[i] is not None), None)
    if last_index is None:
        raise ValueError(
            "No published completed close was available within the five-year calibration window."
        )
    gap = len(sessions) - last_index - 1
    if cutoff and gap:
        # An explicit as-of replay must use precisely the chosen historical session.
        raise MissingClose(
            f"No published close was available for the requested replay session {expected.date()}."
        )
    sessions, closes = sessions[: last_index + 1], closes[: last_index + 1]
    confirmed = sessions[-1].date().isoformat()
    trading = cal.is_session(day) and cal.session_open(day) <= pd.Timestamp(
        instant
    ) < cal.session_close(day)
    minutes = intraday_loader() if intraday_loader and not cutoff and (gap or trading) else {}
    partial = regular_quote(minutes, data, cal, exchange_zone, instant, confirmed)
    notes = []
    # A cached close fetched before an independently reported split still uses the old
    # share basis. Express that old price on the new share basis exactly once.
    actions = {
        a["date"]: a["ratio"]
        for source in (data, minutes.get("data") or {})
        for a in source.get("splits", [])
        if isinstance(a.get("ratio"), (float, int))
        and a["ratio"] > 0
        and confirmed < a["date"] <= day.isoformat()
        and cal.is_session(a["date"])
    }
    unresolved = False
    for split, ratio in sorted(actions.items()):
        try:
            if fetched is None or fetched.tz is None:
                unresolved = True
            elif fetched < cal.session_open(split) <= pd.Timestamp(instant):
                closes = tuple(p / ratio if p is not None else None for p in closes)
                notes.append(
                    f"Earlier cached prices reflect the published {ratio:g}-for-1 split on {split}."
                )
        except (TypeError, ValueError):
            unresolved = True
    if partial and any(
        partial["date"] < d and cal.session_open(d) <= pd.Timestamp(instant) for d in actions
    ):
        # Minute history obtained before a split need not use today's share basis.
        # Prefer the verified basis of the dated daily close in this case.
        partial = None
    if unresolved and not partial:
        raise ValueError(
            "A split occurred after the last published close. An updated share price is needed."
        )
    spot = partial or {
        "date": confirmed,
        "price": closes[-1],
        "time": None,
        "kind": "confirmed_close",
    }
    anchor = pd.Timestamp(spot["date"])
    # The selected horizon is upcoming even if the provider missed one or more
    # completed sessions. Simulate uncertainty across the gap, never output it as
    # observed prices or count it as one one-day historical return.
    origin = max(expected, anchor)
    first = cal.next_session(origin)
    if horizon == "1d":
        last_session = first
        civil_end = first.date()
    elif horizon == "5d":
        last_session = cal.sessions_window(first, 5)[-1]
        civil_end = last_session.date()
    else:
        if horizon == "custom" and start_date <= origin.date():
            raise ValueError(f"Choose custom dates after {origin.date()}.")
        end = target if horizon == "ytd" else horizon_end(origin.date(), horizon, end_date)
        civil_end = end.date()
        if end < first:
            raise ValueError("The selected horizon contains no scheduled future session.")
        last_session = cal.date_to_session(end, direction="previous")
    future = cal.sessions_in_range(cal.next_session(anchor), last_session)
    if not len(future):
        raise ValueError("The selected horizon contains no scheduled future session.")
    observations = [
        {"date": s.date().isoformat(), "price": v}
        for s, v in zip(sessions, closes)
        if v is not None
    ]
    lookback = cal.sessions_in_range(
        expected - pd.DateOffset(years=1) + timedelta(days=1), expected
    )
    bands, volatility, model_inputs, validation, validation_month, validation_year = scenario(
        closes, len(future), len(lookback)
    )
    reference = model_inputs["kind"] == "last_price_reference"
    if reference:
        notes.append("Last-price reference. " + model_inputs["reference_reason"])
    scale = spot["price"] / closes[-1]
    points = [
        {
            "date": spot["date"],
            "low": spot["price"],
            "prediction": spot["price"],
            "median": spot["price"],
            "high": spot["price"],
        }
    ]
    earliest = max(first.date(), start_date or first.date())
    points.extend(
        {
            "date": s.date().isoformat(),
            "low": float(lo * scale),
            "prediction": float(med * scale),
            "median": float(med * scale),
            "high": float(hi * scale),
        }
        for s, (lo, med, hi) in zip(future, bands)
        if full_path or s.date() >= earliest
    )
    if last_session.date() < earliest or len(points) == 1:
        raise ValueError("The custom dates contain no scheduled trading session.")
    # If the daily cache predates a newer quote and there is no common session to
    # corroborate its share scale, keep those historical prices out of the visual
    # lead-in. Daily percentage returns remain valid for calibration.
    older_snapshot = (
        partial
        and gap
        and fetched is not None
        and fetched.tz is not None
        and fetched < cal.session_open(anchor)
    )
    if older_snapshot and not actions:
        recent = {o["date"]: o["price"] for o in observations[-63:]}
        matching_basis = False
        for bar in reversed((minutes.get("data") or {}).get("bars", [])):
            d, p, ts = bar.get("date"), bar.get("raw_close"), bar.get("time")
            if (
                d not in recent
                or not isinstance(p, (float, int))
                or not isinstance(ts, (float, int))
            ):
                continue
            seconds_to_close = cal.session_close(d).timestamp() - ts
            if 0 <= seconds_to_close <= 300 and abs(p / recent[d] - 1) < 0.02:
                matching_basis = True
                break
        unresolved = unresolved or not matching_basis
    history = observations[-63:]
    if unresolved:
        history = []
        notes.append(
            "Earlier share prices are omitted from the chart because their split basis is unverified."
        )
    if partial:
        history = (history + [partial])[-63:]
        notes.append(
            f"The anchor is the regular-session five-minute bar beginning {partial['time']}. The last confirmed daily close is {confirmed}."
        )
    if gap:
        notes.append(
            f"The latest expected completed session is {expected.date()}. Published daily history ends {confirmed}, {gap} trading session{'s' if gap != 1 else ''} earlier."
        )
    as_of = spot["date"]
    digest = hashlib.sha256(
        "|".join(row["date"] + "=" + float.hex(row["price"]) for row in observations).encode()
    ).hexdigest()
    if partial:
        digest = hashlib.sha256(
            (digest + partial["time"] + float.hex(float(partial["price"]))).encode()
        ).hexdigest()
    anchor_source = data
    if partial:
        anchor_source = minutes["data"]
    else:
        confirmed_bar = next(
            (b for b in reversed(data["bars"]) if b["date"] == confirmed and b.get("source")), None
        )
        anchor_source = confirmed_bar or data
    return {
        "symbol": symbol,
        "source": data["source"],
        "url": data.get("url"),
        "currency": data.get("currency"),
        "timezone": zone,
        "calendar": name,
        "as_of": as_of,
        "history": history,
        "price_sources": data.get("price_sources")
        or [{"source": data["source"], "url": data.get("url")}],
        "anchor_source": anchor_source.get("source") or data["source"],
        "anchor_url": anchor_source.get("url") or data.get("url"),
        "expected_session": expected.date().isoformat(),
        "confirmed_close_date": confirmed,
        "confirmed_close": closes[-1],
        "anchor_kind": spot["kind"],
        "anchor_time": spot["time"],
        "horizon_origin": origin.date().isoformat(),
        "projected_sessions": len(future),
        "requested_start": (start_date or first.date()).isoformat(),
        "requested_end": civil_end.isoformat(),
        "data_note": " ".join(notes) or None,
        "stale": bool(gap or (partial and minutes.get("stale"))),
        "anchor_fetched": minutes.get("fetched") if partial else daily_fetched,
        "points": points,
        "coverage": {
            "start": observations[0]["date"],
            "end": confirmed,
            "observations": len(observations),
            "returns": sum(a is not None and b is not None for a, b in pairwise(closes)),
        },
        "annualized_volatility_pct": volatility,
        "annualization_sessions": len(lookback),
        "validation_1d": validation,
        "validation_21d": validation_month,
        "validation_252d": validation_year,
        "model_inputs": model_inputs,
        "method": "Last-price reference"
        if reference
        else "Comparable historical trading conditions",
        "model_version": MODEL,
        "data_digest": digest,
        "assumptions": [
            "Prices begin at the dated observed anchor. Historical calibration uses confirmed daily share prices without dividend reinvestment.",
            "The path carries the dated anchor forward when history is insufficient to fit trading conditions."
            if reference
            else "The path weights non-overlapping follow-on price changes after similar momentum, volatility and drawdowns. Fewer or poorer matches pull the estimate toward the dated anchor.",
            "The model limits individual historical moves to the central 95% of observed daily returns before volatility adjustment. After the last supported horizon the price path stays level.",
            "Walk-forward checks compare absolute price errors against an unchanged close. Each horizon uses non-overlapping outcomes, including 21- and 252-session checks when observations permit.",
            "This models quoted share prices. Cash distributions, dividend reinvestment and future corporate actions are excluded. Historical dispersion does not establish a future probability.",
        ],
    }


def load_projection(
    desk,
    symbol,
    horizon,
    seed,
    instant,
    *,
    as_of=None,
    start=None,
    end=None,
    refresh=False,
    full_path=False,
):
    if as_of:
        packet = desk.date_chart(
            symbol, (pd.Timestamp(as_of) - pd.DateOffset(years=5, months=1)).date(), as_of, refresh
        )
    else:
        packet = desk.chart(symbol, "1d", "10y", refresh)
        data = packet.get("data") or {}
        if packet.get("stale") or len(data.get("bars", [])) <= MIN_RETURNS:
            # Other Research views may already have real daily history on this Mac.
            cache = getattr(desk, "cache", None)
            candidates = [
                p
                for span in ("5y", "2y", "1y", "6mo")
                if cache
                and (p := cache.read(f"bars:{symbol}:1d:{span}"))
                and p.get("data")
                and p["data"].get("bars")
            ]

            def last_day(item):
                bars = (item.get("data") or {}).get("bars", [])
                return max((b["date"] for b in bars if b.get("raw_close")), default="")

            if candidates:
                alternative = max(candidates, key=lambda p: (last_day(p), len(p["data"]["bars"])))
                if (last_day(alternative), len(alternative["data"]["bars"])) > (
                    last_day(packet),
                    len(data.get("bars", [])),
                ):
                    packet = {**alternative, "stale": True}
            elif not data:
                packet = desk.chart(symbol, "1d", "2y", refresh)
    if not packet.get("data"):
        raise ValueError(packet.get("error") or "No published daily prices available.")
    result = project_one(
        packet["data"],
        symbol,
        horizon,
        seed,
        instant,
        as_of,
        start_date=start,
        end_date=end,
        daily_fetched=packet.get("fetched"),
        full_path=full_path,
        intraday_loader=lambda: desk.chart(symbol, "5m", "5d", refresh),
    )
    if packet.get("stale"):
        cached = (
            f"Using cached daily history retrieved {packet['fetched']}."
            if packet.get("fetched")
            else "Using locally cached daily history."
        )
        result["data_note"] = " ".join(x for x in (result.get("data_note"), cached) if x)
    return {
        **result,
        "fetched": packet.get("fetched"),
        "stale": bool(result["stale"] or packet.get("stale")),
    }


def project_symbols(
    desk, symbols, horizon, seed=42, refresh=False, as_of: date | None = None, start=None, end=None
):
    symbols = list(dict.fromkeys(s.strip().upper() for s in symbols))
    if not 1 <= len(symbols) <= 8:
        raise ValueError("Choose between one and eight symbols.")
    if horizon not in RANGE_PRESETS:
        raise ValueError("Choose a supported projection horizon.")
    start, end = validate_range(horizon, start, end)
    if not isinstance(seed, int) or not 0 <= seed <= 2147483647:
        raise ValueError("Choose a seed between 0 and 2147483647.")
    instant = datetime.now(UTC)
    if as_of and as_of > instant.date() + timedelta(days=1):
        raise ValueError("Choose an observation date that has already occurred.")

    def one(symbol):
        try:
            return load_projection(
                desk,
                ticker(symbol),
                horizon,
                seed,
                instant,
                as_of=as_of,
                start=start,
                end=end,
                refresh=refresh,
            )
        except (ValueError, KeyError, OverflowError, xc.errors.CalendarError) as exc:
            return {"symbol": symbol, "error": str(exc)}

    rows = parallel({s: lambda s=s: one(s) for s in symbols}).values()
    return {
        "horizon": horizon,
        "seed": seed,
        "series": [r for r in rows if "error" not in r],
        "errors": [r for r in rows if "error" in r],
    }
