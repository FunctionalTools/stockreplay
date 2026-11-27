"""Calendar facts for an individual listing. Financial periods and release dates are separate."""

import calendar
import re
from datetime import date, datetime, timedelta, timezone
from urllib.parse import quote
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import yfinance as yf
from bs4 import BeautifulSoup

from .desk import YAHOO, fetch_url

EXCHANGES = {
    "AS": "ams",
    "AX": "asx",
    "BR": "ebr",
    "CO": "cph",
    "DE": "etr",
    "F": "fra",
    "HE": "hel",
    "HK": "hkg",
    "L": "lon",
    "LS": "eli",
    "MC": "bme",
    "MI": "bit",
    "NS": "nse",
    "NZ": "nze",
    "OL": "osl",
    "PA": "epa",
    "SI": "sgx",
    "ST": "sto",
    "SW": "swx",
    "T": "tyo",
    "TA": "tlv",
    "TO": "tsx",
    "TW": "tpe",
    "TWO": "tpex",
    "V": "tsxv",
    "WA": "wse",
}


def stock_analysis(symbol):
    base, _, exchange = symbol.rpartition(".")
    if exchange in EXCHANGES and base:
        return f"https://stockanalysis.com/quote/{EXCHANGES[exchange]}/{quote(base, safe='')}/"
    return (
        "https://stockanalysis.com/stocks/"
        + quote(symbol.lower().replace(".", "-"), safe="")
        + "/"
    )


def us_date(text):
    found = re.search(r"\b([A-Z][a-z]{2})[a-z]*\s+(\d{1,2}),\s*(20\d\d)\b", text)
    if not found:
        return None
    try:
        return datetime.strptime(" ".join(found.groups()), "%b %d %Y").date()
    except ValueError:
        return None


def fetch_quarters(symbol):
    url = stock_analysis(symbol) + "financials/?p=quarterly"
    response = fetch_url(url)
    soup = BeautifulSoup(response.content, "html.parser")
    for table in soup.select("table"):
        rows = table.select("tr")
        if len(rows) < 2:
            continue
        quarters = [c.get_text(" ", strip=True) for c in rows[0].select("th,td")]
        ends = [c.get_text(" ", strip=True) for c in rows[1].select("th,td")]
        if quarters[:1] != ["Fiscal Quarter"] or ends[:1] != ["Period Ending"]:
            continue
        periods = []
        for label, stamp in zip(quarters[1:], ends[1:]):
            m = re.fullmatch(r"Q([1-4]) (20\d\d)", label)
            d = us_date(stamp)
            if m and d:
                periods.append([d.isoformat(), int(m[1]), int(m[2])])
        if periods:
            return {
                "url": str(response.url),
                "periods": sorted(periods),
                "source": "Stock Analysis financial statements",
            }
    raise ValueError("No labeled fiscal quarters were available for this listing.")


def fetch_statistics(symbol):
    url = stock_analysis(symbol) + "statistics/"
    response = fetch_url(url)
    soup = BeautifulSoup(response.content, "html.parser")
    facts = {}
    for row in soup.select("table tr"):
        cells = [c.get_text(" ", strip=True) for c in row.select("td,th")]
        if len(cells) == 2 and cells[0] in {"Earnings Date", "Ex-Dividend Date"}:
            d = us_date(cells[1])
            if d:
                facts[cells[0]] = d.isoformat()
    if not facts:
        raise ValueError("No dated earnings or dividend calendar was published here.")
    last_release = next(
        (
            us_date(p.get_text(" ", strip=True))
            for p in soup.select("p")
            if "last earnings date was" in p.get_text(" ", strip=True).lower()
        ),
        None,
    )
    return {
        "url": str(response.url),
        "facts": facts,
        "reported_earnings": last_release.isoformat() if last_release else None,
    }


def yahoo_date(value, zone="UTC"):
    if isinstance(value, (datetime, date)):
        return (
            value.date().isoformat()
            if isinstance(value, datetime)
            else value.isoformat()
        )
    if isinstance(value, (int, float)) and value > 0:
        try:
            dt = datetime.fromtimestamp(value, timezone.utc)
            if dt.hour or dt.minute or dt.second:
                dt = dt.astimezone(ZoneInfo(zone or "UTC"))
            return dt.date().isoformat()
        except (ValueError, OSError, OverflowError, ZoneInfoNotFoundError):
            return None
    return None


