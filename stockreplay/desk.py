"""Read-only public market sources. No account, position or API-key access in this module."""

from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone, timedelta
import hashlib
import math
from urllib.parse import quote, urlsplit
from xml.etree import ElementTree as ET

import httpx
from bs4 import BeautifulSoup
import pandas as pd
import yfinance as yf

from .public_cache import PublicCache
from .trading_calendar import latest_session

INTERVALS = {
    "1m": ["1d", "5d"],
    "5m": ["5d", "1mo"],
    "15m": ["5d", "1mo"],
    "1h": ["1mo", "3mo", "1y"],
    "1d": ["1mo", "6mo", "1y", "2y", "5y", "10y"],
    "1wk": ["1y", "5y", "10y"],
    "1mo": ["5y", "10y", "max"],
}
SECTORS = {
    "Technology": "XLK",
    "Communication Services": "XLC",
    "Consumer Cyclical": "XLY",
    "Consumer Defensive": "XLP",
    "Financial Services": "XLF",
    "Healthcare": "XLV",
    "Industrials": "XLI",
    "Basic Materials": "XLB",
    "Real Estate": "XLRE",
    "Energy": "XLE",
    "Utilities": "XLU",
}
YAHOO = "https://finance.yahoo.com/quote/"
FED = "https://www.federalreserve.gov/feeds/press_all.xml"
SCREENS = {
    "day_gainers",
    "day_losers",
    "most_actives",
    "growth_technology_stocks",
    "undervalued_large_caps",
    "aggressive_small_caps",
}
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/137.0 Safari/537.36",
    "Accept": "application/json, application/xml;q=0.9, */*;q=0.8",
}


def number(v):
    try:
        value = float(v)
        return value if math.isfinite(value) else None
    except (ValueError, TypeError):
        return None


def safe_url(url):
    if not isinstance(url, str):
        return None
    try:
        parsed = urlsplit(url)
        if (
            parsed.scheme in {"https", "http"}
            and parsed.hostname
            and not parsed.username
            and not parsed.password
        ):
            return url
    except ValueError:
        pass
    return None


def fetch_url(url, params=None):
    with httpx.Client(headers=HEADERS, timeout=10, follow_redirects=True) as client:
        response = client.get(url, params=params)
        response.raise_for_status()
        return response


def chart_data(symbol, interval, span):
    if interval not in INTERVALS or span not in INTERVALS[interval]:
        raise ValueError("Choose a supported period for the selected interval.")
    instrument = yf.Ticker(symbol)
    frame = instrument.history(
        period=span, interval=interval, auto_adjust=False, actions=True, timeout=12
    )
    if frame.empty:
        raise ValueError(f"Yahoo Finance returned no {interval} bars for {symbol}.")
    last = latest_session()
    bars = []
    for stamp, row in frame.sort_index().iterrows():
        if interval == "1d" and stamp.date() > last:
            continue
        raw = [number(row.get(k)) for k in ("Open", "High", "Low", "Close")]
        if any(p is None or p <= 0 for p in raw):
            continue
        adj = number(row.get("Adj Close")) or raw[3]
        ratio = adj / raw[3]
        if not (0 < ratio < math.inf):
            continue
        # Anchor daily/weekly/monthly timestamps at UTC midnight for the exchange date.
        time = (
            int(pd.Timestamp(stamp.date(), tz="UTC").timestamp())
            if interval in ("1d", "1wk", "1mo")
            else int(stamp.timestamp())
        )
        values = dict(zip(("open", "high", "low", "close"), (p * ratio for p in raw)))
        bars.append(
            {
                "time": time,
                "date": stamp.date().isoformat(),
                **values,
                "raw_close": raw[3],
                "volume": number(row.get("Volume")),
                "dividend": number(row.get("Dividends")) or 0,
                "split": number(row.get("Stock Splits")) or 0,
            }
        )
    if not bars:
        raise ValueError("No completed bars for this selection.")
    metadata = instrument.history_metadata or {}
    return {
        "currency": metadata.get("currency"),
        "symbol": symbol,
        "interval": interval,
        "span": span,
        "as_of": bars[-1]["date"],
        "bars": bars,
        "source": "Yahoo Finance",
        "url": YAHOO + quote(symbol) + "/history/",
        "timezone": str(frame.index.tz),
        "latest_completed_session": last.isoformat(),
    }


