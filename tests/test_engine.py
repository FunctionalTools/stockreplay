import numpy as np
import pytest

from stockreplay.engine import analyze
from stockreplay.indicators import evaluate, indicator
from stockreplay.market import adjusted
from stockreplay.schema import Condition, Group
from stockreplay.statistics import block_inference, portfolio_metrics


def test_event_timing_independent_expected(config, frames):
    r = analyze(config, frames)
    assert [e["return_pct"] for e in r["events"]] == pytest.approx([-17.5, 12.5])
    first = r["events"][0]
    assert (first["signal"], first["entry"], first["exit"]) == (
        "2023-01-04",
        "2023-01-05",
        "2023-01-06",
    )
    assert (first["entry_price"], first["exit_price"]) == (120, 99)
    assert r["metrics"]["mean"] == pytest.approx(-2.5)
    assert r["metrics"]["median"] == pytest.approx(-2.5)
    assert r["metrics"]["win_rate"] == 50
    assert r["metrics"]["failures"] == 1
    assert sum(b["count"] for b in r["distribution"]) == 2
    assert r["distribution"][0]["low"] == pytest.approx(-17.5)
    assert r["inference"]["low"] is None
    assert r["curve"][-1]["strategy"] == pytest.approx(-2.5)
    assert "total_return" not in r["metrics"]


def test_fees_and_slippage_each_side(config, frames):
    c = config.model_copy(update={"cost_bps": 10, "slippage_bps": 20})
    trade = analyze(c, frames)["events"][0]
    expected = 100 * (99 * 0.998 * 0.999 / (120 * 1.002 * 1.001) - 1)
    assert trade["return_pct"] == pytest.approx(expected)
    assert trade["gross_pct"] == pytest.approx(-17.5)
    assert trade["benchmark_pct"] < 0


def test_portfolio_compounds_and_marks_daily(config, frames):
    r = analyze(config.model_copy(update={"kind": "portfolio"}), frames)
    assert r["metrics"]["total_return"] == pytest.approx(100 * ((99 / 120) * (90 / 80) - 1))
    assert r["curve"][2]["strategy"] == pytest.approx(100 * (92 / 120 - 1))
    assert r["metrics"]["drawdown"] == pytest.approx(100 * (92 / 120 - 1))
    assert r["metrics"]["annualized"] is None and r["metrics"]["sharpe"] is None


def test_equal_sleeves_and_overlap(config, frames):
    frames["AAPL"] = frames["SPY"]
    c = config.model_copy(update={"kind": "portfolio", "tickers": ["NVDA", "AAPL"]})
    assert analyze(c, frames)["metrics"]["total_return"] == pytest.approx(
        50 * ((99 / 120) * (90 / 80) - 1)
    )
    always = Group(rules=[Condition(indicator="volume", operator="gt", value=0)])
    r = analyze(c.model_copy(update={"entry": always, "holding": 3}), frames)
    for asset in c.tickers:
        trades = [e for e in r["events"] if e["ticker"] == asset]
        assert all(a["exit"] < b["entry"] for a, b in zip(trades, trades[1:]))
    assert r["metrics"]["overlaps_skipped"] > 0 and r["metrics"]["boundary_skipped"] > 0


def test_exit_next_open(config, frames):
    exit_rule = Group(rules=[Condition(indicator="volume", operator="gt", value=0)])
    r = analyze(config.model_copy(update={"holding": 4, "exit": exit_rule}), frames)
    event = r["events"][0]
    assert event["exit_at"] == "open" and event["exit_price"] == 96
    assert event["return_pct"] == pytest.approx(-20)


def test_cross_asset_objectives_and_recovery(config, frames):
    c = config.model_copy(
        update={
            "tickers": ["SPY"],
            "entry": Group(rules=[Condition(ticker="NVDA", value=-5)]),
            "objective": "outperform",
        }
    )
    r = analyze(c, frames)
    assert len(r["events"]) == 2 and r["metrics"]["win_rate"] == 0
    c = config.model_copy(update={"objective": "recovery"})
    assert analyze(c, frames)["metrics"]["win_rate"] == 0
    frames["NVDA"].loc[frames["NVDA"].index[3], "Adj Close"] = 101
    assert analyze(c, frames)["events"][0]["success"]


