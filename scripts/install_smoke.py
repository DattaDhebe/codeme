"""Opt-in fresh-copy installation checks. Never installs an OS/model runtime.

The default command prints the plan. --run installs public Python/npm packages
only in a new source snapshot, then probes real CodeMe against a loopback fixture.
"""

from __future__ import annotations

import argparse
from contextlib import contextmanager
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import platform
import re
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from urllib.request import ProxyHandler, Request, build_opener


SOURCE = Path(__file__).resolve().parents[1]
ROOT_FILES = ("install.py", "start.py", "codeme_cli.py", "main.py", "requirements.txt", ".env.example", "alembic.ini")
SOURCE_DIRS = ("codeme_agent", "alembic", "frontend")
EXCLUDED = {".git", ".venv", "venv", "node_modules", ".runtime", ".angular", "dist", "__pycache__", ".pytest_cache", ".vscode", ".env", "codeme.db"}
PRIVATE_NAMES = {
    ".npmrc", ".netrc", "_netrc", ".pypirc", ".git-credentials", ".gitconfig", "credentials", "secrets",
    ".aws", ".ssh", ".gnupg", ".azure", ".kube", ".docker", ".gcloud", ".config",
    "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", "identity", "known_hosts", "authorized_keys",
    ".htpasswd", "service-account.json", "service_account.json", "token.json", "tokens.json", "auth.json",
}
PRIVATE_SUFFIXES = {".db", ".sqlite", ".sqlite3", ".log", ".pem", ".key", ".pfx", ".p12", ".jks", ".keystore",
                    ".crt", ".der", ".asc", ".enc", ".secret", ".token", ".pyc", ".pyo"}
MARKER = ".codeme-install-smoke.json"
FIXTURE_MODEL = "codeme-install-fixture:tiny"
LAUNCH_WRAPPER = """
import _thread, pathlib, runpy, sys, threading, time
stop_file = pathlib.Path(sys.argv[1])
def stop_on_request():
    while not stop_file.exists():
        time.sleep(.05)
    _thread.interrupt_main()
threading.Thread(target=stop_on_request, daemon=True).start()
sys.argv = ['start.py', '--no-browser']
runpy.run_path('start.py', run_name='__main__')
"""
SCENARIOS = (
    "fresh virtualenv and browser build", "installed model reuse", "interrupted pull and retry",
    "cancellation", "low-memory load failure", "installed relaunch without dependency access",
    "upgrade preserves configuration and conversations",
)


def inside(path: Path, root: Path) -> Path:
    resolved, boundary = path.resolve(), root.resolve()
    if resolved == boundary or not resolved.is_relative_to(boundary):
        raise ValueError(f"Expected a child of the smoke directory: {path}")
    return resolved


def source_snapshot(source: Path, target: Path) -> dict:
    """Copy only application source. Never follow links or copy local state."""
    source, target = source.resolve(), target.resolve()
    if source == target or source.is_relative_to(target):
        raise ValueError("Snapshot cannot overwrite or contain its source")
    target.mkdir(parents=True, exist_ok=False)
    digest = hashlib.sha256()
    copied = 0
    def copy_file(file: Path):
        nonlocal copied
        if file.is_symlink() or not file.resolve().is_relative_to(source):
            raise ValueError(f"Snapshot refuses a source symlink: {file.relative_to(source)}")
        relative = file.relative_to(source)
        destination = target / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        data = file.read_bytes()
        destination.write_bytes(data)
        digest.update(relative.as_posix().encode() + b"\0" + hashlib.sha256(data).digest())
        copied += 1
    for name in ROOT_FILES:
        copy_file(source / name)
    def excluded(name: str) -> bool:
        lowered = name.lower()
        return (lowered in EXCLUDED or lowered in PRIVATE_NAMES or lowered.startswith((".env", "id_rsa.", "id_dsa.", "id_ecdsa.", "id_ed25519."))
                or Path(lowered).suffix in PRIVATE_SUFFIXES
                or any(word in lowered for word in ("credential", "secret", "private-key", "private_key"))
                or lowered.endswith((".db-wal", ".db-shm", ".sqlite-wal", ".sqlite-shm")))
    for directory in SOURCE_DIRS:
        if (source / directory).is_symlink():
            raise ValueError("Snapshot refuses source directory symlinks")
        for current, directories, files in os.walk(source / directory, followlinks=False):
            directories[:] = sorted(name for name in directories if not excluded(name))
            for name in directories:
                if (Path(current) / name).is_symlink():
                    raise ValueError("Snapshot refuses source directory symlinks")
            for name in sorted(files):
                file = Path(current) / name
                if excluded(name):
                    continue
                copy_file(file)
    script_target = target / "scripts/install_smoke.py"
    script_target.parent.mkdir(exist_ok=True)
    script_data = Path(__file__).read_bytes()
    script_target.write_bytes(script_data)
    digest.update(b"scripts/install_smoke.py\0" + hashlib.sha256(script_data).digest())
    return {"files": copied + 1, "source_sha256": digest.hexdigest()}


