"""Offline tests for the source-isolation and install-regression harness."""

import importlib.util
import json
from pathlib import Path

import pytest


path = Path(__file__).resolve().parents[2] / "scripts/install_smoke.py"
spec = importlib.util.spec_from_file_location("codeme_install_smoke", path)
smoke = importlib.util.module_from_spec(spec)
spec.loader.exec_module(smoke)


def source_tree(root):
    for name in smoke.ROOT_FILES:
        (root / name).write_text("application source", encoding="utf8")
    for name in smoke.SOURCE_DIRS:
        (root / name).mkdir()
    return root


def test_snapshot_never_copies_local_configuration_database_or_packages(tmp_path):
    (tmp_path / "original").mkdir()
    source = source_tree(tmp_path / "original")
    (source / ".env").write_text("PRIVATE=value")
    (source / "codeme.db").write_bytes(b"private database")
    (source / "frontend/node_modules").mkdir()
    (source / "frontend/node_modules/private.js").write_text("private package state")
    (source / "codeme_agent/__pycache__").mkdir()
    (source / "codeme_agent/__pycache__/old.pyc").write_bytes(b"bytecode")
    (source / "codeme_agent/app.py").write_text("print('source')")
    target = tmp_path / "copy"
    result = smoke.source_snapshot(source, target)
    assert not (target / ".env").exists()
    assert not (target / "codeme.db").exists()
    assert not (target / "frontend/node_modules").exists()
    assert not (target / "codeme_agent/__pycache__").exists()
    assert (target / "codeme_agent/app.py").read_text() == "print('source')"
    assert result["files"] > 0 and len(result["source_sha256"]) == 64
    assert (source / ".env").read_text() == "PRIVATE=value"


def test_snapshot_rejects_external_source_symlinks(tmp_path):
    source = tmp_path / "source"; source.mkdir(); source_tree(source)
    outside = tmp_path / "outside.py"; outside.write_text("private")
    try:
        (source / "codeme_agent/link.py").symlink_to(outside)
    except OSError:
        pytest.skip("Symlink creation is unavailable for this account")
    with pytest.raises(ValueError, match="symlink"):
        smoke.source_snapshot(source, tmp_path / "copy")


def test_snapshot_excludes_nested_configuration_credentials_and_databases(tmp_path):
    source = tmp_path / "source"; source.mkdir(); source_tree(source)
    private = (".env.local", ".env.production", ".npmrc", ".netrc", ".pypirc", "secrets.pem",
               "credentials.json", "private_key.txt", "cache.sqlite3", "user.db-wal", "identity.key",
               "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", "id_rsa.pub", "known_hosts", "authorized_keys",
               "service-account.json", "token.json", "auth.json", "session.token", "session.secret", "vault.enc",
               "identity.asc", "identity.der", "identity.crt")
    for name in private:
        (source / "frontend" / name).write_text("sentinel-private-value")
    private_directories = ("secrets", ".azure", ".kube", ".docker", ".gcloud", ".aws", ".ssh", ".gnupg", ".config")
    for name in private_directories:
        (source / "frontend" / name).mkdir()
        (source / "frontend" / name / "nested.json").write_text("sentinel-private-value")
    (source / "frontend/package-lock.json").write_text('{"lockfileVersion":3}')
    target = tmp_path / "copy"
    smoke.source_snapshot(source, target)
    assert (target / ".env.example").exists()
    assert (target / "frontend/package-lock.json").exists()
    for name in (*private, *private_directories):
        assert not (target / "frontend" / name).exists()
    assert all(b"sentinel-private-value" not in path.read_bytes() for path in target.rglob("*") if path.is_file())


def test_snapshot_fingerprint_includes_configuration_template_and_harness(tmp_path, monkeypatch):
    source = tmp_path / "source"; source.mkdir(); source_tree(source)
    harness = tmp_path / "harness.py"; harness.write_text("first harness")
    monkeypatch.setattr(smoke, "__file__", str(harness))
    first = smoke.source_snapshot(source, tmp_path / "copy1")["source_sha256"]
    harness.write_text("second harness")
    second = smoke.source_snapshot(source, tmp_path / "copy2")["source_sha256"]
    (source / ".env.example").write_text("updated template")
    third = smoke.source_snapshot(source, tmp_path / "copy3")["source_sha256"]
    assert len({first, second, third}) == 3


