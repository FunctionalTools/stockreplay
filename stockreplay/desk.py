"""Read-only public market sources. No account, position or API-key access in this module."""

from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone, timedelta
import hashlib
import math
import re
from statistics import stdev
from urllib.parse import quote, urlsplit
from xml.etree import ElementTree as ET

import httpx
from bs4 import BeautifulSoup
import pandas as pd
import yfinance as yf

from .price_ranges import week_start
from .recent_prices import recover_recent
from .public_cache import PublicCache
from .news_images import NewsImages, image_url
from .web_research import PublicResearch
from .trading_calendar import latest_session

INTERVALS = {
    "1m": ["1d", "5d"],
    "5m": ["5d", "1mo"],
    "15m": ["5d", "1mo"],
    "1h": ["1mo", "3mo", "1y"],
    "1d": ["5d", "1w", "1mo", "3mo", "6mo", "ytd", "1y", "2y", "5y", "10y", "max"],
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


def chart_data(symbol, interval, span, start=None, end=None):
    if interval not in INTERVALS or (span != "custom" and span not in INTERVALS[interval]):
        raise ValueError("Choose a supported period for the selected interval.")
    instrument = yf.Ticker(symbol)
    window = (
        {"start": start.isoformat(), "end": (end + timedelta(days=1)).isoformat()}
        if span == "custom"
        else {"period": "1mo" if span == "1w" else span}
    )
    frame = instrument.history(
        interval=interval,
        prepost=False,
        auto_adjust=False,
        actions=True,
        timeout=12,
        **window,
    )
    if frame.empty:
        raise ValueError(f"Yahoo Finance returned no {interval} bars for {symbol}.")
    observed = datetime.now(timezone.utc)
    last = latest_session(observed)
    metadata = instrument.history_metadata or {}
    # Preserve the exchange date for daily bars. Some foreign exchanges have finished
    # before the US close; a current daily bar is eligible only after its regular close.
    local_today = observed.astimezone(frame.index.tz).date() if frame.index.tz else observed.date()
    current_close = ((metadata.get("currentTradingPeriod") or {}).get("regular") or {}).get("end")
    latest = local_today - timedelta(days=1)
    if str(frame.index.tz) == "America/New_York" and metadata.get("instrumentType") in (
        "EQUITY",
        "ETF",
        "INDEX",
        None,
    ):
        latest = last
    elif (
        isinstance(current_close, (int, float))
        and frame.index.tz
        and datetime.fromtimestamp(current_close, frame.index.tz).date() == local_today
        and current_close <= observed.timestamp()
    ):
        latest = local_today
    supplemented = {}
    if interval == "1d":
        frame, supplemented = recover_recent(
            frame, instrument, symbol, metadata, latest, start, end, span, fetch_url
        )
    adjusted = True
    bars = []
    splits = []
    for stamp, row in frame.sort_index().iterrows():
        if interval == "1d" and stamp.date() > latest:
            continue
        split = number(row.get("Stock Splits"))
        if split and split > 0:
            splits.append({"date": stamp.date().isoformat(), "ratio": split})
        raw = [number(row.get(k)) for k in ("Open", "High", "Low", "Close")]
        if any(p is None or p <= 0 for p in raw):
            continue
        reported_adj = number(row.get("Adj Close"))
        if not reported_adj:
            adjusted = False
        adj = reported_adj or raw[3]
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
                "split": split or 0,
                **(
                    {"source": "Stock Analysis", "url": supplemented[stamp.date().isoformat()]}
                    if stamp.date().isoformat() in supplemented
                    else {}
                ),
            }
        )
    if not bars:
        raise ValueError("No completed bars for this selection.")
    if span == "1w":
        # Yahoo has no one-week period. Slice real daily closes through the last observed session.
        boundary = week_start(bars[-1]["date"])
        bars = [bar for bar in bars if bar["date"] >= boundary]
    url = YAHOO + quote(symbol) + "/history/"
    sources = [{"source": "Yahoo Finance", "url": url}]
    if any(b.get("source") == "Stock Analysis" for b in bars):
        sources.append({"source": "Stock Analysis", "url": next(iter(supplemented.values()))})
    return {
        "price_sources": sources,
        "splits": splits,
        "exchange": metadata.get("exchangeName"),
        "instrument_type": metadata.get("instrumentType"),
        "adjusted": adjusted,
        "currency": metadata.get("currency"),
        "symbol": symbol,
        "interval": interval,
        "span": span,
        "as_of": bars[-1]["date"],
        "bars": bars,
        "source": "Yahoo Finance",
        "url": url,
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
        "financialCurrency",
        "mostRecentQuarter",
        "priceToBook",
        "enterpriseToEbitda",
        "earningsGrowth",
        "grossMargins",
        "operatingMargins",
        "returnOnEquity",
        "debtToEquity",
        "currentRatio",
        "quickRatio",
        "operatingCashflow",
        "freeCashflow",
        "totalRevenue",
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
        "forwardEps",
        "beta",
        "overallRisk",
        "governanceEpochDate",
        "recommendationKey",
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


def forecast(symbol):
    url = "https://stockanalysis.com/stocks/" + quote(symbol.lower(), safe="") + "/forecast/"
    soup = BeautifulSoup(fetch_url(url).content, "html.parser")
    heading = next(
        (h for h in soup.select("h2,h3") if "Stock Price Forecast" in h.get_text(" ", strip=True)),
        None,
    )
    paragraph = heading.find_next("p") if heading else None
    summary = paragraph.get_text(" ", strip=True) if paragraph else ""
    grade = re.search(r'consensus rating of [“"]([^”"]+)', summary, re.I)
    count = re.search(r"([\d,]+) analysts?", summary, re.I)
    if not grade:
        raise ValueError("No published Stock Analysis forecast for this symbol.")
    targets, votes, period = {}, {}, None
    for table in soup.find_all("table"):
        headers = [
            cell.get_text(" ", strip=True) for cell in table.select("thead tr:last-child th")
        ]
        for row in table.select("tbody tr"):
            cells = [
                c.get_text(" ", strip=True) for c in row.find_all(["td", "th"], recursive=False)
            ]
            if not cells or len(cells) != len(headers):
                continue
            if cells[0] == "Price" and "Average" in headers:
                for label, value in zip(headers[1:], cells[1:]):
                    n = number(re.sub(r"[^0-9.\-]", "", value))
                    if n is not None:
                        targets[label.lower()] = n
            elif (
                cells[0] in {"Strong Buy", "Buy", "Hold", "Sell", "Strong Sell"}
                and number(cells[-1]) is not None
            ):
                votes[cells[0]] = int(float(cells[-1]))
                period = headers[-1]
    return {
        "grade": grade.group(1),
        "count": int(count[1].replace(",", "")) if count else None,
        "summary": summary,
        "targets": targets,
        "votes": votes,
        "period": period,
        "url": url,
        "source": "Stock Analysis",
        "provider": "S&P Global" if "S&P Global" in summary else None,
    }


def excerpt(value):
    return " ".join(BeautifulSoup(str(value or ""), "html.parser").stripped_strings)[:480]


MEDIA = "{http://search.yahoo.com/mrss/}"


def article_preview(content):
    thumbnail = content.get("thumbnail") or {}
    if not isinstance(thumbnail, dict):
        thumbnail = {}
    sizes = (
        list(thumbnail.get("resolutions") or [])
        if isinstance(thumbnail.get("resolutions"), list)
        else []
    )
    sizes.append(
        {
            "url": thumbnail.get("originalUrl"),
            "width": thumbnail.get("originalWidth"),
            "height": thumbnail.get("originalHeight"),
        }
    )
    photos = []
    for item in sizes:
        if not isinstance(item, dict):
            continue
        url = image_url(item.get("url"))
        width = number(item.get("width"))
        height = number(item.get("height"))
        if (
            not url
            or not width
            or not height
            or width < 128
            or height < 72
            or width * height > 12_000_000
        ):
            continue
        # Favor a card-sized image, retaining a different publisher-supplied resolution if it fails.
        rank = (
            0 if 320 <= width <= 1600 else 1 if width > 1600 else 2,
            abs(width - 720),
        )
        photos.append((rank, url))
    authors = content.get("authors")
    byline = content.get("byline")
    if not isinstance(byline, str) and isinstance(authors, list):
        byline = ", ".join(
            name
            for a in authors
            if isinstance(a, dict)
            and isinstance((name := a.get("displayName") or a.get("name")), str)
        )
    finance = content.get("finance")
    premium = finance.get("premiumFinance") if isinstance(finance, dict) else None
    return {
        "images": list(dict.fromkeys(url for _, url in sorted(photos)))[:2],
        "byline": excerpt(byline)[:160] if isinstance(byline, str) else None,
        "format": "video" if content.get("contentType") == "VIDEO" else "article",
        "subscription": isinstance(premium, dict) and premium.get("isPremiumNews") is True,
    }


def rss_preview(item):
    images = []
    for node in item.iter():
        if node.tag == MEDIA + "thumbnail" or (
            node.tag in (MEDIA + "content", "enclosure")
            and (node.get("medium") == "image" or (node.get("type") or "").startswith("image/"))
        ):
            url = image_url(node.get("url"))
            if url and url not in images:
                images.append(url)
    return {
        "images": images[:2],
        "byline": excerpt(item.findtext("{http://purl.org/dc/elements/1.1/}creator"))[:160] or None,
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
                    "excerpt": excerpt(item.findtext("description")),
                    "preview": rss_preview(item),
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
            if not isinstance(item, dict):
                continue
            c = item.get("content") or item
            if not isinstance(c, dict):
                continue
            links = [c.get("canonicalUrl"), c.get("clickThroughUrl"), c.get("link")]
            url = next(
                (
                    u
                    for link in links
                    if (u := safe_url(link.get("url") if isinstance(link, dict) else link))
                ),
                None,
            )
            provider = c.get("provider")
            publisher = provider.get("displayName") if isinstance(provider, dict) else None
            stamp = published(c.get("pubDate") or c.get("displayTime"))
            if url and stamp and c.get("title"):
                out.append(
                    {
                        "title": c["title"],
                        "excerpt": excerpt(c.get("summary") or c.get("description")),
                        "preview": article_preview(c),
                        "url": url,
                        "published": stamp,
                        "publisher": publisher
                        if isinstance(publisher, str) and publisher.strip()
                        else urlsplit(url).hostname,
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


def names_company(article, symbol, profile):
    """A company feed can include unrelated headlines. Only use named coverage for its score."""
    text = " ".join((article["title"], article.get("excerpt") or ""))
    if re.search(
        r"(?<![\w])" + re.escape(symbol) + r"(?![\w])",
        text,
        flags=0 if len(symbol) <= 2 else re.I,
    ):
        return True
    suffixes = {
        "inc",
        "incorporated",
        "corporation",
        "corp",
        "company",
        "co",
        "plc",
        "ltd",
        "limited",
        "group",
        "holdings",
        "holding",
        "ag",
        "nv",
    }
    for field in ("longName", "shortName"):
        name = str(profile.get(field) or "").casefold().replace(".com", "").replace("p.l.c.", "plc")
        words = re.findall(r"[\w&]+", name)
        if words[:1] == ["the"]:
            words.pop(0)
        while words and words[-1] in suffixes:
            words.pop()
        if words and re.search(
            r"(?<!\w)" + r"[^\w]+".join(re.escape(x) for x in words) + r"(?!\w)",
            text,
            re.I,
        ):
            return True
    return False


def market_comparisons(asset, benchmark):
    """Use the same trading dates, and matching return intervals for realized beta."""
    prices = {bar["date"]: bar["close"] for bar in asset}
    index = {bar["date"]: bar["close"] for bar in benchmark}
    days = sorted(prices.keys() & index.keys())
    if not days:
        return
    end = days[-1]
    comparisons = []
    for window in (21, 63, 126):
        if len(days) > window:
            start = days[-window - 1]
            difference = 100 * (prices[end] / prices[start] - index[end] / index[start])
            comparisons.append(
                f"{window} aligned sessions vs SPY: {difference:+.2f} percentage points ({start} to {end})"
            )
    if comparisons:
        yield "relative", ". ".join(comparisons), end

    def changes(rows):
        return {(a["date"], b["date"]): b["close"] / a["close"] - 1 for a, b in zip(rows, rows[1:])}

    a, b = changes(asset), changes(benchmark)
    dates = sorted(a.keys() & b.keys())[-126:]
    if len(dates) < 21:
        return
    mean = sum(b[d] for d in dates) / len(dates)
    squares = sum((b[d] - mean) ** 2 for d in dates)
    if squares > 1e-16:
        beta = sum(a[d] * (b[d] - mean) for d in dates) / squares
        yield (
            "sensitivity",
            f"Realized beta vs SPY: {beta:.2f} over {len(dates)} matched daily returns",
            dates[-1][1],
        )


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
        self.photos = NewsImages(db)
        self.cache = PublicCache(db)
        self.web = PublicResearch(self.cache)
        self.db = db

    def chart(self, symbol, interval="1d", span="2y", refresh=False):
        if interval not in INTERVALS or span not in INTERVALS[interval]:
            raise ValueError("Unsupported chart interval or date range.")
        return self.cache.get(
            f"bars:{symbol}:{interval}:{span}",
            120 if interval not in ("1d", "1wk", "1mo") else 600,
            lambda: chart_data(symbol, interval, span),
            refresh,
            required_field="price_sources" if interval == "1d" else None,
        )

    def date_chart(self, symbol, start, end, refresh=False):
        return self.cache.get(
            f"range-custom:{symbol}:{start}:{end}",
            600,
            lambda: chart_data(symbol, "1d", "custom", start, end),
            refresh,
            required_field="price_sources",
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
            "forecast": lambda: self.cache.get(
                "forecast:" + symbol, 21600, lambda: forecast(symbol), refresh
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

    def web_research(self, symbol, question="", refresh=False, public_topic=False):
        profile = (self.cache.read("profile:" + symbol) or {}).get("data") or {}
        return self.web.lookup(symbol, profile, question, refresh, public_topic)

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
        tasks["web_sources"] = lambda: self.web.lookup(symbol, profile, refresh=refresh)
        tasks["volatility_index"] = lambda: self.chart("^VIX", "1d", "6mo", refresh)
        tasks["treasury_yield"] = lambda: self.chart("^TNX", "1d", "6mo", refresh)
        if peer:
            tasks["sector_chart"] = lambda: self.chart(peer, refresh=refresh)
            tasks["sector_news"] = lambda: self.cache.get(
                "sector-news:" + peer, 900, lambda: stories(peer, "sector"), refresh
            )
        v = parallel(tasks)
        search = v.pop("web_sources")
        evidence = list(search["evidence"])

        def add(group, text, url, date, source, excerpt=None, preview=None, **metadata):
            key = hashlib.sha256((group + str(url) + str(date) + text).encode()).hexdigest()[:14]
            evidence.append(
                {
                    "id": key,
                    "group": group,
                    "text": text,
                    "url": url,
                    "date": date,
                    "source": source,
                    "excerpt": excerpt,
                    **({"preview": preview} if preview else {}),
                    **metadata,
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
            if group == "price":
                for window in (50, 200):
                    if len(bars) >= window:
                        average = sum(bar["close"] for bar in bars[-window:]) / window
                        measures.append(
                            f"{100 * (p['close'] / average - 1):+.2f}% versus the {window}-session average"
                        )
            add(
                group,
                ", ".join(measures),
                series["url"],
                p["date"],
                "Yahoo Finance",
                date_kind="close",
                stale=data.get("stale", False),
            )
        asset, benchmark = r["chart"], r["benchmark"]
        if asset["data"] and benchmark["data"]:
            for factor, text, day in market_comparisons(
                asset["data"]["bars"], benchmark["data"]["bars"]
            ):
                add(
                    "technical",
                    text,
                    asset["data"]["url"],
                    day,
                    "StockReplay · Yahoo Finance prices",
                    factor=factor,
                    date_kind="close",
                    stale=bool(asset["stale"] or benchmark["stale"]),
                    related=[{"url": benchmark["data"]["url"], "label": "SPY price history"}],
                )
        for k, label, unit in [
            ("volatility_index", "Cboe VIX", "index points"),
            ("treasury_yield", "US ten-year Treasury yield", "%"),
        ]:
            indicator = v[k]["data"]
            if not indicator:
                continue
            bars = indicator["bars"]
            last = bars[-1]
            text = f"{label} {last['raw_close']:.2f} {unit}"
            if len(bars) > 21:
                change = last["raw_close"] - bars[-22]["raw_close"]
                text += f", 21-session change {change:+.2f} " + (
                    "percentage points" if unit == "%" else unit
                )
            add(
                "market",
                text,
                indicator["url"],
                last["date"],
                "Yahoo Finance",
                factor="macro",
                date_kind="close",
                stale=v[k]["stale"],
            )
        c = r["consensus"]
        current = next((x for x in c["data"] or [] if x["period"] == "0m"), None)
        if current and any(val is not None for k, val in current.items() if k != "period"):
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
                "Yahoo Finance",
                date_kind="retrieved",
                stale=c["stale"],
            )
        n = r["forecast"]
        if n["data"]:
            add(
                "analysts",
                str(n["data"]["grade"]) + ". " + str(n["data"]["summary"] or ""),
                n["data"]["url"],
                n["fetched"],
                "Stock Analysis",
                date_kind="retrieved",
                stale=n["stale"],
            )
        profile_stamp = r["profile"]["fetched"]
        analysis_url = YAHOO + quote(symbol) + "/analysis/"
        metrics = []

        metric_groups = {}

        def metric(
            group,
            factor,
            label,
            value,
            unit,
            url,
            stamp,
            source="Yahoo Finance",
            *,
            date_kind="retrieved",
            stale=False,
            period_end=None,
        ):
            value = number(value)
            if value is None or not stamp:
                return
            metrics.append(
                {
                    "group": group,
                    "label": label,
                    "value": round(value, 3),
                    "unit": unit,
                    "url": url,
                    "date": stamp,
                    "source": source,
                }
            )
            # Keep related observations together so even the compact model request sees the range.
            key = (group, factor, url, stamp, source, date_kind, stale, period_end)
            metric_groups.setdefault(key, []).append(f"{label}: {value:,.2f} {unit}".strip())

        def epoch_day(value):
            value = number(value)
            if value is not None and 0 < value < 4102444800:
                return datetime.fromtimestamp(value, timezone.utc).date().isoformat()
            return None

        currency = profile.get("currency") or ""
        accounts_currency = profile.get("financialCurrency") or "currency unreported"
        quarter = epoch_day(profile.get("mostRecentQuarter"))
        stats_url = YAHOO + quote(symbol) + "/key-statistics/"
        profile_stale = r["profile"]["stale"]
        # Yahoo reports fractional growth and margins, and debt/equity in percentage points.
        for field, factor, title, multiplier, unit in [
            ("trailingPE", "valuation", "Trailing price / earnings", 1, "×"),
            ("forwardPE", "valuation", "Forward price / earnings", 1, "×"),
            ("priceToBook", "valuation", "Price / book value", 1, "×"),
            ("enterpriseToEbitda", "valuation", "Enterprise value / EBITDA", 1, "×"),
            (
                "revenueGrowth",
                "growth",
                "Quarterly revenue growth, year over year",
                100,
                "%",
            ),
            (
                "earningsGrowth",
                "growth",
                "Quarterly earnings growth, year over year",
                100,
                "%",
            ),
            ("grossMargins", "profitability", "Gross margin", 100, "%"),
            ("operatingMargins", "profitability", "Operating margin", 100, "%"),
            ("profitMargins", "profitability", "Net margin", 100, "%"),
            ("returnOnEquity", "profitability", "Return on equity", 100, "%"),
            ("debtToEquity", "balance_sheet", "Debt / equity", 1, "%"),
            ("currentRatio", "balance_sheet", "Current ratio", 1, "×"),
            ("quickRatio", "balance_sheet", "Quick ratio", 1, "×"),
            (
                "operatingCashflow",
                "cash_flow",
                "Operating cash flow, trailing year",
                1,
                accounts_currency,
            ),
            (
                "freeCashflow",
                "cash_flow",
                "Free cash flow, trailing year",
                1,
                accounts_currency,
            ),
        ]:
            value = number(profile.get(field))
            if value is not None:
                metric(
                    "fundamentals",
                    factor,
                    title,
                    value * multiplier,
                    unit,
                    stats_url,
                    profile_stamp,
                    stale=profile_stale,
                    period_end=quarter if factor != "valuation" else None,
                )
        cash, revenue = (
            number(profile.get("freeCashflow")),
            number(profile.get("totalRevenue")),
        )
        if cash is not None and revenue is not None and revenue > 0:
            metric(
                "fundamentals",
                "cash_flow",
                "Free cash flow / revenue",
                cash / revenue * 100,
                "%",
                stats_url,
                profile_stamp,
                stale=profile_stale,
                period_end=quarter,
            )
        for key, label in [
            ("targetMeanPrice", "Average analyst target"),
            ("targetLowPrice", "Low analyst target"),
            ("targetHighPrice", "High analyst target"),
            ("forwardEps", "Estimated earnings per share"),
        ]:
            metric(
                "estimates",
                "earnings" if key == "forwardEps" else "targets",
                label,
                profile.get(key),
                currency,
                analysis_url,
                profile_stamp,
                stale=profile_stale,
            )
        metric(
            "risk",
            "sensitivity",
            "Five-year beta",
            profile.get("beta"),
            "×",
            stats_url,
            profile_stamp,
            stale=profile_stale,
        )
        gov_date = epoch_day(profile.get("governanceEpochDate"))
        metric(
            "risk",
            "governance",
            "ISS governance risk (1 low, 10 high)",
            profile.get("overallRisk"),
            "/ 10",
            YAHOO + quote(symbol) + "/profile/",
            gov_date or profile_stamp,
            date_kind="published" if gov_date else "retrieved",
            stale=profile_stale,
        )
        series = r["chart"]["data"]
        if series:
            bars = series["bars"][-253:]
            if len(bars) >= 21:
                returns = [math.log(b["close"] / a["close"]) for a, b in zip(bars, bars[1:])]
                peak = bars[0]["close"]
                drawdown = 0
                for bar in bars:
                    peak = max(peak, bar["close"])
                    drawdown = min(drawdown, bar["close"] / peak - 1)
                label = f"{len(returns)}-session"
                metric(
                    "risk",
                    "price_risk",
                    label + " annualized volatility",
                    stdev(returns) * math.sqrt(252) * 100,
                    "%",
                    series["url"],
                    bars[-1]["date"],
                    "StockReplay · Yahoo Finance prices",
                    date_kind="close",
                    stale=r["chart"]["stale"],
                )
                metric(
                    "risk",
                    "price_risk",
                    label + " maximum drawdown",
                    drawdown * 100,
                    "%",
                    series["url"],
                    bars[-1]["date"],
                    "StockReplay · Yahoo Finance prices",
                    date_kind="close",
                    stale=r["chart"]["stale"],
                )
        if n["data"]:
            f = n["data"]
            for label in ("low", "average", "high"):
                metric(
                    "estimates",
                    "targets",
                    "Analyst target (" + label + ")",
                    f["targets"].get(label),
                    currency,
                    f["url"],
                    n["fetched"],
                    "Stock Analysis",
                    stale=n["stale"],
                )
        for (
            group,
            factor,
            url,
            stamp,
            source,
            date_kind,
            stale,
            period_end,
        ), parts in metric_groups.items():
            add(
                group,
                ". ".join(parts),
                url,
                stamp,
                source,
                factor=factor,
                date_kind=date_kind,
                stale=stale,
                **({"period_end": period_end} if period_end else {}),
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
                date_kind="published",
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
                relevance = {}
                if k == "company_news":
                    headline = names_company({"title": item["title"]}, symbol, profile)
                    relevance = {
                        "headline_company": headline,
                        "names_company": headline or names_company(item, symbol, profile),
                    }
                add(
                    item["category"] + "_news",
                    item["title"],
                    item["url"],
                    item["published"],
                    item["publisher"],
                    item.get("excerpt"),
                    item.get("preview"),
                    date_kind="published",
                    scope="Feed excerpt" if item.get("excerpt") else "Headline only",
                    discovered_via="Federal Reserve feed"
                    if k == "macro_news"
                    else "Yahoo Finance feed",
                    stale=v[k]["stale"],
                    **relevance,
                )
        self.photos.attach(evidence)
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
                        "forecast",
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
            "metrics": metrics,
            "public_ratings": {
                "forecast": n["data"],
                "forecast_fetched": n["fetched"],
                "consensus": current,
                "consensus_fetched": c["fetched"],
                "consensus_url": analysis_url,
                "consensus_grade": profile.get("recommendationKey"),
            },
            "analyst_actions": sorted(
                (r["actions"]["data"] or []) + (r["stockanalysis"]["data"] or []),
                key=lambda row: row["date"],
                reverse=True,
            ),
            "price_as_of": series["as_of"] if series else None,
            "evidence": evidence,
            "web_research": search,
            "issues": issues,
            "current_prices": fresh_series(r["chart"]),
            "current_context": fresh_series(r["benchmark"]) and fresh_series(v.get("sector_chart")),
        }


def parallel(tasks):
    with ThreadPoolExecutor(max_workers=min(4, len(tasks))) as pool:
        pending = {k: pool.submit(fn) for k, fn in tasks.items()}
        return {k: f.result() for k, f in pending.items()}
