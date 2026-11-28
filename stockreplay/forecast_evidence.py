"""Period-specific published estimates and bounded public evidence for an explicit forecast."""

import math
import re
from datetime import date, timedelta
from urllib.parse import quote

import yfinance as yf

from .desk import parallel, safe_url
from .market_events import market_events


def quarterly_consensus(symbol):
    # yfinance's public estimate DataFrames drop Yahoo's endDate. Preserve it from
    # the same earningsTrend payload to avoid assigning annual or undated numbers.
    trend = yf.Ticker(symbol)._analysis._fetch_earnings_trend()
    return parse_estimates(trend, symbol)


def parse_estimates(trend, symbol):
    out = []
    for row in trend.get("trend", []):
        if row.get("period") not in {"0q", "+1q"}:
            continue
        try:
            period = date.fromisoformat(row.get("endDate", "")).isoformat()
        except (TypeError, ValueError):
            continue
        for field, metric, cc in (
            ("earningsEstimate", "EPS", "earningsCurrency"),
            ("revenueEstimate", "Revenue", "revenueCurrency"),
        ):
            group = row.get(field) or {}
            n = (group.get("numberOfAnalysts") or {}).get("raw")
            value = (group.get("avg") or {}).get("raw")
            currency = group.get(cc)
            if not (
                isinstance(n, (float, int))
                and n > 0
                and isinstance(value, (float, int))
                and math.isfinite(value)
                and isinstance(currency, str)
                and re.fullmatch("[A-Z]{3}", currency)
            ):
                continue
            year_key = "yearAgoEps" if metric == "EPS" else "yearAgoRevenue"
            comparison = (group.get(year_key) or {}).get("raw")
            previous = (
                comparison
                if isinstance(comparison, (int, float)) and math.isfinite(comparison)
                else None
            )
            out.append(
                {
                    "period": period,
                    "metric": metric,
                    "value": value,
                    "analysts": int(n),
                    "year_ago": previous,
                    "unit": currency + "/share" if metric == "EPS" else currency,
                    "url": f"https://finance.yahoo.com/quote/{quote(symbol, safe='')}/analysis/",
                }
            )
    return out


def evidence_packet(desk, baseline):
    symbol = baseline["symbol"]
    anchor = date.fromisoformat(baseline.get("horizon_origin") or baseline["as_of"])
    end = min(
        max(date.fromisoformat(baseline["points"][-1]["date"]), anchor + timedelta(days=380)),
        anchor + timedelta(days=730),
    )
    results = parallel(
        {
            "brief": lambda: desk.briefing(symbol),
            "events": lambda: market_events(desk.cache, [symbol], anchor, end),
            "consensus": lambda: desk.cache.get(
                "forecast:quarterly-consensus:v1:" + symbol,
                14400,
                lambda: quarterly_consensus(symbol),
                False,
            ),
        }
    )
    return assemble(baseline, results["brief"], results["events"], results["consensus"])


def estimate_amount(value, metric):
    if metric == "Revenue":
        for unit, scale in (("billion", 1e9), ("million", 1e6)):
            if abs(value) >= scale:
                return f"{value / scale:,.2f} {unit}"
        return f"{value:,.0f}"
    return f"{value:,.2f}"