def company(symbol):
    info = yf.Ticker(symbol).get_info()
    if not info or not (info.get("shortName") or info.get("longName")):
        raise ValueError("Company profile unavailable.")
    keys = (
        "longName",
        "shortName",
        "industry",
        "sector",
        "exchange",
        "currency",
        "marketCap",
        "trailingPE",
        "forwardPE",
        "trailingEps",
        "revenueGrowth",
        "profitMargins",
        "dividendYield",
        "fiftyTwoWeekHigh",
        "fiftyTwoWeekLow",
        "earningsTimestamp",
        "earningsTimestampEnd",
        "quoteType",
        "targetLowPrice",
        "targetMeanPrice",
        "targetHighPrice",
        "numberOfAnalystOpinions",
    )
    return {k: info.get(k) for k in keys}


def analyst_history(symbol):
    frame = yf.Ticker(symbol).upgrades_downgrades
    if frame is None:
        raise ValueError("Analyst action history unavailable.")
    out = []
    for stamp, row in frame.sort_index(ascending=False).iterrows():
        firm = row.get("Firm")
        if pd.isna(firm) or not str(firm).strip():
            continue

        def clean(key):
            v = row.get(key)
            return "" if pd.isna(v) else str(v).strip()

        if not clean("ToGrade") and not clean("Action"):
            continue
        out.append(
            {
                "date": pd.Timestamp(stamp).isoformat(),
                "firm": str(firm),
                "grade": clean("ToGrade"),
                "previous": clean("FromGrade"),
                "action": clean("Action"),
                "target": number(row.get("currentPriceTarget")) or None,
                "prior_target": number(row.get("priorPriceTarget")) or None,
                "source": "Yahoo Finance",
                "url": YAHOO + quote(symbol) + "/analysis/",
            }
        )
    return out


def stockanalysis(symbol):
    url = "https://stockanalysis.com/stocks/" + quote(symbol.lower(), safe="") + "/ratings/"
    soup = BeautifulSoup(fetch_url(url).content, "html.parser")
    for table in soup.find_all("table"):
        headers = [node.get_text(" ", strip=True) for node in table.select("thead th")]
        if not {"Firm", "Rating", "Date", "Action"} <= set(headers):
            continue
        rows = []
        for tr in table.select("tbody tr"):
            cells = tr.find_all("td", recursive=False)
            if len(cells) != len(headers):
                continue
            values = {key: td.get_text(" ", strip=True) for key, td in zip(headers, cells)}
            analyst = (
                cells[headers.index("Analyst")].select_one("a") if "Analyst" in headers else None
            )
            try:
                date = pd.Timestamp(values["Date"]).date().isoformat()
            except (ValueError, TypeError):
                continue
            target = (
                values.get("Price Target", "")
                .split("→")[-1]
                .strip()
                .removeprefix("$")
                .replace(",", "")
            )
            rows.append(
                {
                    "date": date,
                    "firm": values["Firm"],
                    "analyst": analyst.get_text(strip=True) if analyst else "",
                    "grade": values["Rating"],
                    "action": values["Action"],
                    "previous": "",
                    "target": number(target),
                    "source": "Stock Analysis",
                    "url": url,
                }
            )
        if rows:
            return rows
    raise ValueError("Stock Analysis has no accessible dated rating table for this security.")


def consensus(symbol):
    frame = yf.Ticker(symbol).recommendations
    if frame is None:
        raise ValueError("Consensus unavailable.")
    return [
        {
            "period": str(r.get("period", "")),
            "strongBuy": number(r.get("strongBuy")),
            "buy": number(r.get("buy")),
            "hold": number(r.get("hold")),
            "sell": number(r.get("sell")),
            "strongSell": number(r.get("strongSell")),
        }
        for _, r in frame.iterrows()
    ]


