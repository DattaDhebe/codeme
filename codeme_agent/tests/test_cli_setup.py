"""The installer tests never install software, run a server model, or download weights."""

import functools
from pathlib import Path
import threading
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import pytest

import codeme_cli as cli


@pytest.mark.parametrize("version,supported", [
    ("v18.20.8", False), ("v20.18.1", False), ("v20.19.0", True),
    ("v22.11.0", False), ("v22.12.0", True), ("v24.0.0", True),
    ("v24.14.1", True), ("v26.0.0", False),
])
def test_installer_requires_an_angular_supported_node_runtime(monkeypatch, version, supported):
    monkeypatch.setattr(cli, "executable", lambda name: name)
    monkeypatch.setattr(cli.subprocess, "check_output", lambda *a, **k: version)
    if supported:
        assert cli.require_node() == "npm"
    else:
        with pytest.raises(cli.SetupError, match="Node.js 24 LTS"):
            cli.require_node()


def test_existing_ollama_does_not_reinstall(monkeypatch):
    monkeypatch.setattr(cli, "executable", lambda name: "/installed/ollama")
    monkeypatch.setattr(cli, "run", lambda *a, **k: pytest.fail("Existing runtime must be reused"))
    cli.install_ollama()


def test_windows_installer_uses_exact_package_and_no_shell(monkeypatch):
    calls = []
    monkeypatch.setattr(cli.platform, "system", lambda: "Windows")
    installed = [False]
    monkeypatch.setattr(cli, "executable", lambda name: "winget.exe" if name == "winget" else "ollama.exe" if installed[0] else None)
    def run(args):
        calls.append(args)
        installed[0] = True
    monkeypatch.setattr(cli, "run", run)
    cli.install_ollama()
    assert calls[0][:6] == ["winget.exe", "install", "--id", "Ollama.Ollama", "--exact", "--source"]
    assert "--silent" in calls[0]


def test_missing_package_manager_gives_actionable_recovery(monkeypatch):
    monkeypatch.setattr(cli.platform, "system", lambda: "Windows")
    monkeypatch.setattr(cli, "executable", lambda name: None)
    with pytest.raises(cli.SetupError, match="winget"):
        cli.install_ollama()


def test_install_preserves_env_and_skips_ollama_for_compatible_provider(tmp_path, monkeypatch):
    (tmp_path / ".env").write_text("MODEL_PROVIDER=openai_compatible\nDEFAULT_MODEL=my-model\n")
    monkeypatch.setattr(cli, "ROOT", tmp_path)
    monkeypatch.setattr(cli, "venv_python", lambda: Path(__file__))
    monkeypatch.setattr(cli, "require_node", lambda: "npm")
    monkeypatch.setattr(cli, "ensure_pip", lambda python: None)
    monkeypatch.setattr(cli, "backend_settings", lambda python: {"provider": "openai_compatible"})
    monkeypatch.setattr(cli, "install_ollama", lambda: pytest.fail("Must preserve other local providers"))
    monkeypatch.setattr(cli, "launch", lambda **k: pytest.fail("--no-launch must not start model setup"))
    monkeypatch.setattr(cli, "executable", lambda name: name)
    calls = []
    monkeypatch.setattr(cli, "run", lambda args, **kwargs: calls.append(args))
    assert cli.install_main(["--no-launch"]) == 0
    assert (tmp_path / ".env").read_text() == "MODEL_PROVIDER=openai_compatible\nDEFAULT_MODEL=my-model\n"
    assert calls[-1] == ["npm", "run", "build"]


def test_interrupted_install_repairs_missing_pip(monkeypatch):
    from types import SimpleNamespace
    calls = []
    monkeypatch.setattr(cli.subprocess, "run", lambda *args, **kwargs: SimpleNamespace(returncode=1))
    monkeypatch.setattr(cli, "run", lambda arguments: calls.append(arguments))
    cli.ensure_pip("venv-python")
    assert calls == [["venv-python", "-m", "ensurepip", "--upgrade"]]


def test_complete_environment_reuses_existing_pip(monkeypatch):
    from types import SimpleNamespace
    monkeypatch.setattr(cli.subprocess, "run", lambda *args, **kwargs: SimpleNamespace(returncode=0))
    monkeypatch.setattr(cli, "run", lambda *args: pytest.fail("Must reuse working pip"))
    cli.ensure_pip("venv-python")


def test_owned_backend_gets_graceful_shutdown_before_forced_termination():
    calls = []
    class Process:
        def poll(self):
            return None
        def send_signal(self, value):
            calls.append("graceful signal")
        def wait(self, timeout):
            calls.append(("wait", timeout))
            return 0
        def terminate(self):
            pytest.fail("FastAPI should be allowed to clean up its owned model daemon")
        def kill(self):
            pytest.fail("A responsive service must not be killed")
    cli.stop_owned_backend(Process())
    assert calls == ["graceful signal", ("wait", 10)]


def test_owned_backend_shutdown_has_bounded_forced_fallback(monkeypatch):
    calls = []
    class Process:
        def poll(self):
            return None
        def send_signal(self, value):
            calls.append("signal")
        def wait(self, timeout):
            calls.append(("wait", timeout))
            if calls[-2] != "kill":
                raise cli.subprocess.TimeoutExpired("uvicorn", timeout)
        def terminate(self):
            calls.append("terminate")
        def kill(self):
            calls.append("kill")
    monkeypatch.setattr(cli, "terminate_owned_backend", lambda process: process.terminate())
    cli.stop_owned_backend(Process())
    assert calls == ["signal", ("wait", 10), "terminate", ("wait", 5), "kill", ("wait", 5)]


