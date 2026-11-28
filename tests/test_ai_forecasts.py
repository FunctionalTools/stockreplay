import os
import threading
from concurrent.futures import Future, ThreadPoolExecutor
from datetime import date, datetime
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from stockreplay import ai_forecasts as forecasts
from stockreplay.api import create_app
from stockreplay.forecast_evidence import assemble, parse_estimates
from stockreplay.projections import project_one
from tests.test_projections import CLOSED, history


@pytest.fixture
def wired(tmp_path, monkeypatch):
    app = create_app(tmp_path)
    t = app.state.terminal

    class Clock(datetime):
        @classmethod
        def now(cls, zone):
            return CLOSED.astimezone(zone)

    monkeypatch.setattr(forecasts, "datetime", Clock)
    monkeypatch.setattr(
        t.desk,
        "chart",
        lambda *a: {"data": history(), "fetched": "2026-11-27T19:00:00Z", "stale": False},
    )

    def evidence(desk, base):
        brief = {
            "evidence": [
                {
                    "group": "ollama_web_news",
                    "text": "Company announces product launch",
                    "source": "Issuer newsroom",
                    "url": "https://example.org/news",
                    "date": "2026-11-25",
                    "excerpt": "The issuer reported a new product line.",
                    "scope": "Search excerpt",
                    "discovered_via": "Ollama Web Search",
                    "date_kind": "published",
                }
            ]
        }
        fiscal = {
            "kind": "fiscal",
            "status": "estimated",
            "date": "2026-12-26",
            "title": "Q1 FY 2027 · period end",
            "url": "https://example.org/statements",
            "source": "Statements",
        }
        agenda = {
            "events": [
                fiscal,
                {
                    **fiscal,
                    "date": "2026-11-30",
                    "kind": "earnings",
                    "title": "Earnings release",
                    "status": "scheduled",
                },
            ]
        }
        consensus = {
            "data": [
                {
                    "period": "2026-12-31",
                    "metric": "EPS",
                    "value": 2.5,
                    "unit": "USD/share",
                    "analysts": 5,
                    "url": "https://finance.yahoo.com/quote/AAPL/analysis/",
                }
            ],
            "stale": False,
            "fetched": "2026-11-27",
        }
        return assemble(base, brief, agenda, consensus)

    monkeypatch.setattr(forecasts, "evidence_packet", evidence)
    controls = SimpleNamespace(
        provider="openai",
        calls=0,
        fail=False,
        slow=False,
        entered=threading.Event(),
        release=threading.Event(),
    )

    class Model:
        def __init__(self, provider):
            self.provider = provider

        def credentials(self):
            return None, "selected-model"

        def structured(self, key, model, name, schema, instructions, inputs, budget):
            controls.calls += 1
            assert name == "future_price_scenario" and model == "selected-model"
            assert any(s.get("discovered_via") == "Ollama Web Search" for s in inputs["sources"])
            sid = next(s["id"] for s in inputs["sources"] if s["kind"] == "ollama_web_news")
            event = next(s["id"] for s in inputs["sources"] if s["kind"] == "earnings")
            if controls.slow:
                controls.entered.set()
                assert controls.release.wait(10)
            fields = schema["properties"]
            level = {"tilt": "higher", "source": event if controls.fail else sid}
            return {
                "near": level,
                "middle": level,
                "longer": level,
                "drivers": [sid + "_up"],
                "watch": event,
                "quarters": {"Q1": fields["quarters"]["properties"]["Q1"]["enum"][0]},
            }

    monkeypatch.setattr(t.ai, "active", lambda: Model(controls.provider))
    return app, tmp_path, controls


