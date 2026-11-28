"""Hosted Ollama uses return-only tools (or checked JSON) and separately scoped website keys."""

import json
import os

import httpx
import pytest
from fastapi.testclient import TestClient

from stockreplay.api import create_app
from stockreplay.ollama_cloud import CLOUD_MODEL
from tests.provider_fixture import assessment
from tests.test_local_ai import live_evidence, native_transport

CLOUD = "/api/ai/ollama-cloud"
SEARCH = "/api/ai/ollama-search"
TEST_KEY = "test-only-ollama-website-key"
HIT = {
    "title": "Ollama documentation",
    "url": "https://docs.ollama.com/",
    "content": "Published documentation.",
}


class Hosted:
    def __init__(self):
        self.calls = []
        self.fail = {}
        self.mode = "tool"
        self.hits = [HIT]

    def __call__(self, req):
        assert req.url.scheme == "https" and req.url.host == "ollama.com"
        assert req.url.path.startswith("/api/") and "cookie" not in req.headers
        path = req.url.path.removeprefix("/api/")
        body = json.loads(req.content) if req.content else {}
        self.calls.append((path, body, req.headers.get("authorization")))
        if path in self.fail:
            code, detail = self.fail[path]
            return httpx.Response(code, json={"error": detail})
        if path == "tags":
            return httpx.Response(
                200,
                json={
                    "models": [
                        {"name": CLOUD_MODEL, "capabilities": ["completion", "tools"]},
                        {"name": "classify", "capabilities": ["decision"]},
                    ]
                },
            )
        assert req.headers["authorization"].startswith("Bearer ")
        if path == "web_search":
            return httpx.Response(200, json={"results": self.hits})
        assert path == "chat" and "format" not in body and body["stream"] is False
        inputs = json.loads(body["messages"][1]["content"])
        tools = body.get("tools", [])
        if self.mode == "unsupported" and tools:
            return httpx.Response(400, json={"error": "model does not support tools"})
        if tools:
            function = tools[0]["function"]["name"]
        else:
            function = "submit_connection_check"
        if function == "submit_connection_check":
            if body["model"] == CLOUD_MODEL:
                assert body["think"] == "low"
            result = {"result": "ready"}
        elif function == "submit_app_assistant":
            result = {
                "reply": "",
                "actions": [
                    {
                        "tab": {
                            "operation": "create",
                            "name": "Signals",
                            "value": "",
                            "blocks": [{"view": "news", "span": "1y", "value": "AAPL"}],
                        }
                    }
                ],
                "links": [],
            }
        elif function == "submit_stock_question":
            result = {
                "answer": "Demand is a cited concern.",
                "citations": [inputs["evidence"][0]["ref"]],
            }
        elif function == "submit_stock_scores":
            result = assessment(inputs)
        else:
            raise AssertionError(function)
        if self.mode == "malformed":
            result = {"pretend": "done"}
        message = {"role": "assistant", "content": ""}
        if tools and self.mode != "json":
            message["tool_calls"] = [{"function": {"name": function, "arguments": result}}]
        else:
            message["content"] = "```json\n" + json.dumps(result) + "\n```"
        return httpx.Response(200, json={"done": True, "message": message})


def app_and_server(tmp_path):
    app = create_app(tmp_path)
    hosted = Hosted()
    svc = app.state.terminal
    svc.ai.ollama_cloud.transport = httpx.MockTransport(hosted)
    svc.ai.ollama.transport = native_transport([])
    svc.openai.transport = httpx.MockTransport(
        lambda req: pytest.fail("Unexpected OpenAI fallback")
    )
    return app, hosted