def isolated_environment(run: Path, *, npm_cache: Path | None = None, pip_cache: Path | None = None) -> dict:
    # Preserve PATH/SystemRoot for explicitly installed tools, not user app settings
    # or package-manager authentication/configuration.
    allowed = {"PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "OS", "NUMBER_OF_PROCESSORS",
               "PROCESSOR_ARCHITECTURE", "PROCESSOR_IDENTIFIER", "PROCESSOR_LEVEL", "PROCESSOR_REVISION",
               "LANG", "LC_ALL", "LC_CTYPE"}
    env = {key: value for key, value in os.environ.items() if key.upper() in allowed}
    home, temporary = run / "home", run / "temp"
    home.mkdir(parents=True, exist_ok=True)
    temporary.mkdir(parents=True, exist_ok=True)
    empty_config = run / "empty.npmrc"
    empty_config.write_text("", encoding="utf8")
    global_config = run / "empty-global.npmrc"
    global_config.write_text("", encoding="utf8")
    appdata, localappdata = home / "AppData/Roaming", home / "AppData/Local"
    for directory in (appdata, localappdata, home / ".config", home / ".cache", home / ".local/share"):
        directory.mkdir(parents=True, exist_ok=True)
    env.update(HOME=str(home), USERPROFILE=str(home), TMPDIR=str(temporary), TEMP=str(temporary), TMP=str(temporary),
               APPDATA=str(appdata), LOCALAPPDATA=str(localappdata), XDG_CONFIG_HOME=str(home / ".config"),
               XDG_CACHE_HOME=str(home / ".cache"), XDG_DATA_HOME=str(home / ".local/share"),
               PYTHONDONTWRITEBYTECODE="1", PYTHONNOUSERSITE="1", PIP_CONFIG_FILE=os.devnull,
               PIP_INDEX_URL="https://pypi.org/simple", PIP_CACHE_DIR=str(pip_cache or run / "pip-cache"),
               NPM_CONFIG_USERCONFIG=str(empty_config), NPM_CONFIG_GLOBALCONFIG=str(global_config),
               NPM_CONFIG_CACHE=str(npm_cache or run / "npm-cache"),
               NPM_CONFIG_REGISTRY="https://registry.npmjs.org", NPM_CONFIG_AUDIT="false", NPM_CONFIG_FUND="false",
               AUTO_MODEL_SETUP="false", CI="true", NG_CLI_ANALYTICS="false")
    return env


def execute(arguments, cwd: Path, env: dict, log: Path, timeout: int):
    with log.open("ab") as output:
        output.write(("\n> " + " ".join(map(str, arguments)) + "\n").encode())
        process = subprocess.Popen(list(map(str, arguments)), cwd=cwd, env=env, stdout=output, stderr=output,
                                   creationflags=subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0,
                                   start_new_session=os.name != "nt")
        try:
            code = process.wait(timeout=timeout)
            if code:
                raise subprocess.CalledProcessError(code, arguments)
        except BaseException:
            stop_process(process, tree=True)
            raise


