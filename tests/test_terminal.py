"""Financial data boundaries, persistent account operations and provider contracts."""

import json
import os
import sys
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
    from tests.provider_fixture import completed, assessment

    secret = "isolated-intercepted-test-credential"
    terminal = client.app.state.terminal
    source = brief()
    source["current_context"] = False
    source["evidence"][0]["text"] = "Last return +5.00%"
    monkeypatch.setattr(terminal.desk, "briefing", lambda s: source)
    client.post(
        "/api/holdings/accounts", json={"institution": "Private Bank", "name": "Secret Portfolio"}
    )
    sent = []
    mutation = {}

    def intercept(req):
        assert req.url.host == "api.openai.com"
        if req.method == "GET":
            return httpx.Response(403, json={"error": {"code": "insufficient_permissions"}})
        assert req.url.path == "/v1/responses"
        body = json.loads(req.content)
        name = body["text"]["format"]["name"]
        sent.append((name, body["model"]))
        assert req.headers["Authorization"] == "Bearer " + secret and body["store"] is False
        assert all(
            v not in req.content.decode()
            for v in (secret, "Private Bank", "Secret Portfolio", "PRIVATE ACCOUNT NOTE")
        )
        if body["model"] == "unavailable":
            return httpx.Response(404, json={"error": {"code": "model_not_found"}})
        if name == "connection_check":
            return completed({"result": "ready"})
        data = json.loads(body["input"])
        assert "market_session" in data and data["sector_current"] is False
        return completed({**assessment(data), **mutation})

    terminal.openai.transport = httpx.MockTransport(intercept)
    assert client.post("/api/desk/recommend/NVDA").status_code == 409 and not sent
    saved = client.put("/api/openai", json={"key": "  " + secret + "  "}).json()
    assert (
        saved["verified"]
        and saved["verified_at"]
        and sent == [("connection_check", saved["model"])]
    )
    assert client.get("/api/openai/models?discover=true").json()["models"]
    assert client.put("/api/openai", json={"model": "unavailable"}).status_code == 404
    assert client.get("/api/openai").json()["model"] == saved["model"]
    result = client.post("/api/desk/recommend/NVDA")
    assert result.is_success, result.text
    assert result.json()["buy_score"] == 72 and result.json()["risk_score"] == 58
    assert sent[-1] == ("stock_scores", saved["model"])
    assert client.get("/api/desk/recommend/NVDA").json() == [result.json()]
    assert client.get("/api/desk/recommend/MSFT").json() == []
    mutation["summary"] = {"text": "unsupported citation", "source": "unknown"}
    assert client.post("/api/desk/recommend/NVDA").status_code == 502
    mutation.clear()
    mutation["risk_score"] = 102
    assert client.post("/api/desk/recommend/NVDA").status_code == 502
    assert len(client.get("/api/desk/recommend/NVDA").json()) == 1
    source["evidence"] = []
    assert client.post("/api/desk/recommend/NVDA").status_code == 422
    invalid = client.put("/api/openai", json={"key": secret, "model": "/invalid"})
    assert invalid.status_code == 422 and secret not in invalid.text
    for suffix in ("", "-wal", "-shm"):
        f = Path(str(terminal.db.path) + suffix)
        if f.is_file():
            assert secret.encode() not in f.read_bytes()
    with TestClient(create_app(terminal.db.path.parent)) as another:
        assert not another.get("/api/openai").json()["configured"]
    assert not client.delete("/api/openai").json()["configured"]


@pytest.mark.parametrize(
    "status,code,message",
    [
        (401, "invalid_api_key", "rejected"),
        (429, "insufficient_quota", "credits"),
        (429, "rate_limit_exceeded", "rate limit"),
        (403, "insufficient_permissions", "permission"),
        (404, "model_not_found", "unavailable"),
    ],
)
def test_generation_probe_surfaces_provider_errors(client, status, code, message):
    def reject(req):
        assert req.method == "POST" and req.url.path == "/v1/responses"
        return httpx.Response(
            status, headers={"x-request-id": "req_test"}, json={"error": {"code": code}}
        )

    client.app.state.terminal.openai.transport = httpx.MockTransport(reject)
    response = client.put("/api/openai", json={"key": "intercepted-dummy-value"})
    assert response.is_error and message in response.text and "req_test" in response.text
    assert client.get("/api/openai").json()["verified"] is False


def test_candidate_model_discovery_does_not_store_or_verify_key(client):
    calls = []

    def listing(req):
        calls.append(req)
        return httpx.Response(
            200, json={"data": [{"id": "gpt-4o-mini"}, {"id": "text-embedding-3-small"}]}
        )

    client.app.state.terminal.openai.transport = httpx.MockTransport(listing)
    result = client.post("/api/openai/models", json={"key": "intercepted-dummy-value"})
    assert result.json() == {
        "models": [{"id": "gpt-4o-mini", "label": "GPT-4o mini"}],
        "source": "project",
    }
    assert calls[0].method == "GET" and calls[0].url.path == "/v1/models"
    assert not client.get("/api/openai").json()["configured"]


