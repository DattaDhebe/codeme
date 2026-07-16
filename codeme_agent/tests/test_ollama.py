import pytest

from codeme_agent import ollama


def test_ollama_client_invalid_url(monkeypatch):
    client = ollama.OllamaClient(base_url="http://127.0.0.1:1")

    with pytest.raises(ollama.OllamaError):
        list(client.stream_chat([{"role": "user", "content": "Hello"}], model="qwen2.5-coder:7b", timeout=1))
