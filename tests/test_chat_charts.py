from fastapi.testclient import TestClient
from stockreplay.api import create_app


def test_comparison_snapshot_survives_restart_and_market_changes(tmp_path, monkeypatch):
    app = create_app(tmp_path)
    price = 100

    def quote(symbol, *args):
        if symbol == "ABSENT":
            return {"data": None, "error": "Unavailable", "stale": False}
        return {
            "data": {
                "symbol": symbol,
                "currency": "USD",
                "as_of": "2025-01-03",
                "source": "Publisher",
                "url": "https://example.org/history",
                "bars": [
                    {
                        "date": "2025-01-03",
                        "time": 1735862400,
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