def test_path_guard_rejects_workspace_root_and_escape(tmp_path):
    with pytest.raises(ValueError):
        smoke.inside(tmp_path, tmp_path)
    with pytest.raises(ValueError):
        smoke.inside(tmp_path / ".." / "outside", tmp_path)


def test_probe_refuses_unmarked_or_mismatched_user_tree(tmp_path):
    with pytest.raises(FileNotFoundError):
        smoke.validate_snapshot(tmp_path)
    (tmp_path / smoke.MARKER).write_text(json.dumps({"run_root": str(tmp_path.parent), "snapshot_root": str(tmp_path)}))
    with pytest.raises(ValueError, match="non-fixture"):
        smoke.validate_snapshot(tmp_path)


def test_isolation_drops_user_model_package_configuration_without_logging_secrets(tmp_path, monkeypatch):
    monkeypatch.setenv("DEFAULT_MODEL", "user-private-model")
    monkeypatch.setenv("DATABASE_URL", "sqlite:///private.db")
    monkeypatch.setenv("PIP_INDEX_URL", "https://user:secret@example.invalid")
    monkeypatch.setenv("NPM_CONFIG_REGISTRY", "https://private.invalid")
    private_keys = ("AWS_SECRET_ACCESS_KEY", "GITHUB_TOKEN", "NPM_TOKEN", "PYTHONPATH", "PYTHONHOME",
                    "NODE_OPTIONS", "VIRTUAL_ENV", "CONDA_PREFIX", "HTTP_PROXY", "HTTPS_PROXY")
    for key in private_keys:
        monkeypatch.setenv(key, "sentinel-private-value")
    env = smoke.isolated_environment(tmp_path)
    assert "DEFAULT_MODEL" not in env and "DATABASE_URL" not in env
    assert env["PIP_INDEX_URL"] == "https://pypi.org/simple"
    assert env["NPM_CONFIG_REGISTRY"] == "https://registry.npmjs.org"
    assert env["AUTO_MODEL_SETUP"] == "false"
    assert env["HOME"] == str(tmp_path / "home")
    assert "PATH" in env
    assert all(key not in env for key in private_keys)
    assert "sentinel-private-value" not in " ".join(env.values())
    assert Path(env["APPDATA"]).is_relative_to(tmp_path)
    assert Path(env["LOCALAPPDATA"]).is_relative_to(tmp_path)
    assert Path(env["XDG_CONFIG_HOME"]).is_relative_to(tmp_path)


def test_plan_does_not_install_or_create_snapshot(monkeypatch, capsys):
    monkeypatch.setattr(smoke, "source_snapshot", lambda *a: pytest.fail("Planning must be read-only"))
    assert smoke.main([]) == 0
    result = json.loads(capsys.readouterr().out)
    assert result["mode"] == "plan"
    assert "fresh virtualenv and browser build" in result["scenarios"]


def test_fixture_endpoints_are_local_and_cannot_be_used_for_runtime_autostart():
    from urllib.parse import urlsplit
    with smoke.fixture_daemon() as (_, url):
        assert urlsplit(url).hostname == "127.0.0.1"
        assert urlsplit(url).path == "/codeme-install-fixture"
        assert smoke.local_json(url + "/api/tags")["models"][0]["name"] == smoke.FIXTURE_MODEL


