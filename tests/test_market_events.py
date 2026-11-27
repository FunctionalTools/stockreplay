import os
from datetime import date, timedelta
from urllib.parse import urlsplit

import httpx
import pytest
from fastapi.testclient import TestClient

from stockreplay import (
    company_events as company,
    event_policy as policy,
    market_events as feed,
)
from stockreplay.api import create_app


def page(url, html):
    return httpx.Response(200, text=html, request=httpx.Request("GET", url))


def test_reported_periods_and_rollover_match_non_calendar_fiscal_year(monkeypatch):
    this = date.today().year
    year = this - 1
    # A Japanese March fiscal year. Dual-width publisher labels contain a real date and abbreviated duplicate.
    html = f"""<table><tr><th>Fiscal Quarter</th><th>Q4 {this}</th><th>Q3 {this}</th><th>Q2 {this}</th><th>Q1 {this}</th></tr>
        <tr><th>Period Ending</th><th>Mar 31, {this}</th><th>Dec '{str(year)[-2:]} Dec 31, {year}</th>
        <th>Sep 30, {year}</th><th>Jun 30, {year}</th></tr></table>"""
    monkeypatch.setattr(company, "fetch_url", lambda u: page(u, html))
    statement = company.fetch_quarters("7203.T")
    assert statement["url"].startswith("https://stockanalysis.com/quote/tyo/7203/")
    rows = company.fiscal_events(statement, date(year, 1, 1), date(this + 1, 3, 31))
    actual = next(e for e in rows if e["date"] == f"{this}-03-31")
    projected = next(e for e in rows if e["date"] == f"{this}-06-30")
    assert (
        actual["title"] == f"Q4 FY {this} · period end"
        and actual["status"] == "reported"
    )
    assert (
        projected["title"] == f"Q1 FY {this + 1} · period end"
        and projected["status"] == "estimated"
    )
    assert (
        projected["kind"] == "fiscal"
        and "not an earnings release date" in projected["relevance"]
    )
    assert len({x["date"] for x in rows}) == len(rows)


def test_independent_earnings_windows_and_dividends():
    profile = {
        "window": ["2027-01-28", "2027-02-01"],
        "confirmed": False,
        "url": "https://finance.yahoo.com/quote/AAPL/",
        "dividend": "2026-12-22",
        "ex_dividend": "2026-12-01",
    }
    rows = company.issuer_calendar(profile, None, "2026-11-27")
    assert [(e["kind"], e["status"]) for e in rows] == [
        ("earnings", "estimated"),
        ("dividend", "scheduled"),
        ("dividend", "scheduled"),
    ]
    assert rows[0]["end_date"] == "2027-02-01"
    assert rows[1]["date"] == "2026-12-01" and rows[2]["date"] == "2026-12-22"
    stats = {
        "url": "https://stockanalysis.com/quote/tyo/7203/statistics/",
        "facts": {"Earnings Date": "2027-02-03"},
    }
    fallback = company.issuer_calendar({}, stats, "2026-11-27")
    assert (
        fallback[0]["source"] == "Stock Analysis"
        and fallback[0]["status"] == "estimated"
    )
    assert company.issuer_calendar({}, None, "2026-11-27") == []


def test_official_meeting_spans_and_statutory_deadlines(monkeypatch):
    fomc = """<div class="panel"><div class="panel-heading"><h4>2027 FOMC Meetings</h4></div><div class="fomc-meeting">
    <div class="fomc-meeting__month">Jan/Feb</div><div class="fomc-meeting__date">31-1*</div></div></div>"""
    monkeypatch.setattr(policy, "fetch_url", lambda u: page(u, fomc))
    rows = policy.fomc_events()
    assert (rows[0]["date"], rows[0]["end_date"]) == ("2027-01-31", "2027-02-01")
    text = """<table><th>Action to be completed:</th><tr><td>First Monday in February</td><td>President submits his budget.</td></tr>
    <tr><td>Not later than 6 weeks after President submits budget</td><td>Committees submit views.</td></tr></table>"""
    monkeypatch.setattr(policy, "fetch_url", lambda u: page(u, text))
    deadlines = policy.budget_events(
        policy.budget_table(), date(2026, 1, 1), date(2027, 3, 1)
    )
    assert [d["date"] for d in deadlines] == ["2026-02-02", "2027-02-01"]
    assert all(
        "statutory target" in d["relevance"] and d["url"] == policy.BUDGET
        for d in deadlines
    )


