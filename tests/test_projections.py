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