def test_search_only_key_never_activates_or_calls_cloud_generation(tmp_path):
    app, server = app_and_server(tmp_path)
    svc = app.state.terminal
    with TestClient(app) as c:
        assert c.get("/api/ai").json()["provider"] == "ollama"
        connected = c.put(SEARCH, json={"key": TEST_KEY})
        assert connected.is_success and connected.json()["verified"]
        assert set(connected.json()) == {"configured", "verified", "verified_at", "storage"}
        assert [p for p, _, _ in server.calls] == ["web_search"]
        assert (
            not c.get(CLOUD).json()["configured"]
            and c.get("/api/ai").json()["provider"] == "ollama"
        )
        assert svc.ai.ollama_search.search("AAPL quarterly report", 1) == {"results": [HIT]}
        assert svc.ai.ollama_search.contains_secret("Do not send " + TEST_KEY)
        with pytest.raises(ValueError):
            svc.ai.ollama_search.search(TEST_KEY)
        assert TEST_KEY not in connected.text and not any(p == "chat" for p, _, _ in server.calls)
        assert c.delete(SEARCH).json()["configured"] is False


def test_opaque_keys_cannot_enter_chat_history_or_any_research_request(tmp_path, monkeypatch):
    app, server = app_and_server(tmp_path)
    monkeypatch.setattr(
        app.state.terminal.desk, "web_research", lambda *a, **k: pytest.fail("Secret in research")
    )
    with TestClient(app) as c:
        search_key = 'website-key-with-a-"quote"'
        assert c.put(SEARCH, json={"key": search_key}).is_success
        assert c.put(CLOUD, json={"key": TEST_KEY}).is_success
        assert c.patch("/api/ai", json={"provider": "openai"}).is_success
        calls = len(server.calls)
        for key in (search_key, TEST_KEY):
            message = {"role": "user", "text": "Find sources for " + key}
            submissions = [
                ("/api/assistant/check-message", message),
                ("/api/assistant", {"page": "Research", "symbol": "AAPL", "messages": [message]}),
                ("/api/assistant/research/AAPL", {"question": message["text"]}),
                ("/api/desk/web-research/AAPL", {"question": message["text"]}),
                ("/api/assistant/chats", {"title": key}),
                ("/api/assistant/chats", {"entries": [{"id": 1, **message}]}),
            ]
            for path, payload in submissions:
                response = c.post(path, json=payload)
                assert response.status_code == 422 and "Enter API keys in Settings" in response.text
                assert key not in response.text
        assert c.get("/api/assistant/chats").json() == []
        assert len(server.calls) == calls


def test_hosted_model_search_and_real_workflow_contracts(tmp_path, monkeypatch):
    app, server = app_and_server(tmp_path)
    svc = app.state.terminal
    monkeypatch.setattr(svc.desk, "briefing", lambda *_: live_evidence())
    with TestClient(app) as c:
        assert c.get(CLOUD + "/models").json()["models"] == [
            {"id": CLOUD_MODEL, "label": CLOUD_MODEL}
        ]
        assert server.calls[-1][2] is None
        value = c.put(CLOUD, json={"key": TEST_KEY}).json()
        assert (
            value["provider"] == "ollama_cloud"
            and value["verified"]
            and value["web_search"]["verified"]
        )
        assert {p for p, _, _ in server.calls} == {"tags", "chat", "web_search"}
        assert c.get("/api/ai").json()["provider"] == "ollama_cloud"
        plan = c.post(
            "/api/assistant",
            json={
                "symbol": "AAPL",
                "page": "Research",
                "messages": [
                    {"role": "user", "text": "Create a tab named Signals with Apple news."}
                ],
            },
        )
        assert plan.is_success and plan.json()["actions"][0]["kind"] == "tab", plan.text
        result = c.post("/api/desk/recommend/AAPL")
        assert result.is_success and result.json()["provider"] == "ollama_cloud", result.text
        assert c.get("/api/desk/recommend/AAPL").json()[0] == result.json()
        question = c.post(
            "/api/assistant/research/AAPL", json={"question": "Which business risk affects demand?"}
        )
        assert question.is_success and question.json()["sources"], question.text
        assert c.patch("/api/ai", json={"provider": "ollama"}).is_success
        assert c.get(CLOUD).json()["configured"] and not c.get(SEARCH).json()["configured"]
        assert (
            not c.delete(CLOUD).json()["configured"]
            and c.get("/api/ai").json()["provider"] == "ollama"
        )
        assert TEST_KEY not in str([result.json(), plan.json(), value])


