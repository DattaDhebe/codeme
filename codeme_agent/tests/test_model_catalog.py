"""Optional model selection tests use synthetic inventories, never real weights."""

import json
import hashlib
import os
from pathlib import Path
import subprocess
import sys
import threading

from fastapi.testclient import TestClient
import httpx
import pytest

import main
from codeme_agent import model_catalog as catalog, model_client, model_setup as setup, routers


DEFAULT = "qwen2.5-coder:7b"
TARGET = "qwen3-coder-30b"
TARGET_MODEL = "qwen3-coder:30b"
SYSTEM_POPEN = subprocess.Popen


@pytest.fixture(autouse=True)
def isolated(monkeypatch, tmp_path):
    monkeypatch.setattr(catalog, "MODEL_CHOICE_PATH", tmp_path / ".runtime/model-choice.json")
    monkeypatch.setattr(setup.settings, "default_model", DEFAULT)
    monkeypatch.setattr(setup.settings, "model_provider", "ollama")
    monkeypatch.setattr(setup.settings, "auto_model_setup", False)
    monkeypatch.setattr(setup, "configured_default_model", DEFAULT)
    monkeypatch.setattr(setup.subprocess, "Popen", lambda *a, **k: pytest.fail("No runtime may launch during a catalog test"))
    monkeypatch.setattr(setup.httpx, "stream", lambda *a, **k: pytest.fail("No real download may run during a catalog test"))
    monkeypatch.setattr(setup.httpx, "post", lambda *a, **k: pytest.fail("No real inference may run during a catalog test"))


class Inventory:
    def __init__(self, models):
        self.models = list(models)
        self.calls = []
    def list_models(self, timeout=5):
        self.calls.append(timeout)
        return list(self.models)


def inventory(monkeypatch, models):
    client = Inventory(models)
    monkeypatch.setattr(setup, "create_model_client", lambda: client)
    monkeypatch.setattr(model_client, "create_model_client", lambda: client)
    return client


def synthetic_load(monkeypatch, manager):
    calls = []
    monkeypatch.setattr(manager, "_model_capabilities", lambda url, model: calls.append(("capabilities", model)) or ["completion", "tools"])
    monkeypatch.setattr(manager, "_warm_ollama", lambda url, model: calls.append(("load", model)))
    return calls


def finish(manager):
    manager._thread.join(2)
    assert not manager._thread.is_alive()
    return manager.status()


def api(monkeypatch, manager=None):
    monkeypatch.setattr(routers, "model_setup", manager or setup.ModelSetup())
    return TestClient(main.app, base_url="http://127.0.0.1", client=("127.0.0.1", 50000))


def test_catalog_is_passive_and_distinguishes_installed_candidates(monkeypatch):
    client = inventory(monkeypatch, [DEFAULT])
    manager = setup.ModelSetup()
    monkeypatch.setattr(manager, "start", lambda *a: pytest.fail("GET must not start setup"))
    response = api(monkeypatch, manager).get("/api/model-catalog")
    assert response.status_code == 200
    result = response.json()
    assert result["download_supported"] is True and result["inventory_available"] is True
    assert client.calls == [2]
    assert next(entry for entry in result["models"] if entry["id"] == TARGET)["installed"] is False
    assert next(entry for entry in result["models"] if entry["ollama_model"] == DEFAULT)["installed"] is True
    assert all(entry["hugging_face_url"].startswith("https://huggingface.co/") for entry in result["models"])
    assert all(entry["ollama_url"].startswith("https://ollama.com/library/") for entry in result["models"])
    assert all(entry["license"] == "Apache-2.0" and entry["validation_note"] for entry in result["models"])


def test_catalog_inventory_failure_is_unknown_not_a_forced_download(monkeypatch):
    class Unavailable:
        def list_models(self, timeout=2):
            raise setup.OllamaError("Unavailable")
    monkeypatch.setattr(model_client, "create_model_client", Unavailable)
    result = catalog.catalog_status(setup.ModelSetup().status())
    assert result["inventory_available"] is False
    assert all(entry["installed"] is None for entry in result["models"])
    assert result["inventory_error"]


