from datetime import datetime, timedelta, timezone

from fastapi.testclient import TestClient
from stockreplay.api import create_app


def test_comparison_snapshot_survives_restart_and_market_changes(tmp_path, monkeypatch):
    app = create_app(tmp_path)
    price = 100
    observed = datetime.now(timezone.utc) - timedelta(days=1)

    def quote(symbol, *args):
        if symbol == "ABSENT":
            return {"data": None, "error": "Unavailable", "stale": False}
        return {
            "data": {
                "symbol": symbol,
                "currency": "USD",
                "as_of": observed.date().isoformat(),
                "source": "Publisher",
                "url": "https://example.org/history",
                "bars": [
                    {
                        "date": observed.date().isoformat(),
                        "time": int(observed.timestamp()),
                        "raw_close": price,
                        "close": price,
                    }
                ],
            },
            "stale": False,
            "error": None,
        }

    monkeypatch.setattr(app.state.terminal.desk, "chart", quote)
    with TestClient(app) as client:
        request = {"symbols": ["NVDA", "ABSENT"], "span": "1y"}
        key = client.post("/api/assistant/charts", json=request).json()["id"]
        assert client.post("/api/assistant/charts", json=request).json()["id"] == key
        price = 109
        assert client.post("/api/assistant/charts", json=request).json()["id"] != key
        assert (
            client.post(
                "/api/assistant/charts", json={"symbols": ["ABSENT"], "span": "1y"}
            ).status_code
            == 422
        )
    with TestClient(create_app(tmp_path)) as reopened:
        saved = reopened.get("/api/assistant/charts/" + key).json()
        assert saved["series"][0]["bars"][0]["close"] == 100
        assert saved["errors"] == ["ABSENT · Unavailable"]
        assert saved["captured"]


def test_custom_range_snapshot_keeps_only_the_requested_dates(tmp_path, monkeypatch):
    app = create_app(tmp_path)

    def custom(symbol, start, end, refresh):
        return {
            "data": {
                "symbol": symbol,
                "source": "Price publisher",
                "currency": "USD",
                "timezone": "UTC",
                "url": "https://example.org/prices",
                "bars": [
                    {"date": d, "time": t, "close": c, "raw_close": c}
                    for d, t, c in [
                        ("2025-03-04", 1741046400, 12),
                        ("2025-03-05", 1741132800, 13),
                        ("2025-03-06", 1741219200, 11),
                    ]
                ],
            },
            "error": None,
            "stale": False,
        }

    monkeypatch.setattr(app.state.terminal.desk, "date_chart", custom)
    with TestClient(app) as c:
        body = {"symbols": ["ABC"], "span": "2025-03-05/2025-03-06"}
        result = c.post("/api/assistant/charts", json=body)
        assert result.is_success, result.text
        saved = c.get("/api/assistant/charts/" + result.json()["id"]).json()
        row = saved["series"][0]
        assert row["timezone"] == "UTC" and row["interval"] == "1d"
        assert [p["date"] for p in row["bars"]] == ["2025-03-05", "2025-03-06"]
        assert row["performance"]["percent"] < 0
        assert (
            c.post(
                "/api/assistant/charts", json={**body, "span": "2025-03-06/2025-03-05"}
            ).status_code
            == 422
        )