def test_no_lookahead_or_cross_partition_trade(config, frames):
    c = config.model_copy(update={"holding": 2})
    baseline = analyze(c, frames, bounds=(0, 3))
    changed = {k: v.copy() for k, v in frames.items()}
    changed["NVDA"].iloc[4:] *= 10
    assert analyze(c, changed, bounds=(0, 3)) == baseline
    assert all(
        e["signal"] >= frames["NVDA"].index[4].date().isoformat()
        for e in analyze(c, frames, bounds=(4, 7))["events"]
    )


@pytest.mark.parametrize(
    "kind,w,slow,position,expected",
    [
        ("daily_return", 2, 3, 1, -10),
        ("cumulative_return", 2, 3, 2, -8),
        ("positive_streak", 2, 3, 3, 2),
        ("negative_streak", 2, 3, 1, 1),
        ("rsi", 2, 3, 2, 100 * 2 / 12),
        ("sma_distance", 2, 3, 2, 100 * (92 / 91 - 1)),
        ("cross_above", 2, 3, 3, 1),
        ("cross_below", 2, 3, 5, 1),
        ("drawdown", 3, 4, 2, -8),
        ("relative_volume", 2, 3, 2, 1),
        ("volume", 2, 3, 0, 1000),
        ("relative_return", 2, 3, 2, -8),
        ("volatility", 2, 3, 2, np.std([-0.1, 92 / 90 - 1], ddof=1) * np.sqrt(252) * 100),
    ],
)
def test_indicators(frames, kind, w, slow, position, expected):
    s = indicator(Condition(indicator=kind, window=w, slow=slow), frames, "NVDA", "SPY")
    assert s.iloc[position] == pytest.approx(expected)


def test_no_future_in_relative_volume(frames):
    frames["NVDA"].loc[frames["NVDA"].index[2], "Volume"] = 4000
    r = indicator(Condition(indicator="relative_volume", window=2), frames, "NVDA", "SPY")
    assert r.iloc[2] == 4 and np.isnan(r.iloc[1])


def test_logic_and_warmup(frames):
    a = Condition(value=-5)
    b = Condition(indicator="volume", operator="gt", value=0)
    both = evaluate(Group(logic="and", rules=[a, b]), frames, "NVDA", "SPY")[0]
    either = evaluate(Group(logic="or", rules=[a, b]), frames, "NVDA", "SPY")[0]
    assert both.sum() == 2 and either.sum() == 8
    assert np.isnan(indicator(Condition(indicator="rsi", window=4), frames, "NVDA", "SPY").iloc[3])
    assert indicator(Condition(indicator="rsi", window=2), frames, "SPY", "NVDA").iloc[2] == 50


def test_adjusted_ohlc_and_zero_event(config, frames):
    f = frames["NVDA"].copy()
    f["Adj Close"] *= 0.5
    assert adjusted(f).Open.tolist() == (f.Open * 0.5).tolist()
    c = config.model_copy(update={"entry": Group(rules=[Condition(value=-99)])})
    r = analyze(c, frames)
    assert r["events"] == [] and r["metrics"]["mean"] is None and r["inference"]["p_value"] is None


def test_block_inference_and_annualization(config):
    import pandas as pd

    days = pd.bdate_range("2020-01-01", periods=300)
    events = [
        {"signal": d.strftime("%Y-%m-%d"), "effect": float(i % 9 - 2)} for i, d in enumerate(days)
    ]
    r = block_inference(events, days, config)
    assert r == block_inference(events, days, config)
    clustered = block_inference(events * 5, days, config)
    assert (clustered["low"], clustered["high"]) == pytest.approx((r["low"], r["high"]))
    assert r["low"] < r["estimate"] < r["high"] and 0 < r["p_value"] < 0.05
    assert r["block"] >= config.holding
    equity = np.linspace(1, 1.1, len(days))
    p = portfolio_metrics(equity, equity, days)
    assert p["annualized"] == pytest.approx(
        100 * (1.1 ** (365.2425 / ((days[-1] - days[0]).days + 1)) - 1)
    )
    assert p["sharpe"] is not None and p["drawdown"] == 0
