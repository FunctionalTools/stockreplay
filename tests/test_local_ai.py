"""Exercise both local generation and the boundary between it and optional hosted AI."""

import json
import os
from datetime import date

import httpx
import pytest
from fastapi.testclient import TestClient

from stockreplay.api import create_app
from stockreplay.local_ai import RECOMMENDED


def live_evidence():
    today = date.today().isoformat()
    return {
        "symbol": "ACME",
        "as_of": today,
        "price_as_of": today,
        "evidence": [
            {
                "id": "article",
                "group": "company_news",
                "text": "The company reported weaker demand for equipment.",
                "date": today,
                "source": "Issuer release",
                "url": "https://example.org/release",
                "excerpt": "Orders were deferred.",
            },
            {
                "id": "prices",
                "group": "price",
                "text": "Recent reported closes have moved higher.",
                "date": today,
                "source": "Market data",
                "url": "https://example.org/market",
            },
        ],
    }


def verify_two_widget_tab(c):
    reply = c.post(
        "/api/assistant",
        json={
            "page": "Research",
            "symbol": "AAPL",
            "messages": [
                {
                    "role": "user",
                    "text": "Create a tab called Weekend for a one-year Apple chart and NVIDIA news.",
                }
            ],
        },
    )
    assert reply.is_success, reply.text
    actions = reply.json()["actions"]
    assert len(actions) == 1
    action = actions[0]
    assert (
        action["kind"] == "tab" and action["name"] == "Weekend" and action["operation"] == "create"
    )
    blocks = [
        {"view": "chart", "value": "AAPL", "span": "1y"},
        {"view": "news", "value": "NVDA", "span": "1y"},
    ]
    assert action["blocks"] == blocks
    saved = c.post("/api/tabs", json={"title": action["name"], "blocks": action["blocks"]})
    assert saved.is_success, saved.text
    assert c.get("/api/tabs/" + saved.json()["id"]).json()["blocks"] == blocks


def native_transport(requests, offline=False, corrupt=False, unsupported_claim=False):
    def respond(req):
        assert str(req.url).startswith("http://127.0.0.1:11434/api/")
        assert "authorization" not in req.headers and "cookie" not in req.headers
        path = req.url.path
        body = json.loads(req.content) if req.content else {}
        requests.append((path, body))
        if offline:
            raise httpx.ConnectError("offline")
        if path == "/api/tags":
            return httpx.Response(
                200,
                json={
                    "models": [
                        {"name": name, "digest": name}
                        for name in [
                            RECOMMENDED,
                            "other:latest",
                            "secret:latest",
                            "embedding:mini",
                            "paid:cloud",
                        ]
                    ]
                },
            )
        if path == "/api/show":
            return httpx.Response(
                200,
                json={
                    "details": {"format": "gguf"},
                    "capabilities": ["completion"],
                    **(
                        {"remote_host": "https://provider.test"}
                        if body["model"] == "secret:latest"
                        else {}
                    ),
                },
            )
        assert (
            path == "/api/chat" and body["stream"] is False and body["format"]["type"] == "object"
        )
        assert "PRIVATE_ACCOUNT" not in json.dumps(body)
        fields = body["format"]["properties"]
        inputs = json.loads(body["messages"][1]["content"])
        if "result" in fields:
            result = {"result": "ready"}
        elif "tab_title" in fields:
            assert set(fields) == {"tab_title", "chart_1", "news_2"}
            assert fields["chart_1"]["properties"]["value"]["enum"] == ["AAPL"]
            assert fields["chart_1"]["properties"]["span"]["enum"] == ["1y"]
            assert fields["news_2"]["properties"]["value"]["enum"] == ["NVDA"]
            result = {
                "tab_title": "Weekend",
                "chart_1": {"value": "AAPL", "span": "1y"},
                "news_2": {"value": "NVDA"},
            }
        elif "actions" in fields:
            result = {
                "reply": "",
                "links": [],
                "actions": [
                    {
                        "tab": {
                            "operation": "create",
                            "name": "My charts",
                            "value": "",
                            "blocks": [{"view": "chart", "value": "ACME", "span": "1y"}],
                        }
                    }
                ],
            }
        elif "answer" in fields:
            result = {
                "answer": "Weaker orders may weigh on earnings.",
                "citations": [inputs["evidence"][0]["ref"]],
            }
        elif "buy_score" in fields:
            sid = inputs["factors"][0]["source"]["id"]
            pt = {
                "source": sid,
                "text": "Buyers delayed 97 contracts."
                if unsupported_claim
                else "The dated evidence gives a mixed outlook.",
            }
            result = {
                "buy_score": 52,
                "risk_score": 61,
                "confidence": "Low",
                "summary": pt,
                "positive": pt,
                "concern": pt,
                "watch_for": pt,
            }
        else:
            result = {
                k: {
                    "source": v["properties"]["source"]["enum"][0],
                    "buy": "Mixed",
                    "risk": "Raises",
                    "buy_reason": "Demand is uncertain.",
                    "risk_reason": "Demand can weaken.",
                }
                for k, v in fields.items()
            }
        return httpx.Response(
            200,
            json={
                "done": True,
                "message": {
                    "role": "assistant",
                    "content": "garbled" if corrupt else json.dumps(result),
                },
            },
        )

    return httpx.MockTransport(respond)


