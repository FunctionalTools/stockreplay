"""Local assistant routes must handle only whole, explicit requests."""

import httpx
import pytest
from fastapi.testclient import TestClient

from stockreplay.api import create_app
from stockreplay.assistant_shortcuts import local_actions


@pytest.mark.parametrize(
    ("prompt", "actions"),
    [
        (
            "Show the 5D chart for AAPL",
            [{"kind": "range", "symbol": "AAPL", "span": "5d"}],
        ),
        (
            "view the one month graph",
            [{"kind": "range", "symbol": "NVDA", "span": "1mo"}],
        ),
        (
            "show the one week chart for AAPL",
            [{"kind": "range", "symbol": "AAPL", "span": "1w"}],
        ),
        (
            "graph NVDA for the last 1w",
            [{"kind": "chart", "symbols": ["NVDA"], "span": "1w"}],
        ),
        ("show Apple YTD", [{"kind": "range", "symbol": "AAPL", "span": "ytd"}]),
        (
            "set homepage range to 2025-07-01 through 2025-08-01",
            [{"kind": "range", "symbol": "NVDA", "span": "2025-07-01/2025-08-01"}],
        ),
        ("change the ticker to $tsm", [{"kind": "open_stock", "symbol": "TSM"}]),
        (
            "Graph NVDA and MSFT over the last five days",
            [{"kind": "chart", "symbols": ["NVDA", "MSFT"], "span": "5d"}],
        ),
        ("chart Tesla today", [{"kind": "chart", "symbols": ["TSLA"], "span": "1d"}]),
        ("use my portfolio as my homepage", [{"kind": "home_portfolio"}]),
        ("set my starting stock to Amazon", [{"kind": "home_stock", "symbol": "AMZN"}]),
        (
            "enable dark mode and ocean accent and enable advanced trader tools",
            [
                {"kind": "appearance", "mode": "dark"},
                {"kind": "accent", "color": "ocean"},
                {"kind": "advanced", "enabled": True},
            ],
        ),
        (
            "open the Future tab for Apple",
            [
                {
                    "kind": "navigate",
                    "page": "Research",
                    "symbol": "AAPL",
                    "focus": "future",
                }
            ],
        ),
        ("expand the assistant", [{"kind": "chat_size", "size": "large"}]),
        ("replace my OpenAI API key", [{"kind": "navigate", "page": "Settings"}]),
        ("change model to gpt-4.1-mini", [{"kind": "model", "model": "gpt-4.1-mini"}]),
        ("show news for Apple", [{"kind": "news", "symbol": "AAPL"}]),
        (
            "what are the risks for MSFT?",
            [
                {
                    "kind": "research",
                    "symbol": "MSFT",
                    "question": "what are the risks for MSFT?",
                }
            ],
        ),
        ("enable dark mode if Apple drops", None),
        ("show settings and explain my portfolio", None),
        ("Graph Apple and a company like it", None),
        ("open Acme", None),
        ("Why do investors disagree?", None),
    ],
)
def test_routes(prompt, actions):
    assert local_actions(prompt, "NVDA") == actions


def test_direct_commands_skip_credentials_and_planner_but_never_skip_secret_check(
    tmp_path,
):
    with TestClient(create_app(tmp_path)) as c:
        c.patch("/api/ai", json={"provider": "openai"})
        gateway = c.app.state.terminal.openai
        gateway.transport = httpx.MockTransport(
            lambda _: pytest.fail("Unexpected OpenAI request")
        )
        body = {
            "page": "Research",
            "symbol": "NVDA",
            "messages": [{"role": "user", "text": "Chart Apple today"}],
        }
        result = c.post("/api/assistant", json=body)
        assert result.is_success and result.json()["local"]
        body["messages"][0]["text"] = (
            "How do higher interest rates affect small-cap valuations?"
        )
        assert c.post("/api/assistant", json=body).status_code == 409
        body["messages"].append({"role": "user", "text": "Show settings"})
        body["messages"][0]["text"] = "sk-block-this-secret-before-routing"
        assert c.post("/api/assistant", json=body).status_code == 422


def test_pooled_transport_keeps_credentials_and_request_ids_per_call(tmp_path):
    observed = []

    def respond(request):
        observed.append(dict(request.headers))
        return httpx.Response(200, json={}, headers={"set-cookie": "old=ignored"})

    with TestClient(create_app(tmp_path)) as c:
        gateway = c.app.state.terminal.openai
        gateway.transport = httpx.MockTransport(respond)
        pool = gateway.client()
        gateway.request("first", "GET", "models")
        gateway.request("second", "GET", "models")
        assert pool is gateway.client()
        assert [r["authorization"] for r in observed] == [
            "Bearer first",
            "Bearer second",
        ]
        assert observed[0]["x-client-request-id"] != observed[1]["x-client-request-id"]
        assert all("cookie" not in r for r in observed)
        assert "authorization" not in pool.headers
    assert pool.is_closed


