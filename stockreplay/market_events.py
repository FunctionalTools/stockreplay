"""Aggregate observed public calendars; every date retains its source and retrieval time."""

import calendar
import hashlib
from concurrent.futures import ThreadPoolExecutor
from datetime import date
from functools import partial

from . import company_events as company
from . import event_policy as policy
from .sec_research import sec_submissions, sec_tickers
from .store import now


def market_events(cache, symbols, start, end, refresh=False):
    if not 1 <= len(symbols) <= 8:
        raise ValueError("Choose between one and eight symbols.")
    if end < start or (end - start).days > 2192:
        raise ValueError("Choose an ordered calendar range of up to six years.")
    today = date.today().isoformat()
    checked_at = now()
    events, gaps = {}, {}

    def gap(source, selected, reason):
        key = (source, reason)
        gaps.setdefault(key, set()).update(selected)

    def read(key, ttl, load):
        return cache.get(key, ttl, load, refresh)

    def observed(packet, source, selected):
        if packet["error"]:
            gap(
                source,
                selected,
                (
                    f"Using data retrieved {packet['fetched'][:10]}. "
                    if packet["stale"]
                    else ""
                )
                + packet["error"],
            )
        return packet["data"]

    def collect(rows, packet, source, selected):
        for item in rows:
            if (
                item["date"] > end.isoformat()
                or (item.get("end_date") or item["date"]) < start.isoformat()
            ):
                continue
            symbol_key = ",".join(sorted(selected))
            # SEC, Register and exchange source identifiers survive future title or excerpt edits.
            ident = "|".join(
                [item["kind"], item["date"], item["url"], item["title"], symbol_key]
            )
            uid = hashlib.sha256(ident.encode()).hexdigest()[:20]
            events[uid] = {
                **item,
                "source": item.get("source") or source,
                "id": uid,
                "symbols": sorted(selected),
                "checked_at": packet["fetched"],
                "stale": packet["stale"],
            }

    jobs = {
        "fomc": ("calendar:fomc:v1", 21600, policy.fomc_events),
        "budget": ("calendar:budget:v1", 86400, policy.budget_table),
        "senate": ("calendar:senate:v1", 1800, policy.senate_agendas),
        "sec": ("sec/tickers", 86400, sec_tickers),
    }
    for s in symbols:
        jobs[s, "company"] = (
            "calendar:company:v2:" + s,
            10800,
            partial(company.yahoo_calendar, s),
        )
        jobs[s, "quarters"] = (
            "calendar:quarters:v1:" + s,
            43200,
            partial(company.fetch_quarters, s),
        )
        jobs[s, "stats"] = (
            "calendar:stats:v2:" + s,
            21600,
            partial(company.fetch_statistics, s),
        )

    with ThreadPoolExecutor(max_workers=8) as pool:

        def gather(tasks):
            pending = {k: pool.submit(read, *args) for k, args in tasks.items()}
            return {k: future.result() for k, future in pending.items()}

        packets = gather(jobs)
        fed = observed(packets["fomc"], "Federal Reserve", []) or []
        collect(fed, packets["fomc"], "Federal Reserve", [])
        if fed and end.isoformat() > max(e["end_date"] for e in fed):
            gap(
                "Federal Reserve",
                [],
                "The selected range extends beyond the Fed's published meeting calendar.",
            )
        budget = observed(packets["budget"], "U.S. Code · GovInfo", [])
        if budget:
            collect(
                policy.budget_events(budget, start, end),
                packets["budget"],
                "U.S. Code · GovInfo",
                [],
            )
        ciks = observed(packets["sec"], "SEC EDGAR", symbols) or {}
        second = {}
        profiles = {}
        agencies = set(policy.BROAD)
        # Monthly bounds let adjacent views share the same government search in the local cache.
        month_start = start.replace(day=1)
        month_end = end.replace(day=calendar.monthrange(end.year, end.month)[1])
        for s in symbols:
            p = packets[s, "company"]
            profile = observed(p, "Yahoo Finance", [s]) or {}
            profiles[s] = profile
            if name := profile.get("name"):
                second[s, "rules"] = (
                    f"calendar:issuer-rules:v1:{s}:{name}:{month_start}:{month_end}",
                    21600,
                    partial(policy.register_rules, (), month_start, month_end, name),
                )
            sector = profile.get("sector")
            if sector in policy.SECTORS:
                agencies.update(policy.SECTORS[sector][1])
            elif not sector:
                gap(
                    "Federal Register",
                    [s],
                    "A verified sector was unavailable. Only company-name matches and broad US policy are considered.",
                )
            quarters = packets[s, "quarters"]
            statement = observed(quarters, "Stock Analysis financial statements", [s])
            stats = packets[s, "stats"]
            facts = observed(stats, "Stock Analysis calendar", [s])
            dates = company.issuer_calendar(profile, facts, today)
            for entry in dates:
                evidence = stats if entry["source"] == "Stock Analysis" else p
                collect([entry], evidence, entry["source"], [s])
            if not any(
                e["kind"] == "earnings" and (e.get("end_date") or e["date"]) >= today
                for e in dates
            ):
                gap(
                    "Earnings calendar",
                    [s],
                    "No upcoming earnings release date was available from the checked calendars.",
                )
            if not any(e["kind"] == "dividend" and e["date"] >= today for e in dates):
                gap(
                    "Dividend calendar",
                    [s],
                    "No upcoming dividend date was published in the checked calendars.",
                )
            if statement:
                collect(
                    company.fiscal_events(statement, start, end),
                    quarters,
                    statement["source"],
                    [s],
                )
            elif profile.get("fiscal"):
                second[s, "fallback"] = (
                    "calendar:fiscal-fallback:v1:" + s,
                    43200,
                    partial(company.fallback_periods, s, profile["fiscal"]),
                )
            cik = ciks.get(s) or ciks.get(s.replace(".", "-"))
            if cik and start.isoformat() <= today:
                second[s, "sec"] = (
                    f"sec/submissions/{cik}",
                    3600,
                    partial(sec_submissions, cik),
                )

        agenda = observed(packets["senate"], "U.S. Senate committee schedule", symbols)
        if agenda is not None:
            matches = 0
            for row in agenda:
                if start.isoformat() <= row["date"] <= end.isoformat() and (
                    event := policy.senate_event(row, profiles)
                ):
                    selected, milestone = event
                    collect(
                        [milestone],
                        packets["senate"],
                        "U.S. Senate committee schedule",
                        selected,
                    )
                    matches += 1
            if not matches:
                gap(
                    "U.S. Senate committee schedule",
                    symbols,
                    "No dated hearing or bill consideration matching the selected companies or industries appeared in the published agenda for this range.",
                )
        ag = tuple(sorted(agencies))
        second["rules"] = (
            f"calendar:rules:v1:{month_start}:{month_end}:{','.join(ag)}",
            21600,
            partial(policy.register_rules, ag, month_start, month_end),
        )
        rules_checked = False
        included = False
        for key, packet in gather(second).items():
            if key == "rules" or key[1] == "rules":
                scope = symbols if key == "rules" else [key[0]]
                data = observed(packet, "Federal Register", scope)
                if data is None:
                    continue
                rules_checked = True
                for item in data["rows"]:
                    selected, relevance = policy.rule_scope(item, profiles)
                    if relevance:
                        record = {
                            k: v
                            for k, v in item.items()
                            if k not in ("agencies", "abstract")
                        }
                        collect(
                            [{**record, "relevance": relevance}],
                            packet,
                            "Federal Register",
                            selected,
                        )
                        included |= (
                            start.isoformat() <= record["date"] <= end.isoformat()
                        )
                if data["partial"]:
                    gap(
                        "Federal Register",
                        scope,
                        "Coverage is limited to the newest 200 published final rules per agency or issuer search.",
                    )
                continue
            s, kind = key
            if kind == "sec":
                filings = observed(packet, "SEC EDGAR", [s])
                if filings:
                    rows = company.filing_events(
                        filings,
                        ciks.get(s) or ciks[s.replace(".", "-")],
                        start.isoformat(),
                        end.isoformat(),
                    )
                    collect(rows, packet, "SEC EDGAR", [s])
            elif statement := observed(
                packet, "Yahoo Finance financial statements", [s]
            ):
                collect(
                    company.fiscal_events(statement, start, end),
                    packet,
                    statement["source"],
                    [s],
                )

    if rules_checked and not included:
        gap(
            "Federal Register",
            symbols,
            "No matching final rule with a dated effective milestone was found in the checked agency and issuer results.",
        )

    return {
        "start": start.isoformat(),
        "end": end.isoformat(),
        "checked_at": checked_at,
        "events": sorted(
            events.values(), key=lambda e: (e["date"], e["kind"], e["title"], e["id"])
        ),
        "gaps": [
            {"source": source, "symbols": sorted(selected), "reason": reason}
            for (source, reason), selected in gaps.items()
        ],
    }


def register_events(router, desk, ticker):
    @router.get("/desk/events")
    def events(symbols: str, start: date, end: date, refresh: bool = False):
        batch = list(dict.fromkeys(ticker(s) for s in symbols.split(",")))
        return market_events(desk.cache, batch, start, end, refresh)
