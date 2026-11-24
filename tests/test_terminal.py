"""Financial data boundaries, persistent account operations and provider contracts."""

import json
import os
import sys
from datetime import date
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

from stockreplay.api import create_app
from stockreplay.desk import technical_rating
from stockreplay.public_cache import PublicCache
from stockreplay.store import Store
from stockreplay.trading_calendar import latest_session


@pytest.fixture
def client(tmp_path):
    with TestClient(create_app(tmp_path)) as c:
        yield c


@pytest.mark.parametrize(
    "instant,expected",
    [
        ("2025-11-28T12:59:59-05:00", "2025-11-26"),  # Thanksgiving Friday early close
        ("2025-11-28T13:00:00-05:00", "2025-11-28"),
        ("2026-03-09T15:59:59-04:00", "2026-03-06"),
        ("2026-03-09T16:00:00-04:00", "2026-03-09"),
        ("2026-07-04T14:00:00-04:00", "2026-07-02"),
    ],
)
def test_completed_session(instant, expected):
    assert latest_session(instant).isoformat() == expected


def test_genuine_defaults_and_stale_provenance(client, monkeypatch):
    d = client.get("/api/defaults").json()
    assert d["source"] == "yahoo" and d["end"] == latest_session().isoformat()
    from stockreplay import market

    def fail(*args):
        raise market.MarketError("Provider unavailable")

    monkeypatch.setattr(market, "yahoo", fail)
    assert client.get("/api/opening").status_code == 422
    assert not client.get("/api/data").json()
    cache = PublicCache(client.app.state.store)
    first = cache.get("test", 0, lambda: {"observed": 1})
    later = cache.get("test", 0, fail)
    assert (
        later["stale"]
        and later["data"] == first["data"]
        and later["fetched"] == first["fetched"]
        and later["error"]
    )
    empty = cache.get("missing", 0, fail)
    assert empty["data"] is None and not empty["stale"]


def test_rating_formula_with_coverage():
    import pandas as pd

    dates = pd.bdate_range("2022-01-03", periods=225)

    def frame(values):
        return {"bars": [{"date": str(d.date()), "close": v} for d, v in zip(dates, values)]}

    benchmark = frame([100] * 225)
    assert technical_rating(frame([100] * 199), benchmark) is None
    score = technical_rating(benchmark, benchmark)
    assert score["score"] == 60 and score["as_of"] == str(dates[-1].date())
    assert technical_rating(frame([100 * 1.01**i for i in range(225)]), benchmark)["score"] == 100


def test_watchlist_layout_alert_persistence(client, monkeypatch):
    id = client.post("/api/watchlists", json={"name": "Semis"}).json()["id"]
    path = "/api/watchlists/" + id
    for _ in range(2):
        assert client.post(path + "/symbols", json={"symbol": "nvda"}).is_success
    assert client.get("/api/watchlists").json()[-1]["symbols"] == ["NVDA"]
    assert client.patch(path, json={"name": "Research"}).is_success
    assert client.get("/api/desk/chart/NVDA?interval=1m&span=10y").status_code == 422
    layout = {
        "interval": "5m",
        "span": "5d",
        "style": "OHLC",
        "studies": ["RSI 14"],
        "compare": "spy",
        "drawings": [{"kind": "horizontal", "time": 1750000000, "price": 100}],
    }
    assert client.put("/api/desk/layout/NVDA", json=layout).is_success
    assert client.get("/api/desk/layout/NVDA").json()["compare"] == "SPY"
    key = client.post(
        "/api/alerts", json={"symbol": "nvda", "direction": "above", "threshold": 110}
    ).json()["id"]
    terminal = client.app.state.terminal

    def price(time):
        return {"stale": False, "data": {"price": 112, "time": time}}

    monkeypatch.setattr(terminal, "latest_price", lambda *a: price(1600000000))
    assert client.post("/api/alerts/check").json()[0]["triggered"] is None
    from datetime import datetime, timezone

    monkeypatch.setattr(
        terminal,
        "latest_price",
        lambda *a: price(int(datetime.now(timezone.utc).timestamp()) + 1),
    )
    assert client.post("/api/alerts/check").json()[0]["triggered"]
    with TestClient(create_app(client.app.state.store.path.parent)) as other:
        assert other.get("/api/alerts").json()[0]["id"] == key
        assert other.get("/api/watchlists").json()[-1]["name"] == "Research"
        assert other.delete(path).is_success
        assert other.delete("/api/alerts/" + key).is_success


