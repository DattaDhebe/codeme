"""First-run setup tests never install runtimes or download real model weights."""

import asyncio
import json
import threading

import httpx
import pytest
from fastapi.testclient import TestClient

import main
from codeme_agent import model_setup as setup


DEFAULT = "qwen2.5-coder:7b"


@pytest.fixture(autouse=True)
def isolated_settings(monkeypatch, tmp_path):
    monkeypatch.setattr(setup.model_catalog, "MODEL_CHOICE_PATH", tmp_path / ".runtime/model-choice.json")
    monkeypatch.setattr(setup.settings, "default_model", DEFAULT)
    monkeypatch.setattr(setup.settings, "model_provider", "ollama")
    monkeypatch.setattr(setup.settings, "auto_model_setup", False)
    monkeypatch.setattr(setup.settings, "ollama_url", "http://127.0.0.1:11434")
    monkeypatch.setattr(setup.subprocess, "Popen", lambda *args, **kwargs: pytest.fail("Unexpected runtime launch"))
    monkeypatch.setattr(setup.httpx, "stream", lambda *args, **kwargs: pytest.fail("Unexpected real model download"))
    monkeypatch.setattr(setup.httpx, "post", lambda *args, **kwargs: pytest.fail("Unexpected real HTTP request"))


class Client:
    def __init__(self, inventories):
        self.inventories = list(inventories)

    def list_models(self, timeout=5):
        result = self.inventories.pop(0) if len(self.inventories) > 1 else self.inventories[0]
        if isinstance(result, Exception):
            raise result
        return list(result)


def response(data, status=200):
    return httpx.Response(status, json=data, request=httpx.Request("POST", "http://127.0.0.1:11434"))


def install_client(monkeypatch, inventories):
    client = Client(inventories)
    monkeypatch.setattr(setup, "create_model_client", lambda: client)
    return client


def normal_post(monkeypatch, *, capabilities=None, warm_status=200):
    calls = []

    def post(url, **kwargs):
        assert kwargs["trust_env"] is False
        assert kwargs["follow_redirects"] is False
        calls.append((url, kwargs))
        if url.endswith("/api/show"):
            model = kwargs["json"]["model"]
            return response({"capabilities": (capabilities or {}).get(model, ["completion", "tools"])})
        assert url.endswith("/api/generate")
        assert kwargs["json"]["prompt"] == ""
        assert kwargs["json"]["stream"] is False
        return response({"done": True}, warm_status)

    monkeypatch.setattr(setup.httpx, "post", post)
    return calls


class Pull:
    def __init__(self, events, manager=None):
        self.events = events
        self.manager = manager
        self.snapshots = []
        self.status_code = 200
        self.closed = False

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.closed = True

    def close(self):
        self.closed = True

    def iter_lines(self):
        for event in self.events:
            yield json.dumps(event) if not isinstance(event, str) else event
            if self.manager:
                self.snapshots.append(self.manager.status())


def test_installed_model_is_reused_without_downloading_and_warmed(monkeypatch):
    install_client(monkeypatch, [[DEFAULT]])
    calls = normal_post(monkeypatch)
    manager = setup.ModelSetup()
    manager._run()
    status = manager.status()
    assert status["state"] == "ready"
    assert status["model"] == DEFAULT
    assert status["available_models"] == [DEFAULT]
    assert status["auto_setup_enabled"] is False
    assert status["tool_support"] == "supported"
    assert status["agent_ready"] is True
    assert len(calls) == 2


def test_chat_only_model_stays_chat_ready_without_claiming_agent_support(monkeypatch):
    install_client(monkeypatch, [[DEFAULT]])
    normal_post(monkeypatch, capabilities={DEFAULT: ["completion"]})
    manager = setup.ModelSetup()
    manager._run()
    status = manager.status()
    assert status["state"] == "ready"
    assert status["model"] == DEFAULT
    assert status["agent_ready"] is False
    assert status["tool_support"] == "unsupported"


