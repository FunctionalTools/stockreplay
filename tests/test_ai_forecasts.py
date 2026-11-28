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
from stockreplay.forecast_scores import grade_label
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
        buy=76,
        risk=82,
        calls_with=[],
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
            controls.calls_with.append((schema, inputs))
            assert name == "future_price_scenario" and model == "selected-model"
            assert any(s.get("discovered_via") == "Ollama Web Search" for s in inputs["sources"])
            sid = next(s["id"] for s in inputs["sources"] if s["kind"] == "ollama_web_news")
            event = next(s["id"] for s in inputs["sources"] if s["kind"] == "earnings")
            if controls.slow:
                controls.entered.set()
                assert controls.release.wait(10)
            fields = schema["properties"]
            if "day" in fields:
                out = {k: v["enum"][0] for k, v in fields.items() if "enum" in v}
                for k in ("day", "quarter", "year"):
                    out[k] = (event if controls.fail else sid) + "++"
                if "buy" in fields:
                    out.update(
                        buy=controls.buy, risk=grade_label("risk", controls.risk), buy_source=sid
                    )
                    out["buy_check"] = next(s for s in fields["buy_check"]["enum"] if s != sid)
                    out["risk_check"] = next(
                        s for s in fields["risk_check"]["enum"] if s != out["risk_source"]
                    )
                return out
            level = {"tilt": "higher", "source": event if controls.fail else sid}
            return {
                "near": level,
                "middle": level,
                "longer": level,
                **(
                    {
                        "scores": {
                            "buy": {
                                "score": controls.buy,
                                "source": sid,
                                "check": fields["scores"]["properties"]["buy"]["properties"][
                                    "check"
                                ]["enum"][0],
                                "reason": "New products could support demand.",
                            },
                            "risk": {
                                "score": controls.risk,
                                "source": fields["scores"]["properties"]["risk"]["properties"][
                                    "source"
                                ]["enum"][0],
                                "check": sid,
                                "reason": "Observed price changes leave the future share price uncertain.",
                            },
                        }
                    }
                    if "scores" in fields
                    else {}
                ),
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
            p["low"] < p["prediction"] < p["high"] and p["median"] == p["prediction"]
            for p in row["points"][1:]
        )
        assert row["points"][-1]["prediction"] > row["points"][-1]["baseline"]
        assert row["scores"]["origin"] == "forecast_model" and (
            row["scores"]["buy_score"],
            row["scores"]["risk_score"],
        ) == (76, 82)

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
    schema = forecasts.model_schema(rows, quarters, need_scores=False)
    fields = schema["properties"]
    assert set(fields["near"]["properties"]["source"]["enum"]) == {"S1", "S4", "S5"}
    assert fields["quarters"]["properties"]["Q1"]["enum"] == ["S3_mixed"]
    level = {"tilt": "higher", "source": "S1"}
    answer = {
        "near": level,
        "middle": {"tilt": "higher", "source": "S5"},
        "longer": {"tilt": "higher", "source": "S5"},
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


def test_recent_independent_scores_keep_original_public_basis_and_aged_reports_are_reassessed(
    wired,
):
    import json

    app, _, controls = wired
    t = app.state.terminal
    issued = "2026-11-26"

    def fact(key, factor):
        return {
            "id": key,
            "factor": factor,
            "group": "fundamentals" if factor == "growth" else "risk",
            "date": issued,
            "text": "Issuer disclosed changing cash balances.",
            "url": "https://example.org/issuer/" + key,
            "source": "Issuer",
            "date_kind": "published",
        }

    report = {
        "symbol": "AAPL",
        "created": issued + "T18:00:00Z",
        "as_of": issued,
        "model": "another-model",
        "provider": "ollama",
        "buy_score": 18,
        "risk_score": 91,
        "sources": [fact("issuer-cash", "growth"), fact("issuer-risk", "price_risk")],
        "factors": [
            {
                "id": "growth",
                "status": "used",
                "buy": {
                    "direction": "Lowers",
                    "text": "Cash pressure weakens the investment case.",
                    "citations": ["issuer-cash"],
                },
            },
            {
                "id": "price_risk",
                "status": "used",
                "risk": {
                    "direction": "Raises",
                    "text": "Variable cash balances add uncertainty.",
                    "citations": ["issuer-risk"],
                },
            },
        ],
    }
    t.update(
        "insert into market_recommendations values(?,?,?,?)",
        ("prior", "AAPL", report["created"], json.dumps(report)),
    )
    with TestClient(app) as c:
        addr = "/api/desk/forecast/AAPL?range=1mo"
        row = c.post(addr).raise_for_status().json()["forecast"]
        scores = row["scores"]
        assert (scores["buy_score"], scores["risk_score"], scores["model"], scores["origin"]) == (
            18,
            91,
            "another-model",
            "saved_research",
        )
        assert scores["report_id"] == "prior" and scores["as_of"] == issued
        sources = {v["id"]: v for v in row["sources"]}
        assert sources[scores["buy_source_ids"][0]]["url"].endswith("issuer-cash")
        assert sources[scores["risk_source_ids"][0]]["date"] == issued
        fields, prompt = controls.calls_with[-1]
        assert (
            "scores" not in fields["properties"]
            and prompt["saved_research_scores"]["buy_score"] == 18
            and controls.calls == 1
        )
        report["as_of"] = "2024-01-01"
        t.update(
            "update market_recommendations set payload=? where id=?", (json.dumps(report), "prior")
        )
        fresh = c.post(addr).raise_for_status().json()["forecast"]["scores"]
        assert (
            fresh["origin"] == "forecast_model"
            and fresh["buy_score"] == controls.buy
            and fresh["risk_score"] == controls.risk
        )
        assert "scores" in controls.calls_with[-1][0]["properties"]


def test_buy_changes_direction_and_risk_amplifies_either_sign_of_the_stock_path():
    series = [100, 105, 96, 107, 90, 101]
    points = [
        {
            "date": f"2026-12-{i + 1:02d}",
            "low": p * 0.95,
            "high": p * 1.05,
            "prediction": p,
            "median": p,
        }
        for i, p in enumerate(series)
    ]
    base = {
        "as_of": "2026-12-01",
        "points": points,
        "annualized_volatility_pct": 35,
        "annualization_sessions": 252,
    }
    source = {"id": "S1", "date": "2026-12-01", "kind": "price"}
    neutral = [{"source_id": "S1", "tilt": "near_baseline"}] * 3

    def path(buy, risk):
        return forecasts.model_points(
            base,
            neutral,
            [],
            [source],
            {
                "buy_score": buy,
                "risk_score": risk,
                "buy_source_ids": ["S1"],
                "risk_source_ids": ["S1"],
            },
            None,
        )

    assert [p["prediction"] for p in path(50, 50)] == series
    highhigh, highlow, lowhigh = path(85, 90), path(85, 10), path(15, 90)
    assert all(a["prediction"] > b["prediction"] for a, b in zip(highhigh[1:], lowhigh[1:]))
    assert highhigh[1]["prediction"] > highlow[1]["prediction"]
    assert highhigh[2]["prediction"] < highlow[2]["prediction"]
    assert all(
        p["low"] < p["prediction"] < p["high"] and p["prediction"] == p["median"]
        for p in highhigh[1:]
    )


@pytest.mark.parametrize(
    ("provider", "buy", "risk"), [("openai", 16, 89), ("ollama_cloud", 88, 93), ("ollama", 83, 14)]
)
def test_selected_provider_reports_independent_scores_and_repairs_an_unsupported_claim(
    wired, monkeypatch, provider, buy, risk
):
    import json

    import httpx

    from tests.provider_fixture import completed

    app, _, _ = wired
    ai = app.state.terminal.ai
    actual = {"ollama": ai.ollama, "openai": ai.openai, "ollama_cloud": ai.ollama_cloud}[provider]
    monkeypatch.setattr(ai, "active", lambda: actual)
    monkeypatch.setattr(
        actual,
        "credentials",
        lambda: ("test-only-key" if provider != "ollama" else None, "test-model"),
    )
    calls = []

    def reply(req):
        body = json.loads(req.content)
        if req.url.path == "/api/show":
            return httpx.Response(
                200, json={"details": {"format": "gguf"}, "capabilities": ["completion"]}
            )
        if provider == "openai":
            assert body["text"]["format"]["strict"] and not body["store"]
            schema = body["text"]["format"]["schema"]
        elif provider == "ollama_cloud":
            assert req.url.host == "ollama.com" and "format" not in body
            schema = body["tools"][0]["function"]["parameters"]
        else:
            assert req.url.host == "127.0.0.1" and not req.headers.get("authorization")
            schema = body["format"]

        def strict(node):
            if not isinstance(node, dict):
                return 0
            if node.get("type") == "object":
                assert node["additionalProperties"] is False and set(node["properties"]) == set(
                    node["required"]
                )
            return len(node.get("enum", [])) + sum(strict(v) for v in node.values())

        assert strict(schema) < 1000
        f = schema["properties"]
        if "day" in f:
            answer = {k: v["enum"][0] for k, v in f.items() if "enum" in v}
            answer.update(buy=buy, risk=grade_label("risk", risk))
            for d in ("buy", "risk"):
                answer[d + "_check"] = next(
                    ref for ref in f[d + "_check"]["enum"] if ref != answer[d + "_source"]
                )
            if not calls:
                answer["buy_source"] = "unavailable-source"
            calls.append(True)
            return httpx.Response(
                200, json={"done": True, "message": {"content": json.dumps(answer)}}
            )
        answer = {
            k: {"source": f[k]["properties"]["source"]["enum"][0], "tilt": "near_baseline"}
            for k in ("near", "middle", "longer")
        }
        answer["drivers"] = [f["drivers"]["items"]["enum"][0]]
        if "quarters" in f:
            answer["quarters"] = {k: v["enum"][0] for k, v in f["quarters"]["properties"].items()}
        if "watch" in f:
            answer["watch"] = f["watch"]["enum"][0]
        sf = f["scores"]["properties"]
        answer["scores"] = {
            k: {
                "score": v,
                "source": sf[k]["properties"]["source"]["enum"][0],
                "check": next(
                    ref
                    for ref in sf[k]["properties"]["check"]["enum"]
                    if ref != sf[k]["properties"]["source"]["enum"][0]
                ),
                "reason": "An unsupported 98765 percent increase."
                if not calls
                else "Available evidence affects this judgement.",
            }
            for k, v in [("buy", buy), ("risk", risk)]
        }
        calls.append(True)
        if provider == "openai":
            return completed(answer)
        msg = (
            {"content": json.dumps(answer)}
            if provider == "ollama"
            else {
                "tool_calls": [
                    {"function": {"name": "submit_future_price_scenario", "arguments": answer}}
                ]
            }
        )
        return httpx.Response(200, json={"done": True, "message": msg})

    actual.transport = httpx.MockTransport(reply)
    with TestClient(app) as c:
        result = c.post("/api/desk/forecast/AAPL?range=1mo").raise_for_status().json()["forecast"]
        assert len(calls) == 2 and result["provider"] == provider
        scores = result["scores"]
        assert (scores["buy_score"], scores["risk_score"]) == (buy, risk)
        assert (
            scores["origin"] == "forecast_model"
            and scores["as_of"] == "2026-11-27"
            and "98765" not in json.dumps(scores)
        )
        assert set(scores["buy_source_ids"] + scores["risk_source_ids"]) <= {
            s["id"] for s in result["sources"]
        }


def test_short_history_keeps_observed_reference_price_even_with_strong_scores(wired, monkeypatch):
    app, _, _ = wired
    original = forecasts.load_projection

    def limited(*args, **kwargs):
        base = original(*args, **kwargs)
        quoted = base["points"][0]["median"]
        base.update(
            method="Last observed price",
            annualized_volatility_pct=None,
            model_inputs={
                "kind": "last_price_reference",
                "reference_reason": "Only one price was available.",
            },
        )
        base["points"] = [
            {**p, "prediction": quoted, "low": quoted, "median": quoted, "high": quoted}
            for p in base["points"]
        ]
        return base

    monkeypatch.setattr(forecasts, "load_projection", limited)
    with TestClient(app) as c:
        result = c.post("/api/desk/forecast/AAPL?range=1mo").raise_for_status().json()["forecast"]
        assert result["scores"]["buy_score"] > 70 and not result["checkpoints"]
        assert "price reference" in result["summary"].lower() and all(
            p["prediction"] == result["confirmed_close"] for p in result["points"]
        )
        assert any("too few" in s["excerpt"] for s in result["sources"] if s["kind"] == "price")
        original_evidence = forecasts.evidence_packet

        def quote_only(*args):
            sources, quarters = original_evidence(*args)
            return [s for s in sources if s["kind"] == "price"], quarters

        monkeypatch.setattr(forecasts, "evidence_packet", quote_only)
        unsupported = c.post("/api/desk/forecast/AAPL?range=1d")
        assert (
            unsupported.status_code == 422
            and "too little dated company evidence" in unsupported.json()["detail"]
        )
        assert c.get("/api/desk/forecast/AAPL?range=1d").json()["forecast"] is None


def test_local_forecast_preserves_citation_choices_without_a_long_free_text_response():
    from stockreplay import local_forecast
    from stockreplay.forecast_evidence import local_forecast_sources, local_source_row

    rows = []
    groups = (
        "price",
        "company_news",
        "ollama_web_news",
        "company_filings",
        "fundamentals",
        "sector",
        "market",
        "risk",
        "analysts",
        "estimates",
    )
    for i in range(4):
        for kind in groups:
            fact = (
                "Issuer evidence includes a dated, published observation about financial conditions. "
                * 8
            )
            rows.append(
                {
                    "id": f"S{len(rows) + 1}",
                    "kind": kind,
                    "source": "Publisher",
                    "date": "2026-11-27",
                    "title": "Published observation",
                    "excerpt": fact,
                    "scope": "Article passage",
                    "factor": "company_news"
                    if kind in {"ollama_web_news", "company_news"}
                    else kind,
                    "original_id": str(i),
                }
            )
    local = local_forecast_sources(rows, {}, None)
    assert len(local) <= 16 and {"company_news", "ollama_web_news"} <= {s["kind"] for s in local}
    prompt = [local_source_row(s) for s in local]
    assert all(len(s["fact"]) <= 185 and "original_id" not in s for s in prompt)
    canonical = forecasts.model_schema(local, {}, quarter_consensus_only=True)
    wire = local_forecast.request_schema(canonical)
    assert "reason" not in str(wire) and all(
        "enum" in v or v["type"] == "integer" for v in wire["properties"].values()
    )
    sample = {k: v["enum"][0] if "enum" in v else 77 for k, v in wire["properties"].items()}
    answer = local_forecast.expand(sample, wire, canonical, prompt)
    for d in ("risk", "buy"):
        choice = answer["scores"][d]
        assert choice["reason"] == next(s["fact"] for s in prompt if s["id"] == choice["source"])


@pytest.mark.parametrize("reviewed", [91, 10])
def test_extreme_risk_rechecks_opposite_governance_scale_and_observed_drawdown(reviewed):
    from stockreplay.forecast_scores import audited_scores

    def source(sid, kind, factor, fact, **values):
        return {
            "id": sid,
            "kind": kind,
            "factor": factor,
            "title": fact,
            "excerpt": fact,
            "date": "2026-11-27",
            **values,
        }

    sources = [
        source(
            "target", "estimates", "targets", "The published analyst target implies 242% upside."
        ),
        source("growth", "fundamentals", "growth", "Reported quarterly revenue growth improved."),
        source("iss", "risk", "governance", "ISS governance risk (1 low, 10 high): 7.00 / 10"),
        source(
            "prices",
            "risk",
            "price_risk",
            "21-session annualized volatility 155.7%; 63-session drawdown -63.8%.",
            measured_price_risk=True,
            volatility_21d_pct=155.7,
            drawdown_63d_pct=-63.8,
        ),
    ]
    scores = {
        "symbol": "SNDK",
        "origin": "forecast_model",
        "buy_score": 95,
        "risk_score": 10,
        "buy_source_ids": ["target", "growth"],
        "risk_source_ids": ["iss", "prices"],
        "buy_reason": sources[0]["title"],
        "risk_reason": sources[2]["title"],
    }
    calls = []

    class Review:
        def structured(self, key, model, name, schema, instructions, inputs, budget):
            assert (
                name == "forecast_score_review"
                and set(schema["properties"]) == {"risk"}
                and budget <= 240
            )
            assert len(schema["properties"]["risk"]["properties"]["rating"]["enum"]) == 101
            assert (
                inputs["items"]["risk"]["prior"] == 10
                and len(inputs["items"]["risk"]["concern"]) == 2
            )
            assert (
                "-63.8%" in inputs["evidence"]["prices"]["fact"]
                and "7.00 / 10" in inputs["evidence"]["iss"]["fact"]
            )
            calls.append(1)
            return {
                "risk": {
                    "rating": grade_label("risk", reviewed),
                    "primary": "prices" if reviewed > 50 else "iss",
                    "countercheck": "iss" if reviewed > 50 else "prices",
                }
            }

    result = audited_scores(scores, sources, Review(), (None, "local-test"))
    assert len(calls) == 1 and result["buy_score"] == 95 and result["risk_score"] == reviewed
    assert result["risk_status"] == ("reviewed" if reviewed == 91 else "unresolved")
    assert result["reviews"]["risk"]["initial_score"] == 10
    assert {"prices", "iss"} <= set(result["risk_source_ids"]) and "prices" in result[
        "buy_source_ids"
    ]


@pytest.mark.parametrize(("vol", "draw"), [(None, None), (None, -35.0), (156.0, None)])
def test_unavailable_price_risk_measurements_do_not_imply_extreme_risk(vol, draw):
    from stockreplay.forecast_scores import score_conflicts

    scores = {
        "origin": "forecast_model",
        "risk_score": 10,
        "risk_source_ids": ["issuer", "history"],
    }
    history = {
        "id": "history",
        "kind": "risk",
        "title": "Available price history",
        "measured_price_risk": True,
        "volatility_21d_pct": vol,
        "drawdown_63d_pct": draw,
    }
    rows = {
        "issuer": {"id": "issuer", "kind": "fundamentals", "title": "Issuer balance sheet"},
        "history": history,
    }
    assert score_conflicts(scores, "risk", rows, history) == []


@pytest.mark.parametrize(
    ("counter", "effect", "status"),
    [
        ("liquidity", "mitigates_risk", "reviewed"),
        ("annual", "mitigates_risk", "unresolved"),
        ("liquidity", "inconclusive", "unresolved"),
    ],
)
def test_two_stressed_price_windows_need_a_distinct_mitigator_for_moderate_risk(
    counter, effect, status
):
    from stockreplay.forecast_scores import audited_scores

    def row(sid, kind, factor, text, **other):
        return {
            "id": sid,
            "kind": kind,
            "factor": factor,
            "title": text,
            "excerpt": text,
            "date": "2026-11-27",
            **other,
        }

    sources = [
        row(
            "recent",
            "risk",
            "price_risk",
            "Volatility 155.7%, drawdown 63.8%.",
            measured_price_risk=True,
            volatility_21d_pct=155.7,
            drawdown_63d_pct=-63.8,
        ),
        row(
            "annual",
            "risk",
            "price_risk",
            "Previous year volatility 113.37%, maximum drawdown 74.78%.",
        ),
        row(
            "liquidity",
            "fundamentals",
            "balance_sheet",
            "Company reported liquid assets exceeding its short-term debt.",
        ),
        row("target", "estimates", "targets", "An analyst published a higher price target."),
    ]
    initial = {
        "symbol": "SNDK",
        "origin": "forecast_model",
        "buy_score": 55,
        "risk_score": 50,
        "buy_source_ids": ["liquidity", "target"],
        "risk_source_ids": ["annual", "recent"],
        "buy_reason": "Reported liquidity supports the case.",
        "risk_reason": sources[1]["title"],
    }
    calls = []

    class Review:
        def structured(self, key, model, name, schema, prompt, inputs, budget):
            assert name == "forecast_score_review" and set(inputs["items"]) == {"risk"}
            assert "independent evidence" in inputs["items"]["risk"]["concern"][0]
            assert len(schema["properties"]["risk"]["properties"]["rating"]["enum"]) == 101
            calls.append(True)
            return {
                "risk": {
                    "rating": "moderate_risk_50",
                    "primary": "recent",
                    "countercheck": counter,
                    "countercheck_effect": effect,
                }
            }

    result = audited_scores(initial, sources, Review(), (None, "local-test"))
    assert len(calls) == 1 and result["risk_score"] == 50 and result["risk_status"] == status
    assert result["reviews"]["risk"]["initial_source_ids"] == ["annual", "recent"]
    if counter == "annual":
        assert "risk_crosscheck_source_id" not in result
    else:
        assert result["risk_crosscheck_source_id"] == "liquidity"


def test_standalone_risk_metrics_never_establish_price_direction():
    from stockreplay import local_forecast

    sources = [
        {
            "id": "S1",
            "kind": "risk",
            "factor": "governance",
            "date": "2026-11-27",
            "title": "ISS risk 7 of 10",
        },
        {
            "id": "S2",
            "kind": "risk",
            "factor": "price_risk",
            "date": "2026-11-27",
            "title": "Annualized volatility 45%",
        },
        {
            "id": "S3",
            "kind": "price",
            "anchor_observation": True,
            "date": "2026-11-27",
            "title": "Latest close",
        },
    ]
    schema = forecasts.model_schema(sources, {}, need_scores=False)
    fields = schema["properties"]
    assert fields["near"]["properties"]["tilt"]["enum"] == ["near_baseline"]
    assert all(
        code.endswith("=")
        for code in local_forecast.request_schema(schema)["properties"]["day"]["enum"]
    )
    bad = {k: {"source": "S1", "tilt": "slightly_higher"} for k in ("near", "middle", "longer")}
    with pytest.raises(ValueError):
        forecasts.validated({**bad, "drivers": ["S1_mixed"]}, sources, {}, schema)
    issuer = {
        "id": "S4",
        "kind": "fundamentals",
        "date": "2026-11-27",
        "title": "Reported year-over-year revenue growth",
    }
    supported = forecasts.model_schema([*sources, issuer], {}, need_scores=False)["properties"]
    for k in ("near", "middle", "longer"):
        assert supported[k]["properties"]["source"]["enum"] == ["S4"]
    assert forecasts.can_tilt({**sources[1], "comparison_available": True})
