from datetime import date, datetime, timezone
from zoneinfo import ZoneInfo

import pandas as pd
import pytest

from stockreplay import desk, price_ranges as ranges

NY = ZoneInfo("America/New_York")


def bar(day, price, *, hm=None, adjusted=None):
    stamp = pd.Timestamp(day + (" " + hm if hm else ""), tz=NY if hm else "UTC")
    return {
        "date": day,
        "time": int(stamp.timestamp()),
        "raw_close": price,
        "close": adjusted or price,
    }


class MarketDesk:
    def __init__(self, daily=(), minutes=(), **metadata):
        self.daily, self.minutes = daily, minutes
        self.queries = []
        self.metadata = {
            "timezone": "America/New_York",
            "exchange": "NMS",
            "currency": "USD",
            "adjusted": True,
            **metadata,
        }

    def packet(self, rows):
        return {
            "data": {**self.metadata, "bars": rows},
            "fetched": None,
            "error": None,
            "stale": False,
        }

    def chart(self, ticker, interval, span, refresh):
        self.queries.append((ticker, interval, span, refresh))
        return self.packet(self.daily if interval == "1d" else self.minutes)

    def date_chart(self, ticker, start, end, refresh):
        self.queries.append((ticker, start, end, refresh))
        return self.packet(self.daily)


@pytest.fixture(autouse=True)
def after_early_close(monkeypatch):
    class Now(datetime):
        @classmethod
        def now(cls, tz):
            return datetime(2026, 11, 27, 18, 10, tzinfo=timezone.utc).astimezone(tz)

    monkeypatch.setattr(ranges, "datetime", Now)


def test_day_uses_prior_reported_close_across_holiday_and_excludes_after_hours():
    old, holiday, today = "2026-11-25", "2026-11-26", "2026-11-27"
    market = MarketDesk(
        [bar(old, 80, adjusted=79), bar(today, 84)],
        [
            bar(old, 80, hm="15:55"),
            bar(holiday, 500, hm="10:00"),
            bar(today, 3, hm="09:25"),
            bar(today, 81, hm="09:30"),
            bar(today, 84, hm="12:55"),
            bar(today, 4, hm="13:00"),
            bar(today, 5, hm="14:00"),
        ],
    )
    result = ranges.price_range(market, "AAPL", "1d", refresh=True)["data"]
    assert [b["close"] for b in result["bars"]] == [81, 84]
    p = result["performance"]
    assert (p["basis"], p["start"]["date"], p["start"]["price"], p["end"]["time"]) == (
        "previous_close",
        old,
        80,
        result["bars"][-1]["time"],
    )
    assert p["percent"] == pytest.approx(5)
    assert market.queries == [("AAPL", "5m", "5d", True), ("AAPL", "1d", "1mo", True)]
    market.daily = [bar("2026-11-24", 70)]  # missing the actual previous session
    p = ranges.price_range(market, "AAPL", "1d")["data"]["performance"]
    assert p["start"] is None and p["percent"] is None


def test_five_sessions_and_future_points():
    dates = ["2026-11-19", "2026-11-20", "2026-11-23", "2026-11-24", "2026-11-25", "2026-11-27"]
    market = MarketDesk(
        minutes=[bar(d, 100 + i, hm="09:30") for i, d in enumerate(dates)]
        + [bar("2026-11-30", 400, hm="09:30")]
    )
    result = ranges.price_range(market, "NVDA", "5d")["data"]
    assert [b["date"] for b in result["bars"]] == dates[-5:]
    assert result["performance"]["percent"] == pytest.approx(100 * (105 / 101 - 1))
    assert result["performance"]["start"]["price"] == 101
    assert result["interval"] == "5m"


def test_custom_bounds_use_observed_closes_and_adjustments():
    market = MarketDesk(
        [
            bar("2003-11-26", 96),
            bar("2003-11-28", 100, adjusted=50),
            bar("2003-12-01", 108, adjusted=60),
            bar("2003-12-02", 150),
        ]
    )
    res = ranges.price_range(market, "AAPL", "custom", "2003-11-27", "2003-12-01")["data"]
    assert market.queries == [("AAPL", date(2003, 11, 27), date(2003, 12, 1), False)]
    assert res["performance"]["percent"] == pytest.approx(20)
    assert res["performance"]["start"]["date"] == "2003-11-28"
    assert res["price_basis"] == "adjusted"
    only = ranges.price_range(market, "AAPL", "custom", "2003-11-28", "2003-11-30")["data"]
    assert only["performance"]["percent"] is None
    assert ranges.price_range(market, "AAPL", "custom", "2003-11-29", "2003-11-30")["data"] is None
    market.metadata["adjusted"] = False
    raw = ranges.price_range(market, "AAPL", "custom", "2003-11-27", "2003-12-01")["data"]
    assert raw["price_basis"] == "nominal" and raw["performance"]["percent"] == pytest.approx(8)
    assert raw["bars"][0]["close"] == 100