def test_explicit_absent_model_is_pulled_instead_of_reusing_other_model(monkeypatch):
    client = inventory(monkeypatch, [DEFAULT])
    manager = setup.ModelSetup()
    calls = synthetic_load(monkeypatch, manager)
    def pull(url, model):
        calls.append(("pull", model)); client.models.append(model)
    monkeypatch.setattr(manager, "_pull", pull)
    manager.start(TARGET)
    result = finish(manager)
    assert result["state"] == "ready" and result["model"] == TARGET_MODEL
    assert result["catalog_id"] == TARGET and result["explicit_selection"] is True
    assert result["preference_saved"] is True
    assert calls == [("pull", TARGET_MODEL), ("capabilities", TARGET_MODEL), ("load", TARGET_MODEL)]
    assert setup.settings.default_model == TARGET_MODEL
    assert catalog.saved_model_choice(DEFAULT, "ollama").id == TARGET


def test_explicit_installed_model_is_reused_without_a_pull(monkeypatch):
    entry = catalog.get_model("qwen3-coder-next")
    inventory(monkeypatch, [DEFAULT, entry.ollama_model])
    manager = setup.ModelSetup()
    calls = synthetic_load(monkeypatch, manager)
    monkeypatch.setattr(manager, "_pull", lambda *a: pytest.fail("Installed chosen weights must be reused"))
    manager.start(entry.id)
    result = finish(manager)
    assert result["model"] == entry.ollama_model
    assert all(model == entry.ollama_model for _, model in calls)


def test_api_explicit_download_uses_existing_real_progress_and_empty_warmup(monkeypatch):
    client = inventory(monkeypatch, [DEFAULT])
    manager = setup.ModelSetup()
    calls, progress = [], []
    class Pull:
        status_code = 200
        def __enter__(self): return self
        def __exit__(self, *args): pass
        def iter_lines(self):
            yield json.dumps({"status": "pulling fixture layer", "total": 512, "completed": 128})
            progress.append(manager.status())
            client.models.append(TARGET_MODEL)
            yield json.dumps({"status": "success"})
    def stream(method, url, **kwargs):
        assert method == "POST" and url.endswith("/api/pull")
        assert kwargs["trust_env"] is False and kwargs["follow_redirects"] is False
        calls.append(("pull", kwargs["json"]))
        return Pull()
    def post(url, **kwargs):
        assert kwargs["trust_env"] is False and kwargs["follow_redirects"] is False
        assert kwargs["json"]["model"] == TARGET_MODEL
        if url.endswith("/api/show"):
            result = {"capabilities": ["completion", "tools"]}
        else:
            assert url.endswith("/api/generate") and kwargs["json"]["prompt"] == ""
            result = {"done": True}
        calls.append((url.rsplit("/", 1)[-1], kwargs["json"]))
        return httpx.Response(200, json=result)
    monkeypatch.setattr(setup.httpx, "stream", stream)
    monkeypatch.setattr(setup.httpx, "post", post)
    response = api(monkeypatch, manager).post("/api/model-setup", json={"catalog_id": TARGET})
    assert response.status_code == 200
    result = finish(manager)
    assert result["state"] == "ready" and result["model"] == TARGET_MODEL
    assert progress[0]["state"] == "downloading" and progress[0]["percent"] == 25.0
    assert progress[0]["catalog_id"] == TARGET
    assert calls[0] == ("pull", {"model": TARGET_MODEL, "stream": True})
    assert [name for name, _ in calls] == ["pull", "show", "generate"]


def test_failed_load_preserves_default_and_does_not_save_a_selection(monkeypatch):
    inventory(monkeypatch, [DEFAULT, TARGET_MODEL])
    manager = setup.ModelSetup()
    synthetic_load(monkeypatch, manager)
    monkeypatch.setattr(manager, "_warm_ollama", lambda *a: (_ for _ in ()).throw(setup.OllamaError("Not enough memory")))
    manager.start(TARGET)
    result = finish(manager)
    assert result["state"] == "error" and "memory" in result["error"]
    assert setup.settings.default_model == DEFAULT
    assert not catalog.MODEL_CHOICE_PATH.exists()