HEADER = "Account Number,Account Name,Symbol,Description,Quantity,Last Price,Current Value,Cost Basis Total,Currency\n"
DATA = (
    HEADER
    + "A123456789,Brokerage,NVDA,NVIDIA,2.5,$100,$250,$210,USD\nA123456789,Brokerage,SPAXX**,Cash,,,50,,USD\nB987655432,IRA,XYZ,International,-2,15,(30),,EUR\n"
)


def prepare(c, item):
    response = c.post("/api/holdings/import/preview", json=item)
    assert response.is_success, response.text
    groups = response.json()
    return {**item, "revisions": {a["id"]: a["revision"] for a in groups}}, groups


def test_fidelity_multiple_accounts_privacy_review_and_atomic_replace(client):
    req = {"institution": "Fidelity", "as_of": "2026-11-20", "content": DATA}
    body, groups = prepare(client, req)
    assert len(groups) == 2 and groups[0]["name"].endswith("6789")
    assert "A123456789" not in json.dumps(groups)
    assert client.get("/api/holdings").json() == []
    assert client.post("/api/holdings/import/apply", json=req).status_code == 409
    assert client.post("/api/holdings/import/apply", json=body).is_success
    previous = client.get("/api/holdings").json()
    assert client.post("/api/holdings/import/apply", json=body).is_success
    assert client.get("/api/holdings").json() == previous
    assert (
        groups[0]["positions"][1]["symbol"] == "SPAXX"
        and groups[0]["positions"][1]["quantity"] is None
    )
    assert (
        groups[1]["positions"][0]["value"] == -30 and groups[1]["positions"][0]["currency"] == "EUR"
    )
    for suffix in ("", "-wal"):
        file = Path(str(client.app.state.store.path) + suffix)
        if file.is_file():
            assert b"A123456789" not in file.read_bytes()
    revised = {**req, "content": DATA.replace("$250", "$260")}
    body2, _ = prepare(client, revised)
    assert client.post(
        "/api/holdings/accounts/" + groups[1]["id"] + "/positions",
        json={"description": "Another investment", "value": 125},
    ).is_success
    assert client.post("/api/holdings/import/apply", json=body2).status_code == 409
    # The first account was updated before the second conflict, so the entire transaction must roll back.
    after = client.get("/api/holdings").json()
    assert next(a for a in after if a["id"] == groups[0]["id"])["positions"][0]["value"] == 250
    invalid = client.post(
        "/api/holdings/import/preview",
        json={**req, "content": DATA.replace("$250", "garbled")},
    )
    assert invalid.status_code == 422 and "A123456789" not in invalid.text


