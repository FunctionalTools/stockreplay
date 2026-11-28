"""Period-specific published estimates and bounded public evidence for an explicit forecast."""

import math
import re
from datetime import date, timedelta
from urllib.parse import quote

import yfinance as yf

from .desk import parallel, safe_url
from .forecast_scores import observed_day
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
        if not (
            safe_url(url)
            and observed_day(day)
            and isinstance(title, str)
            and title.strip()
            and isinstance(publisher, str)
            and publisher.strip()
        ):
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
    volatility = baseline.get("annualized_volatility_pct")
    volatility_note = (
        f" Observed annualized volatility {volatility:.1f}%."
        if volatility is not None
        else " There were too few observed price changes to estimate volatility."
    )
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
        + f" {last:.4g} {baseline['currency'] or ''}."
        + volatility_note,
    )
    features = baseline.get("model_inputs", {})
    vol, draw = features.get("volatility_21d_pct"), features.get("drawdown_63d_pct")
    if (
        features.get("kind") != "last_price_reference"
        and isinstance(vol, (int, float))
        and isinstance(draw, (int, float))
        and math.isfinite(vol)
        and math.isfinite(draw)
    ):
        add(
            baseline["symbol"] + " observed price risk",
            baseline["url"],
            baseline["source"],
            baseline.get("confirmed_close_date") or anchor,
            "risk",
            f"21-session annualized price volatility {vol:.1f}%. Last observed close {abs(draw):.1f}% below its 63-session high.",
            "close",
            factor="price_risk",
            measured_price_risk=True,
            volatility_21d_pct=round(vol, 2),
            drawdown_63d_pct=round(draw, 2),
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
        "technical",
        "analysts",
    }
    for e in brief.get("evidence", []):
        g = e.get("group")
        category = (
            (g, e.get("factor")) if g in {"fundamentals", "risk", "estimates", "technical"} else g
        )
        if g not in groups or counts.get(category, 0) >= (
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
            original_id=e.get("id"),
            factor=e.get("factor"),
            stale=e.get("stale"),
            period_end=e.get("period_end"),
            scope=e.get("scope"),
            discovered_via=e.get("discovered_via"),
            checked_at=e.get("checked_at") or e.get("checked"),
        )
        if sid:
            counts[category] = counts.get(category, 0) + 1

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


def local_forecast_sources(sources, quarters, scores):
    """Give a small installed model a cross-section of the actual evidence. Keep the full archive."""
    selected = {}
    if scores:
        required = set(scores["buy_source_ids"] + scores["risk_source_ids"])
        selected.update((s["id"], s) for s in sources if s["id"] in required)
    history = next((s for s in sources if s.get("measured_price_risk")), None)
    if history:
        selected[history["id"]] = history
    for quarter in quarters.values():
        consensus = [
            s for s in sources if s["kind"] == "consensus" and s["id"] in quarter["source_ids"]
        ]
        if consensus:
            source = max(consensus, key=lambda s: bool(s.get("comparison_available")))
            selected[source["id"]] = source

    def category(s):
        if s.get("date_basis") == "event":
            return "scheduled" if s["kind"] == "earnings" else s["kind"] + "_calendar"
        if s["kind"] in {"price", "ollama_web_news"}:
            return s["kind"]
        return s.get("factor") or s["kind"]

    # Select one fact per subject before taking a second article or quarterly estimate.
    subjects = (
        "price",
        "ollama_web_news",
        "company_news",
        "filings",
        "growth",
        "price_risk",
        "valuation",
        "balance_sheet",
        "targets",
        "analysts",
        "sector",
        "governance",
        "scheduled",
        "web_news",
        "regulatory_calendar",
        "market",
        "profitability",
        "sensitivity",
        "cash_flow",
        "earnings",
    )
    for topic in subjects:
        choices_ = [s for s in sources if category(s) == topic and s["id"] not in selected]
        if not choices_:
            continue
        source = max(
            choices_,
            key=lambda s: (
                s.get("scope") in {"Filing passage", "Article passage"},
                s.get("discovered_via") == "Ollama Web Search",
                bool(s.get("comparison_available")),
                s["kind"] == "price" and "return" in s["title"].lower(),
                s.get("date", ""),
            ),
        )
        selected[source["id"]] = source
        if len(selected) >= 16:
            break
    if not selected:
        return sources[:16]
    return list(selected.values())


def local_source_row(source):
    fact = source["excerpt"] or source["title"]
    fact = re.sub(r"https?://\S+", "", fact).strip() or source["title"]
    # Preserve exact magnitudes, units and comparison dates. Prefer one complete
    # publisher sentence instead of repeating titles, URLs and retrieval metadata.
    if source["kind"] == "consensus":
        fact = source["excerpt"]
    elif len(fact) > 185:
        sentence = re.search(r"[.!?](?=\s|$)", fact[55:185])
        fact = fact[: 55 + sentence.end()] if sentence else fact[:182].rsplit(" ", 1)[0] + "…"
    return {
        "id": source["id"],
        "kind": source["kind"],
        "date": source["date"][:10],
        "fact": fact,
        **{k: source[k] for k in ("scope", "date_basis", "discovered_via") if source.get(k)},
    }
