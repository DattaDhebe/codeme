"""One process-owned first-run job for installing and loading a local model.

Only Ollama's configured loopback daemon can download weights. The job has no
caller-supplied URLs, shell commands, or arbitrary model names. Downloads are separate from
inference: no conversation or repository content is sent during setup.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import subprocess
import threading
from time import monotonic
from urllib.parse import urlsplit

import httpx

from codeme_agent.config import configured_default_model, settings
from codeme_agent import model_catalog
from codeme_agent.local_access import validate_local_url
from codeme_agent.model_client import capability_summary, create_model_client
from codeme_agent.model_messages import cloud_model_name, normalize_assistant
from codeme_agent.ollama import OllamaClient, OllamaError


OLLAMA_FALLBACK_PATHS = (
    "/Applications/Ollama.app/Contents/Resources/ollama",
    "/opt/homebrew/bin/ollama", "/usr/local/bin/ollama",
)


class SetupCancelled(Exception):
    pass


class SetupConflict(Exception):
    pass


def find_ollama() -> str | None:
    executable = shutil.which("ollama")
    if executable:
        return executable
    # Windows installers update PATH for new sessions only.
    if os.name == "nt":
        local = os.environ.get("LOCALAPPDATA")
        if local:
            for suffix in ("Programs/Ollama/ollama.exe", "Ollama/ollama.exe"):
                candidate = Path(local) / suffix
                if candidate.is_file():
                    return str(candidate)
    for location in OLLAMA_FALLBACK_PATHS:
        candidate = Path(location)
        if candidate.is_absolute() and candidate.is_file():
            return str(candidate)
    return None


class ModelSetup:
    def __init__(self):
        self._lock = threading.RLock()
        self._thread: threading.Thread | None = None
        self._cancel = threading.Event()
        self._response = None
        self._daemon: subprocess.Popen | None = None
        self._ready_checked_at = 0.0
        self._ready_check_in_progress = False
        self._capabilities: dict[str, list[str] | None] = {}
        saved_choice = model_catalog.saved_model_choice(configured_default_model, settings.model_provider)
        self._catalog_id = (saved_choice.id if saved_choice is not None
                            and settings.default_model == saved_choice.ollama_model else None)
        self._status = {
            "state": "idle", "provider": settings.model_provider, "model": None,
            "available_models": [], "message": "Ready to check your local model.",
            "completed_bytes": 0, "total_bytes": 0, "percent": None,
            "progress_scope": "layer", "error": None,
            "catalog_id": self._catalog_id, "explicit_selection": self._catalog_id is not None,
            "preference_saved": self._catalog_id is not None,
            **capability_summary(None),
        }

    def status(self, *, refresh: bool = False) -> dict:
        if refresh:
            self._refresh_readiness()
        with self._lock:
            result = {**self._status, "available_models": list(self._status["available_models"]),
                      "model_capabilities": list(self._status["model_capabilities"])}
            result["auto_setup_enabled"] = settings.auto_model_setup
            result["can_retry"] = not (self._thread and self._thread.is_alive())
            return result

    def _refresh_readiness(self) -> None:
        """A passive inventory check expires stale ready states, at most every 5s."""
        with self._lock:
            if (self._status["state"] != "ready" or self._ready_check_in_progress
                    or monotonic() - self._ready_checked_at < 5
                    or self._thread and self._thread.is_alive()):
                return
            self._ready_check_in_progress = True
            selected = self._status["model"]
            provider = self._status["provider"]
        try:
            installed = create_model_client().list_models(timeout=2)
            available = (selected in installed or provider == "ollama" and selected is not None
                         and OllamaClient._model_key(selected) in {OllamaClient._model_key(name) for name in installed})
            changes = {"available_models": installed}
            if not available:
                changes.update(state="idle", model=None, percent=None, error=None,
                               message="The selected model is no longer installed. Set up a local model to continue.",
                               **capability_summary(None))
        except Exception:
            changes = {"state": "server_unavailable", "available_models": [], "percent": None,
                       "message": "Your local model server is no longer reachable. Choose Retry to reconnect or restart it.",
                       "error": "The local model server is unavailable.", **capability_summary(None)}
        finally:
            with self._lock:
                self._ready_check_in_progress = False
                self._ready_checked_at = monotonic()
        with self._lock:
            # A simultaneous POST/cancellation takes ownership over this snapshot.
            if (self._status["state"] == "ready" and self._status["model"] == selected
                    and self._status["provider"] == provider and not (self._thread and self._thread.is_alive())):
                self._status.update(changes)

    def _update(self, **changes) -> None:
        with self._lock:
            self._status.update(changes)

    def start(self, catalog_id: str | None = None) -> dict:
        if catalog_id is not None:
            if settings.model_provider != "ollama":
                raise ValueError("Automatic catalog downloads require Ollama. Load the model in your configured local server instead.")
            if model_catalog.get_model(catalog_id) is None:
                raise ValueError("Unknown coding model catalog entry. Choose a model from the catalog.")
        with self._lock:
            if self._thread and self._thread.is_alive():
                if catalog_id is not None and catalog_id != self._catalog_id:
                    raise SetupConflict("Another model setup is active. Cancel it or wait for it to finish before choosing another model.")
                return self.status()
            if catalog_id is not None:
                self._catalog_id = catalog_id
            elif settings.model_provider != "ollama":
                self._catalog_id = None
            selected_entry = model_catalog.get_model(self._catalog_id) if self._catalog_id else None
            self._cancel = threading.Event()
            self._capabilities = {}
            self._status.update(
                state="checking", provider=settings.model_provider, model=selected_entry.ollama_model if selected_entry else None,
                available_models=[], message="Checking for an installed local model…",
                completed_bytes=0, total_bytes=0, percent=None, error=None,
                catalog_id=self._catalog_id, explicit_selection=self._catalog_id is not None,
                preference_saved=False,
                **capability_summary(None),
            )
            self._thread = threading.Thread(target=self._run, name="codeme-model-setup", daemon=True)
            self._thread.start()
            return self.status()

    def cancel(self) -> dict:
        with self._lock:
            if not self._thread or not self._thread.is_alive():
                return self.status()
            self._cancel.set()
            self._status.update(state="cancelled", message="Model setup cancelled. Downloaded layers can be reused on retry.", error=None)
            response = self._response
        if response is not None:
            try:
                response.close()
            except Exception:
                pass
        return self.status()

    def shutdown(self) -> None:
        self.cancel()
        if self._daemon is not None and self._daemon.poll() is None:
            try:
                self._daemon.terminate()
            except OSError:
                pass  # The owned daemon may have exited between poll and stop.

    def _check_cancelled(self) -> None:
        if self._cancel.is_set():
            raise SetupCancelled()

    def _start_daemon(self, base_url: str) -> bool:
        executable = find_ollama()
        if executable is None:
            self._update(state="runtime_missing", message="Ollama is not installed. Run CodeMe's setup installer, then choose Retry.")
            return False
        parsed = urlsplit(base_url)
        if parsed.scheme != "http" or parsed.path not in {"", "/"}:
            self._update(state="server_unavailable", message="Start your configured local Ollama server, then choose Retry.")
            return False
        self._update(message="Starting your local Ollama server. First-time hardware discovery can take up to a minute…")
        environment = {**os.environ, "OLLAMA_HOST": parsed.netloc, "OLLAMA_NO_CLOUD": "1"}
        if self._daemon is None or self._daemon.poll() is not None:
            self._daemon = subprocess.Popen(
                [executable, "serve"], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL, env=environment, shell=False,
                creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
            )
        deadline = monotonic() + 60
        client = OllamaClient(base_url=base_url)
        while monotonic() < deadline:
            self._check_cancelled()
            try:
                client.list_models(timeout=1)
                return True
            except OllamaError:
                if self._daemon.poll() is not None:
                    break
                self._cancel.wait(0.25)
        self._update(state="server_unavailable", message="Ollama did not start. Open Ollama and choose Retry; check whether its configured port is already in use.")
        return False

    @staticmethod
    def _safe_model(model: str) -> bool:
        return (isinstance(model, str) and 0 < len(model) <= 250
                and not any(character.isspace() or ord(character) < 32 for character in model)
                and not cloud_model_name(model)
                and all(character.isalnum() or character in "._:/-" for character in model)
                and not model.startswith(("-", "/", ".")) and ".." not in model
                and "://" not in model and "//" not in model)

    def _model_capabilities(self, base_url: str, name: str) -> list[str] | None:
        self._check_cancelled()
        capabilities = OllamaClient(base_url=base_url)._read_model_capabilities(name, timeout=5)
        self._capabilities[name] = capabilities
        return capabilities

    def _choose_ollama_model(self, base_url: str, installed: list[str], desired: str) -> str | None:
        ordered = sorted(installed, key=lambda name: (
            OllamaClient._model_key(name) != OllamaClient._model_key(desired),
            not any(word in name.lower() for word in ("coder", "code", "qwen", "deepseek")),
        ))
        fallback = None
        for name in ordered[:16]:
            self._check_cancelled()
            if not self._safe_model(name):
                continue
            capabilities = self._model_capabilities(base_url, name)
            if capabilities is not None and "completion" not in capabilities:
                continue
            if capabilities is None and any(word in name.lower() for word in ("embed", "rerank", "bert")):
                continue
            if OllamaClient._model_key(name) == OllamaClient._model_key(desired):
                return name
            if capabilities is not None and "tools" in capabilities:
                return name
            if fallback is None:
                fallback = name
        return fallback

    def _pull(self, base_url: str, model: str) -> None:
        if not self._safe_model(model):
            raise OllamaError("DEFAULT_MODEL must name a local Ollama library model; cloud models and URLs are disabled.")
        self._update(state="downloading", model=model,
                     message=f"Downloading {model}. This first download needs internet; your code stays on this machine.")
        deadline = monotonic() + 7200
        succeeded = False
        with httpx.stream("POST", f"{base_url}/api/pull", json={"model": model, "stream": True},
                          timeout=httpx.Timeout(60, connect=5), trust_env=False, follow_redirects=False) as response:
            with self._lock:
                self._response = response
            if response.status_code != 200:
                raise OllamaError(f"Model download failed (HTTP {response.status_code}). Check the model name and internet connection.")
            for line in response.iter_lines():
                self._check_cancelled()
                if monotonic() > deadline:
                    raise OllamaError("Model download reached its two-hour limit. Choose Retry to resume downloaded layers.")
                if not line:
                    continue
                if len(line) > 65536:
                    raise OllamaError("Ollama sent an oversized download progress event.")
                try:
                    event = json.loads(line)
                except (ValueError, TypeError) as exc:
                    raise OllamaError("Ollama sent invalid model download progress.") from exc
                if not isinstance(event, dict):
                    raise OllamaError("Ollama sent invalid model download progress.")
                if event.get("error"):
                    raise OllamaError("Ollama could not download this model. Check available disk space, model name, and internet access, then retry.")
                phase = event.get("status", "Downloading model")
                if not isinstance(phase, str):
                    raise OllamaError("Ollama sent invalid model download progress.")
                total = event.get("total", 0)
                completed = event.get("completed", 0)
                if type(total) is not int or type(completed) is not int or total < 0 or completed < 0:
                    raise OllamaError("Ollama sent invalid model download sizes.")
                completed = min(completed, total) if total else 0
                percent = round(completed * 100 / total, 1) if total else None
                self._update(message=f"{model}: {phase[:200]}", completed_bytes=completed,
                             total_bytes=total, percent=percent)
                if phase == "success":
                    succeeded = True
                    break
        with self._lock:
            self._response = None
        if not succeeded:
            raise OllamaError("Model download ended before completion. Choose Retry to resume downloaded layers.")

    def _warm_ollama(self, base_url: str, model: str) -> None:
        self._update(state="loading", model=model, percent=None, message=f"Loading {model} into memory. The first load can take a moment…")
        self._check_cancelled()
        response = httpx.post(f"{base_url}/api/generate", json={"model": model, "prompt": "", "stream": False,
                              "keep_alive": "5m", "options": {"num_ctx": settings.ollama_context_length}},
                              timeout=180, trust_env=False, follow_redirects=False)
        if response.status_code != 200:
            raise OllamaError("The model is installed but could not load. Close memory-heavy apps or choose a smaller DEFAULT_MODEL, then retry.")
        data = response.json()
        if not isinstance(data, dict) or data.get("error") or data.get("done") is not True:
            raise OllamaError("Ollama did not confirm the model finished loading. Retry, or choose a smaller DEFAULT_MODEL.")

    def _run(self) -> None:
        try:
            self._capabilities = {}
            provider = settings.model_provider
            entry = model_catalog.get_model(self._catalog_id) if self._catalog_id else None
            if self._catalog_id and (entry is None or provider != "ollama"):
                raise OllamaError("The selected catalog model requires the configured local Ollama server.")
            desired = entry.ollama_model if entry else settings.default_model
            client = create_model_client()
            try:
                installed = client.list_models()
            except OllamaError:
                if provider != "ollama":
                    self._update(state="server_unavailable", message="Start your trusted local model server with a model loaded, then choose Retry. Automatic downloads are available with Ollama.")
                    return
                base_url = validate_local_url(str(settings.ollama_url)).rstrip("/")
                if not self._start_daemon(base_url):
                    return
                installed = client.list_models()
            self._check_cancelled()
            self._update(available_models=installed)
            if provider == "ollama":
                base_url = validate_local_url(str(settings.ollama_url)).rstrip("/")
                # An explicit catalog request is exact. Reusing another installed
                # model would silently ignore the user's download/selection.
                selected = (next((name for name in installed if OllamaClient._model_key(name) == OllamaClient._model_key(desired)), None)
                            if entry else self._choose_ollama_model(base_url, installed, desired))
                if selected is None:
                    if any(OllamaClient._model_key(name) == OllamaClient._model_key(desired) for name in installed):
                        raise OllamaError("The configured model is installed but cannot generate chat. Set DEFAULT_MODEL to a text-generation coding model, then choose Retry.")
                    self._pull(base_url, desired)
                    self._check_cancelled()
                    installed = client.list_models()
                    self._update(available_models=installed)
                    selected = next((name for name in installed
                                     if OllamaClient._model_key(name) == OllamaClient._model_key(desired)), None)
                    if selected is None:
                        raise OllamaError("Download finished but Ollama did not report installed local weights. Retry setup.")
                capabilities = (self._capabilities[selected] if selected in self._capabilities
                                else self._model_capabilities(base_url, selected))
                if capabilities is not None and "completion" not in capabilities:
                    raise OllamaError("The installed model cannot generate chat. Set DEFAULT_MODEL to a text-generation coding model, then choose Retry.")
                self._warm_ollama(base_url, selected)
            else:
                capabilities = None
                if not installed:
                    self._update(state="error", message="No local model is loaded. Load a coding model in your server, then choose Retry; use Ollama for automatic downloads.", error="The configured server has no available local models.")
                    return
                selected = desired if desired in installed else installed[0]
                self._update(state="loading", model=selected, message=f"Checking {selected} on your local model server…")
                # Compatible APIs have no standard preload endpoint. A one-token,
                # synthetic request verifies actual generation without user data.
                client._require_local_model(selected, timeout=5)
                response = httpx.post(f"{client.base_url}/chat/completions", json={"model": selected,
                                      "messages": [{"role": "user", "content": " "}], "stream": False, "max_tokens": 1},
                                      timeout=180, trust_env=False, follow_redirects=False)
                if response.status_code != 200:
                    raise OllamaError("Your model server could not load this model. Load a suitable model in the server and retry.")
                data = response.json()
                if (not isinstance(data, dict) or data.get("error")
                        or not isinstance(data.get("choices"), list) or len(data["choices"]) != 1
                        or not isinstance(data["choices"][0], dict)
                        or data["choices"][0].get("finish_reason") not in {"stop", "length"}):
                    raise OllamaError("The local server did not confirm model generation. Check its configuration and retry.")
                try:
                    assistant = normalize_assistant(data["choices"][0].get("message"), content_parts=True)
                    if assistant.get("tool_calls"):
                        raise ValueError("Unexpected setup tool call")
                except ValueError as exc:
                    raise OllamaError("The local server returned an invalid model check response. Check its configuration and retry.") from exc
            self._check_cancelled()
            with self._lock:
                self._check_cancelled()
                preference_saved = False
                if entry:
                    try:
                        model_catalog.save_model_choice(entry.id, configured_default_model)
                        preference_saved = True
                    except (OSError, ValueError):
                        pass  # Installed weights remain usable for this run.
                settings.default_model = selected
                self._ready_checked_at = monotonic()
                self._status.update(state="ready", model=selected, available_models=installed, percent=100,
                                    message=(f"{selected} is ready. You can start chatting."
                                             + (" The selection could not be saved for restart; check application-folder permissions." if entry and not preference_saved else "")),
                                    error=None, preference_saved=preference_saved,
                                    **capability_summary(capabilities))
        except SetupCancelled:
            self._update(state="cancelled", message="Model setup cancelled. Downloaded layers can be reused on retry.", error=None)
        except Exception as exc:
            if self._cancel.is_set():
                self._update(state="cancelled", message="Model setup cancelled. Downloaded layers can be reused on retry.", error=None)
            else:
                if isinstance(exc, (httpx.HTTPError, OSError)):
                    detail = "Unable to reach the local model runtime. Check the server, available memory and disk space, then retry."
                elif isinstance(exc, OllamaError):
                    detail = str(exc)
                else:
                    detail = "Local model setup did not finish. Check the local server and try again."
                self._update(state="error", message=detail, error=detail)
        finally:
            with self._lock:
                self._response = None


model_setup = ModelSetup()