def test_new_install_local_generation_archive_planner_and_credential_isolation(
    tmp_path, monkeypatch
):
    app = create_app(tmp_path)
    calls = []
    svc = app.state.terminal
    svc.ai.ollama.transport = native_transport(calls)
    svc.openai.transport = httpx.MockTransport(
        lambda r: pytest.fail("Paid provider contacted from free mode")
    )
    monkeypatch.setattr(svc.desk, "briefing", lambda s: live_evidence())
    with TestClient(app) as c:
        info = c.get("/api/ai/ollama/models").json()
        assert [m["id"] for m in info["models"]] == [RECOMMENDED, "other:latest"]
        assert c.get("/api/ai").json()["provider"] == "ollama"
        assert c.put("/api/ai/ollama", json={"model": "secret:latest"}).status_code == 409
        assert c.put("/api/ai/ollama", json={"model": "other"}).json()["verified"]
        assert c.get("/api/ai").json()["model"] == "other:latest"
        c.post(
            "/api/holdings/accounts",
            json={"institution": "Private bank", "name": "PRIVATE_ACCOUNT"},
        )
        ask = {
            "page": "Research",
            "symbol": "ACME",
            "messages": [
                {
                    "role": "user",
                    "text": "Create a custom tab called My charts with a graph of ACME",
                }
            ],
        }
        plan = c.post("/api/assistant", json=ask)
        assert plan.is_success, plan.text
        assert plan.json()["actions"][0]["kind"] == "tab"
        verify_two_widget_tab(c)
        qa = c.post(
            "/api/assistant/research/ACME", json={"question": "Which risks appear in the evidence?"}
        )
        assert qa.is_success, qa.text
        assert qa.json()["sources"]
        saved = c.post("/api/desk/recommend/ACME")
        assert saved.is_success, saved.text
        report = saved.json()
        assert report["model"] == "other:latest" and report["provider"] == "ollama"
        assert report["buy_score"] == 52 and report["risk_score"] == 61
        assert {v["id"] for v in report["factors"] if v["status"] == "used"} == {
            "trend",
            "company_news",
        }
        assert all(
            p in {"article", "prices"}
            for factor in report["factors"]
            if factor["status"] == "used"
            for p in factor["risk"]["citations"]
        )
        assert all(name not in json.dumps(calls) for name in ["PRIVATE_ACCOUNT", "Private bank"])
    reopened = create_app(tmp_path)
    reopened.state.terminal.ai.ollama.transport = native_transport([])
    with TestClient(reopened) as c:
        assert c.get("/api/ai").json()["model"] == "other:latest"
        assert c.get("/api/desk/recommend/ACME").json()[0]["provider"] == "ollama"


def test_local_errors_never_fall_back_or_silently_change_provider(tmp_path):
    from tests.provider_fixture import respond

    svc = create_app(tmp_path)
    local = svc.state.terminal.ai.ollama
    local.transport = native_transport([], offline=True)
    paid = []

    def openai(req):
        paid.append(req.url.path)
        return respond(req)

    svc.state.terminal.openai.transport = httpx.MockTransport(openai)
    with TestClient(svc) as c:
        assert c.get("/api/ai").json()["configured"] is False
        assert c.put("/api/openai", json={"key": "explicit-test-config"}).json()["verified"]
        assert c.get("/api/ai").json()["provider"] == "openai"
        assert c.patch("/api/ai", json={"provider": "ollama"}).json()["provider"] == "ollama"
        count = len(paid)
        assert c.post("/api/desk/recommend/ACME").status_code == 409
        assert c.get("/api/openai").json()["configured"]
        assert len(paid) == count
        requests = []
        local.transport = native_transport(requests, corrupt=True)
        failed = c.put("/api/ai/ollama", json={"model": RECOMMENDED})
        assert failed.status_code == 502
        assert len([r for r in requests if r[0] == "/api/chat"]) == 2
        assert c.get("/api/ai").json()["provider"] == "ollama"