def test_register_validates_effective_date_official_url_and_scope(monkeypatch):
    row = {
        "title": "Bank capital requirements",
        "type": "Rule",
        "dates": "Effective December 1, 2026.",
        "effective_on": "2026-12-01",
        "html_url": "https://www.federalregister.gov/documents/2026/11/01/2026-12345/bank-capital",
        "abstract": "Banks and capital requirements.",
        "agencies": [{"slug": "federal-reserve-system"}],
    }

    def request(url, params):
        assert params["conditions[type][]"] == "RULE"
        return httpx.Response(
            200,
            json={
                "total_pages": 1,
                "results": [
                    row,
                    {**row, "type": "Proposed Rule"},
                    {**row, "effective_on": None},
                    {**row, "html_url": "https://unrelated.example/"},
                ],
            },
        )

    monkeypatch.setattr(policy, "fetch_url", request)
    out = policy.register_rules(
        ["federal-reserve-system"], date(2026, 11, 1), date(2027, 1, 31)
    )
    assert len(out["rows"]) == 1 and not out["partial"]
    symbols, reason = policy.rule_scope(
        out["rows"][0],
        {"JPM": {"sector": "Financial Services"}, "NVDA": {"sector": "Technology"}},
    )
    assert symbols == ["JPM"] and "sector" in reason


def test_calendar_endpoint_isolates_failures_validates_limits_and_reuses_last_check(
    tmp_path, monkeypatch
):
    app = create_app(tmp_path)
    day = date.today()
    stamp = day.isoformat()

    def missing(*args):
        raise ValueError("Calendar not published.")

    monkeypatch.setattr(feed, "sec_tickers", lambda: {})
    monkeypatch.setattr(policy, "senate_agendas", lambda: [])
    monkeypatch.setattr(company, "fetch_quarters", missing)
    monkeypatch.setattr(company, "fetch_statistics", missing)
    monkeypatch.setattr(
        company,
        "yahoo_calendar",
        lambda s: {
            "name": s,
            "sector": "Technology",
            "url": "https://finance.yahoo.com/quote/" + s + "/",
            "window": [stamp],
            "confirmed": True,
        },
    )
    monkeypatch.setattr(policy, "fomc_events", missing)
    monkeypatch.setattr(policy, "budget_table", missing)
    monkeypatch.setattr(
        policy, "register_rules", lambda *args: {"rows": [], "partial": False}
    )
    params = {
        "symbols": "nvda,NVDA",
        "start": stamp,
        "end": (day + timedelta(weeks=5)).isoformat(),
    }
    with TestClient(app) as c:
        results = c.get("/api/desk/events", params=params).json()
        (row,) = results["events"]
        assert (
            row["status"] == "scheduled"
            and row["symbols"] == ["NVDA"]
            and row["checked_at"]
        )
        assert {
            "Federal Reserve",
            "U.S. Code · GovInfo",
            "Stock Analysis calendar",
        } <= {g["source"] for g in results["gaps"]}
        monkeypatch.setattr(company, "yahoo_calendar", missing)
        repeated = c.get(
            "/api/desk/events", params={**params, "refresh": "true"}
        ).json()
        assert repeated["events"] == [{**row, "stale": True}]
        assert any("Using data retrieved" in g["reason"] for g in repeated["gaps"])
        for change in (
            {"end": "2000-01-01"},
            {"symbols": "bad/symbol"},
            {"symbols": "A,B,C,D,E,F,G,H,I"},
            {"end": (day + timedelta(days=2400)).isoformat()},
        ):
            assert (
                c.get("/api/desk/events", params={**params, **change}).status_code
                == 422
            )


def test_sec_material_event_uses_reported_date_and_real_accession():
    docs = {
        "filings": {
            "recent": {
                "form": ["8-K"],
                "reportDate": ["2026-06-20"],
                "filingDate": ["2026-06-22"],
                "items": ["5.07,9.01"],
                "accessionNumber": ["0000320193-26-000123"],
                "primaryDocument": ["aapl-20260620.htm"],
            }
        }
    }
    (event,) = company.filing_events(docs, 320193, "2026-06-01", "2026-06-30")
    assert (
        event["date"] == "2026-06-20" and "filing date 2026-06-22" in event["excerpt"]
    )
    assert (
        event["url"]
        == "https://www.sec.gov/Archives/edgar/data/320193/000032019326000123/aapl-20260620.htm"
    )


