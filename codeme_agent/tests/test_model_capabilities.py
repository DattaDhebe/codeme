"""Capability inspection is read-only and never starts/downloads a model."""

import pytest
from fastapi.testclient import TestClient

import main
from codeme_agent import model_client, ollama, routers


@pytest.mark.parametrize(("capabilities", "support", "ready"), [
    (["completion", "tools"], "supported", True),
    (["completion"], "unsupported", False),
    (["embedding"], "unsupported", False),
    (None, "unknown", None),
])
def test_advertised_capabilities_do_not_confuse_chat_with_agent(capabilities, support, ready):
    state = model_client.capability_summary(capabilities)
    assert state["tool_support"] == support
    assert state["agent_ready"] is ready
    assert state["model_capabilities"] == (capabilities or [])


def test_capability_api_inspects_selected_existing_model_without_conversation_data(monkeypatch):
    calls = []
    def inspect(model):
        calls.append(model)
        return {"provider": "ollama", "model": model, **model_client.capability_summary(["completion", "tools"])}
    monkeypatch.setattr(routers, "inspect_model_capabilities", inspect)
    client = TestClient(main.app, base_url="http://127.0.0.1", client=("127.0.0.1", 50000))
    response = client.get("/api/model-capabilities", params={"model": "my-coder:local"})
    assert response.status_code == 200
    assert response.json()["agent_ready"] is True
    assert calls == ["my-coder:local"]


def test_capability_api_reports_unknown_model_as_actionable_client_error(monkeypatch):
    def inspect(model):
        raise ollama.OllamaError("Choose an installed local model")
    monkeypatch.setattr(routers, "inspect_model_capabilities", inspect)
    client = TestClient(main.app, base_url="http://127.0.0.1", client=("127.0.0.1", 50000))
    response = client.get("/api/model-capabilities", params={"model": "missing"})
    assert response.status_code == 400
    assert "installed local" in response.json()["detail"]


def test_compatible_inspection_checks_inventory_without_assuming_tool_support(monkeypatch):
    calls = []
    class Compatible:
        default_model = "local-coder"
        def model_capabilities(self, model, timeout):
            calls.append((model, timeout))
            return None
    monkeypatch.setattr(model_client.settings, "model_provider", "openai_compatible")
    monkeypatch.setattr(model_client, "create_model_client", lambda: Compatible())
    assert model_client.inspect_model_capabilities()["agent_ready"] is None
    assert calls == [("local-coder", 5)]
