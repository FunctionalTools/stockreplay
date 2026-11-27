import json

from fastapi.testclient import TestClient

from stockreplay.api import create_app
from stockreplay.home import portfolio_context


def test_starting_ticker_tracks_holdings_and_persists_over_restart(tmp_path):
    with TestClient(create_app(tmp_path)) as c:
        assert c.get("/api/preferences").json()["home_mode"] == "portfolio"
        assert c.get("/api/home").json() == {
            "symbol": "SPY",
            "portfolio_symbol": None,
            "position_count": 0,
            "holdings": [],
        }
        account = c.post(
            "/api/holdings/accounts", json={"institution": "Personal", "name": "Private nickname"}
        ).json()["id"]
        path = f"/api/holdings/accounts/{account}/positions"
        position = {"symbol": "aapl", "quantity": 2, "price": 3, "as_of": "2026-03-05"}
        id = c.post(path, json=position).json()["id"]
        context = c.get("/api/home").json()
        assert context["symbol"] == "AAPL"
        assert context["holdings"][0]["quantity"] == 2
        assert context["holdings"][0]["last_date"] == "2026-03-05"
        assert "Private nickname" not in json.dumps(context) and account not in json.dumps(context)
        assert c.put(f"{path}/{id}", json={**position, "symbol": "msft"}).is_success
        assert c.get("/api/home").json()["symbol"] == "MSFT"
        assert (
            c.patch("/api/preferences", json={"home_symbol": " nvda "}).json()["home_mode"]
            == "ticker"
        )

    with TestClient(create_app(tmp_path)) as c:
        context = c.get("/api/home").json()
        assert (context["symbol"], context["portfolio_symbol"]) == ("NVDA", "MSFT")
        c.patch("/api/preferences", json={"home_mode": "portfolio"})
        assert c.get("/api/home").json()["symbol"] == "MSFT"
        assert c.delete(f"{path}/{id}").is_success
        assert c.get("/api/home").json()["symbol"] == "SPY"


def test_home_weights_with_partial_dates_mixed_currencies_and_cash():
    def row(symbol, value, quantity=None, currency="USD", date=None, description=""):
        return {
            "symbol": symbol,
            "quantity": quantity,
            "value": value,
            "currency": currency,
            "as_of": date,
            "description": description,
        }

    positions = [
        row("MSFT", 40, 4, date="2026-03-01"),
        row("msft", -10, -1, date="2026-03-04"),
        row("AAPL", None, 3),
        row("MSFT", None, 1),
        row("SPAXX", 120),
        row("FCASH", 20),
        row("CASH", 5),
        row("", 5),
        row("US0378331005", 100),
        row("037833100", 50),
        row("JPY", 900000, currency="JPY"),
        row("7203.T", 50000, 25, "JPY"),
        row("ABC", 50, description="Bank cash sweep"),
        row("AMZN", 0, 0),
    ]
    result = portfolio_context([{"positions": positions}])
    assert result["portfolio_symbol"] == "MSFT"
    holdings = result["holdings"]
    assert [h["symbol"] for h in holdings] == ["MSFT", "7203.T", "AAPL"]
    assert holdings[0] == {
        "symbol": "MSFT",
        "currency": "USD",
        "gross_value": 50,
        "partial_value": True,
        "weight": 0.125,
        "quantity": 4,
        "first_date": "2026-03-01",
        "last_date": "2026-03-04",
        "undated": True,
    }
    assert holdings[1]["weight"] == 50000 / 950000
    assert holdings[2]["weight"] is None
    assert result["position_count"] == len(positions)


def test_previous_default_is_migrated_without_losing_explicit_tickers(tmp_path):
    with TestClient(create_app(tmp_path)) as c:
        for old, opening, mode in [("NVDA", "SPY", "portfolio"), ("AAPL", "AAPL", "ticker")]:
            with c.app.state.store.connect() as db:
                db.execute(
                    "insert or replace into preferences values(1, ?)",
                    (json.dumps({"accent": "amber", "home_symbol": old}),),
                )
            assert c.get("/api/home").json()["symbol"] == opening
            settings = c.patch("/api/preferences", json={"appearance": "dark"}).json()
            assert (settings["home_mode"], settings["accent"]) == (mode, "amber")