@pytest.mark.skipif(
    os.environ.get("STOCKREPLAY_LIVE_OLLAMA") != "1",
    reason="requires an installed local Ollama model",
)
def test_real_local_model_uses_the_generation_paths(tmp_path, monkeypatch):
    app = create_app(tmp_path)
    monkeypatch.setattr(app.state.terminal.desk, "briefing", lambda s: live_evidence())
    with TestClient(app) as c:
        status = c.get("/api/ai").json()
        assert status["provider"] == "ollama" and status["configured"], status
        model = os.environ.get("STOCKREPLAY_TEST_OLLAMA_MODEL", status["model"])
        probe = c.put("/api/ai/ollama", json={"model": model})
        assert probe.is_success, probe.text
        qa = c.post(
            "/api/assistant/research/ACME",
            json={"question": "What does the company say about demand?"},
        )
        assert qa.is_success and qa.json()["sources"], qa.text
        verify_two_widget_tab(c)
        result = c.post("/api/desk/recommend/ACME")
        assert result.is_success, result.text
        data = result.json()
        assert data["provider"] == "ollama" and data["model"] == model and data["sources"]
        assert 0 <= data["buy_score"] <= 100 and 0 <= data["risk_score"] <= 100


def test_migration_keeps_an_existing_remembered_key_and_explicit_provider_choice(tmp_path):
    from stockreplay.store import Store

    db = Store(tmp_path)
    with db.connect() as c:
        c.execute(
            "create table openai_settings(id integer primary key,model text not null, remember integer not null)"
        )
        c.execute("insert into openai_settings values(1,'gpt-4.1',1)")
    app = create_app(tmp_path)
    app.state.terminal.ai.ollama.transport = native_transport([], offline=True)
    with TestClient(app) as c:
        before = c.get("/api/ai").json()
        assert (
            before["model"] == "gpt-4.1"
            and before["provider"] == "openai"
            and before["storage"] == "macOS Keychain"
        )
        assert c.patch("/api/ai", json={"provider": "ollama"}).json()["provider"] == "ollama"
        assert c.get("/api/openai").json() == before
    reopened = create_app(tmp_path)
    reopened.state.terminal.ai.ollama.transport = native_transport([], offline=True)
    with TestClient(reopened) as c:
        assert c.get("/api/ai").json()["provider"] == "ollama"
        assert c.get("/api/openai").json()["model"] == "gpt-4.1"


def test_local_summary_rejects_unsupported_figures_before_archiving(tmp_path, monkeypatch):
    app = create_app(tmp_path)
    app.state.terminal.ai.ollama.transport = native_transport([], unsupported_claim=True)
    monkeypatch.setattr(app.state.terminal.desk, "briefing", lambda s: live_evidence())
    with TestClient(app) as c:
        reply = c.post("/api/desk/recommend/ACME")
        assert reply.status_code == 502 and "figure" in reply.json()["detail"]
        assert c.get("/api/desk/recommend/ACME").json() == []


def test_switching_to_free_during_openai_verification_cannot_activate_paid_ai(tmp_path):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Event

    from tests.provider_fixture import respond

    started = Event()
    finish = Event()
    app = create_app(tmp_path)
    app.state.terminal.ai.ollama.transport = native_transport([])

    def delayed(req):
        started.set()
        assert finish.wait(5)
        return respond(req)

    app.state.terminal.openai.transport = httpx.MockTransport(delayed)
    with TestClient(app) as c, ThreadPoolExecutor(max_workers=1) as pool:
        pending = pool.submit(c.put, "/api/openai", json={"key": "explicit-test-credentials"})
        try:
            assert started.wait(5)
            assert c.patch("/api/ai", json={"provider": "ollama"}).is_success
        finally:
            finish.set()
        assert pending.result().status_code == 409
        assert c.get("/api/ai").json()["provider"] == "ollama"
