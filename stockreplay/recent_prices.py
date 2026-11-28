"""Recover holes in recent US daily prices using completed, published daily bars."""

from datetime import datetime, timedelta
import math
from urllib.parse import quote

from bs4 import BeautifulSoup
import httpx
import pandas as pd

from .price_ranges import US_EQUITY_EXCHANGES
from .trading_calendar import calendar


OHLC = ("Open", "High", "Low", "Close")


def complete(row):
    return all(pd.notna(row.get(k)) and math.isfinite(row[k]) and row[k] > 0 for k in OHLC)


def published_history(html, url):
    soup = BeautifulSoup(html, "html.parser")
    canonical = soup.select_one('link[rel="canonical"]')
    if not canonical or canonical.get("href", "").rstrip("/") != url.rstrip("/"):
        return {}
    for table in soup.find_all("table"):
        headers = [h.get_text(strip=True) for h in table.select("thead th")]
        if not {*OHLC, "Adj. Close", "Volume", "Date"} <= set(headers):
            continue
        bars = {}
        for tr in table.select("tbody tr"):
            values = dict(zip(headers, [td.get_text(strip=True) for td in tr.find_all("td")]))
            try:
                day = datetime.strptime(values["Date"], "%b %d, %Y").date()
                bar = {k: float(values[k].replace(",", "")) for k in (*OHLC, "Volume")}
                bar["Adj Close"] = float(values["Adj. Close"].replace(",", ""))
            except (ValueError, KeyError):
                continue
            if complete(bar) and math.isfinite(bar["Adj Close"]) and bar["Adj Close"] > 0:
                bars[day] = bar
        return bars
    return {}


def recover_recent(frame, instrument, symbol, meta, latest, start, end, period, fetch):
    """Use the short Yahoo series first. Add other publisher bars only on a verified share basis."""
    used = {}
    # Limit independent quotes to the recent history table. Once the window advances,
    # an unresolved hole from last week can still be recovered for a monthly or longer chart.
    earliest = latest - timedelta(days=60)
    if (
        meta.get("exchangeName") not in US_EQUITY_EXCHANGES
        or not isinstance(frame.index, pd.DatetimeIndex)
        or str(frame.index.tz) != "America/New_York"
        or frame.empty
        or (end and end < earliest)
        or frame.index.max().date() < earliest
    ):
        return frame, used
    cal = calendar()
    recent = cal.sessions_in_range(earliest, latest)
    if period == "5d":
        recent = recent[-5:]
    elif not start:
        earliest = max(earliest, frame.index.min().date())
    wanted = {
        s.date()
        for s in recent
        if s.date() >= max(start or earliest, earliest) and (not end or s.date() <= end)
    }
    rows = {s.date(): row for s, row in frame.tail(65).iterrows() if complete(row)}
    missing = wanted.difference(rows)
    if not missing:
        return frame, used
    frame = frame.copy()

    def insert(day, row):
        stamp = pd.Timestamp(day, tz=frame.index.tz)
        # Replace the entire price bar together, keeping split/dividend events on the primary row.
        for k in (*OHLC, "Adj Close", "Volume"):
            frame.loc[stamp, k] = row.get(k)
        if pd.notna(row.get("Stock Splits")) and row["Stock Splits"] > 0:
            frame.loc[stamp, "Stock Splits"] = row["Stock Splits"]
        if pd.notna(row.get("Dividends")) and row["Dividends"] != 0:
            frame.loc[stamp, "Dividends"] = row["Dividends"]
        rows[day] = row
        missing.remove(day)

    if period != "5d":
        try:
            short = instrument.history(
                period="5d",
                interval="1d",
                prepost=False,
                auto_adjust=False,
                actions=True,
                timeout=8,
            )
        except Exception:
            # The secondary request can fail independently of the original provider response.
            short = None
        if short is not None and str(getattr(short.index, "tz", "")) == str(frame.index.tz):
            for stamp, row in short.iterrows():
                if stamp.date() in missing and complete(row):
                    insert(stamp.date(), row)
    if not missing or meta.get("currency") != "USD" or meta.get("instrumentType") != "EQUITY":
        return frame.sort_index(), used
    url = "https://stockanalysis.com/stocks/" + quote(symbol.lower(), safe="") + "/history/"
    try:
        alternate = published_history(fetch(url).content, url)
    except (httpx.HTTPError, OSError, ValueError):
        return frame.sort_index(), used
    # Independent publishers round differently. Check overlapping recently published
    # closes, including the dividend-adjusted basis, before combining their series.
    overlap = sorted(rows.keys() & alternate.keys(), reverse=True)[:3]
    if overlap and all(
        math.isclose(rows[d][k], alternate[d][k], rel_tol=0.0003, abs_tol=0.011)
        for d in overlap
        for k in ("Close", "Adj Close")
        if pd.notna(rows[d].get(k))
    ):
        for day in sorted(missing & alternate.keys()):
            insert(day, alternate[day])
            used[day.isoformat()] = url
    return frame.sort_index(), used
