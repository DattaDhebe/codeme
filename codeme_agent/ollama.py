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
        url = f"{self.base_url}/chat?model={model}"
        payload = {"messages": messages, "stream": True}

        try:
            with httpx.stream("POST", url, json=payload, headers={"Accept": "text/event-stream"}, timeout=timeout) as response:
                if response.status_code != 200:
                    raise OllamaError("Ollama unavailable or returned error")

                buffer = ""
                for raw_line in response.iter_lines():
                    if raw_line is None:
                        continue
                    line = raw_line.decode("utf-8").strip()
                    if not line or line.startswith(":"):
                        continue
                    if line.startswith("event:"):
                        continue
                    if line.startswith("data:"):
                        data = line[len("data:"):].strip()
                        if data == "[DONE]":
                            break
                        try:
                            decoded = json.loads(data)
                        except json.JSONDecodeError:
                            continue
                        text = decoded.get("content") or decoded.get("message", {}).get("content") or ""
                        buffer += text
                        yield text
        except httpx.RequestError as exc:
            raise OllamaError(f"Ollama request failed: {exc}") from exc
        except httpx.HTTPStatusError as exc:
            raise OllamaError(f"Ollama returned HTTP error: {exc.response.status_code}") from exc
