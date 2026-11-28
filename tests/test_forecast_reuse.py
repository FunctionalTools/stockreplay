"""The normal forecast API joins concurrent requests and retains valid local results."""

import json
import threading
import zlib
from concurrent.futures import Future, ThreadPoolExecutor
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from stockreplay import ai_forecasts, openai_research
from stockreplay.api import create_app

ADDRESS = "/api/desk/forecast/SNDK?range=1mo"
AUTO = ADDRESS + "&auto=true"


@pytest.fixture
def state(tmp_path, monkeypatch):
    control = SimpleNamespace(
        calls=0,
        quote=85.36,
        as_of="2026-11-27",
        article="Sandisk announces results",
        fetched="2026-11-27T14:00:00Z",
        score=None,
        fail=False,
        block_first=False,
        entered=threading.Event(),
        release=threading.Event(),
    )

    def baseline(*args, **kwargs):
        return {
            "data_digest": "history",
            "as_of": control.as_of,
            "points": [{"date": control.as_of, "median": control.quote}],
        }

    def evidence(*args):
        return [
            {
                "id": "S1",
                "title": control.article,
                "date_basis": "retrieved",
                "date": control.fetched,
                "checked_at": control.fetched,
            }
        ], {}

    def generate(
        terminal, symbol, preset, start, end, *, gateway, credentials, base, saved_score, **kwargs
    ):
        control.calls += 1
        request_number = control.calls
        if control.block_first and request_number == 1:
            control.entered.set()
            assert control.release.wait(10)
        if control.fail:
            raise HTTPException(429, "Model capacity reached. Try again shortly.")
        return {
            "id": str(request_number),
            "provider": gateway.provider,
            "model": credentials[1],
            "quote": base["points"][0]["median"],
            "as_of": base["as_of"],
            "score": saved_score,
            "symbol": symbol,
            "range": preset,
        }

    monkeypatch.setattr(ai_forecasts, "load_projection", baseline)
    monkeypatch.setattr(ai_forecasts, "evidence_packet", evidence)
    monkeypatch.setattr(ai_forecasts, "generate", generate)
    monkeypatch.setattr(ai_forecasts, "forecast_score", lambda *args: control.score)
    # Simulate two independently stored credentials. The actual Keychain may be locked
    # while the app starts; GET /ai and fetching a saved snapshot never read a password.
    remembered = {}
    keyring = SimpleNamespace(
        get_password=lambda service, account: remembered.get((service, account)),
        set_password=lambda service, account, key: remembered.update({(service, account): key}),
        delete_password=lambda service, account: remembered.pop((service, account)),
    )
    control.remembered = remembered
    monkeypatch.setattr(openai_research, "keychain", lambda: keyring)

    def new_app():
        app = create_app(tmp_path)
        t = app.state.terminal
        monkeypatch.setattr(
            t.ai.ollama, "models", lambda: {"models": [{"id": "test-local-model"}], "running": True}
        )
        monkeypatch.setattr(
            t.ai.ollama,
            "credentials",
            lambda: (None, "test-local-model"),
        )
        return app

    setting_up = new_app().state.terminal.ai
    for gateway in (setting_up.openai, setting_up.ollama_cloud):
        monkeypatch.setattr(
            gateway, "check_connection", lambda key, model: {"verified_at": "2026-11-27T00:00:00Z"}
        )
        gateway.set(
            openai_research.KeySettings(
                key="test-forecast-remembered-key", model=gateway.config()[0], remember=True
            )
        )
    return new_app(), control, new_app


def forecast(response):
    return response.raise_for_status().json()["forecast"]


@pytest.mark.parametrize("provider", ["openai", "ollama_cloud", "ollama"])
def test_auto_reuses_across_reload_and_restart_with_selected_provider(state, provider):
    app, control, new_app = state
    with TestClient(app) as c:
        selection = c.patch("/api/ai", json={"provider": provider}).raise_for_status().json()
        if provider != "ollama":
            assert selection["configured"] and not selection["verified"]
            assert selection["generation_ready"]
            assert selection["storage"] == "macOS Keychain"
        first = forecast(c.post(AUTO))
        assert first["provider"] == provider and forecast(c.post(AUTO)) == first
        assert c.get("/api/ai").json()["revision"] == selection["revision"]
    with TestClient(new_app()) as c:
        assert forecast(c.get(ADDRESS)) == first and forecast(c.post(AUTO)) == first
        assert control.calls == 1


