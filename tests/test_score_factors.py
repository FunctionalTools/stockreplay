from datetime import date, timedelta
import json

import httpx
import pytest
from fastapi import HTTPException

from stockreplay.desk import Desk, market_comparisons, names_company
from stockreplay.openai_research import OpenAIResearch, indexed_evidence, score_schema
from stockreplay.score_factors import FACTORS, factor_key, older, usable
from stockreplay.store import Store
from tests.provider_fixture import assessment, completed

DAY = "2026-11-25"


def observation(key, **updates):
    return {
        "id": key,
        "group": key,
        "factor": key,
        "text": "Reported observation 4.5%",
        "url": "https://example.org/" + key,
        "source": "Public source",
        "date": DAY,
        **updates,
    }


def generate(tmp_path, rows, mutate=lambda result: None):
    def intercept(request):
        body = json.loads(request.content)
        inputs = json.loads(body["input"])
        assert "private" not in body["input"]
        result = assessment(inputs)
        mutate(result)
        return completed(result)

    gateway = OpenAIResearch(Store(tmp_path), httpx.MockTransport(intercept))
    gateway.session_key = "intercepted-public-evidence-contract"
    return gateway.recommend(
        {"symbol": "MSFT", "as_of": DAY, "evidence": rows, "private": "private"}
    )


def test_every_public_factor_has_two_grounded_effects(tmp_path):
    rows = [observation(k) for k in FACTORS]
    rows[0].update(date="2026-11-20", date_kind="close")
    result = generate(tmp_path, rows)
    assert {f["id"] for f in result["factors"]} == set(FACTORS)
    for factor in result["factors"]:
        assert factor["status"] == ("older" if factor["id"] == "trend" else "used")
        assert factor["buy"]["citations"] == factor["risk"]["citations"] == [factor["id"]]
        assert factor["buy"]["direction"] == "Raises" and factor["risk"]["direction"] == "Mixed"
    assert (result["buy_score"], result["risk_score"]) == (72, 58)


def test_partial_evidence_marks_missing_without_manufacturing_inputs(tmp_path):
    invalid = [
        observation("valuation", date="2024"),
        observation("cash_flow", url="file:///account"),
        observation("growth", source=""),
        observation("company_news", names_company=False),
        observation("sensitivity", text=""),
    ]
    result = generate(tmp_path, [observation("trend"), *invalid])
    assert len(result["sources"]) == 1
    for factor in result["factors"]:
        if factor["id"] == "trend":
            assert factor["status"] == "used"
        else:
            assert factor == {
                "id": factor["id"],
                "label": FACTORS[factor["id"]],
                "status": "missing",
            }
    with pytest.raises(HTTPException, match="dated company evidence"):
        generate(tmp_path, [observation("market"), *invalid])


@pytest.mark.parametrize(
    "change",
    [
        lambda r: r["factors"].pop("trend"),
        lambda r: r["factors"]["trend"].update(sources=["S2"]),
        lambda r: r["factors"]["trend"]["buy"].update(reason="Shares returned 87.50% on the day."),
        lambda r: r["factors"]["trend"].update(sources=[]),
        lambda r: r["factors"]["trend"]["risk"].update(direction="Unknown"),
    ],
)
def test_rejects_missing_or_ungrounded_explanations(tmp_path, change):
    with pytest.raises(HTTPException) as error:
        generate(tmp_path, [observation("trend"), observation("valuation")], change)
    assert error.value.status_code == 502


def test_full_schema_constrains_source_choices_and_fits_strict_model_limits():
    rows = [observation(k, id=f"{k}-{i}") for k in FACTORS for i in range(5)]
    indexed = indexed_evidence(rows)
    available = {factor_key(e) for e in indexed.values()}
    schema = score_schema(indexed, available)
    properties = schema["properties"]["factors"]["properties"]
    assert set(properties) == set(FACTORS)
    for key, child in properties.items():
        assert child["properties"]["sources"]["items"]["enum"] == [
            sid for sid, e in indexed.items() if factor_key(e) == key
        ]

    def nodes(value):
        if isinstance(value, dict):
            yield value
            for item in value.values():
                yield from nodes(item)
        elif isinstance(value, list):
            for item in value:
                yield from nodes(item)

    assert sum(len(n.get("properties", {})) for n in nodes(schema)) <= 100
    assert sum(len(n.get("enum", [])) for n in nodes(schema)) <= 500
    assert all(
        n["additionalProperties"] is False and set(n["required"]) == set(n["properties"])
        for n in nodes(schema)
        if n.get("type") == "object"
    )
    assert {factor_key(e) for e in indexed_evidence(rows, compact=True).values()} == available