def assemble(baseline, brief, agenda, consensus):
    sources = []

    def add(title, url, publisher, day, kind, detail, date_basis=None, **metadata):
        if not safe_url(url):
            return None
        sid = "S" + str(len(sources) + 1)
        sources.append(
            dict(
                id=sid,
                title=title[:240],
                url=url,
                source=publisher,
                date=day,
                kind=kind,
                excerpt=detail[:450],
                date_basis=date_basis,
                **{key: value for key, value in metadata.items() if value},
            )
        )
        return sid

    anchor = baseline["as_of"]
    last = baseline["points"][0]["median"]
    add(
        baseline["symbol"] + " observed market prices",
        baseline.get("anchor_url") or baseline["url"],
        baseline.get("anchor_source") or baseline["source"],
        anchor,
        "price",
        (
            f"Regular-session bar beginning {baseline['anchor_time']}"
            if baseline.get("anchor_kind") == "intraday"
            else "Published daily close " + anchor
        )
        + f" {last:.4g} {baseline['currency'] or ''}. Observed annualized volatility {baseline['annualized_volatility_pct']:.1f}%.",
    )
    # Reserve context for each subject, including issuer filings and independent web/news coverage.
    counts = {}
    groups = {
        "price",
        "company_news",
        "web_news",
        "ollama_web_news",
        "company_filings",
        "fundamentals",
        "valuation",
        "estimates",
        "risk",
        "market",
        "sector",
        "market_news",
        "sector_news",
        "macro_news",
        "relative",
        "financials",
        "earnings",
        "growth",
    }
    for e in brief.get("evidence", []):
        g = e.get("group")
        if g not in groups or counts.get(g, 0) >= (
            2
            if g in {"company_news", "web_news", "ollama_web_news", "company_filings", "estimates"}
            else 1
        ):
            continue
        if e.get("names_company") is False and g in {"company_news", "web_news", "ollama_web_news"}:
            continue
        sid = add(
            e.get("text", ""),
            e.get("url"),
            e.get("source", ""),
            e.get("date"),
            g,
            e.get("excerpt") or e.get("text", ""),
            e.get("date_origin") or e.get("date_kind"),
            scope=e.get("scope"),
            discovered_via=e.get("discovered_via"),
            checked_at=e.get("checked_at") or e.get("checked"),
        )
        if sid:
            counts[g] = counts.get(g, 0) + 1

    quarters = {
        f"Q{n}": {
            "quarter": f"Q{n}",
            "period": None,
            "date": None,
            "date_kind": None,
            "timing": "unavailable",
            "consensus": [],
            "source_ids": [],
        }
        for n in range(1, 5)
    }
    for event in sorted(agenda.get("events", []), key=lambda e: e["date"]):
        if event["date"] < anchor:
            continue
        k = event["kind"]
        q = (
            re.match(r"^(Q[1-4])\s+(.+?)\s*·\s*period end$", event["title"])
            if k == "fiscal"
            else None
        )
        if q and quarters[q[1]]["date"]:
            continue
        if not q and counts.get(k, 0) >= (2 if k in {"earnings", "regulatory"} else 1):
            continue
        detail = " ".join([event["status"], event.get("excerpt", ""), event.get("relevance", "")])
        sid = add(
            event["title"],
            event["url"],
            event["source"],
            event["date"],
            k,
            detail,
            "event",
            status=event["status"],
            checked_at=event.get("checked_at"),
        )
        if not sid:
            continue
        counts[k] = counts.get(k, 0) + 1
        if q:
            quarters[q[1]].update(
                period=q[0].split(" ·")[0],
                date=event["date"],
                date_kind="period_end",
                timing="estimated" if event["status"] == "estimated" else "reported",
                source_ids=[sid],
            )
    for metric in consensus.get("data") or []:
        if consensus.get("stale"):
            continue
        ending = date.fromisoformat(metric["period"])
        # 52/53-week issuers can close a few days before a publisher's month-end period label.
        matches = [
            q
            for q in quarters.values()
            if q["date"]
            and q["date"][:7] == metric["period"][:7]
            and abs((date.fromisoformat(q["date"]) - ending).days) <= 7
        ]
        if len(matches) != 1:
            continue
        label = f"{metric['metric']} consensus · period ending {metric['period']}"
        previous = metric.get("year_ago")

        fact = (
            f"{metric['analysts']} analysts estimate {metric['metric']} of {estimate_amount(metric['value'], metric['metric'])} {metric['unit']} "
            f"for the period ending {metric['period']}"
        )
        if previous is not None:
            fact += f", compared with {estimate_amount(previous, metric['metric'])} {metric['unit']} in the same quarter a year earlier"
        sid = add(
            label,
            metric["url"],
            "Yahoo Finance analyst estimates",
            consensus.get("fetched"),
            "consensus",
            fact + ".",
            "retrieved",
            comparison_available=previous is not None,
        )
        if not sid:
            continue
        matches[0]["consensus"].append(
            {k: v for k, v in metric.items() if k != "url"} | {"source_id": sid}
        )
        matches[0]["source_ids"].append(sid)
    return sources, quarters
