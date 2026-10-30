"""Select a loopback-only inference protocol without cloud credentials."""

from typing import Protocol

from codeme_agent.config import settings
from codeme_agent.ollama import OllamaClient, OllamaError


class LocalModelClient(Protocol):
    default_model: str

    def list_models(self, timeout: int = 5) -> list[str]: ...

    def model_capabilities(self, model: str | None = None, timeout: int = 5) -> list[str] | None: ...

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


def capability_summary(capabilities: list[str] | None) -> dict:
    """Unknown metadata remains distinct from tested or advertised tool support."""
    supported = None if capabilities is None else "completion" in capabilities and "tools" in capabilities
    return {
        "tool_support": "unknown" if supported is None else "supported" if supported else "unsupported",
        "agent_ready": supported,
        "model_capabilities": list(capabilities or []),
    }


def inspect_model_capabilities(model: str | None = None, timeout: int = 5) -> dict:
    """Inspect an installed model only; this endpoint never pulls or generates."""
    client = create_model_client()
    selected = model or client.default_model
    capabilities = client.model_capabilities(selected, timeout=timeout)
    return {"model": selected, "provider": settings.model_provider, **capability_summary(capabilities)}