@pytest.mark.parametrize("provider", ["openai", "ollama", "ollama_cloud"])
def test_explicit_active_model_forecast_and_local_reopen(wired, provider):
    app, path, controls = wired
    controls.provider = provider
    address = "/api/desk/forecast/AAPL?range=1mo"
    with TestClient(app) as c:
        assert c.get(address).json() == {"forecast": None} and controls.calls == 0
        row = c.post(address).raise_for_status().json()["forecast"]
        assert row["requested_end"] == "2026-12-27" and row["points"][-1]["date"] == "2026-12-24"
        assert (row["provider"], row["model"], controls.calls) == (provider, "selected-model", 1)
        start = row["points"][0]
        assert start["median"] == start["baseline"] == row["history"][-1]["price"]
        assert all(
            p["low"] < p["median"] < p["high"] and p["median"] > p["baseline"]
            for p in row["points"][1:]
        )
        assert row["quarters"][0]["date_kind"] == "period_end"
        assert row["quarters"][0]["timing"] == "estimated"
        eps = row["quarters"][0]["consensus"][0]
        assert eps["value"] == 2.5 and eps["period"] == "2026-12-31"
        assert row["quarters"][1]["timing"] == "unavailable"
        assert c.get("/api/desk/forecast/AAPL?range=1d").json() == {"forecast": None}
        controls.fail = True
        assert c.post(address).status_code == 502
        assert c.get(address).json()["forecast"]["id"] == row["id"]  # preserve last good snapshot
    with TestClient(create_app(path)) as reopened:
        assert reopened.get(address).json()["forecast"] == row


def test_concurrent_explicit_generation_is_shared(wired, monkeypatch):
    joined = threading.Event()

    class ObservedFuture(Future):
        def result(self, *args, **kwargs):
            joined.set()
            return super().result(*args, **kwargs)

    monkeypatch.setattr(forecasts, "Future", ObservedFuture)
    app, _, controls = wired
    controls.slow = True
    addr = "/api/desk/forecast/AAPL?range=custom&start=2026-12-03&end=2026-12-06"
    with TestClient(app) as client, ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(client.post, addr)
        assert controls.entered.wait(10)
        second = pool.submit(client.post, addr)
        assert joined.wait(10)
        controls.release.set()
        a = first.result().raise_for_status().json()["forecast"]
        b = second.result().raise_for_status().json()["forecast"]
    assert a["id"] == b["id"] and controls.calls == 1
    assert [p["date"] for p in a["points"]] == ["2026-11-27", "2026-12-03", "2026-12-04"]


def test_range_calendar_and_same_period_consensus():
    data = history()

    def dates(preset, **params):
        return [
            p["date"]
            for p in project_one(data, "AAPL", preset, 42, CLOSED, date(2026, 11, 20), **params)[
                "points"
            ]
        ]

    assert len(dates("5d")) == 6 and len(dates("1w")) == 5
    assert dates("ytd")[-1] == "2026-12-31"
    assert dates("max") == dates("10y")
    assert dates("3mo")[-1] < dates("2y")[-1]
    with pytest.raises(ValueError, match="no scheduled trading session"):
        dates("custom", start_date=date(2026, 11, 26), end_date=date(2026, 11, 26))
    row = {
        "period": "0q",
        "endDate": "2026-12-31",
        "earningsEstimate": {
            "avg": {"raw": 1.25},
            "numberOfAnalysts": {"raw": 7},
            "earningsCurrency": "USD",
        },
    }
    rows = parse_estimates(
        {"trend": [row, {**row, "period": "0y"}, {**row, "endDate": None}]}, "AAPL"
    )
    assert len(rows) == 1 and rows[0]["unit"] == "USD/share" and rows[0]["period"] == "2026-12-31"


