from datetime import UTC, date, datetime

import numpy as np
import pytest
from fastapi.testclient import TestClient

from stockreplay import projections as forecast
from stockreplay.api import create_app
from stockreplay.trading_calendar import calendar

AS_OF = date(2026, 11, 27)  # A Friday half-session after Thanksgiving.
CLOSED = datetime(2026, 11, 27, 18, 5, tzinfo=UTC)


def history(symbol="AAPL", n=340):
    sessions = calendar().sessions_window(AS_OF, -(n - 1))
    rows = []
    for i, d in enumerate(sessions):
        value = 100 * np.exp(i * 0.0005 + 0.02 * np.sin(i / 2.3) + 0.005 * np.cos(i / 4))
        rows.append(
            {"date": d.date().isoformat(), "raw_close": float(value), "close": float(value) * 0.95}
        )
    return {
        "symbol": symbol,
        "source": "Test market feed",
        "url": "https://example.org/history",
        "currency": "USD",
        "timezone": "America/New_York",
        "exchange": "NMS",
        "instrument_type": "EQUITY",
        "bars": rows,
    }


def projected(data, horizon="1mo", seed=42, instant=CLOSED, cutoff=AS_OF):
    return forecast.project_one(data, data["symbol"], horizon, seed, instant, cutoff)


def test_uses_actual_close_calendar_and_anchored_one_day_path():
    data = history()
    close = data["bars"][-1]["raw_close"]
    row = projected(data, "1d")
    assert row["points"][0] == {"date": "2026-11-27", "low": close, "median": close, "high": close}
    next_day = row["points"][1]
    assert (
        next_day["date"] == "2026-11-30"
        and 0 < next_day["low"] < next_day["median"] < next_day["high"]
    )
    assert len(row["points"]) == 2 and row["history"][-1] == {"date": "2026-11-27", "price": close}
    assert (
        row["coverage"]["returns"] == len(data["bars"]) - 1 and row["annualized_volatility_pct"] > 0
    )
    assert row["validation_1d"]["tested_sessions"] == 63
    assert 0 <= row["validation_1d"]["inside_band_sessions"] <= 63
    # Never include today's daily bar while a regular session is still open.
    before_close = datetime(2026, 11, 27, 17, 59, tzinfo=UTC)
    partial = projected(data, "1d", instant=before_close)
    assert partial["as_of"] == "2026-11-25"
    assert [p["date"] for p in partial["points"]] == ["2026-11-25", "2026-11-27"]


def test_all_horizons_are_deterministic_and_share_a_prefix():
    data = history()
    shortest = projected(data, "1d")["points"]
    durations = []
    for horizon in forecast.HORIZONS:
        result = projected(data, horizon)
        assert result["points"][:2] == shortest
        assert all(0 < p["low"] <= p["median"] <= p["high"] for p in result["points"])
        durations.append(len(result["points"]))
    assert durations == sorted(set(durations))
    longest = projected(data, "5y")
    assert longest["points"][-1]["date"] == "2031-11-26"  # Thanksgiving is closed.
    assert projected(data, "5y")["points"] == longest["points"]
    assert projected(data, "1d", seed=43)["points"][1] != shortest[1]
    assert len(longest["data_digest"]) == 64


def test_replay_ignores_later_bars_and_missing_sessions_do_not_create_returns():
    data = history()
    data["bars"].append({"date": "2026-11-30", "raw_close": 1e9})
    observed = projected(data)
    assert observed["history"][-1]["price"] < 200
    before = observed["coverage"]["returns"]
    del data["bars"][-4]
    after = projected(data)
    assert after["coverage"]["returns"] == before - 2
    assert after["data_digest"] != observed["data_digest"]
    assert after["annualized_volatility_pct"] != observed["annualized_volatility_pct"]


def test_unsupported_stale_short_and_flat_histories_return_per_symbol_errors(tmp_path, monkeypatch):
    app = create_app(tmp_path)
    desk = app.state.terminal.desk

    def dates(symbol, start, end, refresh):
        data = history(symbol, 40 if symbol == "IPO" else 320)
        if symbol == "CLOSED":
            data["bars"].pop()
        if symbol == "UNKNOWN":
            data.update(exchange="UNKNOWN")
        if symbol == "FLAT":
            for b in data["bars"]:
                b["raw_close"] = 20.0
        return {"data": data, "stale": False, "fetched": "2026-11-27T19:00:00+00:00"}

    monkeypatch.setattr(desk, "date_chart", dates)

    # Freeze the as-of clock to an instant after the early close regardless of CI wall time.
    class Clock(datetime):
        @classmethod
        def now(cls, tz):
            return CLOSED.astimezone(tz)

    monkeypatch.setattr(forecast, "datetime", Clock)
    with TestClient(app) as client:
        req = "/api/desk/projections"
        q = {
            "symbols": "AAPL,IPO,CLOSED,UNKNOWN,FLAT,BAD$",
            "horizon": "1w",
            "as_of": AS_OF.isoformat(),
        }
        response = client.get(req, params=q)
        assert response.is_success, response.text
        payload = response.json()
        assert [s["symbol"] for s in payload["series"]] == ["AAPL"]
        assert [e["symbol"] for e in payload["errors"]] == [
            "IPO",
            "CLOSED",
            "UNKNOWN",
            "FLAT",
            "BAD$",
        ]
        assert payload["series"][0]["as_of"] == AS_OF.isoformat()
        assert client.get(req, params={**q, "seed": -1}).status_code == 422
        assert client.get(req, params={**q, "horizon": "weekly-ish"}).status_code == 422


