import json
import os
import pytest
from pydantic import ValidationError
import httpx

from stockreplay import ai
from stockreplay.schema import Experiment, InterpretationRequest


@pytest.mark.parametrize(
    "patch",
    [
        {"tickers": ["../NVDA"]},
        {"tickers": ["SPY", "SPY"]},
        {"holding": 0},
        {"holding": 1.5},
        {"entry": {"rules": [{"indicator": "code"}]}},
        {"source": "automatic"},
        {"start": "2020-12-12", "end": "2019-01-01"},
        {"extra": "no"},
        {"entry": {"rules": [{"indicator": "cross_above", "window": 20, "slow": 10}]}},
        {"slippage_bps": float("nan")},
    ],
)
def test_strict_config(patch):
    with pytest.raises(ValidationError):
        Experiment.model_validate({**Experiment().model_dump(), **patch})


def ready():
    return {
        "status": "ready",
        "message": "Ready",
        "tickers": ["MSFT"],
        "holding": 15,
        "objective": "outperform",
        "entry": {
            "logic": "and",
            "rules": [
                {"ticker": "ASSET", "indicator": "daily_return", "operator": "gt", "value": 4}
            ],
        },
    }


def test_correction_and_cross_ticker_literals(monkeypatch):
    replies = iter(["not json", json.dumps(ready())])
    monkeypatch.setattr(ai, "chat", lambda *a: next(replies))
    r = ai.interpret(
        InterpretationRequest(
            question="Does Microsoft outperform in the three days after NVIDIA falls more than 4%?",
            config=Experiment(),
        ),
        "local",
    )
    assert r.status == "ready" and r.config.holding == 3
    assert r.config.tickers == ["MSFT"] and r.config.entry.rules[0].ticker == "NVDA"
    assert r.config.entry.rules[0].value == -4 and r.config.entry.rules[0].operator == "lt"


def test_limited_retries_and_clarification(monkeypatch):
    calls = []

    def bad(*args):
        calls.append(1)
        return "{}"

    monkeypatch.setattr(ai, "chat", bad)
    req = InterpretationRequest(question="When will it gain?", config=Experiment())
    assert ai.interpret(req, "local").status == "clarify" and len(calls) == 3
    monkeypatch.setattr(ai, "chat", lambda *a: '{"status":"clarify","message":"Which ticker?"}')
    assert ai.interpret(req, "local").message == "Which ticker?"


def test_unsupported_guard_and_offline(monkeypatch):
    req = InterpretationRequest(question="Does earnings growth predict gains?", config=Experiment())
    monkeypatch.setattr(ai, "chat", lambda *a: json.dumps(ready()))
    assert ai.interpret(req, "local").status == "unsupported"

    def fail(*a, **k):
        raise httpx.ConnectError("offline")

    monkeypatch.setattr(ai.httpx, "get", fail)
    assert ai.status("x") == {"online": False, "ready": False, "model": "x", "models": []}


def test_grounded_explanation(monkeypatch, config, frames):
    from stockreplay.engine import analyze

    result = analyze(config, frames)
    monkeypatch.setattr(ai, "chat", lambda *a: '{"order":["invented 999 percent"]}')
    answer = ai.explain(result, "local")
    assert {s["text"] for s in answer["sections"] if s["key"] != "assessment"} == set(
        ai.facts(result).values()
    )
    assert answer["origin"] == "engine"
    assert all("999" not in s["text"] for s in answer["sections"])


@pytest.mark.skipif(
    os.environ.get("STOCKREPLAY_LIVE_TESTS") != "1",
    reason="enable installed-model integration explicitly",
)
def test_running_ollama():
    model = os.environ.get("STOCKREPLAY_MODEL", "qwen2.5:7b")
    assert ai.status(model)["ready"]
    r = ai.interpret(
        InterpretationRequest(
            question="Does NVIDIA have a positive five-session return after a daily loss greater than 3%?",
            config=Experiment(),
        ),
        model,
    )
    assert r.status == "ready" and r.config.tickers == ["NVDA"] and r.config.holding == 5
    assert r.config.entry.rules[0].value == -3 and r.config.entry.rules[0].operator == "lt"


def test_assistant_selects_only_verified_prose(monkeypatch, config, frames):
    from stockreplay.engine import analyze

    result = analyze(config, frames)
    leads, choices = ai.evidence_choices(result)

    def pick(model, schema, messages):
        return json.dumps(
            {"assessment": leads[0], "clauses": ["effect_1", "counter_1", "benchmark_1"]}
        )

    monkeypatch.setattr(ai, "chat", pick)
    output = ai.explain(result, "local")
    assert output["origin"] == "ollama"
    assert [v["text"] for v in output["sections"][:3]] == [
        leads[0],
        choices["effect"][1],
        choices["counter"][1],
    ]


@pytest.mark.skipif(
    os.environ.get("STOCKREPLAY_LIVE_TESTS") != "1",
    reason="enable installed-model integration explicitly",
)
@pytest.mark.parametrize(
    "question,status",
    [
        (
            "Does Microsoft outperform the S&P 500 in the three days after NVIDIA falls more than 4%?",
            "ready",
        ),
        ("Which result follows if this stock has an unusually bad day?", "clarify"),
        (
            "Does Apple gain over five sessions when the CEO tweets about its products?",
            "unsupported",
        ),
    ],
)
def test_live_research_language(question, status):
    r = ai.interpret(
        InterpretationRequest(question=question, config=Experiment()),
        os.environ.get("STOCKREPLAY_MODEL", "qwen2.5:7b"),
    )
    assert r.status == status, r.message
    if status == "ready":
        assert (
            r.config.tickers == ["MSFT"] and r.config.benchmark == "SPY" and r.config.holding == 3
        )
        rule = r.config.entry.rules[0]
        assert rule.ticker == "NVDA" and rule.value == -4 and rule.operator == "lt"
        assert r.config.objective == "outperform"


def test_ungrounded_ticker_and_ambiguous_recovery(monkeypatch):
    fake = ready()
    monkeypatch.setattr(ai, "chat", lambda *a: json.dumps(fake))
    for q in [
        "What happens to this stock after a bad day?",
        "Does Microsoft recover after a daily decline exceeding 3%?",
    ]:
        assert (
            ai.interpret(InterpretationRequest(question=q, config=Experiment()), "local").status
            == "clarify"
        )


def test_named_signal_asset_and_unrelated_lookback():
    from stockreplay.language import literals, trigger_symbol

    assert trigger_symbol("Does AAPL gain when Microsoft falls more than 2%?", ["AAPL"]) == "MSFT"
    assert "holding" not in literals(
        "Does Apple gain after NVDA drops more than 4% over five sessions?"
    )