def test_stale_tab_or_externally_replaced_key_never_dispatches_generation(state):
    app, control, _ = state
    with TestClient(app) as c:
        expected = (
            c.patch("/api/ai", json={"provider": "openai"}).raise_for_status().json()["revision"]
        )
        assert c.post(AUTO + f"&revision={expected - 1}").status_code == 409
        keychain = app.state.terminal.openai
        control.remembered[(keychain.keychain_service, keychain.account)] = "a-different-opaque-key"
        assert c.post(AUTO).status_code == 409 and control.calls == 0
        assert not c.get("/api/ai").json()["generation_ready"]


def test_price_evidence_and_existing_scores_define_reuse(state):
    app, control, _ = state
    with TestClient(app) as c:
        first = forecast(c.post(AUTO))
        control.fetched = "2026-11-27T15:00:00Z"
        assert forecast(c.post(AUTO)) == first
        control.score = {"id": "research-1", "risk_score": 31, "buy_score": 62}
        assert forecast(c.post(AUTO))["score"] == control.score
        control.quote = 88
        assert forecast(c.post(AUTO))["quote"] == 88
        control.article = "Sandisk updates its guidance"
        before_switch = forecast(c.post(AUTO))
        assert control.calls == 4
        c.patch("/api/ai", json={"provider": "openai"}).raise_for_status()
        assert forecast(c.post(AUTO))["provider"] == "openai"
        c.patch("/api/ai", json={"provider": "ollama"}).raise_for_status()
        assert forecast(c.post(AUTO)) == before_switch
        assert forecast(c.get(ADDRESS)) == before_switch and control.calls == 5


def test_switching_models_keeps_each_models_matching_forecast(state, monkeypatch):
    app, control, _ = state
    ai = app.state.terminal.ai
    monkeypatch.setattr(
        ai.ollama, "credentials", lambda: (None, ai.ollama.settings() or "model-one")
    )
    with TestClient(app) as c:
        first = forecast(c.post(AUTO))
        ai.activate_verified("ollama", ai.revision(), "model-two")
        second = forecast(c.post(AUTO))
        assert first["model"] == "model-one" and second["model"] == "model-two"
        ai.activate_verified("ollama", ai.revision(), "model-one")
        assert forecast(c.post(AUTO)) == first and control.calls == 2


def test_updated_forecast_protocol_refreshes_matching_archive_once(state, monkeypatch):
    app, control, _ = state
    with TestClient(app) as c:
        old = forecast(c.post(AUTO))
        next_version = old["forecast_protocol_version"] + 1
        monkeypatch.setattr(ai_forecasts, "FORECAST_PROTOCOL_VERSION", next_version)
        updated = forecast(c.post(AUTO))
        assert updated["id"] != old["id"] and updated["forecast_protocol_version"] == next_version
        assert forecast(c.post(AUTO)) == updated and control.calls == 2


@pytest.mark.parametrize("provider", ["openai", "ollama_cloud"])
def test_remembered_generation_failure_and_successful_retest_survive_restart(state, provider):
    app, control, reopen = state
    gateway = getattr(app.state.terminal.ai, provider)
    gateway.mark_verified(*gateway.credentials(), None, "Model access denied.")
    with TestClient(reopen()) as c:
        old = c.patch("/api/ai", json={"provider": provider}).raise_for_status().json()
        assert old["configured"] and not old["generation_ready"]
        assert old["generation_detail"] == "Model access denied."
        assert c.post(AUTO).status_code == 409 and control.calls == 0
        current = c.app.state.terminal.ai.active()
        current.mark_verified(*current.credentials(), "2026-11-28T00:00:00Z")
    with TestClient(reopen()) as c:
        readiness = c.get("/api/ai").json()
        assert readiness["generation_ready"] and "generation_detail" not in readiness
        assert forecast(c.post(AUTO))["provider"] == provider
        assert control.calls == 1