def test_generic_mapped_csv_manual_and_ofx(client):
    body = {
        "institution": "Local bank",
        "account": "Investment",
        "content": "Security code,Shares held,Local value\nABC,2,20\n",
        "mapping": {
            "symbol": "Security code",
            "quantity": "Shares held",
            "value": "Local value",
        },
    }
    req, acc = prepare(client, body)
    assert client.post("/api/holdings/import/apply", json=req).is_success
    path = "/api/holdings/accounts/" + acc[0]["id"] + "/positions"
    p = client.post(path, json={"description": "Private fund", "quantity": 2, "price": 18}).json()[
        "id"
    ]
    assert client.put(path + "/" + p, json={"description": "Private fund", "value": 42}).is_success
    assert client.delete(path + "/" + p).is_success
    xml = """<OFX><INVSTMTMSGSRSV1><INVSTMTTRNRS><INVSTMTRS><DTASOF>20261120<CURDEF>USD<INVACCTFROM><ACCTID>F99991111</INVACCTFROM><INVPOSLIST><POSSTOCK><INVPOS><SECID><UNIQUEID>abc123</SECID><UNITS>3<UNITPRICE>10<MKTVAL>30<DTPRICEASOF>20261120160000</INVPOS></POSSTOCK></INVPOSLIST></INVSTMTRS></INVSTMTTRNRS></INVSTMTMSGSRSV1><SECLIST><STOCKINFO><SECINFO><SECID><UNIQUEID>abc123</SECID><SECNAME>A company<TICKER>ABC</SECINFO></STOCKINFO></SECLIST></OFX>"""
    _, result = prepare(client, {"institution": "Credit union", "content": xml})
    pos = result[0]["positions"][0]
    assert (pos["symbol"], pos["value"], pos["as_of"]) == ("ABC", 30, "2026-11-20")
    bank = "<OFX><STMTRS><CURDEF>EUR</CURDEF><BANKACCTFROM><ACCTID>123456</ACCTID></BANKACCTFROM><LEDGERBAL><BALAMT>250.65</BALAMT><DTASOF>20261115</DTASOF></LEDGERBAL></STMTRS></OFX>"
    _, groups = prepare(client, {"institution": "Bank", "content": bank})
    assert (
        groups[0]["positions"][0]["currency"] == "EUR"
        and groups[0]["positions"][0]["value"] == 250.65
    )


def brief():
    groups = ["price", "company_news", "sector", "sector_news", "market", "macro_news"]
    return {
        "symbol": "NVDA",
        "as_of": "2026-11-24",
        "current_prices": True,
        "current_context": True,
        "private_note": "PRIVATE ACCOUNT NOTE",
        "evidence": [
            {
                "id": g,
                "group": g,
                "text": g + " public evidence",
                "source": "Publisher",
                "date": "2026-11-24",
                "url": "https://example.com/" + g,
            }
            for g in groups
        ],
    }


def test_openai_explicit_public_only_contract(client, monkeypatch):
    # This credential is a test sentinel. HTTP is intercepted before leaving the test process.
    secret = "test-only-credential-for-intercepted-transport"
    t = client.app.state.terminal
    source = brief()
    monkeypatch.setattr(t.desk, "briefing", lambda symbol: source)
    assert client.post("/api/desk/recommend/NVDA").status_code == 409
    status = client.put("/api/openai", json={"key": secret, "model": "gpt-4.1-mini"})
    assert status.is_success and secret not in status.text
    assert client.post(
        "/api/holdings/accounts",
        json={"institution": "Private Bank", "name": "Secret Portfolio"},
    ).is_success
    point = lambda text, *ids: {"text": text, "citations": list(ids)}
    opinion = {
        "stance": "Neutral",
        "horizon": "Weeks",
        "thesis": point("Momentum is mixed.", "price", "market"),
        "catalysts": [point("Issuer news supports demand.", "company_news")],
        "risks": [point("Sector weakness could persist.", "sector_news")],
        "reconsider": point("Watch monetary policy.", "macro_news"),
    }
    sent = []

    def intercept(req):
        assert (
            req.url.host == "api.openai.com" and req.headers["authorization"] == "Bearer " + secret
        )
        sent.append(req)
        if req.method == "GET":
            return httpx.Response(200, json={"id": "gpt-4.1-mini"})
        assert req.url.path == "/v1/responses"
        payload = json.loads(req.content)
        assert payload["store"] is False and payload["text"]["format"]["strict"] is True
        assert all(
            x not in req.content.decode()
            for x in [
                "Private Bank",
                "Secret Portfolio",
                "PRIVATE ACCOUNT NOTE",
                secret,
            ]
        )
        assert set(json.loads(payload["input"])) == {"as_of", "symbol", "evidence"}
        return httpx.Response(
            200,
            json={
                "status": "completed",
                "output": [
                    {
                        "type": "message",
                        "content": [{"type": "output_text", "text": json.dumps(opinion)}],
                    }
                ],
            },
        )

    t.openai.transport = httpx.MockTransport(intercept)
    assert client.post("/api/openai/test").is_success
    result = client.post("/api/desk/recommend/NVDA")
    assert result.is_success and len(result.json()["sources"]) == 5
    saved = client.get("/api/desk/recommend/NVDA").json()
    assert saved == [result.json()] and client.get("/api/desk/recommend/SPY").json() == []
    opinion["thesis"]["text"] = "Expect 999% upside."
    assert client.post("/api/desk/recommend/NVDA").status_code == 502
    opinion["thesis"] = point("Invalid citation.", "unknown")
    assert client.post("/api/desk/recommend/NVDA").status_code == 502
    source["current_prices"] = False
    count = len(sent)
    assert client.post("/api/desk/recommend/NVDA").status_code == 409 and len(sent) == count
    invalid = client.put("/api/openai", json={"key": secret, "model": "/invalid"})
    assert invalid.status_code == 422 and secret not in invalid.text
    for suffix in ("", "-wal", "-shm"):
        f = Path(str(t.db.path) + suffix)
        if f.is_file():
            assert secret.encode() not in f.read_bytes()
    with TestClient(create_app(t.db.path.parent)) as another:
        assert not another.get("/api/openai").json()["configured"]
    assert not client.delete("/api/openai").json()["configured"]


