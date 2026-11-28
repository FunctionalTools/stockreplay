"""User-facing price ranges. All graph points and return baselines are observed market bars."""

from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import pandas as pd

from .trading_calendar import calendar

RANGE_PRESETS = (
    "1d",
    "5d",
    "1w",
    "1mo",
    "3mo",
    "6mo",
    "ytd",
    "1y",
    "2y",
    "5y",
    "10y",
    "max",
    "custom",
)


def week_start(last_day):
    """Calendar-week boundary for a window ending at the last observed close."""
    return (date.fromisoformat(last_day) - timedelta(weeks=1)).isoformat()


def validate_range(preset, start=None, end=None):
    if preset not in RANGE_PRESETS:
        raise ValueError("Choose a supported price range.")
    if preset != "custom":
        if start is not None or end is not None:
            raise ValueError("Use Custom to enter a start and end date.")
        return None, None
    try:
        first = date.fromisoformat(str(start))
        last = date.fromisoformat(str(end))
    except ValueError:
        raise ValueError("Choose a start and end date for the chart.") from None
    if last < first:
        raise ValueError("The end date must be on or after the start date.")
    return first, last


US_EQUITY_EXCHANGES = {
    "NMS",
    "NYQ",
    "NGM",
    "NCM",
    "PCX",
    "ASE",
    "BTS",
    "PNK",
}


def us_equity(series):
    return series.get("exchange") in US_EQUITY_EXCHANGES or (
        series.get("timezone") == "America/New_York"
        and series.get("instrument_type") in (None, "EQUITY", "ETF", "INDEX", "MUTUALFUND")
    )


def point(bar, key):
    return {"date": bar["date"], "time": bar["time"], "price": bar[key]}


def regular_intraday(bars, american, now):
    days = {}
    result = []
    for bar in bars:
        if bar["time"] > now.timestamp():
            continue
        if american:
            d = bar["date"]
            if d not in days:
                cal = calendar()
                days[d] = (
                    (cal.session_open(d).timestamp(), cal.session_close(d).timestamp())
                    if cal.is_session(d)
                    else None
                )
            hours = days[d]
            if not hours or not hours[0] <= bar["time"] < hours[1]:
                continue
        result.append(bar)
    return result


def price_range(desk, symbol, preset, start=None, end=None, refresh=False):
    start, end = validate_range(preset, start, end)
    instant = datetime.now(timezone.utc)
    intraday = preset in {"1d", "5d"}
    interval = "5m" if intraday else "1d"
    if preset == "custom":
        # The provider's end boundary is exclusive. Preserve the requested inclusive
        # dates separately, and never request nonexistent future price history.
        ceiling = instant.date() + timedelta(days=1)
        if start > ceiling:
            raise ValueError("The selected dates are in the future.")
        packet = desk.date_chart(symbol, start, min(end, ceiling), refresh)
    else:
        period = "5d" if intraday else "2y" if preset == "ytd" else preset
        packet = desk.chart(symbol, interval, period, refresh)
    series = packet.get("data")
    if not series:
        return packet
    try:
        zone = ZoneInfo(series.get("timezone") or "UTC")
    except (ValueError, ZoneInfoNotFoundError):
        zone = timezone.utc
    today = instant.astimezone(zone).date()
    full = series["bars"]
    source = regular_intraday(full, us_equity(series), instant) if intraday else full
    requested_end = (end or today).isoformat()
    start_day = None
    previous = None
    if intraday:
        available = sorted({b["date"] for b in source})
        if available:
            start_day = available[-1 if preset == "1d" else -min(len(available), 5)]
    elif preset == "custom":
        start_day = start.isoformat()
    elif preset == "1w":
        start_day = week_start(source[-1]["date"]) if source else None
    elif preset == "ytd":
        start_day = f"{today.year}-01-01"
        previous = next(
            (b for b in reversed(full) if b["date"].startswith(str(today.year - 1) + "-")), None
        )
    elif preset != "max":
        offset = (
            pd.DateOffset(months=int(preset[:-2]))
            if preset.endswith("mo")
            else pd.DateOffset(years=int(preset[:-1]))
        )
        start_day = (pd.Timestamp(today) - offset).date().isoformat()
    bars = [
        b
        for b in source
        if (not start_day or b["date"] >= start_day)
        and b["date"] <= min(today.isoformat(), requested_end)
    ]
    if not bars:
        return {
            **packet,
            "data": None,
            "error": "No trading observations were available for these dates.",
        }
    # Earlier cached packets do not establish whether adjusted prices were supplied.
    nominal = intraday or series.get("adjusted") is not True
    if nominal:
        bars = [{**b, "close": b["raw_close"]} for b in bars]
    key = "raw_close" if nominal else "close"
    baseline = point(bars[0], key)
    basis = "first_observation"
    note = (
        "First to last five-minute closing price. Times mark the start of each bar. Dividends are excluded."
        if intraday
        else "First to last closing price, adjusted for splits and distributions."
        if not nominal
        else "Change between the first and last reported closes. Adjusted prices are unavailable."
    )
    if preset == "1w":
        note += " Daily closes over one calendar week ending at the last observation."
    if preset == "5d":
        sessions = len({b["date"] for b in bars})
        note += f" {sessions} observed trading session{'s' if sessions != 1 else ''}."
    if preset == "1d":
        basis = "previous_close"
        day = bars[-1]["date"]
        reference = desk.chart(symbol, "1d", "1mo", refresh)
        reference_series = reference.get("data") or {}
        if us_equity(series):
            prior_day = calendar().previous_session(day).date().isoformat()
        else:
            prior_day = max((b["date"] for b in source if b["date"] < day), default=None)
        previous = next(
            (b for b in reversed(reference_series.get("bars", [])) if b["date"] == prior_day),
            None,
        )
        comparable = previous is not None and series.get("currency") == reference_series.get(
            "currency"
        )
        baseline = point(previous, "raw_close") if comparable else None
        note = "Previous session’s close to the latest regular-session price. Times mark the start of each five-minute bar. Dividends are excluded."
        if baseline is None:
            note = "The previous session’s comparable close is unavailable."
    if preset == "ytd":
        if previous and us_equity(series):
            expected = (
                calendar()
                .date_to_session(date(today.year, 1, 1) - timedelta(days=1), direction="previous")
                .date()
            )
            if previous["date"] != expected.isoformat():
                previous = None
        if previous:
            basis = "prior_year_close"
            baseline = point(previous, key)
            note = (
                "From the prior year’s last available close, adjusted for splits and distributions."
                if not nominal
                else "From the prior year’s last available reported close. Adjusted prices are unavailable."
            )
        else:
            note = "Prior year-end close unavailable. Change starts at the first observed close this year."
    finish = point(bars[-1], key)
    change = None
    if baseline is not None and baseline["time"] != finish["time"] and baseline["price"] > 0:
        change = 100 * (finish["price"] / baseline["price"] - 1)
    elif baseline is not None:
        note += " Two distinct observations are needed to measure change."
    return {
        **packet,
        "data": {
            **series,
            "bars": bars,
            "as_of": bars[-1]["date"],
            "range": preset,
            "interval": interval,
            "timezone": str(zone),
            "price_basis": "nominal" if nominal else "adjusted",
            "requested_start": start_day,
            "requested_end": requested_end,
            "performance": {
                "start": baseline,
                "end": finish,
                "percent": change,
                "basis": basis,
                "description": note,
            },
        },
    }
