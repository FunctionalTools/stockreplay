import os

import httpx
import pytest

from stockreplay import sec_research, source_reader, web_research
from stockreplay.assistant import asks_for_sources, research_question
from stockreplay.public_cache import PublicCache
from stockreplay.store import Store, now

BODY = "The issuer reported higher cloud revenue and operating income as customers increased demand for its subscription services during the quarter."
NEWS = "https://www.tipranks.com/news/msft-quarterly-results"
SECOND = "https://stockanalysis.com/news/microsoft-announcement/"
CIK = 789019
ACC = "0001193125-26-436133"


@pytest.mark.parametrize(
    "url",
    [
        "http://www.sec.gov/files/company_tickers.json",
        "https://www.sec.gov:8080/files/company_tickers.json",
        "https://127.0.0.1/secret",
        "https://www.sec.gov.evil.test/files/company_tickers.json",
        "https://x@www.sec.gov/files/company_tickers.json",
        "https://www.sec.gov/redirect?url=https://127.0.0.1/",
        "https://stockanalysis.com/news/%2e%2e/admin",
        "https://stockanalysis.com/news/a\\b",
    ],
)
def test_fetch_only_known_document_routes(url, monkeypatch):
    monkeypatch.setattr(
        source_reader.socket,
        "getaddrinfo",
        lambda *args, **kwargs: pytest.fail("should reject before DNS"),
    )
    with pytest.raises(ValueError):
        source_reader.read_public(url)


def test_reject_internal_resolution_and_redirects_and_oversized_bodies(monkeypatch):
    monkeypatch.setattr(
        source_reader.socket, "getaddrinfo", lambda *a, **kw: [(0, 0, 0, "", ("127.0.0.1", 443))]
    )
    with pytest.raises(ValueError, match="public address"):
        source_reader.read_public(NEWS)
    monkeypatch.setattr(
        source_reader.socket, "getaddrinfo", lambda *a, **kw: [(0, 0, 0, "", ("1.1.1.1", 443))]
    )
    statuses = [
        (302, {"location": "http://127.0.0.1/"}, b""),
        (200, {"content-type": "text/html"}, b"x" * 100),
        (200, {"content-type": "application/pdf"}, b"pdf"),
    ]
    real_client = httpx.Client

    def respond(request):
        assert str(request.url) == NEWS
        status, headers, body = statuses.pop(0)
        return httpx.Response(status, headers=headers, content=body)

    monkeypatch.setattr(
        source_reader.httpx,
        "Client",
        lambda **kw: real_client(**kw, transport=httpx.MockTransport(respond)),
    )
    for _ in range(3):
        with pytest.raises((httpx.HTTPStatusError, ValueError)):
            source_reader.read_public(NEWS, limit=80)
    assert not statuses


def test_document_reader_only_quotes_article_and_visible_filing_narrative(monkeypatch):
    html = f'<head><meta property="article:published_time" content="2025-01-14T14:00:00Z"></head><article><aside><p>{BODY.replace("cloud", "unrelated")}</p></aside><p>{BODY}</p></article>'
    monkeypatch.setattr(source_reader, "read_public", lambda *a, **kw: html.encode())
    doc = source_reader.article_document(NEWS)
    assert doc["paragraphs"] == [BODY] and doc["date"].startswith("2025-01-14")
    monkeypatch.setattr(
        source_reader, "read_public", lambda *a, **kw: b"<main><p>Subscribe now to read.</p></main>"
    )
    with pytest.raises(ValueError):
        source_reader.article_document(NEWS)
    parser = source_reader.FilingParagraphs()
    parser.feed(
        f"<html><head>{BODY}</head><ix:hidden><div>{BODY}</div></ix:hidden><table><tr><td>{BODY}</td></tr></table><div><span>{BODY}</span></div></html>"
    )
    assert parser.paragraphs == [BODY]
    boiler = "Actual results and outcomes may differ from management’s estimates and assumptions due to risks and uncertainties."
    assert source_reader.best_passage([boiler, BODY], ["risk", "cloud"]) == BODY


