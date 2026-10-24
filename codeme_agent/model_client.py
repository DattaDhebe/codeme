"""Select a loopback-only inference protocol without cloud credentials."""

from typing import Protocol

from codeme_agent.config import settings
from codeme_agent.ollama import OllamaClient, OllamaError


class LocalModelClient(Protocol):
    default_model: str

    def list_models(self, timeout: int = 5) -> list[str]: ...

    def stream_chat(self, messages: list[dict], model: str | None = None, timeout: int = 120): ...

    def chat_with_tools(self, messages: list[dict], tools: list[dict], model: str | None = None,
                        timeout: int = 180, options: dict | None = None) -> dict: ...


def create_model_client() -> LocalModelClient:
    if settings.model_provider == "ollama":
        return OllamaClient()
    if settings.model_provider == "openai_compatible":
        from codeme_agent.local_models import LocalCompatibleClient
        return LocalCompatibleClient()
    raise OllamaError("Unsupported local model provider")