def test_ytd_uses_only_comparable_prior_year_close_and_calendar_presets():
    market = MarketDesk(
        [
            bar("2025-12-31", 100),
            bar("2026-01-02", 110),
            bar("2026-10-26", 125),
            bar("2026-10-27", 130),
            bar("2026-11-27", 140),
        ]
    )
    p = ranges.price_range(market, "SPY", "ytd")["data"]["performance"]
    assert p["basis"] == "prior_year_close" and p["percent"] == pytest.approx(40)
    market.daily[0] = bar("2025-12-30", 98)
    p = ranges.price_range(market, "SPY", "ytd")["data"]["performance"]
    assert p["basis"] == "first_observation" and p["start"]["price"] == 110
    m = ranges.price_range(market, "SPY", "1mo")["data"]
    assert m["performance"]["start"]["date"] == "2026-10-27"
    assert ranges.price_range(market, "SPY", "max")["data"]["bars"][0]["date"] == "2025-12-30"
    with pytest.raises(ValueError):
        ranges.price_range(market, "SPY", "custom", "2027-02-01", "2027-02-02")
    with pytest.raises(ValueError):
        ranges.validate_range("custom", "2024-01-02", "2024-01-01")


def test_provider_requests_historical_inclusive_end_once(monkeypatch):
    calls = []

    class Ticker:
        history_metadata = {"currency": "JPY", "exchangeName": "JPX", "instrumentType": "EQUITY"}

        def history(self, **kwargs):
            calls.append(kwargs)
            return pd.DataFrame(
                [{"Open": 100, "High": 110, "Low": 95, "Close": 108, "Adj Close": 54}],
                index=pd.DatetimeIndex(["2000-01-04"], tz="Asia/Tokyo"),
            )

    monkeypatch.setattr(desk.yf, "Ticker", lambda _: Ticker())
    historic = desk.chart_data("7203.T", "1d", "custom", date(2000, 1, 1), date(2000, 1, 4))
    assert calls == [
        {
            "interval": "1d",
            "start": "2000-01-01",
            "end": "2000-01-05",
            "prepost": False,
            "auto_adjust": False,
            "actions": True,
            "timeout": 12,
        }
    ]
    assert historic["bars"][0]["date"] == "2000-01-04"
    assert historic["bars"][0]["close"] == 54
    assert historic["timezone"] == "Asia/Tokyo"


def test_one_calendar_week_of_closes_across_holiday():
    market = MarketDesk(
        daily=[
            bar("2026-11-19", 75, adjusted=35),
            bar("2026-11-20", 80, adjusted=40),
            bar("2026-11-23", 90, adjusted=45),
            bar("2026-11-27", 100, adjusted=50),
        ]
    )
    weekly = ranges.price_range(market, "AAPL", "1w")["data"]
    p = weekly["performance"]
    assert market.queries == [("AAPL", "1d", "1w", False)]
    assert weekly["interval"] == "1d" and weekly["price_basis"] == "adjusted"
    assert weekly["requested_start"] == p["start"]["date"] == "2026-11-20"
    assert p["end"]["date"] == "2026-11-27" and p["percent"] == pytest.approx(25)
    assert [b["date"] for b in weekly["bars"]] == ["2026-11-20", "2026-11-23", "2026-11-27"]


def test_weekly_preset_uses_supported_daily_provider_period_and_observed_end(monkeypatch):
    requests = []

    class Ticker:
        history_metadata = {"currency": "USD", "exchangeName": "NMS", "instrumentType": "EQUITY"}

        def history(self, **kwargs):
            requests.append(kwargs)
            return pd.DataFrame(
                [
                    {"Open": v, "High": v + 1, "Low": v - 1, "Close": v, "Adj Close": v}
                    for v in (79, 80, 90, 100)
                ],
                index=pd.DatetimeIndex(
                    ["2001-11-15", "2001-11-16", "2001-11-19", "2001-11-23"], tz=NY
                ),
            )

    monkeypatch.setattr(desk.yf, "Ticker", lambda _: Ticker())
    series = desk.chart_data("AAPL", "1d", "1w")
    assert requests[0]["period"] == "1mo" and requests[0]["interval"] == "1d"
    assert [b["date"] for b in series["bars"]] == ["2001-11-16", "2001-11-19", "2001-11-23"]
    assert series["span"] == "1w" and series["as_of"] == "2001-11-23"
