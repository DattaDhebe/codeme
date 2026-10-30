"""Standard-library installer and local launcher; no model prompts leave this PC.

Installation is an explicit user action. Runtime/package downloads happen here;
model downloads and their browser/sidebar progress belong to model_setup.py.
"""

import argparse
import functools
import http.server
import json
import os
from pathlib import Path
import platform
import shutil
import signal
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import venv
import webbrowser


ROOT = Path(__file__).resolve().parent


class SetupError(Exception):
    """An actionable installation or launch failure."""


def run(arguments, *, cwd=ROOT):
    print("\n> " + " ".join(str(value) for value in arguments), flush=True)
    subprocess.run([str(value) for value in arguments], cwd=cwd, check=True)


def venv_python(root=ROOT):
    return root / ".venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")


def executable(name):
    found = shutil.which(name)
    if found:
        return found
    # A Windows installer updates the registry's PATH, not this running process.
    if name == "ollama":
        candidates = [
            Path(os.environ.get("LOCALAPPDATA", "")) / "Programs/Ollama/ollama.exe",
            Path("/Applications/Ollama.app/Contents/Resources/ollama"),
            Path("/opt/homebrew/bin/ollama"), Path("/usr/local/bin/ollama"),
        ]
        return next((str(path) for path in candidates if path.is_absolute() and path.is_file()), None)
    return None


def require_node():
    node, npm = executable("node"), executable("npm")
    if not node or not npm:
        raise SetupError("Install Node.js 24 LTS (includes npm) from https://nodejs.org, reopen your terminal, then run python install.py again.")
    try:
        version = subprocess.check_output([node, "--version"], text=True).strip().lstrip("v")
        major, minor = [int(value) for value in version.split(".")[:2]]
    except (ValueError, subprocess.SubprocessError) as exc:
        raise SetupError("Could not check Node.js. Reinstall Node.js 24 LTS and retry.") from exc
    if not (major == 24 or major == 22 and minor >= 12 or major == 20 and minor >= 19):
        raise SetupError("CodeMe's Angular 21 browser requires Node.js 20.19+, 22.12+, or 24.x. Install Node.js 24 LTS, reopen your terminal, and retry.")
    return npm


def backend_settings(python, root=ROOT):
    code = ("import json; from codeme_agent.config import settings; "
            "print(json.dumps({'host':settings.host,'port':settings.port,"
            "'provider':settings.model_provider,'model':settings.default_model,"
            "'ollama_url':str(settings.ollama_url)}))")
    return json.loads(subprocess.check_output([str(python), "-B", "-c", code], cwd=root, text=True,
                                             stdin=subprocess.DEVNULL, timeout=30))