def yahoo_calendar(symbol):
    t = yf.Ticker(symbol)
    try:
        info = t.info or {}
    except Exception:
        info = {}
    try:
        published = t.calendar or {}
    except Exception:
        published = {}
    if not info.get("symbol") and not published:
        raise ValueError("No company calendar was available from Yahoo Finance.")
    zone = info.get("exchangeTimezoneName", "UTC")

    def fmt(key):
        return yahoo_date(info.get(key), zone)

    dates = published.get("Earnings Date") or []
    window = sorted({d for item in dates if (d := yahoo_date(item, zone))})
    timed = [
        d
        for key in ("earningsTimestampStart", "earningsTimestampEnd")
        if (d := fmt(key))
    ]
    if not window or (timed and window[-1] < date.today().isoformat() <= min(timed)):
        window = sorted(set(timed)) or (
            [fmt("earningsTimestamp")] if fmt("earningsTimestamp") else []
        )
    confirmed = (
        len(window) == 1
        and info.get("isEarningsDateEstimate") is False
        and fmt("earningsTimestamp") == window[0]
    )
    return {
        "name": info.get("longName") or info.get("shortName"),
        "sector": info.get("sector"),
        "industry": info.get("industry"),
        "quote_type": info.get("quoteType"),
        "country": info.get("country"),
        "url": YAHOO + quote(symbol, safe="") + "/",
        "window": window,
        "confirmed": confirmed,
        "dividend": yahoo_date(published.get("Dividend Date")) or fmt("dividendDate"),
        "ex_dividend": yahoo_date(published.get("Ex-Dividend Date"))
        or fmt("exDividendDate"),
        "split": fmt("lastSplitDate"),
        "split_factor": info.get("lastSplitFactor"),
        "fiscal": fmt("lastFiscalYearEnd"),
    }


def fallback_periods(symbol, fiscal):
    if not fiscal:
        raise ValueError("The issuer's fiscal-year anchor was unavailable.")
    frame = yf.Ticker(symbol).quarterly_income_stmt
    if frame is None or frame.empty:
        raise ValueError("No quarterly financial statements were available.")
    end = date.fromisoformat(fiscal)
    periods = []
    for stamp in frame.columns:
        d = stamp.date()
        delta = round((d - end).days / 91.3125)
        if abs((d - end).days - delta * 91.3125) <= 20:
            q = (delta - 1) % 4 + 1
            fy_end = d + timedelta(days=round((4 - q) * 91.3125))
            periods.append([d.isoformat(), q, fy_end.year])
    if not periods:
        raise ValueError(
            "Quarterly dates could not be reconciled to this fiscal-year end."
        )
    return {
        "periods": sorted(periods),
        "url": YAHOO + quote(symbol, safe="") + "/financials/",
        "source": "Yahoo Finance financial statements",
        "inferred_labels": True,
    }


def projected_date(target_year, previous):
    last_day = calendar.monthrange(target_year, previous.month)[1]
    if previous.day == calendar.monthrange(previous.year, previous.month)[1]:
        return date(target_year, previous.month, last_day)
    anchor = date(target_year, previous.month, min(previous.day, last_day))
    return anchor + timedelta(days=(previous.weekday() - anchor.weekday() + 3) % 7 - 3)


def fiscal_events(data, start, end):
    periods = data["periods"]
    if not periods:
        return []
    latest = date.fromisoformat(periods[-1][0])
    by_quarter = {}
    out = []

    def add(d, q, fy, estimated, anchor):
        if not start <= d <= end:
            return
        label = f"year ending {fy}" if data.get("inferred_labels") else f"FY {fy}"
        out.append(
            dict(
                date=d.isoformat(),
                title=f"Q{q} {label} · period end",
                kind="fiscal",
                status="estimated" if estimated else "reported",
                url=data["url"],
                excerpt=f"Last reported Q{q} anchor: {anchor}."
                if estimated
                else f"Quarterly financial statements list a period ending {d}.",
                relevance=(
                    "Estimated from the same fiscal quarter in the latest available reporting cycle. The issuer may change its fiscal calendar."
                    if estimated
                    else "A reported financial-statement period end."
                )
                + " This is a period boundary, not an earnings release date.",
            )
        )

    for stamp, q, fy in periods:
        d = date.fromisoformat(stamp)
        add(d, q, fy, False, stamp)
        by_quarter[q] = (d, fy)
    # Estimate each quarter from its own latest anchor, never from calendar-year quarters.
    # A stopped/discontinued reporter's old statements are not an active calendar.
    if len(by_quarter) != 4 or (date.today() - latest).days > 550:
        return out
    for q, (anchor, old_fy) in by_quarter.items():
        for year in range(max(start.year - 1, anchor.year), end.year + 2):
            d = projected_date(year, anchor)
            if d > latest and year > anchor.year:
                add(d, q, old_fy + year - anchor.year, True, anchor.isoformat())
    return out