@pytest.mark.parametrize(
    ("scope", "code", "detail", "expected"),
    [
        ("chat", 429, "usage limit reached", "limit"),
        ("chat", 503, "model at capacity", "capacity"),
        ("chat", 403, "access denied", "access"),
        ("chat", 402, "payment required", "credits"),
        ("chat", 403, "account has insufficient credits", "credits"),
        ("web_search", 429, "daily search limit", "limit"),
    ],
)
def test_independent_entitlements_and_capacity(tmp_path, scope, code, detail, expected):
    app, server = app_and_server(tmp_path)
    server.fail[scope] = (code, detail)
    with TestClient(app) as c:
        response = c.put(CLOUD, json={"key": TEST_KEY})
        assert response.is_success, response.text
        v = response.json()
        assert (
            v["configured"]
            and v["verified"] == (scope != "chat")
            and v["web_search"]["verified"] == (scope != "web_search")
        )
        assert expected in (v.get("generation_detail") or v["web_search"]["detail"]).lower()
        server.fail.clear()
        assert c.post(CLOUD + "/test").json()["verified"]
        assert c.get(CLOUD).json()["web_search"]["verified"]


def test_invalid_keys_and_total_capacity_failure_preserve_existing_session(tmp_path):
    app, server = app_and_server(tmp_path)
    with TestClient(app) as c:
        assert c.put(CLOUD, json={"key": TEST_KEY}).json()["verified"]
        assert c.patch("/api/ai", json={"provider": "ollama"}).is_success
        server.fail = {"web_search": (401, TEST_KEY), "chat": (401, "unauthorized " + TEST_KEY)}
        bad = c.put(CLOUD, json={"key": "invalid-candidate-only"})
        assert bad.status_code == 401 and "rejected" in bad.text and TEST_KEY not in bad.text
        server.fail = {"chat": (429, "model overloaded"), "web_search": (503, "busy")}
        offline = c.put(CLOUD, json={"key": "another-candidate-key"})
        assert (
            offline.status_code == 503
            and "capacity" in offline.text
            and "rejected" not in offline.text
        )
        assert c.get("/api/ai").json()["provider"] == "ollama"
        assert app.state.terminal.ai.ollama_cloud.credentials()[0] == TEST_KEY


@pytest.mark.parametrize("mode", ["unsupported", "json", "malformed"])
def test_cloud_tool_fallback_and_validation(tmp_path, mode):
    app, server = app_and_server(tmp_path)
    server.mode = mode
    with TestClient(app) as c:
        response = c.put(CLOUD, json={"key": TEST_KEY})
        assert response.is_success
        assert response.json()["verified"] == (mode != "malformed")
        assert response.json()["web_search"]["verified"]
        chats = [body for path, body, _ in server.calls if path == "chat"]
        assert len(chats) == (1 if mode == "json" else 2)
        assert all("format" not in body for body in chats)
        if mode != "json":
            assert "tools" not in chats[-1] and "JSON object" in chats[-1]["messages"][0]["content"]