def test_already_exited_backend_is_not_signalled():
    class Process:
        def poll(self):
            return 0
        def send_signal(self, value):
            pytest.fail("Exited processes must not be signalled")
    cli.stop_owned_backend(Process())


def test_detached_windows_backend_has_bounded_termination_when_console_signal_fails(monkeypatch):
    calls = []
    class Process:
        def poll(self): return None
        def send_signal(self, value): raise SystemError("No attached console")
        def terminate(self): calls.append("terminate")
        def wait(self, timeout): calls.append(("wait", timeout)); return 0
    monkeypatch.setattr(cli, "terminate_owned_backend", lambda process: process.terminate())
    cli.stop_owned_backend(Process())
    assert calls == ["terminate", ("wait", 10)]


def test_windows_ctrl_break_uses_normal_launcher_cleanup_and_restores_handler(monkeypatch):
    calls = []
    monkeypatch.setattr(cli.platform, "system", lambda: "Windows")
    monkeypatch.setattr(cli.signal, "SIGBREAK", 21, raising=False)
    def install_signal(number, handler):
        calls.append((number, handler)); return cli.signal.SIG_DFL
    monkeypatch.setattr(cli.signal, "signal", install_signal)
    monkeypatch.setattr(cli, "launch", lambda **kwargs: 0)
    assert cli.start_main(["--no-browser"]) == 0
    assert calls == [(21, cli.signal.default_int_handler), (21, cli.signal.SIG_DFL)]


def test_windows_tree_fallback_targets_only_owned_process(monkeypatch):
    calls = []
    class Process:
        pid = 12345
        def poll(self): return 0
    monkeypatch.setattr(cli.platform, "system", lambda: "Windows")
    monkeypatch.setenv("SystemRoot", str(Path.cwd()))
    monkeypatch.setattr(cli.subprocess, "run", lambda arguments, **kwargs: calls.append((arguments, kwargs)))
    cli.terminate_owned_backend(Process())
    arguments, options = calls[0]
    assert Path(arguments[0]).is_absolute()
    assert Path(arguments[0]).parts[-2:] == ("System32", "taskkill.exe")
    assert arguments[1:] == ["/PID", "12345", "/T", "/F"]
    assert options["timeout"] == 10 and options["check"] is False


def test_settings_probe_never_reads_launcher_stdin_and_has_startup_deadline(monkeypatch, tmp_path):
    captured = {}
    def read(arguments, **options):
        captured.update(options)
        return '{"host":"127.0.0.1","port":8000}'
    monkeypatch.setattr(cli.subprocess, "check_output", read)
    assert cli.backend_settings("fixture-python", tmp_path)["port"] == 8000
    assert captured["stdin"] == cli.subprocess.DEVNULL and captured["timeout"] == 30


def test_browser_and_backend_port_conflict_fails_before_starting_services(tmp_path, monkeypatch):
    browser = tmp_path / "frontend/dist/frontend/browser"
    browser.mkdir(parents=True)
    (browser / "index.html").write_text("<h1>CodeMe</h1>")
    monkeypatch.setattr(cli, "ROOT", tmp_path)
    monkeypatch.setattr(cli, "venv_python", lambda: Path(__file__))
    monkeypatch.setattr(cli, "backend_settings", lambda *args: {"host": "127.0.0.1", "port": 4200})
    monkeypatch.setattr(cli.subprocess, "Popen", lambda *a, **k: pytest.fail("Invalid configuration must not start services"))
    with pytest.raises(cli.SetupError, match="reserved for the browser"):
        cli.launch(no_browser=True)


@pytest.fixture
def browser_server(tmp_path):
    (tmp_path / "index.html").write_text("<h1>CodeMe</h1>", encoding="utf8")
    (tmp_path / "app.js").write_text("// app", encoding="utf8")
    handler = functools.partial(cli.BrowserHandler, directory=str(tmp_path), backend_url="http://127.0.0.1:8123", model="my-coder")
    server = cli.LocalWebServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{server.server_port}"
    server.shutdown()
    server.server_close()
    thread.join(timeout=3)


def test_browser_launcher_serves_spa_routes_and_runtime_configuration(browser_server):
    import json
    with urlopen(Request(browser_server + "/settings", headers={"Host": "127.0.0.1:4200"})) as response:
        assert response.read() == b"<h1>CodeMe</h1>"
    with urlopen(Request(browser_server + "/runtime-config.json", headers={"Host": "127.0.0.1:4200"})) as response:
        assert json.load(response) == {"backendUrl": "http://127.0.0.1:8123", "defaultModel": "my-coder"}
        assert response.headers["Cache-Control"] == "no-store"


def test_browser_launcher_rejects_foreign_host_and_missing_assets(browser_server):
    with pytest.raises(HTTPError) as foreign:
        urlopen(Request(browser_server + "/", headers={"Host": "attacker.example"}))
    assert foreign.value.code == 403
    with pytest.raises(HTTPError) as missing:
        urlopen(Request(browser_server + "/missing.js", headers={"Host": "127.0.0.1:4200"}))
    assert missing.value.code == 404
