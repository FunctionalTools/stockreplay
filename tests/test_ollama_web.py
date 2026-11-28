import json
import os
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from stockreplay import ollama_web, web_research
from stockreplay.api import create_app
from stockreplay.ollama_web import (
    PROVIDER,
    SearchAccess,
    fetchable,
    hosted_sources,
    search_access,
    source_url,
)
from stockreplay.openai_research import indexed_evidence
from stockreplay.public_cache import PublicCache
from stockreplay.score_factors import usable
from stockreplay.store import Store

SECRET = "intercepted-ollama-website-account-key"
NEWS = "https://www.tipranks.com/news/microsoft-cloud-results"
BODY = "Microsoft reported an increase in cloud revenue as enterprise customers expanded the number of subscription products they use."
SNIPPET = (
    "Microsoft highlighted stronger demand for its cloud products in the quarterly earnings update."
)
UNKNOWN = "https://publisher.example.org/analysis/market-outlook"


def disable_market(monkeypatch):
    monkeypatch.setattr(web_research, "news_index", lambda *a: [])
    monkeypatch.setattr(web_research, "ticker_index", lambda *a: [])
    monkeypatch.setattr(web_research, "sec_lookup", lambda *a: ([], []))

    def restricted(url):
        raise ValueError("The publisher did not expose an article.")

    monkeypatch.setattr(ollama_web, "article_document", restricted)


def results():
    return {
        "results": [
            {
                "title": "Microsoft cloud outlook",
                "url": NEWS + "?utm_source=feed",
                "content": SNIPPET,
            },
            {
                "title": "Microsoft investment outlook",
                "url": UNKNOWN,
                "content": "Microsoft will discuss its investment outlook in the upcoming shareholders' meeting.",
            },
            {
                "title": "Unrelated article",
                "url": "https://example.org/news/other",
                "content": "Other issuer only.",
            },
            {"title": "Microsoft analysis", "url": "http://127.0.0.1/private", "content": SNIPPET},
            {
                "title": "Microsoft credentials",
                "url": "https://publisher.example.org/news?access_token=x",
                "content": SNIPPET,
            },
        ]
    }


def connect_search_only(client, send):
    client.app.state.terminal.ai.ollama_cloud.transport = httpx.MockTransport(send)
    saved = client.put("/api/ai/ollama-search", json={"key": SECRET})
    assert saved.is_success and saved.json()["verified"], saved.text


def test_local_search_only_uses_official_search_without_remote_inference_or_key_disclosure(
    tmp_path, monkeypatch
):
    disable_market(monkeypatch)
    calls = []

    def respond(request):
        assert request.url == "https://ollama.com/api/web_search" and request.method == "POST"
        assert request.headers["Authorization"] == "Bearer " + SECRET
        payload = json.loads(request.content)
        calls.append(payload)
        assert SECRET not in request.content.decode()
        return httpx.Response(200, json=results())

    with TestClient(create_app(tmp_path)) as client:
        t = client.app.state.terminal
        monkeypatch.setattr(t.ai.ollama, "status", lambda: {"configured": False})
        assert PROVIDER not in str(t.desk.web_research("MSFT"))
        connect_search_only(client, respond)
        assert t.ai.active().provider == "ollama"
        packet = t.desk.web_research(
            "MSFT", "Search the web for cloud earnings for my secret bank account 2873419"
        )
        assert calls[-1] == {"query": "Microsoft (MSFT) earnings cloud", "max_results": 5}
        assert len(calls) == 2  # one connection probe, one actual query
        assert "2873419" not in json.dumps(calls) and all(usable(e) for e in packet["evidence"])
        assert {r["url"] for r in packet["evidence"]} == {NEWS, UNKNOWN}
        assert (
            packet["evidence"][0]["excerpt"] == SNIPPET
            and packet["evidence"][0]["date_kind"] == "retrieved"
        )
        assert all(r["scope"] == "Search excerpt" for r in packet["evidence"])
        assert next(c for c in packet["coverage"] if c["provider"] == PROVIDER)["count"] == 2
        assert any(
            e["discovered_via"] == PROVIDER
            for e in indexed_evidence(packet["evidence"], compact=True).values()
        )
        assert t.desk.web_research("MSFT", "cloud earnings") == packet and len(calls) == 2
        denied = client.post("/api/desk/web-research/MSFT", json={"question": SECRET})
        assert denied.status_code == 422 and SECRET not in denied.text and len(calls) == 2
        chat = client.post(
            "/api/assistant/research/MSFT",
            json={"question": "Search the web for Microsoft cloud earnings"},
        )
        assert chat.is_success and chat.json()["sources"][0]["url"] in (NEWS, UNKNOWN)
        assert SECRET.encode() not in Path(t.db.path).read_bytes()
        client.delete("/api/ai/ollama-search")
        assert PROVIDER not in str(t.desk.web_research("MSFT", "cloud earnings"))