def ensure_pip(python):
    # An interrupted venv creation can leave Python present before pip exists.
    check = subprocess.run([str(python), "-m", "pip", "--version"], cwd=ROOT,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
    if check.returncode:
        print("Repairing the Python package installer...", flush=True)
        run([python, "-m", "ensurepip", "--upgrade"])


def install_ollama():
    if executable("ollama"):
        print("Ollama is already installed. Keeping your existing models.", flush=True)
        return
    system = platform.system()
    print("Installing Ollama. Its package manager may request OS permission.", flush=True)
    if system == "Windows":
        winget = executable("winget")
        if not winget:
            raise SetupError("Install Ollama from https://ollama.com/download/windows, then rerun python install.py. Automatic installation requires Windows App Installer (winget).")
        run([winget, "install", "--id", "Ollama.Ollama", "--exact", "--source", "winget",
             "--accept-package-agreements", "--accept-source-agreements", "--silent"])
    elif system == "Darwin":
        brew = executable("brew")
        if not brew:
            raise SetupError("Install Ollama from https://ollama.com/download/mac, then rerun python install.py. Automatic installation on macOS requires Homebrew.")
        run([brew, "install", "ollama"])
    elif system == "Linux":
        # Save the official HTTPS installer before execution, rather than a shell pipeline.
        directory = ROOT / ".runtime/installers"
        directory.mkdir(parents=True, exist_ok=True)
        script = directory / "ollama-install.sh"
        with urllib.request.urlopen("https://ollama.com/install.sh", timeout=60) as response:
            data = response.read(2_000_001)
        if len(data) > 2_000_000 or not data.startswith(b"#!/"):
            raise SetupError("The official Ollama installer response was invalid. Use https://ollama.com/download/linux and retry.")
        script.write_bytes(data)
        run(["sh", script])
    else:
        raise SetupError("Install a supported Ollama runtime from https://ollama.com/download, or configure a local compatible server.")
    if not executable("ollama"):
        raise SetupError("Ollama installation finished but its executable was not found. Reopen your terminal and run python install.py again.")


def install_main(argv=None):
    parser = argparse.ArgumentParser(description="Install CodeMe and open automatic local model setup.")
    parser.add_argument("--no-launch", action="store_true", help="Install dependencies without starting CodeMe or downloading a model.")
    parser.add_argument("--skip-ollama", action="store_true", help="Do not install the Ollama runtime (for managed or other local servers).")
    parser.add_argument("--no-browser", action="store_true", help="Launch CodeMe without opening a browser window.")
    args = parser.parse_args(argv)
    try:
        if sys.version_info < (3, 10):
            raise SetupError("Install Python 3.10 or newer, then retry.")
        npm = require_node()
        python = venv_python()
        if not python.is_file():
            print("Creating CodeMe's Python environment...", flush=True)
            venv.EnvBuilder(with_pip=True).create(ROOT / ".venv")
        ensure_pip(python)
        run([python, "-m", "pip", "install", "-r", ROOT / "requirements.txt"])
        env_file = ROOT / ".env"
        if not env_file.exists():
            # Exclusive creation keeps an existing or concurrently created configuration intact.
            try:
                with env_file.open("x", encoding="utf-8") as target:
                    target.write((ROOT / ".env.example").read_text(encoding="utf-8"))
            except FileExistsError:
                pass
        config = backend_settings(python)
        if config["provider"] == "ollama" and not args.skip_ollama:
            inventory = local_json(config["ollama_url"].rstrip("/") + "/api/tags")
            if isinstance(inventory, dict) and isinstance(inventory.get("models"), list):
                print("Using your running local Ollama server.", flush=True)
            else:
                install_ollama()
        run([npm, "ci", "--no-audit", "--no-fund"], cwd=ROOT / "frontend")
        run([npm, "run", "build"], cwd=ROOT / "frontend")
        for name in ("git", "rg"):
            if not executable(name):
                print(f"Repository tool missing: {name}. Install it to enable full code search/Git inspection.", flush=True)
        print("\nCodeMe is installed. On launch, it reuses a suitable model or downloads the configured model with progress.", flush=True)
        if args.no_launch:
            print("Start it with: python start.py", flush=True)
            return 0
        return launch(no_browser=args.no_browser)
    except (SetupError, OSError, subprocess.SubprocessError, ValueError) as exc:
        print(f"\nSetup needs attention: {exc}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("\nSetup stopped. Run python install.py again to continue.", flush=True)
        return 130


class LocalWebServer(http.server.ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


class BrowserHandler(http.server.SimpleHTTPRequestHandler):
    """Serve only built browser files with SPA fallback and local runtime configuration."""

    def __init__(self, *args, directory, backend_url, model, **kwargs):
        self.asset_root = Path(directory).resolve()
        self.backend_url = backend_url
        self.model = model
        super().__init__(*args, directory=directory, **kwargs)

    def send_head(self):
        if self.headers.get("Host", "").lower() not in {"127.0.0.1:4200", "localhost:4200"}:
            self.send_error(403, "Use http://127.0.0.1:4200")
            return None
        route = urllib.parse.urlsplit(self.path).path
        if route == "/runtime-config.json":
            import io
            body = json.dumps({"backendUrl": self.backend_url, "defaultModel": self.model}).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            return io.BytesIO(body)
        path = Path(self.translate_path(self.path)).resolve()
        if not path.is_relative_to(self.asset_root):
            self.send_error(403)
            return None
        if not path.is_file():
            # Real missing assets must be 404s. Only browser navigation gets index.html.
            if Path(route).suffix:
                self.send_error(404)
                return None
            if not (self.asset_root / "index.html").resolve().is_relative_to(self.asset_root):
                self.send_error(403)
                return None
            self.path = "/index.html"
        return super().send_head()

    def end_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Frame-Options", "DENY")
        super().end_headers()

    def log_message(self, format, *args):
        pass


def local_json(url):
    # Local readiness checks bypass corporate/environment proxies and redirects.
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs):
            return None
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    try:
        with opener.open(url, timeout=2) as response:
            return json.load(response)
    except (OSError, ValueError):
        return None


def terminate_owned_backend(process):
    """Stop the owned Windows redirector and its actual Python child together."""
    if platform.system() == "Windows":
        taskkill = Path(os.environ.get("SystemRoot", "C:/Windows")) / "System32/taskkill.exe"
        try:
            subprocess.run([str(taskkill), "/PID", str(process.pid), "/T", "/F"], check=False,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)
        except (OSError, subprocess.TimeoutExpired):
            pass
    if process.poll() is None:
        process.terminate()


def stop_owned_backend(process):
    """Allow FastAPI lifespan cleanup before falling back to forced termination."""
    if process.poll() is not None:
        return
    try:
        # A Windows process group accepts CTRL_BREAK without interrupting this
        # launcher's own console. Uvicorn then closes its setup/daemon ownership.
        process.send_signal(signal.CTRL_BREAK_EVENT if os.name == "nt" else signal.SIGINT)
    except (OSError, ValueError, SystemError):
        # Detached Windows processes may have no console for CTRL_BREAK.
        terminate_owned_backend(process)
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        terminate_owned_backend(process)
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)


def launch(*, no_browser=False, backend_only=False):
    python = venv_python()
    if not python.is_file():
        raise SetupError("CodeMe is not installed. Run python install.py first.")
    browser = ROOT / "frontend/dist/frontend/browser"
    if not backend_only and not (browser / "index.html").is_file():
        raise SetupError("The browser build is missing. Run python install.py first, or use python start.py --backend-only.")
    config = backend_settings(python)
    if not backend_only and config["port"] == 4200:
        raise SetupError("PORT=4200 is reserved for the browser app. Choose another backend PORT, or use --backend-only.")
    hostname = f"[{config['host']}]" if ":" in config["host"] else config["host"]
    backend_url = f"http://{hostname}:{config['port']}"
    process = None
    server = None
    try:
        existing = local_json(backend_url + "/api/model-setup")
        if not (isinstance(existing, dict) and "state" in existing and "provider" in existing):
            environment = dict(os.environ, PYTHONDONTWRITEBYTECODE="1")
            process = subprocess.Popen([str(python), "-B", "-m", "uvicorn", "main:app", "--host", config["host"],
                                        "--port", str(config["port"]), "--workers", "1"], cwd=ROOT, env=environment,
                                       creationflags=subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0)
            deadline = time.monotonic() + 45
            while time.monotonic() < deadline:
                if process.poll() is not None:
                    raise SetupError("The backend stopped during startup. Check the error above; a port may already be in use.")
                if local_json(backend_url + "/health") == {"status": "ok"}:
                    break
                time.sleep(0.3)
            else:
                raise SetupError("Backend startup took too long. Check its database/configuration and try again.")
        else:
            print("Using the CodeMe backend already running on this machine.", flush=True)
        if not backend_only:
            handler = functools.partial(BrowserHandler, directory=str(browser), backend_url=backend_url, model=config["model"])
            server = LocalWebServer(("127.0.0.1", 4200), handler)
            threading.Thread(target=server.serve_forever, daemon=True).start()
            print("\nOpen CodeMe: http://127.0.0.1:4200\nModel download and loading progress appear in the app.", flush=True)
            if not no_browser:
                webbrowser.open("http://127.0.0.1:4200")
        print(f"Backend: {backend_url}\nPress Ctrl+C to stop this launcher's services.", flush=True)
        while process is None or process.poll() is None:
            time.sleep(0.5)
        raise SetupError("The backend stopped. Check the error above and restart with python start.py.")
    except KeyboardInterrupt:
        print("\nStopping CodeMe...", flush=True)
        return 0
    finally:
        if server:
            server.shutdown()
            server.server_close()
        if process:
            stop_owned_backend(process)


def start_main(argv=None):
    parser = argparse.ArgumentParser(description="Start your installed CodeMe and automatic model setup.")
    parser.add_argument("--no-browser", action="store_true", help="Do not open the browser automatically.")
    parser.add_argument("--backend-only", action="store_true", help="Start only the backend for the VS Code extension.")
    args = parser.parse_args(argv)
    previous_break_handler = None
    if platform.system() == "Windows" and threading.current_thread() is threading.main_thread():
        # Python's default SIGBREAK action bypasses finally blocks. Route an
        # actual console Ctrl+Break through the same cleanup as Ctrl+C.
        previous_break_handler = signal.signal(signal.SIGBREAK, signal.default_int_handler)
    try:
        return launch(no_browser=args.no_browser, backend_only=args.backend_only)
    except (SetupError, OSError, subprocess.SubprocessError, ValueError) as exc:
        print(f"\nCould not start CodeMe: {exc}", file=sys.stderr)
        return 1
    finally:
        if previous_break_handler is not None:
            signal.signal(signal.SIGBREAK, previous_break_handler)