@pytest.mark.skipif(
    os.getenv("STOCKREPLAY_LIVE_OLLAMA") != "1" or os.getenv("STOCKREPLAY_PUBLIC_LIVE") != "1",
    reason="Requires a running local Ollama model and live market sources",
)
def test_live_local_provider_forecast(tmp_path):
    with TestClient(create_app(tmp_path)) as c:
        addr = "/api/desk/forecast/SNDK?range=2y"
        live = c.get("/api/desk/projections?symbols=SNDK&horizon=2y").raise_for_status().json()
        assert not live["errors"], live["errors"]
        baseline = live["series"][0]
        row = c.post(addr).raise_for_status().json()["forecast"]
        assert row["provider"] == "ollama" and row["model"]
        assert row["symbol"] == "SNDK" and row["range"] == "2y" and len(row["points"]) > 450
        assert row["as_of"] >= baseline["as_of"] and row["points"][0]["median"] > 0
        assert row["points"][1]["date"] > row["expected_session"]
        assert row["points"][-1]["date"] <= row["requested_end"]
        assert row["price_sources"] and row["summary_source_ids"] and row["drivers"]
        refs = {s["id"] for s in row["sources"]}
        assert all(set(d["source_ids"]) <= refs for d in row["drivers"])
    with TestClient(create_app(tmp_path)) as reopened:
        assert reopened.get(addr).json()["forecast"] == row


def test_calendar_and_uncompared_estimates_cannot_generate_directional_claims():
    def source(sid, kind, **extra):
        return dict(
            id=sid,
            kind=kind,
            source="Publisher",
            title="Original source title",
            excerpt="Published observation.",
            date="2026-12-01",
            **extra,
        )

    market = source("S1", "price")
    date_only = source("S2", "fiscal", date_basis="event")
    standalone = source("S3", "consensus")
    compared = source("S4", "consensus", comparison_available=True)
    issuer = source("S5", "company_news")
    annual = source("S6", "estimates")
    rows = [market, date_only, standalone, compared, issuer, annual]
    assert forecasts.quarter_sources({"source_ids": []}, rows) == [issuer]
    quarters = {"Q1": {"quarter": "Q1", "period": "Q1 FY 2027", "source_ids": ["S2", "S3"]}}
    schema = forecasts.model_schema(rows, quarters)
    fields = schema["properties"]
    assert set(fields["near"]["properties"]["source"]["enum"]) == {"S1", "S4", "S5"}
    assert fields["quarters"]["properties"]["Q1"]["enum"] == ["S3_mixed"]
    level = {"tilt": "higher", "source": "S1"}
    answer = {
        "near": level,
        "middle": level,
        "longer": level,
        "drivers": ["S1_up"],
        "quarters": {"Q1": "S3_mixed"},
    }
    _, _, cards = forecasts.validated(answer, rows, quarters, schema)
    assert "uncertain" in cards[0]["expectation"] and "increase" not in cards[0]["expectation"]
    for bad in (
        {**answer, "near": {"tilt": "higher", "source": "S2"}},
        {**answer, "quarters": {"Q1": "S3_up"}},
        {**answer, "quarters": {"Q1": "S4_up"}},
        {**answer, "summary": {"text": "Strong earnings beat", "source": "S2"}},
    ):
        with pytest.raises(ValueError):
            forecasts.validated(bad, rows, quarters, schema)


def test_ai_generation_uses_a_real_earlier_close_when_a_session_is_missing(wired, monkeypatch):
    app, _, _ = wired
    daily = history()
    daily["bars"] = [b for b in daily["bars"] if b["date"] < "2026-11-27"]
    monkeypatch.setattr(
        app.state.terminal.desk,
        "chart",
        lambda symbol, interval, *args: {
            "data": daily if interval == "1d" else None,
            "fetched": "2026-11-27T19:00:00Z",
            "stale": False,
        },
    )
    with TestClient(app) as c:
        result = c.post("/api/desk/forecast/AAPL?range=1d").raise_for_status().json()["forecast"]
        assert result["stale"] and result["as_of"] == "2026-11-25"
        assert (
            result["expected_session"] == "2026-11-27"
            and "daily history ends" in result["data_note"]
        )
        assert [p["date"] for p in result["points"]] == ["2026-11-25", "2026-11-30"]