def test_hosted_search_and_fetch_require_server_selected_original_and_keep_dates(
    tmp_path, monkeypatch
):
    disable_market(monkeypatch)
    calls = []

    def send(secret, method, path, payload):
        assert secret == SECRET and method == "POST"
        calls.append((path, payload))
        if path == "web_search":
            return results()
        assert path == "web_fetch" and payload == {"url": NEWS}
        return {
            "title": "Microsoft cloud outlook",
            "content": "Published: October 2, 2026\n\n" + BODY,
            "links": ["http://127.0.0.1/private", UNKNOWN],
        }

    gateway = SimpleNamespace(
        provider="ollama_cloud", credentials=lambda: (SECRET, "hosted"), request=send, revision=1
    )
    providers = SimpleNamespace(active=lambda: gateway)
    service = web_research.PublicResearch(PublicCache(Store(tmp_path)))
    service.search_access = lambda: search_access(providers)
    report = service.lookup("MSFT", {}, "cloud")
    assert [r for r, _ in calls] == ["web_search", "web_fetch"]
    article = next(r for r in report["evidence"] if r["url"] == NEWS)
    assert article["scope"] == "Article passage" and article["excerpt"] == BODY
    assert article["date"].startswith("2026-10-02") and article["date_kind"] == "published"
    assert article["discovered_via"] == PROVIDER
    snippet = next(r for r in report["evidence"] if r["url"] == UNKNOWN)
    assert snippet["date_kind"] == "retrieved" and snippet["scope"] == "Search excerpt"
    assert "/private" not in json.dumps(report) and SECRET not in json.dumps(report)


@pytest.mark.parametrize(
    "status,note", [(401, "credential"), (403, "permission"), (429, "limit"), (503, "busy")]
)
def test_provider_outage_uses_dated_public_cache_and_preserves_other_providers(
    tmp_path, monkeypatch, status, note
):
    disable_market(monkeypatch)
    cache = PublicCache(Store(tmp_path))
    offline = SearchAccess(
        "local", 1, lambda *args: (_ for _ in ()).throw(HTTPException(status, "hidden " + SECRET))
    )
    online = SearchAccess("local", 1, lambda *args: results())
    old, _ = hosted_sources(cache, online, "MSFT", "Microsoft", (), web_research.mentions)
    records, coverage = hosted_sources(
        cache, offline, "MSFT", "Microsoft", (), web_research.mentions, True
    )
    assert (
        coverage["status"] == "Cached"
        and note in coverage["note"]
        and SECRET not in coverage["note"]
    )
    assert records[0]["stale"] and records[0]["date"] == old[0]["date"]
    svc = web_research.PublicResearch(cache)
    svc.search_access = lambda: offline
    packet = svc.lookup("NVDA", {}, refresh=True)
    assert len(packet["coverage"]) == 4 and packet["coverage"][-1]["status"] == "Unavailable"


def test_search_only_reads_supported_publisher_locally_without_sending_credential(
    tmp_path, monkeypatch
):
    seen = []

    def approved_reader(url):
        seen.append(url)
        return {"paragraphs": [BODY], "date": "2026-10-02"}

    monkeypatch.setattr(ollama_web, "article_document", approved_reader)
    access = SearchAccess("local_with_search", 1, lambda *args: results())
    rows, status = hosted_sources(
        PublicCache(Store(tmp_path)), access, "MSFT", "Microsoft", (), web_research.mentions
    )
    assert seen == [NEWS] and status["count"] == 2
    assert (
        rows[0]["scope"] == "Article passage"
        and rows[0]["date_kind"] == "published"
        and rows[0]["excerpt"] == BODY
    )