def test_cancelled_selection_retry_retains_exact_target(monkeypatch):
    client = inventory(monkeypatch, [DEFAULT])
    manager = setup.ModelSetup()
    synthetic_load(monkeypatch, manager)
    pulled = []
    def pull(url, model):
        pulled.append(model)
        if len(pulled) == 1:
            manager.cancel()
            raise setup.SetupCancelled()
        client.models.append(model)
    monkeypatch.setattr(manager, "_pull", pull)
    manager.start(TARGET)
    assert finish(manager)["state"] == "cancelled"
    assert not catalog.MODEL_CHOICE_PATH.exists()
    manager.start()  # Existing retry clients need not send the ID again.
    assert finish(manager)["state"] == "ready"
    assert pulled == [TARGET_MODEL, TARGET_MODEL]


def test_selection_save_failure_keeps_session_ready_with_visible_warning(monkeypatch):
    inventory(monkeypatch, [TARGET_MODEL])
    manager = setup.ModelSetup()
    synthetic_load(monkeypatch, manager)
    monkeypatch.setattr(catalog, "save_model_choice", lambda *a: (_ for _ in ()).throw(OSError("Read only")))
    manager.start(TARGET)
    result = finish(manager)
    assert result["state"] == "ready" and result["preference_saved"] is False
    assert "could not be saved" in result["message"]
    assert setup.settings.default_model == TARGET_MODEL


def test_active_selection_is_idempotent_and_different_selection_conflicts(monkeypatch):
    entered, release = threading.Event(), threading.Event()
    manager = setup.ModelSetup()
    calls = []
    def blocked():
        calls.append(True); entered.set(); release.wait(2)
    monkeypatch.setattr(manager, "_run", blocked)
    try:
        manager.start(TARGET)
        assert entered.wait(1)
        assert manager.start(TARGET)["catalog_id"] == TARGET
        with pytest.raises(setup.SetupConflict):
            manager.start("qwen25-coder-7b")
        assert len(calls) == 1 and manager.status()["catalog_id"] == TARGET
        manager.cancel()
        with pytest.raises(setup.SetupConflict):
            manager.start("qwen25-coder-7b")
    finally:
        release.set(); manager._thread.join(2)


@pytest.mark.parametrize("payload", [{"catalog_id": "https://example.com/model"}, {"catalog_id": "qwen3-coder:30b-cloud"}, {"catalog_id": "unknown-model"}])
def test_api_rejects_unreviewed_ids_without_starting_worker(monkeypatch, payload):
    manager = setup.ModelSetup()
    client = api(monkeypatch, manager)
    assert client.post("/api/model-setup", json=payload).status_code == 400
    assert manager._thread is None


def test_api_supports_existing_empty_posts_and_rejects_arbitrary_model_fields(monkeypatch):
    manager = setup.ModelSetup()
    called = []
    monkeypatch.setattr(manager, "start", lambda: called.append(True) or {"state": "checking"})
    client = api(monkeypatch, manager)
    assert client.post("/api/model-setup").status_code == 200
    assert client.post("/api/model-setup", json={}).status_code == 200
    assert client.post("/api/model-setup", json={"model": TARGET_MODEL}).status_code == 422
    assert called == [True, True]


def test_api_returns_conflict_without_replacing_running_target(monkeypatch):
    manager = setup.ModelSetup()
    def busy(catalog_id):
        raise setup.SetupConflict("Another model setup is active")
    monkeypatch.setattr(manager, "start", busy)
    response = api(monkeypatch, manager).post("/api/model-setup", json={"catalog_id": TARGET})
    assert response.status_code == 409


