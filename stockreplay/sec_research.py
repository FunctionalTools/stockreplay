"""Lookup, search and read SEC filings by the public issuer identifier."""

from datetime import date, timedelta
import json
import re
from urllib.parse import urlencode

from .source_reader import best_passage, filing_document, published, read_public


def sec_json(url, limit=1_600_000):
    return json.loads(read_public(url, limit=limit, accept="application/json"))


def sec_tickers():
    return {
        row["ticker"].upper(): int(row["cik_str"])
        for row in sec_json("https://www.sec.gov/files/company_tickers.json").values()
        if row.get("ticker")
    }


def sec_submissions(cik):
    return sec_json(f"https://data.sec.gov/submissions/CIK{int(cik):010}.json", 8_000_000)


def filings_list(data):
    recent = data.get("filings", {}).get("recent", {})
    return [
        {
            field: values[i]
            for field, values in recent.items()
            if isinstance(values, list) and len(values) > i
        }
        for i, form in enumerate(recent.get("form", []))
        if form in ("10-Q", "10-K", "20-F", "40-F", "6-K")
    ]


def search_filings(cik, terms):
    today = date.today()
    query = urlencode(
        {
            "ciks": f"{cik:010}",
            "q": " ".join(terms),
            "forms": "10-Q,10-K,20-F,40-F,6-K",
            "dateRange": "custom",
            "startdt": str(today - timedelta(days=550)),
            "enddt": str(today),
            "from": 0,
            "size": 12,
        }
    )
    hits = (
        sec_json("https://efts.sec.gov/LATEST/search-index?" + query)
        .get("hits", {})
        .get("hits", [])
    )
    return [h.get("_source", {}).get("adsh") for h in hits]


def original(cik, row):
    accession = row.get("accessionNumber", "")
    doc = row.get("primaryDocument", "")
    if (
        re.fullmatch(r"\d{10}-\d{2}-\d{6}", accession)
        and re.fullmatch(r"[\w-][\w.-]*\.html?", doc, re.I)
        and published(row.get("filingDate"))
    ):
        return f"https://www.sec.gov/Archives/edgar/data/{cik}/{accession.replace('-', '')}/{doc}"
    return None


def sec_lookup(symbol, terms, cache, refresh):
    directory = cache.get("sec/tickers", 86400, sec_tickers, refresh)
    cik = (directory["data"] or {}).get(symbol.upper().replace(".", "-"))
    if not cik:
        if directory["error"]:
            raise ValueError(directory["error"])
        return [], ["No SEC issuer matched this ticker."]
    submissions = cache.get(f"sec/submissions/{cik}", 3600, lambda: sec_submissions(cik), refresh)
    if not submissions["data"]:
        raise ValueError(submissions["error"] or "SEC issuer submissions unavailable.")
    data = submissions["data"]
    rows = filings_list(data)
    notes = [p["error"] for p in (directory, submissions) if p["error"]]
    if terms:
        hits = cache.get(
            f"sec/search/{cik}/{'-'.join(terms)}", 3600, lambda: search_filings(cik, terms), refresh
        )
        matches = set(hits["data"] or [])
        if matches:
            rows.sort(key=lambda row: row.get("accessionNumber") not in matches)
        elif hits["error"]:
            notes.append("Full-text search was unavailable; the latest filing was checked.")
        else:
            notes.append("No matching filing in full-text search; the latest filing was checked.")
    records = []
    issuer = data.get("name") or symbol
    for row in rows[:1]:
        url = original(cik, row)
        if not url:
            continue
        accession = row["accessionNumber"]
        document = cache.get(
            "sec/passages/v1/" + str(cik) + "/" + accession,
            86400,
            lambda: filing_document(url),
            refresh,
        )
        if document["error"]:
            notes.append(document["error"])
        lines = document["data"] or []
        # Preserve original wording. Query topics choose a filing passage; the default looks for financial changes or risk.
        words = terms or (
            "revenue",
            "increased",
            "decreased",
            "operating",
            "cash",
            "quarter",
            "risk",
        )
        excerpt = best_passage(lines, words)
        if excerpt:
            records.append(
                {
                    "group": "company_filings",
                    "factor": "filings",
                    "text": f"{issuer} · {row['form']} for {row.get('reportDate') or row['filingDate']}",
                    "excerpt": excerpt,
                    "date": published(row["filingDate"]),
                    "url": url,
                    "source": "SEC EDGAR",
                    "scope": "Filing passage",
                    "date_origin": "SEC filing date",
                    "checked": document["fetched"],
                    "stale": any(p["stale"] for p in (directory, submissions, document)),
                    "discovered_via": "SEC EDGAR full-text search"
                    if terms and accession in matches
                    else "SEC issuer submissions",
                }
            )
    if records:
        return records, notes
    # If the narrative archive is restricted, use an actual dated XBRL fact from the same issuer.
    facts = cache.get(
        f"sec/assets/{cik}",
        21600,
        lambda: sec_json(
            f"https://data.sec.gov/api/xbrl/companyconcept/CIK{cik:010}/us-gaap/Assets.json",
            2_000_000,
        ),
        refresh,
    )
    if facts["error"]:
        notes.append(facts["error"])
    accessions = {r["accessionNumber"]: r for r in rows}
    for unit, entries in (facts["data"] or {}).get("units", {}).items():
        for fact in sorted(
            entries, key=lambda x: (x.get("end", ""), x.get("filed", "")), reverse=True
        ):
            row = accessions.get(fact.get("accn"))
            day = published(fact.get("filed"))
            if (
                not row
                or not day
                or not isinstance(fact.get("val"), (int, float))
                or not (url := original(cik, row))
            ):
                continue
            return [
                {
                    "group": "company_filings",
                    "factor": "balance_sheet",
                    "text": f"{issuer} · reported assets",
                    "excerpt": f"Reported total assets of {unit} {fact['val']:,} for the period ending {fact['end']}.",
                    "source": "SEC EDGAR XBRL",
                    "url": url,
                    "date": day,
                    "date_origin": "SEC filing date",
                    "scope": "Filed financial fact",
                    "discovered_via": "SEC company facts",
                    "checked": facts["fetched"],
                    "stale": facts["stale"],
                    "related": [
                        {
                            "label": "SEC structured fact",
                            "url": f"https://data.sec.gov/api/xbrl/companyconcept/CIK{cik:010}/us-gaap/Assets.json",
                        }
                    ],
                }
            ], notes
    return [], notes
