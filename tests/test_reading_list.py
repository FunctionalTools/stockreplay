from concurrent.futures import ThreadPoolExecutor

from fastapi.testclient import TestClient
import pytest

from stockreplay.api import create_app


@pytest.fixture
def article():
    return {
        "url": "https://example.com/story?edition=us#intro",
        "title": "Publisher headline",
        "source": "Example News",
        "published": "2026-11-24T12:00:00Z",
        "excerpt": "A short preview.",
    }


def test_saved_articles_survive_restart_and_duplicate_saves(tmp_path, article):
    with TestClient(create_app(tmp_path)) as client:
        assert client.get("/api/reading-list").json() == []
        with ThreadPoolExecutor(max_workers=3) as pool:
            results = list(
                pool.map(lambda _: client.put("/api/reading-list", json=article), range(3))
            )
        assert all(r.is_success for r in results)
        second = client.put(
            "/api/reading-list", json={**article, "url": article["url"].split("#")[0]}
        ).json()
        assert all(r.json() == second for r in results)
    with TestClient(create_app(tmp_path)) as client:
        saved = client.get("/api/reading-list").json()
        assert saved == [second]
        assert saved[0]["url"] == "https://example.com/story?edition=us"
        path = "/api/reading-list/" + second["id"]
        assert client.delete(path).is_success and client.delete(path).is_success
        assert client.get("/api/reading-list").json() == []


@pytest.mark.parametrize(
    "change",
    [
        {"url": "javascript:alert(1)"},
        {"url": "https://name:password@example.com/story"},
        {"url": "http://127.0.0.1/story"},
        {"url": "https://example.local/story"},
        {"published": "unknown"},
        {"title": " "},
        {"source": ""},
        {"holdings": [1, 2]},
    ],
)
def test_invalid_reading_list_metadata(tmp_path, article, change):
    with TestClient(create_app(tmp_path)) as client:
        assert client.put("/api/reading-list", json={**article, **change}).status_code == 422
        assert client.get("/api/reading-list").json() == []