def nasdaq(symbol):
    data = (
        fetch_url("https://api.nasdaq.com/api/analyst/" + quote(symbol, safe="") + "/ratings")
        .json()
        .get("data")
        or {}
    )
    if not data.get("meanRatingType"):
        raise ValueError("Nasdaq publishes no consensus for this symbol.")
    return {
        "grade": data["meanRatingType"],
        "summary": data.get("ratingsSummary"),
        "contributors": data.get("brokerNames") or [],
        "url": "https://www.nasdaq.com/market-activity/stocks/"
        + symbol.lower()
        + "/analyst-research",
    }


def published(value):
    if not value:
        return None
    try:
        dt = pd.Timestamp(value)
        return (dt.tz_localize("UTC") if dt.tz is None else dt.tz_convert("UTC")).isoformat()
    except (ValueError, TypeError):
        return None


def rss(url, category):
    root = ET.fromstring(fetch_url(url).content)
    out = []
    for item in root.findall(".//item"):
        link = safe_url(item.findtext("link"))
        title = item.findtext("title")
        stamp = published(item.findtext("pubDate"))
        if link and title and stamp:
            out.append(
                {
                    "title": title,
                    "url": link,
                    "published": stamp,
                    "publisher": "Federal Reserve"
                    if category == "macro"
                    else urlsplit(link).hostname,
                    "category": category,
                }
            )
    return out[:30]


def stories(symbol, category):
    try:
        raw = yf.Ticker(symbol).get_news(count=25)
        out = []
        for item in raw:
            c = item.get("content") or item
            url = safe_url(
                (c.get("canonicalUrl") or {}).get("url")
                or (c.get("clickThroughUrl") or {}).get("url")
                or c.get("link")
            )
            stamp = published(c.get("pubDate") or c.get("displayTime"))
            if url and stamp and c.get("title"):
                out.append(
                    {
                        "title": c["title"],
                        "url": url,
                        "published": stamp,
                        "publisher": (c.get("provider") or {}).get("displayName")
                        or urlsplit(url).hostname,
                        "category": category,
                    }
                )
        if out:
            return out
    except Exception:
        pass
    return rss(
        "https://feeds.finance.yahoo.com/rss/2.0/headline?s="
        + quote(symbol, safe="")
        + "&region=US&lang=en-US",
        category,
    )


def screen(name):
    if name not in SCREENS:
        raise ValueError("Unknown market screen.")
    result = yf.screen(name, count=100)
    if not result or not result.get("quotes"):
        raise ValueError("The market screener returned no quotes.")
    fields = (
        "symbol",
        "shortName",
        "longName",
        "regularMarketPrice",
        "regularMarketChangePercent",
        "regularMarketVolume",
        "marketCap",
        "regularMarketTime",
        "currency",
        "fullExchangeName",
        "sector",
    )
    return [{k: q.get(k) for k in fields} for q in result["quotes"] if q.get("symbol")]