def test_sourced_shortcut_only_bills_the_answer_and_hides_automatic_holdings(
    tmp_path, monkeypatch
):
    import json
    from tests.provider_fixture import respond

    calls = []

    def record(req):
        payload = json.loads(req.content)
        calls.append((payload["text"]["format"]["name"], json.loads(payload["input"])))
        return respond(req)

    with TestClient(create_app(tmp_path)) as c:
        service = c.app.state.terminal
        service.openai.transport = httpx.MockTransport(record)
        assert c.put("/api/openai", json={"key": "test-only-intercepted"}).is_success
        calls.clear()
        question = "What are the risks for MSFT?"
        prompt = {
            "messages": [{"role": "user", "text": question}],
            "page": "Research",
            "symbol": "PRIVATE",
            "portfolio_context": True,
        }
        routed = c.post("/api/assistant", json=prompt).json()
        assert routed["local"] and not calls
        monkeypatch.setattr(
            service.desk,
            "briefing",
            lambda asset: {
                "symbol": asset,
                "evidence": [
                    {
                        "id": "news",
                        "source": "Publisher",
                        "text": "Market demand eased.",
                        "date": "2025-01-15",
                        "group": "company_news",
                        "url": "https://example.org/story",
                    }
                ],
            },
        )
        assert c.post(
            "/api/assistant/research/MSFT", json={"question": question}
        ).is_success
        assert [name for name, _ in calls] == ["stock_question"]
        assert "PRIVATE" not in json.dumps(calls)
        prompt["messages"][0]["text"] = "How do I change the chart style?"
        assert c.post("/api/assistant", json=prompt).is_success
        assert calls[-1][0] == "app_assistant" and calls[-1][1]["symbol"] == ""
        assert "PRIVATE" not in json.dumps(calls)


def test_prediction_location_question_returns_a_local_link_without_navigating(tmp_path):
    with TestClient(create_app(tmp_path)) as c:
        sent = c.post(
            "/api/assistant",
            json={
                "messages": [
                    {
                        "role": "user",
                        "text": "wheres the tab where i can see future stock prediction",
                    }
                ],
                "page": "Settings",
                "symbol": "BRK-B",
            },
        )
        assert sent.status_code == 200
        answer = sent.json()
        assert answer["actions"] == [] and answer["local"]
        assert answer["links"] == [
            {
                "label": "Open Future",
                "page": "Research",
                "symbol": "BRK-B",
                "focus": "future",
            }
        ]


def test_forecast_generation_accepts_an_explicit_single_ticker_instruction(tmp_path):
    assert local_actions("Open the saved 1M forecast for Apple", "MSFT") == [
        {
            "kind": "navigate",
            "symbol": "AAPL",
            "page": "Research",
            "focus": "future_1mo",
        }
    ]
    assert local_actions("Generate a 1M forecast for AAPL", "MSFT") == [
        {"kind": "forecast", "symbol": "AAPL", "span": "1mo"}
    ]
    assert local_actions("Update my price forecast for Apple for one week", "MSFT") == [
        {"kind": "forecast", "symbol": "AAPL", "span": "1w"}
    ]
    assert local_actions("Show the 3-month forecast for NVDA", "AAPL") == [
        {"kind": "navigate", "symbol": "NVDA", "page": "Research", "focus": "future_3mo"}
    ]
    assert local_actions(
        "Generate a forecast for AAPL from 2027-02-01 to 2027-02-07", "MSFT"
    ) == [{"kind": "forecast", "symbol": "AAPL", "span": "2027-02-01/2027-02-07"}]
    assert local_actions("Generate a 1M forecast for AAPL and MSFT", "MSFT") is None
    with TestClient(create_app(tmp_path)) as c:
        for text, symbol, focus in [
            ("Can you generate a forecast for AAPL?", "AAPL", "future"),
            ("Where do I find my forecast assumptions?", "MSFT", "future"),
            ("Do you have a stock price prediction?", "MSFT", "future"),
            ("Generate a 1M forecast for AAPL?", "AAPL", "future_1mo"),
            ("Can I see the 6-month forecast for Apple?", "AAPL", "future_6mo"),
            ("What is the forecast for NVDA over five days?", "NVDA", "future_5d"),
            ("What is the forecast for NVDA next week?", "NVDA", "future_1w"),
            ("What’s Apple’s forecast for the next 3 months?", "AAPL", "future_3mo"),
            (
                "Can I see the forecast for AAPL from 2027-02-02 to 2027-02-05?",
                "AAPL",
                "future_custom_2027-02-02_2027-02-05",
            ),
        ]:
            answer = c.post(
                "/api/assistant",
                json={
                    "page": "Settings",
                    "symbol": "MSFT",
                    "messages": [{"role": "user", "text": text}],
                },
            )
            assert answer.status_code == 200
            assert answer.json()["local"] and answer.json()["actions"] == []
            assert answer.json()["links"] == [
                {"label": "Open Future", "page": "Research", "symbol": symbol, "focus": focus}
            ]
