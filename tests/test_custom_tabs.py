from fastapi.testclient import TestClient

from stockreplay.api import create_app


def test_tab_lifecycle_is_persistent_and_versioned(tmp_path):
    client = TestClient(create_app(tmp_path))
    blocks = [
        {"view": "chart", "value": "nvda, AMD", "span": "6mo"},
        {"view": "note", "value": "Review operating margin."},
    ]
    created = client.post("/api/tabs", json={"title": "Chip stocks", "blocks": blocks})
    assert created.status_code == 201
    tab = created.json()
    assert tab["revision"] == 1 and tab["blocks"][0]["value"] == "NVDA, AMD"
    assert client.post("/api/tabs", json={"title": "chip stocks"}).status_code == 409
    path = "/api/tabs/" + tab["id"]
    reopened = TestClient(create_app(tmp_path))
    assert reopened.get(path).json() == tab
    assert "blocks" not in reopened.get("/api/tabs").json()[0]
    change = {"revision": 1, "title": "Semiconductors", "blocks": tab["blocks"][::-1]}
    newer = reopened.put(path, json=change).json()
    assert newer["title"] == "Semiconductors" and newer["blocks"] == change["blocks"]
    assert client.put(path, json=change).status_code == 409
    assert client.delete(path + "?revision=1").status_code == 409
    assert reopened.delete(path + "?revision=2").is_success
    assert reopened.get(path).status_code == 404
    assert not client.get("/api/tabs").json()


def test_tab_blocks_are_typed_and_atomic(tmp_path):
    client = TestClient(create_app(tmp_path))
    for block in [
        {"view": "html", "value": "<script>"},
        {"view": "news", "value": "NVDA,AAPL"},
        {"view": "chart", "value": "http://example.com"},
        {"view": "chart", "value": "NVDA", "span": "anything"},
        {"view": "note", "value": ""},
    ]:
        response = client.post("/api/tabs", json={"title": "Invalid", "blocks": [block]})
        assert response.status_code == 422
    assert client.get("/api/tabs").json() == []