def test_compatible_provider_catalog_is_informational_and_rejects_install(monkeypatch):
    monkeypatch.setattr(setup.settings, "model_provider", "openai_compatible")
    inventory(monkeypatch, ["local-coder"])
    manager = setup.ModelSetup()
    client = api(monkeypatch, manager)
    result = client.get("/api/model-catalog").json()
    assert result["download_supported"] is False
    assert all(entry["installed"] is None and entry["active"] is False for entry in result["models"])
    assert client.post("/api/model-setup", json={"catalog_id": TARGET}).status_code == 400
    assert manager._thread is None


def test_saved_choice_contains_only_narrow_ids_and_respects_changed_configuration():
    catalog.save_model_choice(TARGET, DEFAULT)
    payload = json.loads(catalog.MODEL_CHOICE_PATH.read_text(encoding="utf8"))
    assert set(payload) == {"schema_version", "catalog_id", "configured_default_sha256"}
    assert DEFAULT not in json.dumps(payload)
    assert catalog.saved_model_choice(DEFAULT, "ollama").id == TARGET
    assert catalog.saved_model_choice("different-default", "ollama") is None
    assert catalog.saved_model_choice(DEFAULT, "openai_compatible") is None
    assert list(catalog.MODEL_CHOICE_PATH.parent.glob("*.tmp")) == []


@pytest.mark.parametrize("payload", ["not json", "[]", '{"schema_version":1,"catalog_id":"https://evil/model","configured_default_sha256":"wrong"}', '"huge"' * 1000])
def test_invalid_preferences_are_ignored(payload):
    catalog.MODEL_CHOICE_PATH.parent.mkdir()
    catalog.MODEL_CHOICE_PATH.write_text(payload, encoding="utf8")
    assert catalog.saved_model_choice(DEFAULT, "ollama") is None


def test_unreviewed_preference_id_is_ignored_even_with_valid_default_fingerprint():
    catalog.MODEL_CHOICE_PATH.parent.mkdir()
    payload = {"schema_version": 1, "catalog_id": "https://example.invalid/model",
               "configured_default_sha256": hashlib.sha256(DEFAULT.encode()).hexdigest()}
    catalog.MODEL_CHOICE_PATH.write_text(json.dumps(payload), encoding="utf8")
    assert catalog.saved_model_choice(DEFAULT, "ollama") is None


def test_preference_write_refuses_symlinked_state_directory(tmp_path):
    outside = tmp_path / "outside"
    outside.mkdir()
    try:
        catalog.MODEL_CHOICE_PATH.parent.symlink_to(outside, target_is_directory=True)
    except OSError:
        pytest.skip("Host does not permit creating test symlinks")
    with pytest.raises(OSError):
        catalog.save_model_choice(TARGET, DEFAULT)
    assert not list(outside.iterdir())


def test_saved_choice_is_applied_after_a_real_config_restart(monkeypatch, tmp_path):
    catalog.save_model_choice(TARGET, DEFAULT)
    # Use a child interpreter without importing/starting the application server.
    root = Path(__file__).resolve().parents[2]
    code = ("import sys; from pathlib import Path; sys.path.insert(0,sys.argv[1]); "
            "from codeme_agent import model_catalog; model_catalog.MODEL_CHOICE_PATH=Path(sys.argv[2]); "
            "from codeme_agent.config import settings; print(settings.default_model)")
    env = {**os.environ, "DEFAULT_MODEL": DEFAULT, "MODEL_PROVIDER": "ollama", "PYTHONDONTWRITEBYTECODE": "1"}
    args = [sys.executable, "-B", "-c", code, str(root), str(catalog.MODEL_CHOICE_PATH)]
    with monkeypatch.context() as process_check:
        process_check.setattr(subprocess, "Popen", SYSTEM_POPEN)
        selected = subprocess.check_output(args, cwd=tmp_path, env=env, text=True, timeout=15).strip()
        assert selected == TARGET_MODEL
        env["DEFAULT_MODEL"] = "user-changed-default"
        changed = subprocess.check_output(args, cwd=tmp_path, env=env, text=True, timeout=15).strip()
        assert changed == "user-changed-default"