def test_search_falls_back_to_dated_index_and_cached_passage_without_sending_raw_question(
    tmp_path, monkeypatch
):
    service = web_research.PublicResearch(PublicCache(Store(tmp_path)))
    calls = []

    def gdelt(name, words):
        calls.append((name, words))
        raise ValueError("News index unavailable.")

    def ticker(*args):
        return [
            {
                "text": "Microsoft quarterly results",
                "date": now(),
                "date_origin": "Index listing",
                "url": url,
                "discovered_via": "Stock Analysis ticker news",
            }
            for url in [NEWS, SECOND, "https://127.0.0.1/private"]
        ]

    def original(url):
        if url == SECOND:
            raise ValueError("Subscription required")
        assert url == NEWS
        return {"paragraphs": [BODY], "date": now()}

    monkeypatch.setattr(web_research, "news_index", gdelt)
    monkeypatch.setattr(web_research, "ticker_index", ticker)
    monkeypatch.setattr(
        web_research, "sec_lookup", lambda *args: ([], ["No SEC issuer matched this ticker."])
    )
    monkeypatch.setattr(web_research, "article_document", original)
    report = service.lookup("MSFT", {}, "My secret brokerage 89991: search web for cloud earnings")
    assert calls == [("Microsoft", ("earnings", "cloud"))]
    assert "89991" not in str(report)
    assert {r["scope"] for r in report["evidence"]} == {"Headline only", "Article passage"}
    assert report["coverage"][0]["status"] == "Unavailable"
    article = next(r for r in report["evidence"] if r["scope"] == "Article passage")
    assert article["excerpt"] == BODY and article["date_origin"] == "Publisher publication date"
    monkeypatch.setattr(
        web_research, "article_document", lambda url: (_ for _ in ()).throw(ValueError("offline"))
    )
    again = service.lookup("MSFT", {}, "earnings cloud", refresh=True)
    kept = next(r for r in again["evidence"] if r["url"] == NEWS)
    assert kept["stale"] and kept["id"] == article["id"] and kept["excerpt"] == BODY


def test_sec_reads_actual_original_and_uses_only_filed_fact_if_document_blocked(
    tmp_path, monkeypatch
):
    cache = PublicCache(Store(tmp_path))
    monkeypatch.setattr(sec_research, "sec_tickers", lambda: {"MSFT": CIK})
    recent = {
        "form": ["10-Q"],
        "filingDate": ["2026-10-28"],
        "reportDate": ["2026-09-30"],
        "primaryDocument": ["msft-q.htm"],
        "accessionNumber": [ACC],
    }
    monkeypatch.setattr(
        sec_research,
        "sec_submissions",
        lambda cik: {"filings": {"recent": recent}, "name": "Microsoft"},
    )
    monkeypatch.setattr(sec_research, "search_filings", lambda cik, terms: [ACC])
    monkeypatch.setattr(sec_research, "filing_document", lambda url: [BODY])
    r, notes = sec_research.sec_lookup("MSFT", ("cloud",), cache, False)
    assert r[0]["scope"] == "Filing passage" and r[0]["excerpt"] == BODY
    assert r[0]["discovered_via"] == "SEC EDGAR full-text search"
    assert (
        r[0]["url"]
        == f"https://www.sec.gov/Archives/edgar/data/{CIK}/{ACC.replace('-', '')}/msft-q.htm"
    )
    other = PublicCache(Store(tmp_path / "second"))
    monkeypatch.setattr(
        sec_research, "filing_document", lambda url: (_ for _ in ()).throw(ValueError("restricted"))
    )
    monkeypatch.setattr(
        sec_research,
        "sec_json",
        lambda *args: {
            "units": {
                "USD": [{"filed": "2026-10-28", "end": "2026-09-30", "val": 651, "accn": ACC}]
            }
        },
    )
    r, notes = sec_research.sec_lookup("MSFT", (), other, False)
    assert (
        r[0]["scope"] == "Filed financial fact"
        and "USD 651" in r[0]["excerpt"]
        and "restricted" in notes
    )
    assert r[0]["related"][0]["url"].endswith("/us-gaap/Assets.json")