def test_keychain_slots_are_independent_and_migrate_without_changing_model(tmp_path, monkeypatch):
    from stockreplay import openai_research

    credentials = {}

    class Keychain:
        def get_password(self, service, account):
            return credentials.get((service, account))

        def set_password(self, service, account, value):
            credentials[service, account] = value

        def delete_password(self, service, account):
            credentials.pop((service, account))

    monkeypatch.setattr(openai_research, "keychain", lambda: Keychain())
    with TestClient(app_and_server(tmp_path)[0]) as c:
        assert c.put(SEARCH, json={"key": "search-only-website-value", "remember": True}).is_success
        assert c.put(CLOUD, json={"key": "generation-website-value", "remember": True}).is_success
        assert len(credentials) == 2
    app, server = app_and_server(tmp_path)
    with TestClient(app) as c:
        assert c.get("/api/ai").json()["provider"] == "ollama_cloud"
        assert c.get(SEARCH).json()["storage"] == "macOS Keychain"
        assert c.post(CLOUD + "/test").json()["verified"]
        assert app.state.terminal.ai.ollama_search.search("MSFT press release", 1)["results"]
        assert server.calls[-1][2] == "Bearer search-only-website-value"
        assert c.delete(CLOUD).is_success and len(credentials) == 1
        assert "search-only-website-value" in credentials.values()
        assert not c.get("/api/openai").json()["configured"]


def test_hosted_key_runs_search_and_answer_even_when_the_mac_has_no_local_model(
    tmp_path, monkeypatch
):
    from tests.test_ollama_web import UNKNOWN, disable_market

    disable_market(monkeypatch)
    app, server = app_and_server(tmp_path)
    t = app.state.terminal
    t.ai.ollama.transport = httpx.MockTransport(
        lambda _: pytest.fail("Unexpected local Ollama dependency")
    )
    server.hits = []
    with TestClient(app) as c:
        # A successful authenticated response can legitimately have zero hits.
        connection = c.put(CLOUD, json={"key": TEST_KEY}).raise_for_status().json()
        assert connection["verified"] and connection["web_search"]["verified"]
        server.hits = [
            {
                "title": "Microsoft reports cloud demand",
                "url": UNKNOWN,
                "content": "Microsoft discussed cloud demand in its latest earnings report.",
            }
        ]
        q = {"question": "Search the web for Microsoft cloud demand"}
        result = c.post("/api/assistant/research/MSFT", json=q).raise_for_status().json()
        assert (
            result["sources"][0]["url"] == UNKNOWN
            and result["sources"][0]["discovered_via"] == "Ollama Web Search"
        )
        assert result["text"] == "Demand is a cited concern."
        lookups = [b["query"] for path, b, _ in server.calls if path == "web_search"]
        prompts = [b for path, b, _ in server.calls if path == "chat"]
        assert any("Microsoft" in q for q in lookups)
        assert any(
            "Microsoft discussed cloud demand" in b["messages"][1]["content"] for b in prompts
        )

        # Credit exhaustion after a successful check keeps the actual source results accessible.
        server.fail["chat"] = (402, "payment required")
        unavailable = c.post("/api/assistant/research/MSFT", json=q).raise_for_status().json()
        assert "credits" in unavailable["text"] and unavailable["sources"][0]["url"] == UNKNOWN
        health = c.get("/api/ai").json()
        assert health["provider"] == "ollama_cloud" and not health["verified"]
        assert "billing" in health["generation_detail"] and health["web_search"]["verified"]
        del server.fail["chat"]
        # Successful research also restores the status without a paid extra Settings test.
        assert (
            c.post("/api/assistant/research/MSFT", json=q).raise_for_status().json()["text"]
            == result["text"]
        )
        assert c.get("/api/ai").json()["verified"]
        server.fail["web_search"] = (429, "daily search limit")
        t.desk.web_research("MSFT", "Microsoft earnings", refresh=True)
        health = c.get("/api/ai").json()
        assert (
            health["verified"]
            and not health["web_search"]["verified"]
            and "limit" in health["web_search"]["detail"]
        )
        del server.fail["web_search"]
        t.desk.web_research("MSFT", "Microsoft earnings", refresh=True)
        assert c.get("/api/ai").json()["web_search"]["verified"]


