"""Conversation persistence and compact assistant outputs through the local app API."""

from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

from fastapi.testclient import TestClient
from stockreplay.api import create_app
from stockreplay import assistant


BASE = "/api/assistant/chats"


def test_rich_history_reopens_after_service_restart(tmp_path):
    key = str(uuid4())
    path = BASE + "/" + key
    title = "My allocation"
    entries = [
        {"id": 1, "role": "user", "text": "Compare my holdings"},
        {
            "id": 2,
            "role": "assistant",
            "text": "Allocation",
            "rows": [{"name": "Private bank", "value": 123, "currency": "USD"}],
            "allocation": True,
            "links": [{"page": "Portfolio", "label": "Open portfolio"}],
        },
        {
            "id": 3,
            "role": "assistant",
            "text": "Chart",
            "graph": {"symbols": ["AAPL"], "span": "1y", "snapshot": "a" * 64},
        },
        {
            "id": 4,
            "role": "assistant",
            "text": "Read this",
            "sources": [{"text": "Article", "url": "https://example.org/news"}],
        },
        {
            "id": 5,
            "role": "assistant",
            "text": "Created",
            "confirmation": {
                "action": {"kind": "delete_list", "name": "Retirement"},
                "pending": False,
            },
        },
    ]
    context = [{"role": "user", "text": "Compare my holdings"}]
    with TestClient(create_app(tmp_path)) as client:
        new = client.post(BASE, json={"title": title, "id": key})
        assert new.status_code == 201 and new.json()["revision"] == 0
        assert client.post(BASE, json={"title": title, "id": key}).json() == new.json()
        body = {"revision": 0, "entries": entries, "context": context}
        saved = client.put(path, json=body)
        assert saved.status_code == 200 and saved.json()["revision"] == 1
        assert client.put(path, json=body).json() == saved.json()
        assert "no-store" in client.get(path).headers["cache-control"]
        assert client.post("/api/watchlists", json={"name": "Retirement"}).is_success
    with TestClient(create_app(tmp_path)) as client:
        restored = client.get(path).json()
        assert restored["entries"] == entries and restored["context"] == context
        menu = client.get(BASE).json()
        assert len(menu) == 1 and menu[0]["title"] == title
        assert "entries" not in menu[0] and "context" not in menu[0]
        assert any(row["name"] == "Retirement" for row in client.get("/api/watchlists").json())
        renamed = client.patch(path, json={"title": "Saved allocation", "revision": 1}).json()
        assert renamed["revision"] == 2 and renamed["entries"] == entries
        assert client.delete(path + "?revision=1").status_code == 409
        assert client.delete(path + "?revision=2").is_success
        assert client.get(path).status_code == 404 and client.get(BASE).json() == []
        assert client.put(path, json=body).status_code == 404


def test_concurrent_chat_updates_preserve_one_complete_snapshot(tmp_path):
    with TestClient(create_app(tmp_path)) as c:
        path = BASE + "/" + c.post(BASE, json={}).json()["id"]

        def write(i):
            entry = {"role": "user", "text": str(i), "id": 1}
            return c.put(path, json={"revision": 0, "entries": [entry], "context": []})

        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(write, [1, 2]))
        assert sorted(r.status_code for r in results) == [200, 409]
        assert c.get(path).json() == next(r.json() for r in results if r.is_success)


def test_chat_rejects_secrets_without_echo_or_mutation(tmp_path):
    with TestClient(create_app(tmp_path)) as c:
        secret = "sk-invalid-fixture-never-send-or-retain"
        bad = c.post(BASE, json={"title": secret})
        assert bad.status_code == 422 and secret not in bad.text and c.get(BASE).json() == []
        path = BASE + "/" + c.post(BASE, json={}).json()["id"]
        for snapshot in [
            {"context": [{"role": "user", "text": secret}], "entries": []},
            {
                "context": [],
                "entries": [
                    {
                        "role": "assistant",
                        "id": 1,
                        "text": "Receipt",
                        "rows": [{"name": secret}],
                    }
                ],
            },
            {
                "context": [],
                "entries": [
                    {"role": "user", "id": 1, "text": "A"},
                    {"role": "user", "id": 1, "text": "B"},
                ],
            },
        ]:
            bad = c.put(path, json={**snapshot, "revision": 0})
            assert bad.status_code == 422 and secret not in bad.text
        assert c.get(path).json()["revision"] == 0


