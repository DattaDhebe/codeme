"""OpenAI-compatible *local* model transport for LM Studio and llama.cpp.

Only loopback HTTP(S) is allowed, redirects/proxies/auth are disabled, and the
requested ID must appear in the local daemon's inventory before prompts are sent.
The compatible API cannot prove that a daemon has local weights or does not proxy
requests. Run a trusted local-only server with remote connectors disabled. Explicit
cloud names and affirmative remote metadata are rejected as an additional check.
"""

import json
from urllib.parse import urlsplit

import httpx

from codeme_agent.config import settings
from codeme_agent.local_access import validate_local_url
from codeme_agent.model_messages import (
    VisibleText, cloud_model_name, compatible_messages, explicit_remote_model,
    normalize_assistant,
)
from codeme_agent.ollama import OllamaError


class LocalCompatibleClient:
    def __init__(self, base_url: str | None = None, default_model: str | None = None):
        try:
            self.base_url = validate_local_url(base_url or str(settings.local_model_url)).rstrip("/")
        except ValueError as exc:
            raise OllamaError(str(exc)) from exc
        if not urlsplit(self.base_url).path:
            self.base_url += "/v1"
        self.default_model = default_model or settings.default_model

    @staticmethod
    def _valid_model(model: object) -> bool:
        return (isinstance(model, str) and 0 < len(model) <= 250
                and not any(char.isspace() or ord(char) < 32 for char in model)
                and not cloud_model_name(model))

    def list_models(self, timeout: int = 5) -> list[str]:
        try:
            response = httpx.get(f"{self.base_url}/models", timeout=timeout, trust_env=False, follow_redirects=False)
            if response.status_code != 200:
                raise OllamaError(f"Local model server returned HTTP {response.status_code}")
            decoded = response.json()
            if not isinstance(decoded, dict) or not isinstance(decoded.get("data"), list):
                raise OllamaError("Local model server returned an invalid model inventory")
            return list(dict.fromkeys(
                item["id"] for item in decoded["data"]
                if isinstance(item, dict) and self._valid_model(item.get("id"))
                and not explicit_remote_model(item)
            ))
        except (httpx.RequestError, ValueError) as exc:
            raise OllamaError(f"Unable to query local models: {exc}") from exc

    def _require_local_model(self, model: str, timeout: int) -> None:
        # Recheck before each prompt: compatible inventories have no standard digest
        # or local-weights metadata that could safely support a verification cache.
        if not self._valid_model(model):
            raise OllamaError("Choose an installed local model; cloud models are disabled")
        if model not in self.list_models(timeout=min(timeout, 5)):
            raise OllamaError(f"Model '{model}' is not in the trusted local server inventory")

    def model_capabilities(self, model: str | None = None, timeout: int = 5) -> list[str] | None:
        # Compatible inventories have no standard tool-capability declaration.
        # Verify local availability while keeping unknown distinct from supported.
        self._require_local_model(model or self.default_model, timeout=timeout)
        return None

    def _payload(self, messages: list[dict], model: str, stream: bool, tools: list[dict] | None = None,
                 options: dict | None = None) -> dict:
        try:
            payload = {"model": model, "messages": compatible_messages(messages), "stream": stream}
        except ValueError as exc:
            raise OllamaError(f"Invalid local model history: {exc}") from exc
        if tools:
            payload["tools"] = tools
            payload["tool_choice"] = "auto"
        for key, value in (options or {}).items():
            if key in {"temperature", "top_p", "top_k", "seed", "max_tokens", "stop", "repeat_penalty"}:
                payload[key] = value
            elif key == "num_predict":
                payload["max_tokens"] = value
        return payload

    @staticmethod
    def _choice(decoded: object) -> dict:
        if not isinstance(decoded, dict):
            raise OllamaError("Local model server returned an invalid response")
        if decoded.get("error"):
            # Avoid echoing arbitrary server errors, which may include prompt text.
            raise OllamaError("Local model server reported a generation error")
        choices = decoded.get("choices")
        if not isinstance(choices, list) or len(choices) != 1 or not isinstance(choices[0], dict):
            raise OllamaError("Local model server returned invalid response choices")
        return choices[0]

    @staticmethod
    def _finish(reason: object) -> None:
        if not isinstance(reason, str) or reason not in {"stop", "tool_calls"}:
            raise OllamaError("Local model generation did not finish successfully; retry with a suitable context or output budget")

    def chat_with_tools(self, messages: list[dict], tools: list[dict], model: str | None = None,
                        timeout: int = 180, options: dict | None = None) -> dict:
        model = model or self.default_model
        self._require_local_model(model, timeout)
        payload = self._payload(messages, model, False, tools, options)
        try:
            response = httpx.post(f"{self.base_url}/chat/completions", json=payload, timeout=timeout,
                                  trust_env=False, follow_redirects=False)
            if response.status_code != 200:
                raise OllamaError(f"Local model server returned HTTP {response.status_code}")
            choice = self._choice(response.json())
            self._finish(choice.get("finish_reason"))
            return normalize_assistant(choice.get("message"), content_parts=True)
        except (httpx.RequestError, ValueError) as exc:
            raise OllamaError(f"Local model request failed: {exc}") from exc

    @staticmethod
    def _sse_data(response):
        lines = []
        size = 0
        for raw in response.iter_lines():
            line = raw.decode("utf-8") if isinstance(raw, bytes) else raw
            if not line:
                if lines:
                    yield "\n".join(lines)
                    lines, size = [], 0
                continue
            if line.startswith(":"):
                continue
            field, _, value = line.partition(":")
            if field == "data":
                value = value[1:] if value.startswith(" ") else value
                size += len(value)
                if size > 2_000_000:
                    raise OllamaError("Local model streaming event exceeds limit")
                lines.append(value)
            elif field not in {"event", "id", "retry"}:
                raise OllamaError("Local model server returned an invalid SSE stream")
        if lines:
            yield "\n".join(lines)

    def stream_chat(self, messages: list[dict], model: str | None = None, timeout: int = 120):
        model = model or self.default_model
        self._require_local_model(model, timeout)
        payload = self._payload(messages, model, True)
        try:
            with httpx.stream("POST", f"{self.base_url}/chat/completions", json=payload, timeout=timeout,
                              trust_env=False, follow_redirects=False) as response:
                if response.status_code != 200:
                    raise OllamaError(f"Local model server returned HTTP {response.status_code}")
                completed = False
                visible = VisibleText()
                for data in self._sse_data(response):
                    if data.strip() == "[DONE]":
                        if not completed:
                            raise OllamaError("Local model stream ended before a completion reason")
                        break
                    decoded = json.loads(data)
                    # OpenAI-style servers may emit a final usage-only chunk.
                    if (isinstance(decoded, dict) and not decoded.get("error")
                            and decoded.get("choices") == [] and isinstance(decoded.get("usage"), dict)):
                        continue
                    choice = self._choice(decoded)
                    delta = choice.get("delta")
                    if not isinstance(delta, dict):
                        raise OllamaError("Local model server returned an invalid stream delta")
                    if delta.get("tool_calls"):
                        raise OllamaError("Unexpected tool call in a text-only model stream")
                    text = delta.get("content")
                    if text is None:
                        text = ""
                    if isinstance(text, list):
                        # Preserve split reasoning-tag filtering across text parts.
                        parts = []
                        for part in text:
                            if not isinstance(part, dict):
                                raise OllamaError("Local model server returned invalid content parts")
                            if part.get("type") in {"text", "output_text"} and isinstance(part.get("text"), str):
                                parts.append(part["text"])
                            elif part.get("type") not in {"reasoning", "thinking", "analysis"}:
                                raise OllamaError("Local model server returned invalid content parts")
                        text = "".join(parts)
                    if not isinstance(text, str) or (completed and text):
                        raise OllamaError("Local model server returned invalid streaming content")
                    output = visible.feed(text)
                    if output:
                        yield output
                    reason = choice.get("finish_reason")
                    if reason is not None:
                        self._finish(reason)
                        completed = True
                if not completed:
                    raise OllamaError("Local model stream ended before completion; the response may be incomplete")
                output = visible.feed("", final=True)
                if output:
                    yield output
        except (httpx.RequestError, ValueError) as exc:
            raise OllamaError(f"Local model request failed: {exc}") from exc