def test_retries_incomplete_output(client):
    from tests.provider_fixture import completed

    budgets = []

    def respond(req):
        body = json.loads(req.content)
        budgets.append(body["max_output_tokens"])
        if len(budgets) == 1:
            return httpx.Response(
                200,
                json={
                    "status": "incomplete",
                    "incomplete_details": {"reason": "max_output_tokens"},
                },
            )
        return completed({"result": "ready"})

    client.app.state.terminal.openai.transport = httpx.MockTransport(respond)
    assert client.put(
        "/api/openai", json={"key": "intercepted-dummy-value", "model": "gpt-5-mini"}
    ).json()["verified"]
    assert len(budgets) == 2 and budgets[1] > budgets[0]


def test_watch_import_and_preferences(client):
    p = "/api/watchlists/default/import"
    assert client.post(p, json={"content": "Symbol,Notes\nMSFT,one\nNVDA,two"}).json()["added"] == 2
    assert client.post(p, json={"content": "NVDA\nMSFT"}).json()["existing"] == 2
    assert client.post(p, json={"content": "AAPL\nbad value!"}).status_code == 422
    assert sorted(client.get("/api/watchlists").json()[0]["symbols"]) == ["MSFT", "NVDA"]
    client.patch("/api/preferences", json={"appearance": "dark", "advanced": True})
    assert (
        client.patch("/api/preferences", json={"accent": "violet"}).json()["appearance"] == "dark"
    )
    assert client.patch("/api/preferences", json={"home_symbol": "bad value!"}).status_code == 422


def test_chat_privacy_and_actions(client):
    from tests.provider_fixture import respond

    calls = []

    def intercept(req):
        assert "PRIVATE_ACCOUNT" not in req.content.decode()
        calls.append(req)
        return respond(req)

    client.app.state.terminal.openai.transport = httpx.MockTransport(intercept)
    client.put("/api/openai", json={"key": "intercepted-dummy-value"})
    client.post("/api/holdings/accounts", json={"name": "PRIVATE_ACCOUNT", "institution": "Local"})
    data = {
        "page": "Research",
        "symbol": "NVDA",
        "messages": [{"role": "user", "text": "Chart prices"}],
    }
    assert client.post("/api/assistant", json=data).json()["actions"][0]["kind"] == "chart"
    count = len(calls)
    data["messages"][0]["text"] = "sk-do-not-send-this-api-key"
    assert client.post("/api/assistant", json=data).status_code == 422 and len(calls) == count


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
        from tests.provider_fixture import respond

        client = research.OpenAIResearch(store, httpx.MockTransport(respond))
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
    for name in ("forecast", "stockanalysis"):
        packet = r[name]
        if packet["data"] is None:
            assert packet["error"] and not packet["stale"]
            print(f"{name} reported unavailability: {packet['error']}")
    assert r["forecast"]["data"] or r["stockanalysis"]["data"], (
        "Both independent ratings publishers were unavailable."
    )
    forecast = r["forecast"]["data"]
    assert (
        forecast
        and forecast["grade"]
        and forecast["count"] > 0
        and forecast["targets"]["average"] > 0
        and sum(forecast["votes"].values()) > 0
    )
    b = client.get("/api/desk/brief/NVDA").json()
    assert {"estimates", "risk"} <= {e["group"] for e in b["evidence"]}
    assert any(
        e["group"] == "company_news" and e["url"].startswith("https://") for e in b["evidence"]
    )
    assert b["current_context"] and b["current_prices"]
    assert {"company_news", "sector_news", "market", "price"} <= {x["group"] for x in b["evidence"]}
    print(
        f"NVDA through {b['as_of']}: {len(b['evidence'])} evidence items, {len(r['actions']['data'])} Yahoo actions and {len(r['stockanalysis']['data'] or [])} Stock Analysis disclosures."
    )


@pytest.mark.skipif(
    not os.environ.get("STOCKREPLAY_TEST_OPENAI_KEY"),
    reason="Requires a dedicated OpenAI project key",
)
def test_live_openai_generation(client):
    status = client.put(
        "/api/openai",
        json={
            "key": os.environ["STOCKREPLAY_TEST_OPENAI_KEY"],
            "model": os.environ.get("STOCKREPLAY_TEST_OPENAI_MODEL", "gpt-4.1-mini"),
        },
    )
    assert status.is_success and status.json()["verified"], status.text
    output = client.post("/api/desk/recommend/NVDA")
    assert output.is_success, output.text
    result = output.json()
    assert all(0 <= result[k] <= 100 for k in ("buy_score", "risk_score")) and result["sources"]
    chat = client.post(
        "/api/assistant",
        json={
            "page": "Research",
            "symbol": "NVDA",
            "messages": [{"role": "user", "text": "Plot MSFT over one year."}],
        },
    )
    assert chat.is_success and any(a["kind"] == "chart" for a in chat.json()["actions"]), chat.text