def technical_rating(chart, benchmark):
    if not chart or not benchmark:
        return None
    a = {b["date"]: b["close"] for b in chart["bars"]}
    b = {x["date"]: x["close"] for x in benchmark["bars"]}
    days = sorted(a.keys() & b.keys())
    if len(days) < 200:
        return None
    prices = [a[d] for d in days]
    index = [b[d] for d in days]
    last = prices[-1]
    changes = {
        "trend": 100 * (last / (sum(prices[-200:]) / 200) - 1),
        "relative": 100 * (last / prices[-64] - index[-1] / index[-64]),
        "momentum": 100 * (last / prices[-22] - 1),
        "drawdown": 100 * (last / max(prices[-126:]) - 1),
    }
    factors = []
    for k, label, low, high, weight in [
        ("trend", "Distance from 200-session SMA", -15, 15, 30),
        ("relative", "63-session excess vs SPY", -15, 15, 30),
        ("momentum", "21-session momentum", -10, 10, 20),
        ("drawdown", "126-session drawdown", -25, 0, 20),
    ]:
        v = changes[k]
        points = weight * max(0, min(1, (v - low) / (high - low)))
        factors.append(
            {
                "label": label,
                "value": round(v, 3),
                "weight": weight,
                "points": round(points, 2),
                "floor": low,
                "ceiling": high,
            }
        )
    score = round(sum(x["points"] for x in factors))
    return {
        "score": score,
        "label": "Strong"
        if score >= 75
        else "Constructive"
        if score >= 60
        else "Mixed"
        if score >= 40
        else "Cautious"
        if score >= 25
        else "Weak",
        "as_of": days[-1],
        "factors": factors,
        "formula": "Technical rating v1",
        "current": days[-1] == latest_session().isoformat(),
    }