def test_malformed_or_empty_fetch_retains_attributed_snippet(tmp_path):
    access = SearchAccess(
        "hosted", 1, lambda *args: results(), lambda url: {"content": "subscribe now"}
    )
    data, c = hosted_sources(
        PublicCache(Store(tmp_path)), access, "MSFT", "Microsoft", (), web_research.mentions
    )
    assert data[0]["excerpt"] == SNIPPET and data[0]["date_kind"] == "retrieved"
    assert c["count"] == 2 and c["note"]


def test_no_proxy_or_navigation_to_private_results():
    for invalid in (
        "https://test.local/a",
        "https://localhost/",
        "https://[::1]/",
        "file:///a",
        "https://abc@www.sec.gov/",
        "https://www.sec.gov:81/",
        "https://example.org/a?token=hey",
        "https://example.org/a%0a",
    ):
        assert source_url(invalid) is None
    assert source_url(NEWS + "#top") == NEWS and fetchable(NEWS)
    assert not fetchable(UNKNOWN) and not fetchable(NEWS + "?url=http://127.0.0.1")
    assert not fetchable("https://www.tipranks.com/search/redirect")


def test_search_only_connection_keeps_live_sources_if_cloud_generation_is_unavailable(
    tmp_path, monkeypatch
):
    with TestClient(create_app(tmp_path)) as client:
        t = client.app.state.terminal
        source = {
            "id": "doc",
            "group": "ollama_web_news",
            "text": "Microsoft report",
            "excerpt": SNIPPET,
            "scope": "Search excerpt",
            "url": NEWS,
            "source": "Publisher",
            "date": "2026-10-01",
        }
        monkeypatch.setattr(
            t.desk, "web_research", lambda *a: {"symbol": "MSFT", "evidence": [source]}
        )
        model = SimpleNamespace(
            provider="ollama_cloud",
            status=lambda: {"configured": True},
            credentials=lambda: (SECRET, "unavailable"),
            structured=lambda *a: (_ for _ in ()).throw(HTTPException(429, "Usage limit")),
        )
        monkeypatch.setattr(t.ai, "active", lambda: model)
        ans = client.post(
            "/api/assistant/research/MSFT",
            json={"question": "Search the web for Microsoft earnings"},
        )
        assert ans.is_success and ans.json()["sources"] == [source] and SECRET not in ans.text
        assert "generation limit" in ans.json()["text"]


@pytest.mark.skipif(
    not os.getenv("STOCKREPLAY_TEST_OLLAMA_SEARCH_KEY"),
    reason="requires an explicit hosted-search test credential",
)
def test_real_ollama_website_search(tmp_path):
    with TestClient(create_app(tmp_path)) as client:
        check = client.put(
            "/api/ai/ollama-search", json={"key": os.environ["STOCKREPLAY_TEST_OLLAMA_SEARCH_KEY"]}
        )
        assert check.is_success and check.json()["verified"]
        result = client.post("/api/desk/web-research/MSFT", json={"question": "cloud earnings"})
        assert result.is_success
        assert any(
            r.get("discovered_via") == PROVIDER and r.get("excerpt")
            for r in result.json()["evidence"]
        ), result.json()["coverage"]


def test_local_scores_consider_distinct_hosted_and_original_publisher_evidence():
    from stockreplay.local_ai import company_news_sources

    def source(url, via, scope):
        return {
            "group": "web_news",
            "factor": "company_news",
            "url": url,
            "discovered_via": via,
            "scope": scope,
            "date": "2025-10-01",
        }

    sources = {
        "S1": source(NEWS, PROVIDER, "Search excerpt"),
        "S2": source(UNKNOWN, PROVIDER, "Search excerpt"),
        "S3": source(NEWS, "Stock Analysis ticker news", "Article passage"),
        "S4": source("https://other.example.org/news", "GDELT news search", "Article passage"),
    }
    selected = company_news_sources(sources)
    assert [sid for sid, _ in selected] == ["S1", "S4"]
