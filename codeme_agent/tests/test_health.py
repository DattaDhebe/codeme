from fastapi.testclient import TestClient

import main


def test_api_health_confirms_configured_ollama_model(monkeypatch):
    monkeypatch.setattr(main.OllamaClient, "list_models", lambda self: ["qwen2.5-coder:7b"])

    response = TestClient(main.app, base_url="http://127.0.0.1", client=("127.0.0.1", 50000)).get("/api/health")

    assert response.status_code == 200
    assert response.json() == {
        "status": "ok",
        "ollama": "ok",
        "provider": "ollama",
        "model": "qwen2.5-coder:7b",
        "models": ["qwen2.5-coder:7b"],
    }


def test_health_selects_compatible_provider_and_retains_legacy_status(monkeypatch):
    class Client:
        def list_models(self):
            return ["local-coder"]
    monkeypatch.setattr(main.settings, "model_provider", "openai_compatible")
    monkeypatch.setattr(main.settings, "default_model", "local-coder")
    monkeypatch.setattr(main, "create_model_client", lambda: Client())
    response = TestClient(main.app, base_url="http://127.0.0.1", client=("127.0.0.1", 50000)).get("/api/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok", "ollama": "ok", "provider": "openai_compatible", "model": "local-coder", "models": ["local-coder"]}


def test_health_accepts_native_ollama_latest_alias(monkeypatch):
    monkeypatch.setattr(main.settings, "default_model", "coder")
    monkeypatch.setattr(main.OllamaClient, "list_models", lambda self: ["coder:latest"])
    response = TestClient(main.app, base_url="http://127.0.0.1", client=("127.0.0.1", 50000)).get("/api/health")
    assert response.status_code == 200


def test_health_reports_selected_provider_inventory_errors(monkeypatch):
    def unavailable():
        raise main.OllamaError("local server offline")
    monkeypatch.setattr(main, "create_model_client", unavailable)
    response = TestClient(main.app, base_url="http://127.0.0.1", client=("127.0.0.1", 50000)).get("/api/health")
    assert response.status_code == 503
    assert response.json()["ollama"] == "unavailable"


def test_health_reports_missing_configured_model(monkeypatch):
    monkeypatch.setattr(main.OllamaClient, "list_models", lambda self: ["other:latest"])
    response = TestClient(main.app, base_url="http://127.0.0.1", client=("127.0.0.1", 50000)).get("/api/health")
    assert response.status_code == 503
    assert response.json()["ollama"] == "ok"
