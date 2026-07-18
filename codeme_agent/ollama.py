import json

import httpx

from codeme_agent.config import settings


class OllamaError(Exception):
    pass


class OllamaClient:
    def __init__(self, base_url: str | None = None, default_model: str | None = None):
        self.base_url = base_url or str(settings.ollama_url)
        self.default_model = default_model or settings.default_model

    def stream_chat(self, messages: list[dict[str, str]], model: str | None = None, timeout: int = 120):
        model = model or self.default_model
        url = f"{self.base_url.rstrip('/')}/api/chat"
        payload = {"model": model, "messages": messages, "stream": True}

        try:
            with httpx.stream("POST", url, json=payload, timeout=timeout) as response:
                if response.status_code != 200:
                    raise OllamaError(f"Ollama returned HTTP {response.status_code}")

                for raw_line in response.iter_lines():
                    if not raw_line:
                        continue
                    line = raw_line.decode("utf-8") if isinstance(raw_line, bytes) else raw_line
                    try:
                        decoded = json.loads(line)
                    except json.JSONDecodeError as exc:
                        raise OllamaError("Ollama returned an invalid stream response") from exc

                    if decoded.get("error"):
                        raise OllamaError(str(decoded["error"]))

                    text = decoded.get("message", {}).get("content", "")
                    if text:
                        yield text
                    if decoded.get("done"):
                        break
        except httpx.RequestError as exc:
            raise OllamaError(f"Ollama request failed: {exc}") from exc

    def chat_with_tools(
        self,
        messages: list[dict],
        tools: list[dict],
        model: str | None = None,
        timeout: int = 180,
    ) -> dict:
        """Run one non-streaming native Ollama tool-calling turn."""
        model = model or self.default_model
        url = f"{self.base_url.rstrip('/')}/api/chat"
        payload = {
            "model": model,
            "messages": messages,
            "stream": False,
        }
        if tools:
            payload["tools"] = tools
        try:
            response = httpx.post(url, json=payload, timeout=timeout)
            if response.status_code != 200:
                raise OllamaError(f"Ollama returned HTTP {response.status_code}: {response.text[:500]}")
            decoded = response.json()
            if decoded.get("error"):
                raise OllamaError(str(decoded["error"]))
            message = decoded.get("message")
            if not isinstance(message, dict):
                raise OllamaError("Ollama returned a response without an assistant message")
            return message
        except (httpx.RequestError, ValueError) as exc:
            raise OllamaError(f"Ollama request failed: {exc}") from exc

    def list_models(self, timeout: int = 5) -> list[str]:
        url = f"{self.base_url.rstrip('/')}/api/tags"
        try:
            response = httpx.get(url, timeout=timeout)
            if response.status_code != 200:
                raise OllamaError(f"Ollama returned HTTP {response.status_code}")
            data = response.json()
            return [item["name"] for item in data.get("models", []) if item.get("name")]
        except (httpx.RequestError, ValueError) as exc:
            raise OllamaError(f"Unable to query Ollama models: {exc}") from exc