def test_existing_tool_model_is_selected_instead_of_downloading_default(monkeypatch):
    install_client(monkeypatch, [["code-small:latest", "llama:latest"]])
    normal_post(monkeypatch, capabilities={"code-small:latest": ["completion"], "llama:latest": ["completion", "tools"]})
    manager = setup.ModelSetup()
    manager._run()
    assert manager.status()["state"] == "ready"
    assert manager.status()["model"] == "llama:latest"
    assert setup.settings.default_model == "llama:latest"


def test_default_latest_alias_is_reused(monkeypatch):
    monkeypatch.setattr(setup.settings, "default_model", "coder")
    install_client(monkeypatch, [["coder:latest"]])
    normal_post(monkeypatch)
    manager = setup.ModelSetup()
    manager._run()
    assert manager.status()["model"] == "coder:latest"


def test_missing_model_downloads_with_layer_progress_then_warms(monkeypatch):
    install_client(monkeypatch, [[], [DEFAULT]])
    calls = normal_post(monkeypatch)
    manager = setup.ModelSetup()
    pull = Pull([
        {"status": "pulling manifest"},
        {"status": "pulling layer", "digest": "sha256:layer1", "total": 1000, "completed": 250},
        {"status": "pulling layer", "digest": "sha256:layer1", "total": 1000, "completed": 1000},
        {"status": "verifying sha256 digest"},
        {"status": "success"},
    ], manager)

    def stream(method, url, **kwargs):
        assert method == "POST" and url == "http://127.0.0.1:11434/api/pull"
        assert kwargs["json"] == {"model": DEFAULT, "stream": True}
        assert kwargs["trust_env"] is False and kwargs["follow_redirects"] is False
        return pull

    monkeypatch.setattr(setup.httpx, "stream", stream)
    manager._run()
    assert manager.status()["state"] == "ready"
    progress = pull.snapshots[1]
    assert progress["completed_bytes"] == 250
    assert progress["total_bytes"] == 1000
    assert progress["percent"] == 25
    assert progress["progress_scope"] == "layer"
    assert progress["state"] == "downloading"
    assert calls[-1][0].endswith("/api/generate")


def test_embedding_only_inventory_does_not_prevent_installing_coding_model(monkeypatch):
    install_client(monkeypatch, [["nomic-embed-text:latest"], ["nomic-embed-text:latest", DEFAULT]])
    normal_post(monkeypatch, capabilities={"nomic-embed-text:latest": ["embedding"]})
    monkeypatch.setattr(setup.httpx, "stream", lambda *args, **kwargs: Pull([{"status": "success"}]))
    manager = setup.ModelSetup()
    manager._run()
    assert manager.status()["model"] == DEFAULT


@pytest.mark.parametrize("desired", ["nomic-embed-text", "nomic-embed-text:latest"])
def test_installed_embedding_default_is_not_downloaded_or_warmed_again(monkeypatch, desired):
    monkeypatch.setattr(setup.settings, "default_model", desired)
    install_client(monkeypatch, [["nomic-embed-text:latest"]])
    calls = normal_post(monkeypatch, capabilities={"nomic-embed-text:latest": ["embedding"]})
    manager = setup.ModelSetup()
    monkeypatch.setattr(manager, "_pull", lambda *args: pytest.fail("Installed weights must not be downloaded again"))
    monkeypatch.setattr(manager, "_warm_ollama", lambda *args: pytest.fail("Embedding-only models must not be warmed for chat"))
    manager._run()
    assert manager.status()["state"] == "error"
    assert "text-generation coding model" in manager.status()["message"]
    assert setup.settings.default_model == desired
    assert len(calls) == 1 and calls[0][0].endswith("/api/show")


def test_installed_embedding_default_still_reuses_suitable_coding_fallback(monkeypatch):
    monkeypatch.setattr(setup.settings, "default_model", "nomic-embed-text")
    install_client(monkeypatch, [["nomic-embed-text:latest", DEFAULT]])
    calls = normal_post(monkeypatch, capabilities={"nomic-embed-text:latest": ["embedding"]})
    manager = setup.ModelSetup()
    monkeypatch.setattr(manager, "_pull", lambda *args: pytest.fail("A suitable installed fallback must be reused"))
    manager._run()
    assert manager.status()["state"] == "ready"
    assert manager.status()["model"] == DEFAULT
    assert setup.settings.default_model == DEFAULT
    assert calls[-1][0].endswith("/api/generate")
    assert calls[-1][1]["json"]["model"] == DEFAULT


