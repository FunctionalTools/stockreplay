"""Optional check of the same public observations used by the homepage and saved tabs."""

import os

import pytest
from fastapi.testclient import TestClient

from stockreplay.api import create_app


@pytest.mark.skipif(
    os.getenv("STOCKREPLAY_PUBLIC_LIVE") != "1", reason="Requires live market sources"
)
def test_live_ranges_and_exchange_holiday(tmp_path):
    with TestClient(create_app(tmp_path)) as client:
        for symbol, query in (
            ("AAPL", "range=1d"),
            ("SPY", "range=5d"),
            ("MSFT", "range=custom&start=2023-11-22&end=2023-11-28"),
        ):
            response = client.get(f"/api/desk/range/{symbol}?{query}")
            response.raise_for_status()
            packet = response.json()
            assert packet["data"], packet["error"]
            data = packet["data"]
            perf = data["performance"]
            assert perf["percent"] == pytest.approx(
                100 * (perf["end"]["price"] / perf["start"]["price"] - 1)
            )
            dates = {bar["date"] for bar in data["bars"]}
            if query == "range=1d":
                assert len(dates) == 1
                assert perf["basis"] == "previous_close" and perf["start"]["date"] < min(dates)
            elif query == "range=5d":
                assert 1 < len(dates) <= 5
            else:
                assert dates == {"2023-11-22", "2023-11-24", "2023-11-27", "2023-11-28"}
                assert perf["start"]["date"] == min(dates) and perf["end"]["date"] == max(dates)