@pytest.mark.skipif(sys.platform != "darwin", reason="macOS Keychain integration")
def test_native_keychain_lifecycle(tmp_path, monkeypatch):
    import subprocess
    from keyring.backends.macOS import Keyring
    from stockreplay import openai_research as research

    path = str(tmp_path / "test.keychain-db")
    password = "ephemeral-integration-test"
    subprocess.run(["security", "create-keychain", "-p", password, path], check=True)
    try:
        subprocess.run(["security", "unlock-keychain", "-p", password, path], check=True)
        kc = Keyring()
        kc.keychain = path
        monkeypatch.setattr(research, "keychain", lambda: kc)
        store = Store(tmp_path / "state")
        client = research.OpenAIResearch(store)
        key = "intercepted-macos-keychain-test-value"
        client.set(research.KeySettings(key=key, remember=True))
        assert research.OpenAIResearch(store).credentials()[0] == key
        assert client.forget()["configured"] is False
        assert kc.get_password(research.SERVICE, client.account) is None
    finally:
        subprocess.run(["security", "delete-keychain", path], check=True)


@pytest.mark.skipif(
    os.getenv("STOCKREPLAY_PUBLIC_LIVE") != "1", reason="opt in to current public providers"
)
def test_live_public_sources(client):
    chart = client.get("/api/desk/chart/NVDA?interval=1d&span=2y").json()
    assert (
        chart["data"]["as_of"] == latest_session().isoformat()
        and chart["data"]["currency"] == "USD"
    )
    r = client.get("/api/desk/ratings/NVDA").json()
    assert r["stockreplay"] and r["actions"]["data"] and r["consensus"]["data"]
    for name in ("nasdaq", "stockanalysis"):
        packet = r[name]
        if packet["data"] is None:
            assert packet["error"] and not packet["stale"]
            print(f"{name} reported unavailability: {packet['error']}")
    assert r["nasdaq"]["data"] or r["stockanalysis"]["data"], (
        "Both independent ratings publishers were unavailable."
    )
    b = client.get("/api/desk/brief/NVDA").json()
    assert b["current_context"] and b["current_prices"]
    assert {"company_news", "sector_news", "market", "price"} <= {x["group"] for x in b["evidence"]}
    print(
        f"NVDA through {b['as_of']}: {len(b['evidence'])} evidence items, {len(r['actions']['data'])} Yahoo actions and {len(r['stockanalysis']['data'] or [])} Stock Analysis disclosures."
    )