@pytest.mark.parametrize("events", [
    [{"status": "pulling manifest"}],
    [{"error": "insufficient disk space"}],
    ["not-json"],
    [{"status": "pulling", "total": -1}],
    [{"status": "pulling", "completed": True}],
])
def test_broken_download_never_becomes_ready(monkeypatch, events):
    install_client(monkeypatch, [[]])
    monkeypatch.setattr(setup.httpx, "stream", lambda *args, **kwargs: Pull(events))
    manager = setup.ModelSetup()
    manager._run()
    assert manager.status()["state"] == "error"
    assert manager.status()["error"]
    assert manager.status()["can_retry"] is True


def test_success_message_without_installed_local_weights_is_not_ready(monkeypatch):
    install_client(monkeypatch, [[]])
    monkeypatch.setattr(setup.httpx, "stream", lambda *args, **kwargs: Pull([{"status": "success"}]))
    manager = setup.ModelSetup()
    manager._run()
    assert manager.status()["state"] == "error"
    assert "local weights" in manager.status()["message"]


@pytest.mark.parametrize("model", ["coder:cloud", "qwen:480b-cloud", "https://example.com/model", "../private", "-option", "a b"])
def test_unsafe_or_cloud_model_cannot_trigger_pull(monkeypatch, model):
    monkeypatch.setattr(setup.settings, "default_model", model)
    install_client(monkeypatch, [[]])
    manager = setup.ModelSetup()
    manager._run()
    assert manager.status()["state"] == "error"


def test_installed_but_unloadable_model_reports_memory_guidance(monkeypatch):
    install_client(monkeypatch, [[DEFAULT]])
    normal_post(monkeypatch, warm_status=500)
    manager = setup.ModelSetup()
    manager._run()
    assert manager.status()["state"] == "error"
    assert "smaller DEFAULT_MODEL" in manager.status()["message"]


def test_missing_runtime_returns_install_guidance_without_spawning(monkeypatch):
    install_client(monkeypatch, [setup.OllamaError("offline")])
    monkeypatch.setattr(setup, "find_ollama", lambda: None)
    manager = setup.ModelSetup()
    manager._run()
    assert manager.status()["state"] == "runtime_missing"
    assert "setup installer" in manager.status()["message"]


def test_existing_runtime_starts_with_local_host_cloud_disabled_and_no_shell(monkeypatch):
    captured = {}

    class Process:
        def poll(self):
            return None

    def spawn(arguments, **kwargs):
        captured.update(arguments=arguments, **kwargs)
        return Process()

    monkeypatch.setattr(setup, "find_ollama", lambda: "C:/Programs/Ollama/ollama.exe")
    monkeypatch.setattr(setup.subprocess, "Popen", spawn)
    monkeypatch.setattr(setup.OllamaClient, "list_models", lambda *args, **kwargs: [])
    manager = setup.ModelSetup()
    assert manager._start_daemon("http://127.0.0.1:11434") is True
    assert captured["arguments"] == ["C:/Programs/Ollama/ollama.exe", "serve"]
    assert captured["env"]["OLLAMA_HOST"] == "127.0.0.1:11434"
    assert captured["env"]["OLLAMA_NO_CLOUD"] == "1"
    assert captured["shell"] is False
    if setup.os.name == "nt":
        assert captured["creationflags"] == setup.subprocess.CREATE_NO_WINDOW


def test_nonstandard_ollama_endpoint_is_not_used_to_spawn_daemon(monkeypatch):
    monkeypatch.setattr(setup, "find_ollama", lambda: "ollama")
    manager = setup.ModelSetup()
    assert manager._start_daemon("https://127.0.0.1:11434/proxy") is False
    assert manager.status()["state"] == "server_unavailable"