def test_planner_returns_controlled_links_and_compact_text(tmp_path, monkeypatch):
    captured = []
    with TestClient(create_app(tmp_path)) as c:
        c.patch("/api/ai", json={"provider": "openai"})
        gateway = c.app.state.terminal.openai
        monkeypatch.setattr(gateway, "credentials", lambda: ("intercepted", "gpt-4.1-mini"))

        def planner(key, model, name, schema, instructions, inputs, budget):
            captured.append((schema, inputs))
            return {
                "actions": [],
                "reply": "Open Portfolio. " + "Excess text " * 200,
                "links": [
                    "Portfolio import guide",
                    "https://example.org/fabricated",
                    "Portfolio import guide",
                    "Import a statement",
                    "Watchlists",
                ],
            }

        monkeypatch.setattr(gateway, "structured", planner)
        path = BASE + "/" + c.post(BASE, json={}).json()["id"]
        c.put(
            path,
            json={
                "context": [],
                "entries": [{"role": "assistant", "id": 5, "text": "private position value"}],
                "revision": 0,
            },
        )
        result = c.post(
            "/api/assistant",
            json={
                "page": "Research",
                "symbol": "AAPL",
                "custom_tab_open": True,
                "messages": [{"role": "user", "text": "How do I import my portfolio?"}],
            },
        ).json()
        assert result["reply"] == "Open Portfolio."
        assert result["links"] == [
            {
                "page": "Portfolio",
                "label": "Portfolio import guide",
                "focus": "import-guide",
            },
            {"page": "Portfolio", "label": "Import a statement", "focus": "holdings"},
        ]
    schema, inputs = captured[0]
    assert "private position value" not in str(inputs)
    assert (
        set(inputs) == {"page", "symbol", "messages", "custom_tab_open"}
        and inputs["custom_tab_open"] is True
    )
    # Strict Structured Outputs supports object roots, requires all fields and rejects
    # ambiguous anyOf object branches whose first property is the same.
    variants = schema["properties"]["actions"]["items"]["anyOf"]
    names = [next(iter(variant["properties"])) for variant in variants]
    assert len(names) == len(set(names)) and "tab" in names and "chart" in names

    def stats(node, depth=0):
        if node.get("type") == "object":
            fields = node["properties"]
            assert node["additionalProperties"] is False and node["required"] == list(fields)
            counts = [stats(field, depth + 1) for field in fields.values()]
            return len(fields) + sum(count for count, _ in counts), max(
                [depth + 1] + [d for _, d in counts]
            )
        if "anyOf" in node:
            counts = [stats(field, depth) for field in node["anyOf"]]
            return sum(count for count, _ in counts), max(d for _, d in counts)
        if node.get("type") == "array":
            return stats(node["items"], depth)
        return 0, depth

    count, depth = stats(schema)
    definitions = schema["$defs"]
    for variant in variants:
        for arg in variant["properties"].values():
            if "$ref" in arg:
                definition = definitions[arg["$ref"].removeprefix("#/$defs/")]
                assert definition["additionalProperties"] is False
                # The root and action wrapper appear above this argument.
                depth = max(depth, 2 + stats(definition)[1])
    count += sum(stats(definition)[0] for definition in definitions.values())
    assert count <= 100 and depth <= 5, (count, depth)


def test_chat_research_caps_words_and_attributes_evidence(monkeypatch, tmp_path):
    with TestClient(create_app(tmp_path)) as c:
        c.patch("/api/ai", json={"provider": "openai"})
        gateway = c.app.state.terminal.openai
        monkeypatch.setattr(gateway, "credentials", lambda: ("intercepted", "gpt-4.1-mini"))
        docs = [
            {
                "source": "Publisher",
                "text": f"Source {i}",
                "group": "company_news",
                "date": "2026-01-01",
                "url": f"https://example.org/{i}",
            }
            for i in range(3)
        ]

        def answer(*args):
            evidence = args[-2]["evidence"]
            return {
                "answer": "Downside remains possible. " + "More words " * 100,
                "citations": [x["ref"] for x in evidence],
            }

        monkeypatch.setattr(gateway, "structured", answer)
        value = assistant.research_question(
            gateway, {"symbol": "XYZ", "evidence": docs}, "What is the risk?"
        )
        assert value["text"] == "Downside remains possible." and len(value["sources"]) == 2
        assert all(s in docs for s in value["sources"])


def test_initial_transcript_is_atomic_and_lost_response_can_be_retried(tmp_path):
    key = str(uuid4())
    path = BASE + "/" + key
    copy = {
        "id": key,
        "title": "Recovered copy",
        "entries": [{"id": 1, "role": "user", "text": "My turn"}],
        "context": [{"role": "user", "text": "My turn"}],
    }
    with TestClient(create_app(tmp_path)) as c:
        first = c.post(BASE, json=copy)
        assert first.status_code == 201 and c.get(path).json() == first.json()
        assert (
            first.json()["entries"] == copy["entries"]
            and first.json()["context"] == copy["context"]
        )
        assert c.get(BASE).json()[0]["title"] == copy["title"]
        assert c.post(BASE, json=copy).json() == first.json()
        assert len(c.get(BASE).json()) == 1
        # Another window edits the copy before the original browser retries a lost create response.
        renamed = c.patch(path, json={"revision": 0, "title": "Edited copy"}).json()
        assert c.post(BASE, json=copy).json() == renamed
        assert c.post(BASE, json={**copy, "entries": []}).status_code == 409
        assert c.get(path).json() == renamed
        # Legacy callers can retry an idempotent empty creation with the same ID.
        assert c.post(BASE, json={"id": key, "title": "Old client"}).json() == renamed
        for entries in [
            [
                {
                    "id": 1,
                    "role": "user",
                    "text": "x",
                    "data": {"secret": "sk-this-must-not-hit-storage"},
                }
            ],
            [
                {"id": 1, "role": "user", "text": "a"},
                {"id": 1, "role": "user", "text": "b"},
            ],
        ]:
            other = str(uuid4())
            assert c.post(BASE, json={**copy, "id": other, "entries": entries}).status_code == 422
            assert c.get(BASE + "/" + other).status_code == 404
