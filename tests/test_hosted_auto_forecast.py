"""Exercise the full website-key path when a dedicated provider test key is supplied."""

import os

import pytest
from fastapi.testclient import TestClient

from stockreplay.api import create_app
from stockreplay.ollama_cloud import CLOUD_MODEL


@pytest.mark.parametrize(
    "provider,endpoint,env_name,default_model",
    [
        ("openai", "/api/openai", "OPENAI", "gpt-4.1-mini"),
        ("ollama_cloud", "/api/ai/ollama-cloud", "OLLAMA_CLOUD", CLOUD_MODEL),
    ],
)
def test_hosted_auto_forecast(tmp_path, provider, endpoint, env_name, default_model):
    prefix = f"STOCKREPLAY_TEST_{env_name}_"
    key = os.getenv(prefix + "KEY")
    if not key:
        pytest.skip(f"Requires a dedicated {provider} key")
    model = os.getenv(prefix + "MODEL", default_model)
    with TestClient(create_app(tmp_path)) as client:
        status = client.put(endpoint, json={"key": key, "model": model, "remember": False})
        assert status.is_success and status.json()["verified"]
        assert client.get("/api/ai").json()["provider"] == provider
        url = "/api/desk/forecast/AAPL?range=1mo"
        response = client.post(url + "&auto=true")
        assert response.is_success, response.text
        row = response.json()["forecast"]
        assert (row["symbol"], row["provider"], row["model"]) == ("AAPL", provider, model)
        assert all(p["prediction"] > 0 for p in row["points"])
        assert row["points"][0]["date"] < row["points"][-1]["date"]
        sources = {s["id"] for s in row["sources"] if s["date"] and s["url"]}
        for kind in ("buy", "risk"):
            assert 0 <= row["scores"][kind + "_score"] <= 100
            refs = row["scores"][kind + "_source_ids"]
            assert refs and set(refs) <= sources
        assert client.get(url).json()["forecast"]["id"] == row["id"]
        assert client.post(url + "&auto=true").json()["forecast"]["id"] == row["id"]