def test_runtime_readiness_allows_slow_first_hardware_discovery(monkeypatch):
    from types import SimpleNamespace
    manager = setup.ModelSetup()
    manager._daemon = SimpleNamespace(poll=lambda: None)
    monkeypatch.setattr(setup, "find_ollama", lambda: "ollama")
    clock = iter([0.0, 0.0, 25.0])
    monkeypatch.setattr(setup, "monotonic", lambda: next(clock))
    monkeypatch.setattr(manager._cancel, "wait", lambda seconds: False)
    calls = []
    def inventory(*args, **kwargs):
        calls.append(True)
        if len(calls) == 1:
            raise setup.OllamaError("hardware discovery still starting")
        return []
    monkeypatch.setattr(setup.OllamaClient, "list_models", inventory)
    assert manager._start_daemon("http://127.0.0.1:11434") is True
    assert len(calls) == 2


def test_start_is_idempotent_and_cancelled_job_cannot_become_ready(monkeypatch):
    manager = setup.ModelSetup()
    entered = threading.Event()
    release = threading.Event()
    calls = []

    def blocked_run():
        calls.append(True)
        entered.set()
        release.wait(2)
        try:
            manager._check_cancelled()
        except setup.SetupCancelled:
            return
        manager._update(state="ready")

    monkeypatch.setattr(manager, "_run", blocked_run)
    manager.start()
    assert entered.wait(1)
    manager.start()
    assert len(calls) == 1
    assert manager.cancel()["state"] == "cancelled"
    release.set()
    manager._thread.join(2)
    assert manager.status()["state"] == "cancelled"
    assert manager.status()["can_retry"] is True


def test_compatible_server_reuses_local_inventory_and_performs_synthetic_warmup(monkeypatch):
    monkeypatch.setattr(setup.settings, "model_provider", "openai_compatible")

    class Compatible(Client):
        base_url = "http://127.0.0.1:1234/v1"

        def _require_local_model(self, model, timeout):
            assert model == "local-coder"

    monkeypatch.setattr(setup, "create_model_client", lambda: Compatible([["local-coder"]]))
    captured = {}

    def post(url, **kwargs):
        captured.update(url=url, **kwargs)
        return response({"choices": [{"message": {"content": "a"}, "finish_reason": "length"}]})

    monkeypatch.setattr(setup.httpx, "post", post)
    manager = setup.ModelSetup()
    manager._run()
    assert manager.status()["state"] == "ready"
    assert manager.status()["model"] == "local-coder"
    assert captured["url"] == "http://127.0.0.1:1234/v1/chat/completions"
    assert captured["json"]["messages"] == [{"role": "user", "content": " "}]
    assert captured["json"]["max_tokens"] == 1
    assert captured["trust_env"] is False and captured["follow_redirects"] is False


@pytest.mark.parametrize("data", [
    {"choices": [{}]},
    {"choices": [{"message": {"role": "user", "content": "hi"}, "finish_reason": "stop"}]},
    {"choices": [{"message": {"role": "assistant", "content": "hi"}, "finish_reason": "error"}]},
    {"choices": [{"message": {"content": 42}, "finish_reason": "stop"}]},
])
def test_compatible_model_check_rejects_malformed_success_responses(monkeypatch, data):
    monkeypatch.setattr(setup.settings, "model_provider", "openai_compatible")

    class Compatible(Client):
        base_url = "http://127.0.0.1:1234/v1"

        def _require_local_model(self, model, timeout):
            pass

    monkeypatch.setattr(setup, "create_model_client", lambda: Compatible([["local-coder"]]))
    monkeypatch.setattr(setup.httpx, "post", lambda *args, **kwargs: response(data))
    manager = setup.ModelSetup()
    manager._run()
    assert manager.status()["state"] == "error"
    assert setup.settings.default_model == DEFAULT