def snapshot_python(snapshot: Path) -> Path:
    return snapshot / ".venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")


def validate_snapshot(snapshot: Path) -> Path:
    snapshot = snapshot.resolve()
    marker = json.loads((snapshot / MARKER).read_text(encoding="utf8"))
    run = Path(marker["run_root"]).resolve()
    if snapshot != run / "source" or marker["snapshot_root"] != str(snapshot):
        raise ValueError("Refusing to probe a non-fixture source tree")
    inside(snapshot, run)
    return run


def local_json(url: str, payload=None):
    data = None if payload is None else json.dumps(payload).encode()
    request = Request(url, data=data, headers={"Content-Type": "application/json"} if data else {})
    with build_opener(ProxyHandler({})).open(request, timeout=3) as response:
        return json.load(response)


class ModelFixture:
    """Controlled protocol fixture, not a real model or registry download."""
    def __init__(self):
        self.installed = True
        self.mode = "complete"
        self.pull_calls = 0
        self.warm_calls = 0
        self.cached_bytes = 0
        self.release = threading.Event()


@contextmanager
def fixture_daemon():
    state = ModelFixture()
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass
        def send_json(self, data, status=200):
            body = json.dumps(data).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        def do_GET(self):
            if self.path != "/codeme-install-fixture/api/tags":
                self.send_json({"error": "unexpected fixture endpoint"}, 404)
                return
            self.send_json({"models": [{"name": FIXTURE_MODEL, "size": 1024, "digest": "f" * 64,
                                        "details": {"format": "gguf"}}] if state.installed else []})
        def do_POST(self):
            payload = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))))
            if payload.get("model") != FIXTURE_MODEL:
                self.send_json({"error": "unexpected fixture model"}, 400)
                return
            endpoint = self.path.removeprefix("/codeme-install-fixture")
            if endpoint == "/api/show":
                self.send_json({"capabilities": ["completion", "tools"]})
            elif endpoint == "/api/generate":
                state.warm_calls += 1
                self.send_json({"done": True} if state.mode != "low_memory" else {"error": "fixture insufficient memory"},
                               200 if state.mode != "low_memory" else 500)
            elif endpoint == "/api/pull":
                state.pull_calls += 1
                self.send_response(200)
                self.send_header("Content-Type", "application/x-ndjson")
                self.end_headers()
                try:
                    state.cached_bytes = max(256, state.cached_bytes)
                    self.wfile.write((json.dumps({"status": "pulling fixture layer", "total": 1024,
                                                 "completed": state.cached_bytes}) + "\n").encode())
                    self.wfile.flush()
                    if state.mode == "interrupted":
                        self.close_connection = True
                        return
                    if state.mode == "hold":
                        while not state.release.wait(.05):
                            self.wfile.write(b'\n')
                            self.wfile.flush()
                        return
                    state.cached_bytes = 1024
                    state.installed = True
                    self.wfile.write(b'{"status":"success"}\n')
                    self.wfile.flush()
                except (ConnectionError, OSError):
                    pass
            else:
                self.send_json({"error": "unexpected fixture endpoint"}, 404)
    class Server(ThreadingHTTPServer):
        daemon_threads = True
    server = Server(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        # A non-root configured path prevents CodeMe from starting an installed
        # real Ollama executable if the fixture becomes unavailable.
        yield state, f"http://127.0.0.1:{server.server_port}/codeme-install-fixture"
    finally:
        state.release.set()
        server.shutdown()
        server.server_close()
        thread.join(timeout=3)


def wait_setup(manager, states, timeout=10):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        status = manager.status()
        if status["state"] in states:
            return status
        time.sleep(.02)
    raise AssertionError(f"Setup did not reach {states}: {manager.status()}")


def wait_api_setup(backend: str, timeout=10):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        status = local_json(backend + "/api/model-setup")
        if status["state"] == "ready":
            return
        if status["state"] in {"error", "cancelled"}:
            raise AssertionError(f"Launched model setup failed: {status}")
        time.sleep(.05)
    raise AssertionError("Launched model setup did not become ready")


def stop_process(process, *, tree=False):
    if process.poll() is not None:
        return
    try:
        if tree and os.name != "nt":
            os.killpg(process.pid, signal.SIGINT)
        else:
            process.send_signal(signal.CTRL_BREAK_EVENT if os.name == "nt" else signal.SIGINT)
    except (OSError, ValueError, SystemError):
        process.terminate()
    try:
        process.wait(timeout=20)
    except subprocess.TimeoutExpired:
        if tree and os.name == "nt":
            subprocess.run([str(Path(os.environ.get("SystemRoot", "C:/Windows")) / "System32/taskkill.exe"),
                            "/PID", str(process.pid), "/T", "/F"], stdout=subprocess.DEVNULL,
                           stderr=subprocess.DEVNULL, check=False, timeout=10)
        elif tree:
            os.killpg(process.pid, signal.SIGKILL)
        if process.poll() is None:
            process.kill()
        process.wait(timeout=5)


@contextmanager
def launched_copy(snapshot: Path, env: dict, log: Path):
    with log.open("ab") as output:
        # The marker wrapper interrupts the real start.py main thread even on a
        # headless Windows host where console control events are unavailable.
        stop_file = inside(snapshot.parent / f"launcher-stop-{uuid.uuid4().hex}", snapshot.parent)
        process = subprocess.Popen([str(snapshot_python(snapshot)), "-B", "-c", LAUNCH_WRAPPER, str(stop_file)],
            cwd=snapshot, env=env, stdin=subprocess.DEVNULL, stdout=output, stderr=output,
            creationflags=subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0,
            start_new_session=os.name != "nt")
        identity = {"launcher_pid": process.pid}
        try:
            deadline = time.monotonic() + 45
            while time.monotonic() < deadline:
                if process.poll() is not None:
                    raise AssertionError(f"Isolated launcher exited: {process.returncode}; inspect {log}")
                try:
                    config = local_json("http://127.0.0.1:4200/runtime-config.json")
                    if config.get("backendUrl") == f"http://127.0.0.1:{env['PORT']}":
                        break
                except (OSError, ValueError):
                    pass
                time.sleep(.1)
            else:
                raise AssertionError("Isolated launcher did not become ready")
            matches = re.findall(r"Started server process \[(\d+)\]", log.read_text(encoding="utf8", errors="replace"))
            if not matches:
                raise AssertionError("Launcher must start a new owned backend, not reuse an existing server")
            identity["backend_pid"] = int(matches[-1])
            yield f"http://127.0.0.1:{env['PORT']}", identity
        finally:
            if process.poll() is None:
                try:
                    stop_file.touch(exist_ok=False)
                    process.wait(timeout=25)
                except (OSError, ValueError, subprocess.TimeoutExpired):
                    stop_process(process, tree=True)
            identity["launcher_exit_code"] = process.returncode
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                with socket.socket() as listener:
                    listener.settimeout(.25)
                    if listener.connect_ex(("127.0.0.1", int(env["PORT"]))) != 0:
                        identity["backend_port_closed"] = True
                        break
                time.sleep(.05)
            else:
                raise AssertionError("Owned backend survived launcher shutdown; restart proof is invalid")
            if process.returncode != 0:
                raise AssertionError(f"Launcher did not shut down cleanly: {process.returncode}")


def probe(snapshot: Path):
    run = validate_snapshot(snapshot)
    sys.path.insert(0, str(snapshot))
    from codeme_agent.config import settings
    from codeme_agent.model_setup import ModelSetup
    checks = []
    def passed(name, **evidence):
        checks.append({"name": name, "status": "passed", **evidence})
    with fixture_daemon() as (state, address):
        settings.model_provider, settings.ollama_url, settings.default_model = "ollama", address, FIXTURE_MODEL
        manager = ModelSetup()
        manager.start()
        assert wait_setup(manager, {"ready", "error"})["state"] == "ready"
        manager._thread.join(3)
        assert state.pull_calls == 0 and state.warm_calls == 1
        passed("installed_model_reused", pull_requests=0, load_requests=1, model_runtime="controlled HTTP fixture")

        state.installed, state.mode = False, "interrupted"
        manager = ModelSetup(); manager.start()
        failed = wait_setup(manager, {"error"})
        manager._thread.join(3)
        assert failed["percent"] == 25 and state.cached_bytes == 256
        state.mode = "complete"
        manager.start()
        assert wait_setup(manager, {"ready", "error"})["state"] == "ready"
        manager._thread.join(3)
        assert state.pull_calls == 2 and state.cached_bytes == 1024
        passed("interrupted_pull_retry", protocol_fixture=True, resumed_fixture_bytes=256)

        state.installed, state.mode = False, "hold"
        manager = ModelSetup(); manager.start()
        wait_setup(manager, {"downloading"})
        manager.cancel(); state.release.set(); manager._thread.join(5)
        assert manager.status()["state"] == "cancelled" and not manager._thread.is_alive()
        passed("download_cancelled", protocol_fixture=True)

        state.installed, state.mode = True, "low_memory"
        manager = ModelSetup(); manager.start()
        assert wait_setup(manager, {"error"})["state"] == "error"
        manager._thread.join(3)
        passed("load_failure_never_ready", protocol_fixture=True)

        state.mode = "complete"
        env = dict(os.environ, OLLAMA_URL=address, DEFAULT_MODEL=FIXTURE_MODEL,
                   MODEL_PROVIDER="ollama", AUTO_MODEL_SETUP="true")
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0)); env["PORT"] = str(listener.getsockname()[1])
        env["DATABASE_URL"] = "sqlite:///./codeme.db"
        configuration = (snapshot / ".env").read_bytes() + b"\n# Installation smoke: preserve this user configuration marker.\n"
        (snapshot / ".env").write_bytes(configuration)
        with launched_copy(snapshot, env, run / "launcher-first.log") as (backend, first_identity):
            wait_api_setup(backend)
            conversation = local_json(backend + "/api/conversations", {"title": "installation smoke preserved conversation"})
            with build_opener(ProxyHandler({})).open("http://127.0.0.1:4200/settings", timeout=3) as response:
                assert b"<app-root" in response.read()
        passed("fresh_copy_launch", api=True, built_browser_spa=True, **first_identity)

        # Dependency access is disabled for this upgrade and subsequent relaunch.
        offline = dict(env, PIP_NO_INDEX="1", NPM_CONFIG_OFFLINE="true",
                       HTTP_PROXY="http://127.0.0.1:9", HTTPS_PROXY="http://127.0.0.1:9")
        execute([snapshot_python(snapshot), "-B", "install.py", "--no-launch", "--skip-ollama"],
                snapshot, offline, run / "upgrade-offline.log", 600)
        assert (snapshot / ".env").read_bytes() == configuration
        pulls_before_relaunch = state.pull_calls
        with launched_copy(snapshot, offline, run / "launcher-relaunch.log") as (backend, second_identity):
            wait_api_setup(backend)
            conversations = local_json(backend + "/api/conversations")
            assert any(item["id"] == conversation["id"] and item["title"] == conversation["title"] for item in conversations)
            assert state.pull_calls == pulls_before_relaunch
        assert first_identity["backend_pid"] != second_identity["backend_pid"]
        passed("upgrade_preserves_configuration_and_conversations", conversation_id=conversation["id"])
        passed("offline_dependency_relaunch", external_dependency_access_disabled=True,
               inference="controlled loopback fixture remains available", **second_identity)
    result = {"status": "passed", "checks": checks, "model_weights_downloaded": False,
              "runtime_installation": "not performed", "evidence_kind": "fresh-copy controlled-daemon integration"}
    (run / "probe-result.json").write_text(json.dumps(result, indent=2), encoding="utf8")
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", action="store_true", help="Install dependencies in a fresh copy and run the checks.")
    parser.add_argument("--npm-cache", type=Path, help="Optional explicit cache; environments themselves remain fresh.")
    parser.add_argument("--pip-cache", type=Path, help="Optional explicit package cache.")
    parser.add_argument("--probe", type=Path, help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    if args.probe:
        print(json.dumps(probe(args.probe)))
        return 0
    if not args.run:
        print(json.dumps({"mode": "plan", "scenarios": SCENARIOS,
                          "run": "python scripts/install_smoke.py --run",
                          "network": "Public Python/npm packages only during fresh dependency installation",
                          "limits": "Local fresh-copy evidence is not proof of a clean OS VM or real model download"}, indent=2))
        return 0
    runtime = SOURCE / ".runtime"
    runtime.mkdir(exist_ok=True)
    run = Path(tempfile.mkdtemp(prefix="install-smoke-", dir=runtime)).resolve()
    snapshot = inside(run / "source", run)
    report = {"schema_version": 1, "status": "running", "platform": platform.platform(),
              "evidence_kind": "fresh-copy installation on existing host", "clean_os_claimed": False,
              "model_weights_downloaded": False, "run_directory": str(run), "scenarios": SCENARIOS,
              "bootstrap_python": platform.python_version(), "phases": [],
              "package_archives_reused": {"pip": args.pip_cache is not None, "npm": args.npm_cache is not None},
              "installed_environments_reused": False}
    report_path = run / "report.json"
    @contextmanager
    def phase(name):
        entry = {"name": name, "status": "running"}
        report["phases"].append(entry)
        report_path.write_text(json.dumps(report, indent=2), encoding="utf8")
        started = time.monotonic()
        try:
            yield
            entry["status"] = "passed"
        except BaseException:
            entry["status"] = "failed"
            raise
        finally:
            entry["elapsed_seconds"] = round(time.monotonic() - started, 2)
    print(f"Installation smoke artifacts: {run}", flush=True)
    try:
        with phase("source_snapshot"):
            report["snapshot"] = source_snapshot(SOURCE, snapshot)
            (snapshot / MARKER).write_text(json.dumps({"schema": 1, "run_root": str(run), "snapshot_root": str(snapshot)}), encoding="utf8")
            assert not (snapshot / ".venv").exists() and not (snapshot / "frontend/node_modules").exists()
            assert not (snapshot / ".env").exists() and not (snapshot / "codeme.db").exists()
            env = isolated_environment(run, npm_cache=args.npm_cache, pip_cache=args.pip_cache)
            report["node_version"] = subprocess.check_output(["node", "--version"], cwd=snapshot, env=env,
                                                             timeout=10, text=True).strip()
        with phase("fresh_dependency_install_and_browser_build"):
            execute([sys.executable, "-B", "install.py", "--no-launch", "--skip-ollama"], snapshot, env, run / "install.log", 1800)
        with phase("controlled_daemon_launch_upgrade_and_relaunch"):
            execute([snapshot_python(snapshot), "-B", "scripts/install_smoke.py", "--probe", snapshot], snapshot, env, run / "probe.log", 900)
        report.update(status="passed", probe=json.loads((run / "probe-result.json").read_text(encoding="utf8")))
    except (OSError, ValueError, AssertionError, subprocess.SubprocessError) as error:
        report.update(status="failed", error=str(error))
    except KeyboardInterrupt:
        report.update(status="cancelled", error="Interrupted by user")
    finally:
        report_path.write_text(json.dumps(report, indent=2), encoding="utf8")
    print(json.dumps({"status": report["status"], "report": str(report_path)}, indent=2))
    return 0 if report["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