def test_auto_and_explicit_join_pending_then_completed_auto_reuses(state, monkeypatch):
    app, control, _ = state
    control.block_first = True
    joined = threading.Event()

    class Joined(Future):
        def result(self, *args, **kwargs):
            joined.set()
            return super().result(*args, **kwargs)

    monkeypatch.setattr(ai_forecasts, "Future", Joined)
    with TestClient(app) as c, ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(c.post, AUTO)
        assert control.entered.wait(10)
        second = pool.submit(c.post, ADDRESS)
        assert joined.wait(10)
        control.release.set()
        result = forecast(first.result())
        assert forecast(second.result()) == forecast(c.post(AUTO)) == result
    assert control.calls == 1


def test_earlier_model_or_observation_cannot_overwrite_latest(state):
    app, control, _ = state
    control.block_first = True
    with TestClient(app) as c, ThreadPoolExecutor(max_workers=1) as pool:
        older = pool.submit(c.post, AUTO)
        assert control.entered.wait(10)
        control.quote = 92
        current = forecast(c.post(AUTO))
        control.release.set()
        assert older.result().status_code == 409
        assert forecast(c.get(ADDRESS)) == current and current["quote"] == 92


def test_feed_regression_keeps_more_recent_observation_without_spending_again(state):
    app, control, _ = state
    with TestClient(app) as c:
        actual = forecast(c.post(AUTO))
        control.as_of = "2026-11-25"
        assert c.post(AUTO).status_code == 409
        assert c.post(ADDRESS).status_code == 409
        assert forecast(c.get(ADDRESS)) == actual and control.calls == 1


def test_key_change_during_generation_cannot_overwrite_new_credentials(state):
    app, control, _ = state
    control.block_first = True
    with TestClient(app) as c, ThreadPoolExecutor(max_workers=1) as pool:
        c.patch("/api/ai", json={"provider": "openai"}).raise_for_status()
        old = pool.submit(c.post, AUTO)
        assert control.entered.wait(10)
        # The selected model can stay identical when the user saves a replacement credential.
        app.state.terminal.ai.activate_verified("openai", app.state.terminal.ai.revision())
        fresh = forecast(c.post(AUTO))
        control.release.set()
        assert old.result().status_code == 409
        assert forecast(c.get(ADDRESS)) == fresh and control.calls == 2


def test_automatic_failure_cooldown_and_explicit_retry_keep_saved_report(state):
    app, control, _ = state
    with TestClient(app) as c:
        old = forecast(c.post(AUTO))
        control.quote = 102
        control.fail = True
        a, b = c.post(AUTO), c.post(AUTO)
        assert a.status_code == b.status_code == 429 and a.json() == b.json()
        assert forecast(c.get(ADDRESS)) == old and control.calls == 2
        control.fail = False
        fresh = forecast(c.post(ADDRESS))
        assert forecast(c.post(AUTO)) == fresh and fresh["id"] != old["id"]
        assert control.calls == 3


def test_legacy_snapshot_survives_unauthenticated_retry_and_first_new_forecast(state):
    app, control, _ = state
    former = {"id": "legacy-archive"}
    old_selection = json.dumps(["SNDK", "1mo", "None", "None"], separators=(",", ":"))
    with app.state.terminal.db.connect() as conn:
        conn.execute(
            "insert into future_forecasts values(?,?)",
            (old_selection, zlib.compress(json.dumps(former).encode())),
        )
    with TestClient(app) as c:
        assert forecast(c.get(ADDRESS)) == former
        c.patch("/api/ai", json={"provider": "ollama_cloud"}).raise_for_status()
        app.state.terminal.ai.ollama_cloud.generation_detail = (
            "Web search only. Choose another model."
        )
        assert c.post(AUTO).status_code == 409
        assert forecast(c.get(ADDRESS)) == former and control.calls == 0
        current = forecast(c.post(ADDRESS))
        assert current["id"] != former["id"] and forecast(c.get(ADDRESS)) == current


def test_legacy_model_with_newer_observation_survives_upgrade(state):
    app, control, _ = state
    old = {"as_of": "2026-11-27", "provider": "ollama", "model": "test-local-model", "id": "legacy"}
    ident = json.dumps(["SNDK", "1mo", "None", "None"], separators=(",", ":"))
    with app.state.terminal.db.connect() as c:
        c.execute(
            "insert into future_forecasts values(?,?)",
            (ident, zlib.compress(json.dumps(old).encode())),
        )
    control.as_of = "2026-11-25"
    with TestClient(app) as c:
        assert c.post(AUTO).status_code == 409
        assert forecast(c.get(ADDRESS)) == old and control.calls == 0