def test_find_runtime_uses_known_install_path_when_parent_path_is_stale(tmp_path, monkeypatch):
    executable = tmp_path / "ollama"
    executable.write_text("installed runtime placeholder")
    monkeypatch.setattr(setup.shutil, "which", lambda name: None)
    monkeypatch.delenv("LOCALAPPDATA", raising=False)
    monkeypatch.setattr(setup, "OLLAMA_FALLBACK_PATHS", (str(executable),))
    assert setup.find_ollama() == str(executable)


@pytest.mark.parametrize("inventory,state", [([], "error"), (setup.OllamaError("offline"), "server_unavailable")])
def test_compatible_setup_requires_server_loaded_model_without_downloading(monkeypatch, inventory, state):
    monkeypatch.setattr(setup.settings, "model_provider", "openai_compatible")
    install_client(monkeypatch, [inventory])
    manager = setup.ModelSetup()
    manager._run()
    assert manager.status()["state"] == state
    assert "Ollama" in manager.status()["message"]


def test_setup_routes_are_passive_until_explicit_start_even_when_opted_out(monkeypatch):
    import main
    from codeme_agent import routers
    manager = setup.ModelSetup()
    called = []
    monkeypatch.setattr(manager, "start", lambda: called.append(True) or {"state": "checking"})
    monkeypatch.setattr(routers, "model_setup", manager)
    client = TestClient(main.app, base_url="http://127.0.0.1", client=("127.0.0.1", 50000))
    assert client.get("/api/model-setup").json()["auto_setup_enabled"] is False
    assert called == []
    assert client.post("/api/model-setup").json()["state"] == "checking"
    assert called == [True]
    assert client.delete("/api/model-setup").json()["state"] == "idle"


def test_readiness_refresh_is_cached_and_never_starts_another_generation(monkeypatch):
    now = [100.0]
    monkeypatch.setattr(setup, "monotonic", lambda: now[0])
    install_client(monkeypatch, [[DEFAULT]])
    calls = normal_post(monkeypatch)
    manager = setup.ModelSetup()
    manager._run()
    monkeypatch.setattr(setup, "create_model_client", lambda: pytest.fail("Readiness should remain cached for five seconds"))
    now[0] = 104.9
    assert manager.status(refresh=True)["state"] == "ready"
    install_client(monkeypatch, [[DEFAULT]])
    now[0] = 106.0
    assert manager.status(refresh=True)["state"] == "ready"
    assert len(calls) == 2  # /show and original warmup only; no extra inference.


def test_passive_readiness_detects_stopped_daemon_without_restarting(monkeypatch):
    install_client(monkeypatch, [[DEFAULT]])
    normal_post(monkeypatch)
    manager = setup.ModelSetup()
    manager._run()
    manager._ready_checked_at = -10
    install_client(monkeypatch, [setup.OllamaError("offline")])
    state = manager.status(refresh=True)
    assert state["state"] == "server_unavailable"
    assert state["available_models"] == []
    assert "Retry" in state["message"]


def test_passive_readiness_detects_removed_model_without_downloading(monkeypatch):
    install_client(monkeypatch, [[DEFAULT]])
    normal_post(monkeypatch)
    manager = setup.ModelSetup()
    manager._run()
    manager._ready_checked_at = -10
    install_client(monkeypatch, [[]])
    state = manager.status(refresh=True)
    assert state["state"] == "idle"
    assert state["model"] is None
    assert state["available_models"] == []


@pytest.mark.parametrize("enabled", [True, False])
def test_startup_honors_automatic_setup_setting_and_shutdown_cleans_up(monkeypatch, enabled):
    import main
    calls = []
    monkeypatch.setattr(main.settings, "auto_model_setup", enabled)
    monkeypatch.setattr(main, "initialize_database", lambda engine: None)
    monkeypatch.setattr(main.model_setup, "start", lambda: calls.append("start"))
    monkeypatch.setattr(main.model_setup, "shutdown", lambda: calls.append("shutdown"))

    async def run():
        async with main.lifespan(main.app):
            assert calls == (["start"] if enabled else [])

    asyncio.run(run())
    assert calls == (["start", "shutdown"] if enabled else ["shutdown"])