def issuer_calendar(data, stats, today):
    """Favor upcoming windows over the last release. A one-day estimate is still an estimate."""
    out = []

    def add(stamp, title, kind, source, url, excerpt, relevance, status, end=None):
        if stamp:
            out.append(
                dict(
                    date=stamp,
                    end_date=end,
                    title=title,
                    kind=kind,
                    status=status,
                    url=url,
                    source=source,
                    excerpt=excerpt,
                    relevance=relevance,
                )
            )

    facts = (stats or {}).get("facts", {})
    yahoo = data or {}
    source, url = "Yahoo Finance company calendar", yahoo.get("url")
    window = yahoo.get("window") or []
    when = facts.get("Earnings Date")
    if when and (not window or window[-1] < today <= when):
        add(
            when,
            "Earnings release",
            "earnings",
            "Stock Analysis",
            stats["url"],
            f"Earnings Date: {when}.",
            "Published earnings calendar date; future dates can change.",
            "reported"
            if when < today and stats.get("reported_earnings") == when
            else "estimated",
        )
    elif window:
        final = window[-1] if len(window) > 1 else None
        status = (
            "reported"
            if yahoo["confirmed"] and window[-1] < today
            else "scheduled"
            if yahoo["confirmed"]
            else "estimated"
        )
        add(
            window[0],
            "Earnings release window" if final else "Earnings release",
            "earnings",
            source,
            url,
            "Earnings Date: "
            + " to ".join(dict.fromkeys([window[0], window[-1]]))
            + ".",
            "The provider lists this reporting date as confirmed."
            if yahoo["confirmed"]
            else "Provider estimate. The publication date may change.",
            status,
            final,
        )
    ex_date = yahoo.get("ex_dividend")
    stat_date = facts.get("Ex-Dividend Date")
    if stat_date and (not ex_date or ex_date < today <= stat_date):
        add(
            stat_date,
            "Ex-dividend date",
            "dividend",
            "Stock Analysis",
            stats["url"],
            f"Ex-Dividend Date: {stat_date}.",
            "Published cutoff for trading without the upcoming dividend.",
            "scheduled" if stat_date >= today else "reported",
        )
    elif ex_date:
        add(
            ex_date,
            "Ex-dividend date",
            "dividend",
            source,
            url,
            f"Ex-Dividend Date: {ex_date}.",
            "Published cutoff for trading without the upcoming dividend.",
            "scheduled" if ex_date >= today else "reported",
        )
    payment = yahoo.get("dividend")
    add(
        payment,
        "Dividend payment date",
        "dividend",
        source,
        url,
        f"Dividend Date: {payment}.",
        "Provider-listed cash distribution date.",
        "scheduled" if payment and payment >= today else "reported",
    )
    split = yahoo.get("split")
    add(
        split,
        "Stock split",
        "company",
        source,
        url,
        f"Split date: {split}. Reported split factor: {yahoo.get('split_factor') or 'not supplied'}.",
        "Share count and quoted price change on a split-adjusted basis.",
        "reported",
    )
    return out


def filing_events(submissions, cik, start, end):
    recent = submissions.get("filings", {}).get("recent", {})
    items = {
        "5.07": "Shareholder voting results filed",
        "2.01": "Asset acquisition or disposition filed",
        "5.02": "Officer or director change filed",
        "1.03": "Bankruptcy or receivership filed",
    }
    out = []
    for form, report, filed, codes, acc, name in zip(
        *(
            recent.get(k, [])
            for k in (
                "form",
                "reportDate",
                "filingDate",
                "items",
                "accessionNumber",
                "primaryDocument",
            )
        )
    ):
        if (
            form != "8-K"
            or not start <= report <= end
            or not re.fullmatch(r"\d{10}-\d{2}-\d{6}", acc)
            or not re.fullmatch(r"[A-Za-z0-9_.-]+\.html?", name, re.I)
        ):
            continue
        for code, title in items.items():
            if code not in [c.strip() for c in codes.split(",")]:
                continue
            out.append(
                dict(
                    date=report,
                    title=title,
                    kind="company",
                    status="reported",
                    url=f"https://www.sec.gov/Archives/edgar/data/{int(cik)}/{acc.replace('-', '')}/{name}",
                    excerpt=f"Form 8-K, item {code}; event date {report}; filing date {filed}; accession {acc}.",
                    relevance="The company reported this material event to the SEC. The marker uses the filing's event date.",
                )
            )
    return out