def test_assistant_research_sends_passage_scope_and_returns_original_citations():
    assert asks_for_sources("Search online for Microsoft cloud risk")

    class Gateway:
        def structured(self, key, model, name, schema, prompt, inputs, budget):
            row = inputs["evidence"][0]
            assert (
                row["scope"] == "Article passage"
                and row["excerpt"] == BODY
                and "raw_account" not in inputs
            )
            return {
                "answer": "The publisher describes higher cloud demand.",
                "citations": [row["ref"]],
            }

    source = {
        "id": "x",
        "group": "web_news",
        "date": now(),
        "source": "Publisher",
        "scope": "Article passage",
        "text": "Named coverage",
        "excerpt": BODY,
        "url": NEWS,
    }
    result = research_question(
        Gateway(),
        {
            "symbol": "MSFT",
            "evidence": [source],
            "raw_account": "private",
            "query": "Microsoft cloud",
            "coverage": [],
        },
        "Search online for cloud demand",
        ("unused", "local"),
    )
    assert result["sources"] == [source]


@pytest.mark.skipif(
    os.getenv("STOCKREPLAY_LIVE_TESTS") != "1", reason=" opt-in live publisher and SEC sources"
)
def test_live_company_lookup_reads_actual_documents(tmp_path):
    result = web_research.PublicResearch(PublicCache(Store(tmp_path))).lookup(
        "MSFT", {}, "Search the web for cloud risk"
    )
    assert any(
        r["scope"] in ("Filing passage", "Article passage")
        and len(r["excerpt"]) >= 65
        and r["url"].startswith("https://")
        for r in result["evidence"]
    ), result["coverage"]
    assert {r["provider"] for r in result["coverage"]} == {
        "GDELT news search",
        "Stock Analysis ticker news",
        "SEC EDGAR",
    }


def test_explicit_chat_search_without_an_ai_account_returns_the_attributed_passage(
    tmp_path, monkeypatch
):
    from fastapi.testclient import TestClient
    from stockreplay.api import create_app

    with TestClient(create_app(tmp_path)) as client:
        client.patch("/api/ai", json={"provider": "openai"})
        src = {
            "symbol": "MSFT",
            "query": "Microsoft earnings",
            "evidence": [
                {
                    "id": "read",
                    "source": "Publisher",
                    "text": "Microsoft earnings",
                    "excerpt": BODY,
                    "scope": "Article passage",
                    "url": NEWS,
                }
            ],
        }

        def search(symbol, question):
            assert symbol == "MSFT" and "earnings" in question
            return src

        monkeypatch.setattr(client.app.state.terminal.desk, "web_research", search)
        msg = "Search the web for Microsoft earnings"
        planned = client.post(
            "/api/assistant",
            json={
                "messages": [{"role": "user", "text": msg}],
                "page": "Research",
                "symbol": "AAPL",
            },
        ).json()
        assert planned["local"] and planned["actions"] == [
            {"kind": "research", "symbol": "MSFT", "question": msg}
        ]
        reply = client.post("/api/assistant/research/MSFT", json={"question": msg})
        assert reply.is_success and reply.json()["text"].startswith("Publisher · “")
        assert reply.json()["sources"][0]["url"] == NEWS


def test_user_can_search_for_public_product_phrases_without_sending_a_chat_message():
    assert web_research.topics("Search online for NVIDIA “Blackwell delivery” and earnings") == (
        "blackwell delivery",
        "earnings",
    )
    assert web_research.topics("Blackwell shipments", explicit_topic=True) == (
        "blackwell",
        "shipments",
    )
    assert web_research.topics("account 123456789 earnings", explicit_topic=True) == ("earnings",)