@pytest.mark.skipif(
    not os.getenv("STOCKREPLAY_TEST_OLLAMA_CLOUD_KEY"),
    reason="Requires an authorized Ollama Cloud API key",
)
def test_live_ollama_cloud_generation_and_web_search(tmp_path, monkeypatch):
    from tests.test_ollama_web import disable_market

    # Isolate evidence to actual hosted search; the resulting answer must cite its original URL.
    disable_market(monkeypatch)
    app = create_app(tmp_path)
    terminal = app.state.terminal
    terminal.ai.ollama.transport = httpx.MockTransport(
        lambda _: pytest.fail("Unexpected local Ollama dependency")
    )
    cloud = terminal.ai.ollama_cloud
    actual = cloud.structured
    outputs = []

    def generated(key, model, name, *args):
        response = actual(key, model, name, *args)
        outputs.append(name)
        return response

    monkeypatch.setattr(cloud, "structured", generated)
    with TestClient(app) as c:
        result = c.put(
            CLOUD,
            json={
                "key": os.environ["STOCKREPLAY_TEST_OLLAMA_CLOUD_KEY"],
                "model": os.environ.get("STOCKREPLAY_TEST_OLLAMA_CLOUD_MODEL", CLOUD_MODEL),
            },
        )
        assert result.is_success, result.text
        status = result.json()
        assert status["verified"] and status["web_search"]["verified"], status
        assert c.get("/api/ai").json()["provider"] == "ollama_cloud"
        answer = (
            c.post(
                "/api/assistant/research/MSFT",
                json={
                    "question": "Search the web for Microsoft's latest quarterly cloud earnings and summarize its sales outlook."
                },
            )
            .raise_for_status()
            .json()
        )
        assert "stock_question" in outputs and answer["text"].strip()
        assert any(
            source.get("discovered_via") == "Ollama Web Search"
            and source["url"].startswith("https://")
            for source in answer["sources"]
        )


@pytest.mark.skipif(
    not os.getenv("STOCKREPLAY_TEST_OLLAMA_SEARCH_KEY"),
    reason="Requires an authorized Ollama web-search key",
)
def test_live_search_only_key(tmp_path, monkeypatch):
    app = create_app(tmp_path)
    cloud = app.state.terminal.ai.ollama_cloud
    real_request = cloud.request
    paths = []

    def search_only(key, method, path, payload=None):
        assert (method, path) == ("POST", "web_search")
        paths.append(path)
        return real_request(key, method, path, payload)

    monkeypatch.setattr(cloud, "request", search_only)
    with TestClient(app) as c:
        result = c.put(SEARCH, json={"key": os.environ["STOCKREPLAY_TEST_OLLAMA_SEARCH_KEY"]})
        assert result.is_success and result.json()["verified"], result.text
        hits = app.state.terminal.ai.ollama_search.search(
            "Apple investor relations quarterly results", max_results=2
        )["results"]
        assert any(x.get("url", "").startswith("https://") and x.get("title") for x in hits)
        assert c.get("/api/ai").json()["provider"] == "ollama"
        assert not c.get(CLOUD).json()["configured"]
        assert paths == ["web_search", "web_search"]


def test_failed_retest_reports_revoked_key_without_deleting_or_switching(tmp_path):
    app, server = app_and_server(tmp_path)
    with TestClient(app) as c:
        assert c.put(CLOUD, json={"key": TEST_KEY}).json()["verified"]
        assert c.put(SEARCH, json={"key": "standalone-test-search"}).json()["verified"]
        server.fail = {"chat": (401, "revoked"), "web_search": (401, "revoked")}
        assert c.post(CLOUD + "/test").status_code == 401
        saved = c.get("/api/ai").json()
        assert (
            saved["provider"] == "ollama_cloud"
            and saved["configured"]
            and not saved["verified"]
            and not saved["web_search"]["verified"]
        )
        assert c.put(SEARCH, json={}).status_code == 401
        assert c.get(SEARCH).json()["configured"] and not c.get(SEARCH).json()["verified"]
