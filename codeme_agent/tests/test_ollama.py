import pytest

from codeme_agent import ollama


class FakeStreamResponse:
    status_code = 200

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_value, traceback):
        return False

    def iter_lines(self):
        return iter([
            '{"message":{"role":"assistant","content":"Hello"},"done":false}',
            '{"message":{"role":"assistant","content":" world"},"done":false}',
            '{"message":{"role":"assistant","content":""},"done":true}',
        ])


def test_ollama_client_invalid_url(monkeypatch):
    client = ollama.OllamaClient(base_url="http://127.0.0.1:1")

    with pytest.raises(ollama.OllamaError):
        list(client.stream_chat([{"role": "user", "content": "Hello"}], model="qwen2.5-coder:7b", timeout=1))


def test_ollama_client_uses_native_chat_api(monkeypatch):
    captured = {}

    def fake_stream(method, url, **kwargs):
        captured.update(method=method, url=url, **kwargs)
        return FakeStreamResponse()

    monkeypatch.setattr(ollama.httpx, "stream", fake_stream)
    client = ollama.OllamaClient(base_url="http://127.0.0.1:11434/")

    chunks = list(client.stream_chat([{"role": "user", "content": "Hello"}], model="qwen2.5-coder:7b"))

    assert chunks == ["Hello", " world"]
    assert captured["method"] == "POST"
    assert captured["url"] == "http://127.0.0.1:11434/api/chat"
    assert captured["json"] == {
        "model": "qwen2.5-coder:7b",
        "messages": [{"role": "user", "content": "Hello"}],
        "stream": True,
    }


def test_ollama_client_uses_native_tools(monkeypatch):
    captured = {}

    class FakeResponse:
        status_code = 200
        text = ""

        def json(self):
            return {"message": {"role": "assistant", "content": "done"}}

    def fake_post(url, **kwargs):
        captured.update(url=url, **kwargs)
        return FakeResponse()

    monkeypatch.setattr(ollama.httpx, "post", fake_post)
    client = ollama.OllamaClient(base_url="http://127.0.0.1:11434/")
    tools = [{"type": "function", "function": {"name": "read_file"}}]

    message = client.chat_with_tools([{"role": "user", "content": "inspect"}], tools, model="qwen2.5-coder:7b")

    assert message["content"] == "done"
    assert captured["url"] == "http://127.0.0.1:11434/api/chat"
    assert captured["json"]["tools"] == tools
    assert captured["json"]["stream"] is False
