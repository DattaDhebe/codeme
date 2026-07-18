from fastapi.testclient import TestClient

import main


def test_api_health_confirms_configured_ollama_model(monkeypatch):
    monkeypatch.setattr(main.OllamaClient, "list_models", lambda self: ["qwen2.5-coder:7b"])

    response = TestClient(main.app).get("/api/health")

    assert response.status_code == 200
    assert response.json() == {
        "status": "ok",
        "ollama": "ok",
        "model": "qwen2.5-coder:7b",
        "models": ["qwen2.5-coder:7b"],
    }
