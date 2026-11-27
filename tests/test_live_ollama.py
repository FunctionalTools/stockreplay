"""Opt-in end-to-end test using installed Ollama weights and live public research."""

import os

import pytest
from fastapi.testclient import TestClient

from stockreplay.api import create_app
from stockreplay.score_factors import FACTORS


@pytest.mark.skipif(
    os.getenv("STOCKREPLAY_LIVE_OLLAMA") != "1",
    reason="Requires a local Ollama model and live public data",
)
def test_free_research_with_real_local_model(tmp_path):
    model = os.getenv("STOCKREPLAY_TEST_OLLAMA_MODEL", "qwen2.5:3b")
    with TestClient(create_app(tmp_path)) as client:
        assert client.get("/api/ai").json()["provider"] == "ollama"
        models = client.get("/api/ai/ollama/models").json()
        assert model in {entry["id"] for entry in models["models"]}, models
        connection = client.put("/api/ai/ollama", json={"model": model})
        assert connection.is_success, connection.text
        assert (
            connection.json()["verified"] and connection.json()["provider"] == "ollama"
        )
        briefing = client.get("/api/desk/brief/MSFT")
        assert briefing.is_success, briefing.text
        records = briefing.json()["web_research"]["evidence"]
        read_sources = [
            row
            for row in records
            if row["scope"]
            in {"Filing passage", "Article passage", "Filed financial fact"}
            and row.get("excerpt")
            and row.get("url", "").startswith("https://")
        ]
        assert read_sources, (
            "No readable public source for Microsoft during this live check"
        )
        print(f"Read {read_sources[0]['scope'].lower()} at {read_sources[0]['url']}")
        response = client.post("/api/desk/recommend/MSFT")
        assert response.is_success, response.text
        assessment = response.json()
        assert assessment["model"] == model and assessment["provider"] == "ollama"
        for key in ("buy_score", "risk_score"):
            assert type(assessment[key]) is int and 0 <= assessment[key] <= 100
        assert {row["id"] for row in assessment["factors"]} == set(FACTORS)
        cited = {s["id"]: s for s in assessment["sources"]}
        for point in [
            assessment["thesis"],
            *assessment["catalysts"],
            *assessment["risks"],
        ]:
            assert point["text"] and point["citations"]
            for ref in point["citations"]:
                assert cited[ref]["url"].startswith("https://") and cited[ref]["date"]
        assert client.get("/api/desk/recommend/MSFT").json()[0] == assessment
        print(
            f"Live {model} on {assessment['symbol']} ({assessment['as_of']}), buy {assessment['buy_score']}, risk {assessment['risk_score']}, {len(cited)} cited sources."
        )
        question = client.post(
            "/api/assistant/research/MSFT",
            json={
                "question": "Which source should I read to understand one risk for Microsoft?"
            },
        )
        assert question.is_success, question.text
        answer = question.json()
        assert answer["text"] and 1 <= len(answer["sources"]) <= 2
        assert all(source["url"].startswith("https://") for source in answer["sources"])
        print(f"Assistant citation: {answer['sources'][0]['url']}")