class Desk:
    def __init__(self, db):
        self.cache = PublicCache(db)
        self.db = db

    def chart(self, symbol, interval="1d", span="2y", refresh=False):
        if interval not in INTERVALS or span not in INTERVALS[interval]:
            raise ValueError("Unsupported chart interval or date range.")
        return self.cache.get(
            f"bars:{symbol}:{interval}:{span}",
            120 if interval not in ("1d", "1wk", "1mo") else 600,
            lambda: chart_data(symbol, interval, span),
            refresh,
        )

    def ratings(self, symbol, refresh=False):
        tasks = {
            "stockanalysis": lambda: self.cache.get(
                "stockanalysis:" + symbol, 21600, lambda: stockanalysis(symbol), refresh
            ),
            "actions": lambda: self.cache.get(
                "actions:" + symbol, 21600, lambda: analyst_history(symbol), refresh
            ),
            "consensus": lambda: self.cache.get(
                "consensus:" + symbol, 3600, lambda: consensus(symbol), refresh
            ),
            "nasdaq": lambda: self.cache.get(
                "nasdaq:" + symbol, 21600, lambda: nasdaq(symbol), refresh
            ),
            "profile": lambda: self.cache.get(
                "profile:" + symbol, 3600, lambda: company(symbol), refresh
            ),
            "asset": lambda: self.chart(symbol, refresh=refresh),
            "benchmark": lambda: self.chart("SPY", refresh=refresh),
        }
        values = parallel(tasks)
        a, b = values.pop("asset"), values.pop("benchmark")
        return {
            **values,
            "symbol": symbol,
            "stockreplay": technical_rating(a["data"], b["data"]),
            "chart": a,
            "benchmark": b,
        }

    def briefing(self, symbol, refresh=False):
        r = self.ratings(symbol, refresh)
        profile = r["profile"]["data"] or {}
        sector = profile.get("sector")
        peer = SECTORS.get(sector)
        tasks = {
            "company_news": lambda: self.cache.get(
                "news:" + symbol, 600, lambda: stories(symbol, "company"), refresh
            ),
            "macro_news": lambda: self.cache.get(
                "news:fed", 1800, lambda: rss(FED, "macro"), refresh
            ),
            "market_news": lambda: self.cache.get(
                "market-news:SPY", 600, lambda: stories("SPY", "market"), refresh
            ),
        }
        if peer:
            tasks["sector_chart"] = lambda: self.chart(peer, refresh=refresh)
            tasks["sector_news"] = lambda: self.cache.get(
                "sector-news:" + peer, 900, lambda: stories(peer, "sector"), refresh
            )
        v = parallel(tasks)
        evidence = []

        def add(group, text, url, date, source):
            key = hashlib.sha256((group + str(url) + str(date) + text).encode()).hexdigest()[:14]
            evidence.append(
                {
                    "id": key,
                    "group": group,
                    "text": text,
                    "url": url,
                    "date": date,
                    "source": source,
                }
            )

        for key, data, group in [
            ("asset", r["chart"], "price"),
            ("benchmark", r["benchmark"], "market"),
            ("sector", v.get("sector_chart", {}), "sector"),
        ]:
            series = data.get("data")
            if not series:
                continue
            bars = series["bars"]
            p = bars[-1]
            measures = [f"Adjusted {series['symbol']} close {p['close']:.2f}"]
            for n in [1, 21, 63, 252]:
                if len(bars) > n:
                    measures.append(
                        f"{n}-session return {100 * (p['close'] / bars[-n - 1]['close'] - 1):+.2f}%"
                    )
            add(group, ", ".join(measures), series["url"], p["date"], "Yahoo Finance")
        if r["stockreplay"]:
            own = r["stockreplay"]
            add(
                "technical",
                f"StockReplay technical score {own['score']}/100 ({own['label']})",
                YAHOO + quote(symbol) + "/history/",
                own["as_of"],
                "StockReplay calculation",
            )
        c = r["consensus"]
        current = next((x for x in c["data"] or [] if x["period"] == "0m"), None)
        if current:
            add(
                "analysts",
                "Current consensus response counts: "
                + ", ".join(
                    f"{k} {int(val)}"
                    for k, val in current.items()
                    if k != "period" and val is not None
                ),
                YAHOO + quote(symbol) + "/analysis/",
                c["fetched"],
                "Yahoo Finance · retrieved",
            )
        n = r["nasdaq"]
        if n["data"]:
            add(
                "analysts",
                str(n["data"]["grade"]) + ". " + str(n["data"]["summary"] or ""),
                n["data"]["url"],
                n["fetched"],
                "Nasdaq · retrieved",
            )
        for x in sorted(
            (r["actions"]["data"] or [])[:5] + (r["stockanalysis"]["data"] or [])[:5],
            key=lambda x: x["date"],
            reverse=True,
        )[:8]:
            add(
                "analysts",
                x["firm"] + " published " + (x["grade"] or x["action"]),
                x["url"],
                x["date"],
                x["source"],
            )
        seen = set()
        cutoff = datetime.now(timezone.utc) - timedelta(days=30)
        for k in ["company_news", "sector_news", "market_news", "macro_news"]:
            for item in (v.get(k, {}).get("data") or [])[:12]:
                if item["url"] in seen or not cutoff <= datetime.fromisoformat(
                    item["published"]
                ) <= datetime.now(timezone.utc) + timedelta(minutes=5):
                    continue
                seen.add(item["url"])
                add(
                    item["category"] + "_news",
                    item["title"],
                    item["url"],
                    item["published"],
                    item["publisher"],
                )
        issues = [
            f"{key.replace('_', ' ')}: {value['error']}"
            for key, value in {
                **v,
                **{
                    k: r[k]
                    for k in (
                        "profile",
                        "chart",
                        "benchmark",
                        "actions",
                        "stockanalysis",
                        "consensus",
                        "nasdaq",
                    )
                },
            }.items()
            if value.get("error")
        ]
        if not peer:
            issues.append("Sector classification or matching US sector ETF unavailable.")
        expected = latest_session().isoformat()

        def fresh_series(packet):
            return bool(
                packet
                and packet["data"]
                and packet["data"]["as_of"] == expected
                and not packet["stale"]
            )

        return {
            "symbol": symbol,
            "name": profile.get("longName") or symbol,
            "sector": sector,
            "sector_etf": peer,
            "as_of": latest_session().isoformat(),
            "rating": r["stockreplay"],
            "fundamentals": profile,
            "profile_fetched": r["profile"]["fetched"],
            "evidence": evidence,
            "issues": issues,
            "current_prices": fresh_series(r["chart"]),
            "current_context": fresh_series(r["benchmark"]) and fresh_series(v.get("sector_chart")),
        }


def parallel(tasks):
    with ThreadPoolExecutor(max_workers=min(4, len(tasks))) as pool:
        pending = {k: pool.submit(fn) for k, fn in tasks.items()}
        return {k: f.result() for k, f in pending.items()}
