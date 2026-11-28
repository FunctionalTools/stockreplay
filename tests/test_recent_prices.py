from datetime import date
from types import SimpleNamespace

import pandas as pd
import pytest

from stockreplay import desk
from stockreplay.recent_prices import recover_recent


DAY = date(2026, 11, 27)
URL = "https://stockanalysis.com/stocks/sndk/history/"
META = {"instrumentType": "EQUITY", "currency": "USD", "exchangeName": "NMS"}


def bar(close, split=0):
    return {
        "Open": close,
        "High": close,
        "Low": close,
        "Close": close,
        "Adj Close": close,
        "Volume": 100,
        "Stock Splits": split,
    }


def frame(days):
    return pd.DataFrame(
        [row for _, row in days],
        index=pd.DatetimeIndex([d for d, _ in days], tz="America/New_York"),
    )


def published(closes, url=URL):
    rows = "".join(
        f"<tr><td>{day}</td>" + f"<td>{p}</td>" * 5 + "<td>100</td></tr>" for day, p in closes
    )
    return SimpleNamespace(
        content=(
            f'<link rel="canonical" href="{url}"><table><thead><tr>'
            + "".join(
                f"<th>{h}</th>"
                for h in ("Date", "Open", "High", "Low", "Close", "Adj. Close", "Volume")
            )
            + f"</tr></thead><tbody>{rows}</tbody></table>"
        ).encode()
    )


def test_missing_split_week_recovers_published_closes_and_sources(monkeypatch):
    long = frame(
        [("2026-11-19", bar(94.394997)), ("2026-11-20", bar(None, 8)), ("2026-11-27", bar(None))]
    )
    short = frame([("2026-11-27", bar(85.36))])
    calls = []

    class Instrument:
        history_metadata = META

        def history(self, **opts):
            calls.append(opts["period"])
            return short if opts["period"] == "5d" else long

    monkeypatch.setattr(desk.yf, "Ticker", lambda _: Instrument())
    monkeypatch.setattr(desk, "latest_session", lambda *_: DAY)
    closes = [
        ("Nov 19, 2026", 94.40),
        ("Nov 20, 2026", 79.24),
        ("Nov 23, 2026", 87.71),
        ("Nov 24, 2026", 77.95),
        ("Nov 25, 2026", 73.61),
        ("Nov 27, 2026", 85.36),
        ("Nov 30, 2026", 1000),
    ]
    monkeypatch.setattr(desk, "fetch_url", lambda url: published(closes))
    data = desk.chart_data("SNDK", "1d", "10y")
    assert calls == ["10y", "5d"]
    assert [b["raw_close"] for b in data["bars"]] == [94.394997, 79.24, 87.71, 77.95, 73.61, 85.36]
    assert data["splits"] == [{"date": "2026-11-20", "ratio": 8}]
    assert data["bars"][1]["split"] == 8
    assert data["as_of"] == "2026-11-27"
    assert data["price_sources"][1] == {"source": "Stock Analysis", "url": URL}
    assert all(b["source"] == "Stock Analysis" for b in data["bars"][1:-1])


@pytest.mark.parametrize("alternate_close,url", [(944, URL), (94.4, URL.replace("sndk", "wrong"))])
def test_different_share_basis_or_security_cannot_repair_bars(alternate_close, url):
    original = frame([("2026-11-19", bar(94.395)), ("2026-11-20", bar(None, 8))])
    html = published([("Nov 19, 2026", alternate_close), ("Nov 27, 2026", 85.36)], url)
    repaired, sources = recover_recent(
        original, None, "SNDK", META, DAY, None, None, "5d", lambda _: html
    )
    assert not sources
    pd.testing.assert_frame_equal(repaired, original)


def test_updating_recovers_pre_repair_cache_and_keeps_offline_history(tmp_path, monkeypatch):
    from stockreplay.store import Store

    market = desk.Desk(Store(tmp_path))
    old = {"as_of": "2026-11-19", "bars": [bar(94.395)]}
    market.cache.get("bars:SNDK:1d:10y", 600, lambda: old)

    def offline(*args):
        raise ValueError("No connection")

    monkeypatch.setattr(desk, "chart_data", offline)
    cached = market.chart("SNDK", "1d", "10y")
    assert cached["stale"] and cached["data"] == old
    repaired = {
        **old,
        "price_sources": [{"source": "Yahoo Finance", "url": URL}],
        "as_of": "2026-11-27",
    }
    monkeypatch.setattr(desk, "chart_data", lambda *args: repaired)
    assert market.chart("SNDK", "1d", "10y")["data"] == repaired
    monkeypatch.setattr(desk, "chart_data", offline)
    assert not market.chart("SNDK", "1d", "10y")["stale"]