def test_foreign_calendar_session_date_and_future_anchor():
    tokyo = forecast.exchange_calendar("XTKS", 2020, "2027-01-08")
    schedule = tokyo.sessions_window("2026-11-27", -120)
    data = history()
    data.update(
        exchange="JPX",
        timezone="Asia/Tokyo",
        bars=[
            {"date": s.date().isoformat(), "raw_close": 100 + i * 0.01 + np.sin(i * 0.5)}
            for i, s in enumerate(schedule)
        ],
    )
    result = projected(data, "1w")
    assert result["calendar"] == "XTKS" and result["timezone"] == "Asia/Tokyo"
    assert result["points"][1]["date"] == "2026-11-30"
    with pytest.raises(ValueError, match="already occurred"):
        projected(data, cutoff=date(2026, 12, 1))


def test_late_daily_close_still_forecasts_upcoming_sessions_without_filling_history():
    data = history()
    data["bars"] = [b for b in data["bars"] if b["date"] <= "2026-11-19"]
    row = forecast.project_one(data, "AAPL", "1d", 42, CLOSED, None)
    assert row["as_of"] == row["coverage"]["end"] == row["confirmed_close_date"] == "2026-11-19"
    assert row["stale"] and row["expected_session"] == "2026-11-27"
    assert row["points"][0]["median"] == data["bars"][-1]["raw_close"]
    assert [p["date"] for p in row["points"]] == ["2026-11-19", "2026-11-30"]
    assert "5 trading sessions" in row["data_note"]
    assert row["history"][-1]["date"] == "2026-11-19"


def test_live_regular_quote_is_separate_from_completed_daily_calibration():
    from zoneinfo import ZoneInfo

    data = history()
    day = "2026-11-27"
    supplied = [("09:25", 12), ("09:30", 101), ("12:45", 102), ("13:00", 500)]
    times = [
        int(
            datetime.fromisoformat(day + "T" + clock)
            .replace(tzinfo=ZoneInfo("America/New_York"))
            .timestamp()
        )
        for clock, _ in supplied
    ]
    minute_data = {
        **data,
        "bars": [
            {"date": day, "time": ts, "raw_close": price} for ts, (_, price) in zip(times, supplied)
        ],
    }
    observed = datetime(2026, 11, 27, 17, 46, tzinfo=UTC)
    row = forecast.project_one(
        data, "AAPL", "1d", 42, observed, None, intraday_loader=lambda: {"data": minute_data}
    )
    assert row["anchor_kind"] == "intraday" and row["anchor_time"].endswith("12:45:00-05:00")
    assert row["points"][0]["median"] == 102
    assert row["confirmed_close_date"] == row["coverage"]["end"] == "2026-11-25"
    assert row["points"][1]["date"] == "2026-11-30"
    # A cached intraday daily candle still isn't a confirmed close after market close.
    cached = forecast.project_one(
        data, "AAPL", "1d", 42, CLOSED, None, daily_fetched=observed.isoformat()
    )
    assert cached["as_of"] == "2026-11-25" and cached["expected_session"] == day


def test_observed_split_is_applied_only_to_a_preannouncement_cache():
    data = history()
    data["bars"] = [b for b in data["bars"] if b["date"] <= "2026-11-19"]
    data["bars"][-1]["raw_close"] = 755.16
    data["splits"] = [{"date": "2026-11-20", "ratio": 8}]
    row = forecast.project_one(
        data, "AAPL", "1d", 42, CLOSED, None, daily_fetched="2026-11-19T22:00:00Z"
    )
    assert row["points"][0]["median"] == pytest.approx(94.395)
    assert "8-for-1" in row["data_note"]
    data["bars"][-1]["raw_close"] = 94.395
    refreshed = forecast.project_one(
        data, "AAPL", "1d", 42, CLOSED, None, daily_fetched="2026-11-27T19:00:00Z"
    )
    assert refreshed["points"][0]["median"] == pytest.approx(94.395)


def test_key_free_endpoint_handles_every_period_and_cached_history(tmp_path, monkeypatch):
    app = create_app(tmp_path)
    desk = app.state.terminal.desk
    data = history()
    # Friday's latest recovery supplements the before-holiday series.
    data["price_sources"] = [
        {"source": "Yahoo Finance", "url": "https://finance.yahoo.com/quote/AAPL/history/"},
        {"source": "Stock Analysis", "url": "https://stockanalysis.com/stocks/aapl/history/"},
    ]
    data["bars"][-1].update(source="Stock Analysis", url=data["price_sources"][1]["url"])
    monkeypatch.setattr(desk, "chart", lambda *args: {"data": None, "error": "Offline."})
    monkeypatch.setattr(
        desk.cache,
        "read",
        lambda key: (
            {"data": data, "fetched": "2026-11-27T19:00:00Z", "stale": False}
            if key.endswith(":2y")
            else None
        ),
    )

    class Clock(datetime):
        @classmethod
        def now(cls, tz):
            return CLOSED.astimezone(tz)

    monkeypatch.setattr(forecast, "datetime", Clock)
    with TestClient(app) as client:
        for preset in forecast.RANGE_PRESETS:
            params = {"symbols": "AAPL", "horizon": preset}
            if preset == "custom":
                params.update(start="2026-12-03", end="2026-12-06")
            result = client.get("/api/desk/projections", params=params).raise_for_status().json()
            assert not result["errors"], result
            row = result["series"][0]
            assert row["stale"] and "cached" in row["data_note"]
            assert (
                row["price_sources"] == data["price_sources"]
                and row["anchor_source"] == "Stock Analysis"
            )
            assert len(row["points"]) >= 2 and row["points"][1]["date"] > "2026-11-27"
            if preset == "custom":
                assert row["requested_end"] == "2026-12-06" and [
                    p["date"] for p in row["points"][1:]
                ] == ["2026-12-03", "2026-12-04"]
