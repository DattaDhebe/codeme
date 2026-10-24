import json

import httpx

from codeme_agent.config import settings
from codeme_agent.local_access import validate_local_url
from codeme_agent.model_messages import VisibleText, explicit_remote_model, normalize_assistant


class OllamaError(Exception):
    pass


class OllamaClient:
    def __init__(self, base_url: str | None = None, default_model: str | None = None):
        try:
            self.base_url = validate_local_url(base_url or str(settings.ollama_url))
        except ValueError as exc:
            raise OllamaError(str(exc)) from exc
        self.default_model = default_model or settings.default_model
        self._verified_local_models: set[str] = set()

    def stream_chat(self, messages: list[dict[str, str]], model: str | None = None, timeout: int = 120):
        model = model or self.default_model
        self._require_local_model(model, timeout=min(timeout, 5))
        url = f"{self.base_url.rstrip('/')}/api/chat"
        payload = {"model": model, "messages": messages, "stream": True, "options": {"num_ctx": settings.ollama_context_length}}

        try:
            with httpx.stream("POST", url, json=payload, timeout=timeout, trust_env=False, follow_redirects=False) as response:
                if response.status_code != 200:
                    raise OllamaError(f"Ollama returned HTTP {response.status_code}")

                completed = False
                visible = VisibleText()
                for raw_line in response.iter_lines():
                    if not raw_line:
                        continue
                    line = raw_line.decode("utf-8") if isinstance(raw_line, bytes) else raw_line
                    try:
                        decoded = json.loads(line)
                    except json.JSONDecodeError as exc:
                        raise OllamaError("Ollama returned an invalid stream response") from exc

                    if not isinstance(decoded, dict):
                        raise OllamaError("Ollama returned an invalid stream response")
                    if decoded.get("error"):
                        raise OllamaError("Ollama reported a generation error")

                    message = decoded.get("message", {})
                    if not isinstance(message, dict) or not isinstance(message.get("content", ""), str):
                        raise OllamaError("Ollama returned invalid assistant content")
                    text = visible.feed(message.get("content", ""))
                    if text:
                        yield text
                    if decoded.get("done"):
                        if decoded.get("done_reason") is not None and decoded.get("done_reason") != "stop":
                            raise OllamaError("Ollama generation stopped before successful completion")
                        completed = True
                        break
                if not completed:
                    raise OllamaError("Ollama stream ended before completion; the response may be incomplete")
                text = visible.feed("", final=True)
                if text:
                    yield text
        except httpx.RequestError as exc:
            raise OllamaError(f"Ollama request failed: {exc}") from exc

    def chat_with_tools(
        self,
        messages: list[dict],
        tools: list[dict],
        model: str | None = None,
        timeout: int = 180,
        options: dict | None = None,
    ) -> dict:
        """Run one non-streaming native Ollama tool-calling turn."""
        model = model or self.default_model
        self._require_local_model(model, timeout=min(timeout, 5))
        url = f"{self.base_url.rstrip('/')}/api/chat"
        payload = {
            "model": model,
            "messages": messages,
            "stream": False,
        }
        if tools:
            payload["tools"] = tools
        payload["options"] = {"num_ctx": settings.ollama_context_length, **(options or {})}
        try:
            response = httpx.post(url, json=payload, timeout=timeout, trust_env=False, follow_redirects=False)
            if response.status_code != 200:
                raise OllamaError(f"Ollama returned HTTP {response.status_code}")
            decoded = response.json()
            if not isinstance(decoded, dict):
                raise OllamaError("Ollama returned an invalid response")
            if decoded.get("error"):
                raise OllamaError("Ollama reported a generation error")
            message = decoded.get("message")
            if not isinstance(message, dict):
                raise OllamaError("Ollama returned a response without an assistant message")
            if not isinstance(message.get("content", ""), str) or not isinstance(message.get("tool_calls", []), list):
                raise OllamaError("Ollama returned an invalid assistant message")
            if decoded.get("done_reason") is not None and decoded.get("done_reason") != "stop":
                raise OllamaError("Ollama generation stopped before successful completion")
            return normalize_assistant(message)
        except (httpx.RequestError, ValueError) as exc:
            raise OllamaError(f"Ollama request failed: {exc}") from exc

    @staticmethod
    def _model_key(name: str) -> str:
        return name if ":" in name.rsplit("/", 1)[-1] else name + ":latest"

    @staticmethod
    def _is_local_entry(item: object) -> bool:
        if not isinstance(item, dict) or not isinstance(item.get("name"), str) or not item["name"]:
            return False
        name = item["name"].lower()
        tag = name.rsplit(":", 1)[-1]
        details = item.get("details")
        return (tag != "cloud" and not tag.endswith("-cloud")
                and not explicit_remote_model(item)
                and isinstance(details, dict) and details.get("format") in {"gguf", "safetensors"}
                and type(item.get("size")) is int and item["size"] > 0)

    def _require_local_model(self, model: str, timeout: int = 5) -> None:
        """Verify local weights before sending any prompt to the loopback daemon.

        Ollama can proxy cloud inference through localhost, including model aliases.
        A name suffix alone cannot establish that model weights are local.
        """
        if not isinstance(model, str) or not model or len(model) > 250 or any(char.isspace() for char in model):
            raise OllamaError("Choose an installed local Ollama model")
        tag = model.lower().rsplit(":", 1)[-1]
        if tag == "cloud" or tag.endswith("-cloud"):
            raise OllamaError("Cloud models are disabled in CodeMe; choose an installed local model")
        key = self._model_key(model)
        if key in self._verified_local_models:
            return
        available = self.list_models(timeout=timeout)
        self._verified_local_models.update(self._model_key(name) for name in available)
        if key not in self._verified_local_models:
            raise OllamaError(f"Model '{model}' is not verified as an installed local model. Install local weights in Ollama and choose that model.")

    def list_models(self, timeout: int = 5) -> list[str]:
        url = f"{self.base_url.rstrip('/')}/api/tags"
        try:
            response = httpx.get(url, timeout=timeout, trust_env=False, follow_redirects=False)
            if response.status_code != 200:
                raise OllamaError(f"Ollama returned HTTP {response.status_code}")
            data = response.json()
            if not isinstance(data, dict) or not isinstance(data.get("models"), list):
                raise OllamaError("Ollama returned an invalid model inventory")
            return list(dict.fromkeys(item["name"] for item in data["models"] if self._is_local_entry(item)))
        except (httpx.RequestError, ValueError) as exc:
            raise OllamaError(f"Unable to query Ollama models: {exc}") from exc