def test_senate_agenda_keeps_bill_and_hearing_subjects_attached_to_confirmed_meeting_dates(
    monkeypatch,
):
    def hearing(identifier, kind, subject, day="2026-12-01"):
        return f"""<meeting><identifier>{identifier}</identifier><committee>Homeland Security</committee>
        <type>{kind}</type><date_iso_8601>{day}</date_iso_8601><matter>{subject}</matter></meeting>"""

    xml = (
        "<css_meetings_scheduled>"
        + "".join(
            [
                hearing(
                    "2",
                    "Open Business Meeting",
                    "Business meeting to consider S.42, to regulate nitrile glove procurement, S.300, to amend park boundaries, and the nomination of someone.",
                ),
                hearing(
                    "3",
                    "Open Hearing",
                    "Oversight hearings to examine United States export controls.",
                    "2026-12-03",
                ),
                hearing("4", "Canceled Open Hearing", "Hearing on export controls."),
                hearing("", "Open Hearing", "No committee hearings scheduled"),
                hearing("5", "Open Hearing", "Undated hearing on nitrile gloves", ""),
            ]
        )
        + "</css_meetings_scheduled>"
    )
    monkeypatch.setattr(policy, "fetch_url", lambda u: page(u, xml))
    agendas = policy.senate_agendas()
    assert len(agendas) == 3
    profiles = {
        "MED": {"sector": "Healthcare", "industry": "Medical Devices"},
        "NVDA": {"sector": "Technology", "industry": "Semiconductors"},
    }
    selected, bill = policy.senate_event(agendas[0], profiles)
    assert (
        selected == ["MED"]
        and bill["status"] == "scheduled"
        and bill["kind"] == "legislative"
    )
    assert "S.42" in bill["excerpt"] and "S.300" not in bill["excerpt"]
    assert "enactment" in bill["relevance"] and bill["url"] == policy.SENATE
    assert policy.senate_event(agendas[1], profiles) is None
    selected, oversight = policy.senate_event(agendas[2], profiles)
    assert selected == ["NVDA"] and oversight["date"] == "2026-12-03"


def test_industry_specific_rule_filter_and_issuer_names_avoid_unrelated_businesses():
    companies = {
        "AAPL": {
            "name": "Apple Inc.",
            "sector": "Technology",
            "industry": "Consumer Electronics",
        },
        "TM": {
            "name": "Toyota Motor Corporation",
            "sector": "Consumer Cyclical",
            "industry": "Auto Manufacturers",
        },
    }
    wrong = {
        "title": "Safety rules for retail apple packing",
        "abstract": "Consumer product packaging.",
        "agencies": ["consumer-product-safety-commission"],
    }
    assert policy.rule_scope(wrong, companies) == ([], "")
    correct = {
        "title": "Toyota Motor Corporation vehicle safety rule",
        "abstract": "Motor vehicle safety.",
        "agencies": ["national-highway-traffic-safety-administration"],
    }
    selected, reason = policy.rule_scope(correct, companies)
    assert selected == ["TM"] and "names the company" in reason


@pytest.mark.skipif(
    os.getenv("STOCKREPLAY_PUBLIC_LIVE") != "1", reason="Requires live public calendars"
)
def test_live_senate_agenda_and_upcoming_market_events(tmp_path):
    from bs4 import BeautifulSoup
    from stockreplay.desk import fetch_url

    start = date.today()
    end = start + timedelta(days=365)
    with TestClient(create_app(tmp_path)) as c:
        request = c.get(
            "/api/desk/events",
            params={
                "symbols": "AAPL,NVDA,7203.T,JPM,MDT",
                "start": start.isoformat(),
                "end": end.isoformat(),
            },
        )
        assert request.status_code == 200
        result = request.json()
    rows = result["events"]
    kinds = {e["kind"] for e in rows}
    assert {"fiscal", "macro", "legislative"} <= kinds
    for e in rows:
        assert (
            start.isoformat() <= (e.get("end_date") or e["date"])
            and e["date"] <= end.isoformat()
        )
        assert e["status"] in ("estimated", "reported", "effective", "scheduled")
        assert (
            e["checked_at"]
            and e["excerpt"]
            and e["relevance"]
            and urlsplit(e["url"]).scheme == "https"
        )
    # The Senate can legitimately be in recess. Still verify its actual machine-readable
    # calendar and human source in that case, and require an explicit coverage gap.
    html = BeautifulSoup(fetch_url(policy.SENATE).content, "html.parser")
    assert "hearings" in html.get_text(" ", strip=True).lower()
    published = policy.senate_agendas()
    assert all(a["committee"] and a["text"] and a["meeting"] for a in published)
    meetings = [e for e in rows if e["source"] == "U.S. Senate committee schedule"]
    if meetings:
        for e in meetings:
            assert e["status"] == "scheduled" and e["url"] == policy.SENATE
            assert any(
                a["date"] == e["date"] and a["title"] == e["title"] for a in published
            )
    else:
        assert any(
            g["source"] == "U.S. Senate committee schedule"
            and "No dated hearing" in g["reason"]
            for g in result["gaps"]
        )
    for source, expected in [
        ("Federal Reserve", "federalreserve.gov"),
        ("U.S. Code · GovInfo", "govinfo.gov"),
    ]:
        entry = next(e for e in rows if e["source"] == source)
        res = fetch_url(entry["url"])
        assert res.is_success and urlsplit(str(res.url)).hostname.rsplit(".", 2)[
            -2:
        ] == expected.split(".")