def test_public_financial_observations_preserve_units_period_dates_and_missing_values(
    tmp_path, monkeypatch
):
    from stockreplay import desk

    sample = {
        "shortName": "Example",
        "financialCurrency": "EUR",
        "currency": "USD",
        "mostRecentQuarter": 1759190400,
        "net": None,
        "freeCashflow": -100,
        "operatingCashflow": 0,
        "totalRevenue": 800,
        "grossMargins": 0.48,
        "debtToEquity": 26.25,
        "revenueGrowth": 0.125,
        "trailingPE": 15.91,
    }
    monkeypatch.setattr(desk, "company", lambda s: sample)
    monkeypatch.setattr(desk, "chart_data", lambda *args: None)
    for attr in (
        "analyst_history",
        "stockanalysis",
        "consensus",
        "forecast",
        "stories",
        "rss",
    ):
        monkeypatch.setattr(desk, attr, lambda *args: [])
    brief = Desk(Store(tmp_path)).briefing("MSFT")
    grouped = {factor_key(e): e for e in brief["evidence"] if usable(e)}
    assert set(grouped) == {
        "cash_flow",
        "profitability",
        "balance_sheet",
        "growth",
        "valuation",
    }
    cash = grouped["cash_flow"]
    assert (
        "0.00 EUR" in cash["text"] and "-100.00 EUR" in cash["text"] and "-12.50 %" in cash["text"]
    )
    assert (
        "48.00 %" in grouped["profitability"]["text"]
        and "26.25 %" in grouped["balance_sheet"]["text"]
    )
    assert "12.50 %" in grouped["growth"]["text"] and "Forward" not in grouped["valuation"]["text"]
    assert (
        cash["period_end"] == "2025-09-30" and cash["date_kind"] == "retrieved" and older(cash, DAY)
    )
    assert "period_end" not in grouped["valuation"]


def test_market_comparisons_require_actual_shared_periods_and_moving_benchmark():
    prices = [
        {"date": (date(2026, 1, 1) + timedelta(days=i)).isoformat(), "close": 90 + i}
        for i in range(130)
    ]
    flat = [{**x, "close": 200} for x in prices]
    assert not list(market_comparisons(prices, []))
    assert not list(market_comparisons(prices[:20], prices[:20]))
    assert [x[0] for x in market_comparisons(prices, flat)] == ["relative"]
    same = list(market_comparisons(prices, prices))
    assert "+0.00 percentage points" in same[0][1] and "1.00 over 126" in same[1][1]


def test_company_feed_adjacency_alone_does_not_count_as_company_news():
    doc = {
        "title": "Chip stocks rose after an earnings release",
        "excerpt": "The index rose.",
    }
    assert not names_company(doc, "MSFT", {"shortName": "Microsoft Corporation"})
    assert not names_company(
        {"title": "General market report"}, "GM", {"longName": "General Motors Company"}
    )
    assert names_company(
        {**doc, "excerpt": "Microsoft expanded its orders."},
        "MSFT",
        {"shortName": "Microsoft Corporation"},
    )
    assert names_company({"title": "MSFT gained after the announcement"}, "MSFT", {})
    assert not names_company({"title": "Trading volume rose"}, "A", {})


def test_invalid_model_explanation_is_repaired_without_saving_it(tmp_path):
    replies = []

    def repair_first(report):
        replies.append(report)
        if len(replies) == 1:
            report["factors"]["trend"]["buy"]["reason"] = "An unsupported return of 87%."

    result = generate(tmp_path, [observation("trend")], repair_first)
    assert len(replies) == 2
    assert "87%" not in json.dumps(result)


def test_compact_evidence_prefers_a_company_headline_to_a_passing_mention():
    rows = [
        observation("company_news", id="passing", date="2026-11-25", headline_company=False),
        observation("company_news", id="direct", date="2026-11-24", headline_company=True),
    ]
    assert indexed_evidence(rows, compact=True)["S1"]["id"] == "direct"