def test_owned_launcher_uses_headless_shutdown_and_records_closed_backend(tmp_path, monkeypatch):
    import socket
    captured = {}
    class Process:
        pid = 12345
        returncode = None
        def poll(self): return self.returncode
        def wait(self, timeout): self.returncode = 0; return 0
    def spawn(arguments, **kwargs):
        captured.update(arguments=arguments, **kwargs)
        return Process()
    monkeypatch.setattr(smoke.subprocess, "Popen", spawn)
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0)); port = listener.getsockname()[1]
    monkeypatch.setattr(smoke, "local_json", lambda url: {"backendUrl": f"http://127.0.0.1:{port}"})
    log = tmp_path / "launch.log"; log.write_text("Started server process [54321]\n")
    with smoke.launched_copy(tmp_path, {"PORT": str(port)}, log) as (_, identity):
        assert identity["backend_pid"] == 54321
    assert captured["start_new_session"] == (smoke.os.name != "nt")
    assert captured["stdin"] == smoke.subprocess.DEVNULL
    assert "runpy.run_path('start.py'" in captured["arguments"][-2]
    assert Path(captured["arguments"][-1]).exists()
    assert identity["launcher_exit_code"] == 0 and identity["backend_port_closed"] is True


def test_owned_launcher_timeout_uses_tree_fallback(tmp_path, monkeypatch):
    import socket
    stopped = []
    class Process:
        pid = 12345
        returncode = None
        def poll(self): return self.returncode
        def wait(self, timeout): raise smoke.subprocess.TimeoutExpired("owned launcher", timeout)
    process = Process()
    monkeypatch.setattr(smoke.subprocess, "Popen", lambda *a, **k: process)
    def stop(owned, *, tree):
        assert owned is process
        stopped.append(tree); owned.returncode = -9
    monkeypatch.setattr(smoke, "stop_process", stop)
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0)); port = listener.getsockname()[1]
    monkeypatch.setattr(smoke, "local_json", lambda url: {"backendUrl": f"http://127.0.0.1:{port}"})
    log = tmp_path / "launch.log"; log.write_text("Started server process [54321]\n")
    with pytest.raises(AssertionError, match="shut down cleanly"):
        with smoke.launched_copy(tmp_path, {"PORT": str(port)}, log):
            pass
    assert stopped == [True]


def test_missing_node_stops_before_any_install_or_configuration_write(monkeypatch, tmp_path):
    import codeme_cli as cli
    monkeypatch.setattr(cli, "ROOT", tmp_path)
    monkeypatch.setattr(cli, "executable", lambda name: None)
    monkeypatch.setattr(cli, "run", lambda *a, **k: pytest.fail("Missing tools must not install anything"))
    assert cli.install_main(["--no-launch"]) == 1
    assert not (tmp_path / ".env").exists() and not (tmp_path / ".venv").exists()


def test_macos_runtime_installer_uses_existing_package_manager_without_shell(monkeypatch):
    import codeme_cli as cli
    calls = []
    installed = [False]
    monkeypatch.setattr(cli.platform, "system", lambda: "Darwin")
    monkeypatch.setattr(cli, "executable", lambda name: "brew" if name == "brew" else "ollama" if installed[0] else None)
    def run(arguments):
        calls.append(arguments)
        installed[0] = True
    monkeypatch.setattr(cli, "run", run)
    cli.install_ollama()
    assert calls == [["brew", "install", "ollama"]]


def test_linux_official_installer_is_bounded_and_saved_before_execution(monkeypatch, tmp_path):
    import codeme_cli as cli
    installed = [False]
    monkeypatch.setattr(cli, "ROOT", tmp_path)
    monkeypatch.setattr(cli.platform, "system", lambda: "Linux")
    monkeypatch.setattr(cli, "executable", lambda name: "ollama" if installed[0] else None)
    class Response:
        def __enter__(self): return self
        def __exit__(self, *args): pass
        def read(self, limit):
            assert limit == 2_000_001
            return b"#!/bin/sh\n# controlled installer fixture\n"
    def download(url, timeout):
        assert url == "https://ollama.com/install.sh" and timeout == 60
        return Response()
    monkeypatch.setattr(cli.urllib.request, "urlopen", download)
    def run(arguments):
        assert arguments[0] == "sh"
        assert arguments[1].read_bytes().startswith(b"#!/bin/sh")
        assert arguments[1].resolve().is_relative_to(tmp_path.resolve())
        installed[0] = True
    monkeypatch.setattr(cli, "run", run)
    cli.install_ollama()
