import os
import time

import pytest
from fastapi.testclient import TestClient

from stockreplay import ai, market
from stockreplay.api import create_app
from stockreplay.robustness import evaluate_robustness
from stockreplay.schema import Experiment, RobustnessRequest


@pytest.fixture
def client(tmp_path):
    with TestClient(create_app(tmp_path)) as cli:
        yield cli


def run(client, config, pins=None):
    res = client.post("/api/jobs", json={"config": config, "pins": pins})
    assert res.status_code == 202, res.text
    key = res.json()["job"]
    deadline = time.monotonic() + 120
    while time.monotonic() < deadline:
        state = client.get("/api/jobs/" + key).json()
        if state["status"] == "error":
            raise AssertionError(state)
        if state["status"] == "complete":
            return client.get("/api/runs/" + state["run"]).json()
        time.sleep(0.1)
    raise AssertionError("Timed out")


def test_full_api_persistence_export_replay(client, config, frames):
    for s, f in frames.items():
        assert client.post("/api/data/import", json={"ticker": s, "csv": f.to_csv()}).is_success
    assert len(client.get("/api/data").json()) == 2
    r = run(client, config.model_dump(mode="json"))
    assert r["metrics"]["mean"] == pytest.approx(-2.5)
    key = r["id"]
    sid = client.post(
        "/api/library", json={"run_id": key, "name": "Sample", "notes": "a < b"}
    ).json()["id"]
    assert client.patch(
        "/api/library/" + sid, json={"name": "Renamed", "notes": "a < b"}
    ).is_success
    saved = client.get("/api/library").json()[0]
    assert saved["name"] == "Renamed" and saved["notes"] == "a < b"
    base = "/api/runs/" + key + "/export/"
    html = client.get(base + "html?saved=" + sid)
    assert (
        "Renamed" in html.text
        and "a &lt; b" in html.text
        and "<svg" in html.text
        and "attachment" in html.headers["content-disposition"]
    )
    assert len(client.get(base + "csv").text.splitlines()) == 3
    assert client.get(base + "config").json()["holding"] == 2
    restored = client.post("/api/import", json=client.get(base + "bundle").json()).json()
    assert restored["metrics"] == r["metrics"] and restored["events"] == r["events"]
    assert client.get("/api/data/" + r["sources"]["SPY"]["id"] + "/csv").text.startswith(
        "Date,Open"
    )
    assert (
        client.post(
            "/api/comparisons", json={"name": "Reproduction", "left": key, "right": restored["id"]}
        ).status_code
        == 201
    )
    assert len(client.get("/api/comparisons").json()[0]["payload"]) == 2
    assert client.delete("/api/library/" + sid).is_success and not client.get("/api/library").json()
    assert client.get("/api/runs/invalid").status_code == 404


def test_demo_jobs_and_offline_ai(client, monkeypatch):
    r = client.get("/api/demo").json()
    assert r["config"]["source"] == "demo" and r["metrics"]["count"] > 0
    assert client.get("/api/demo").json()["id"] == r["id"]

    def down(*args):
        raise ai.AIUnavailable("offline")

    monkeypatch.setattr(ai, "chat", down)
    assert (
        client.post(
            "/api/interpret", json={"config": r["config"], "question": "Test this question"}
        ).status_code
        == 503
    )
    assert client.post("/api/runs/" + r["id"] + "/explain").status_code == 503
    assert run(client, r["config"])["metrics"] == r["metrics"]


def test_error_paths_and_settings(client, config, monkeypatch):
    assert client.post("/api/jobs", json={"config": {"holding": 0}}).status_code == 422
    assert (
        client.post(
            "/api/data/import", json={"ticker": "AAPL", "csv": "Date,Open\n2020-01-01,1"}
        ).status_code
        == 422
    )
    assert (
        client.post("/api/data/fetch", json={"config": config.model_dump(mode="json")}).status_code
        == 422
    )
    assert client.get("/api/symbols?q=NVIDIA").json()[0]["symbol"] == "NVDA"
    assert client.get("/api/jobs/absent").status_code == 404
    monkeypatch.setattr(
        ai, "status", lambda m: {"model": m, "online": False, "ready": False, "models": []}
    )
    assert client.put("/api/settings", json={"model": "local:v1"}).json()["model"] == "local:v1"
    assert client.get("/api/ai").json()["model"] == "local:v1"
    assert (
        client.post("/api/jobs", json={}, headers={"origin": "https://other.example"}).status_code
        == 403
    )


def test_robustness_chronology(client):
    r = client.get("/api/demo").json()
    payload = {
        "config": r["config"],
        "thresholds": [-2, -3],
        "holdings": [3, 5],
        "costs": [0, 10],
        "split": 0.65,
        "folds": 2,
        "pins": {s: m["id"] for s, m in r["sources"].items()},
    }
    res = client.post("/api/runs/" + r["id"] + "/robustness", json=payload)
    assert res.is_success, res.text
    results = res.json()
    assert len(results["cells"]) == 4 and results["train_end"] < results["test_start"]
    assert results["costs"][0]["test"]["mean"] > results["costs"][1]["test"]["mean"]
    assert results["folds"][0]["end"] < results["folds"][1]["start"]
    assert client.get("/api/runs/" + r["id"]).json()["robustness"] == results


def test_holdout_does_not_influence_training(tmp_path):
    from stockreplay.store import Store

    c = Experiment(source="demo")
    frames, _ = market.load_market(Store(tmp_path), c)
    req = RobustnessRequest(config=c, holdings=[4, 5], thresholds=[-2, -3], split=0.65, folds=2)
    before = evaluate_robustness(req, frames)
    first = int(len(frames["NVDA"]) * req.split)
    idx = frames["NVDA"].index[first:]
    cols = ["Open", "High", "Low", "Close", "Adj Close"]
    frames["NVDA"].loc[idx, cols] *= 2
    after = evaluate_robustness(req, frames)
    assert [x["train"] for x in before["cells"]] == [x["train"] for x in after["cells"]]
    assert before["folds"][0]["selected"] == after["folds"][0]["selected"]


@pytest.mark.skipif(
    os.getenv("STOCKREPLAY_LIVE_TESTS") != "1", reason="enable live Yahoo request explicitly"
)
def test_real_yahoo_and_cached_replay(client, monkeypatch):
    c = Experiment(source="yahoo", start="2023-01-03", end="2024-12-31")
    r = run(client, c.model_dump(mode="json"))
    assert all(s["source"] == "yahoo" and s["rows"] == 502 for s in r["sources"].values())
    assert r["metrics"]["count"] > 0

    def no_network(*a):
        raise AssertionError("Expected cached real data")

    monkeypatch.setattr(market, "yahoo", no_network)
    assert run(client, r["config"])["metrics"] == r["metrics"]


def test_changed_robustness_invalidates_inflight_explanation(client, monkeypatch):
    r = client.get("/api/demo").json()
    db = client.app.state.store

    def changed(*args):
        with db.connect() as conn:
            conn.execute(
                "insert into research(run_id,robustness) values(?,?)", (r["id"], '{"cells":[]}')
            )
        return {"origin": "ollama", "model": "local", "sections": []}

    monkeypatch.setattr(ai, "explain", changed)
    assert client.post("/api/runs/" + r["id"] + "/explain").status_code == 409
    assert "explanation" not in client.get("/api/runs/" + r["id"]).json()
