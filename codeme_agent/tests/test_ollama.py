import pytest

from codeme_agent import ollama


def local_entry(name="qwen2.5-coder:7b", **overrides):
    return {"name": name, "size": 1_000_000, "details": {"format": "gguf"}, **overrides}


@pytest.fixture(autouse=True)
def local_model_inventory(monkeypatch):
    class Response:
        status_code = 200
        def json(self):
            return {"models": [local_entry()]}
    monkeypatch.setattr(ollama.httpx, "get", lambda *args, **kwargs: Response())


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
        "options": {"num_ctx": ollama.settings.ollama_context_length},
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


@pytest.mark.parametrize("url", ["https://example.com", "http://192.168.1.2:11434", "http://localhost.example.com:11434"])
def test_ollama_client_rejects_remote_model_urls(url):
    with pytest.raises(ollama.OllamaError):
        ollama.OllamaClient(base_url=url)


def test_ollama_requests_ignore_proxy_environment(monkeypatch):
    captured = {}
    def fake_stream(method, url, **kwargs):
        captured.update(kwargs)
        return FakeStreamResponse()
    monkeypatch.setattr(ollama.httpx, "stream", fake_stream)
    list(ollama.OllamaClient().stream_chat([{"role": "user", "content": "private"}]))
    assert captured["trust_env"] is False


def test_incomplete_ollama_stream_is_reported_as_failure(monkeypatch):
    class IncompleteResponse(FakeStreamResponse):
        def iter_lines(self):
            return iter(['{"message":{"content":"partial"},"done":false}'])
    monkeypatch.setattr(ollama.httpx, "stream", lambda *args, **kwargs: IncompleteResponse())
    chunks = ollama.OllamaClient().stream_chat([])
    assert next(chunks) == "partial"
    with pytest.raises(ollama.OllamaError, match="before completion"):
        next(chunks)


@pytest.mark.parametrize("payload", [[], None, {"message": {"content": []}}, {"message": {"tool_calls": {}}}])
def test_ollama_invalid_tool_response_is_a_controlled_error(monkeypatch, payload):
    class Response:
        status_code = 200
        def json(self):
            return payload
    monkeypatch.setattr(ollama.httpx, "post", lambda *args, **kwargs: Response())
    with pytest.raises(ollama.OllamaError):
        ollama.OllamaClient().chat_with_tools([], [])


def test_ollama_model_inventory_handles_invalid_entries(monkeypatch):
    captured = {}
    class Response:
        status_code = 200
        def json(self):
            return {"models": [None, local_entry("coder"), {"name": 2}, local_entry("coder")]}
    def get(url, **kwargs):
        captured.update(kwargs)
        return Response()
    monkeypatch.setattr(ollama.httpx, "get", get)
    assert ollama.OllamaClient().list_models() == ["coder"]
    assert captured["trust_env"] is False


@pytest.mark.parametrize("entry", [
    local_entry("coder:cloud"), local_entry("coder:7b-cloud"),
    local_entry("innocent-alias:latest", remote_host="https://ollama.com"),
    local_entry("innocent-alias:latest", remote_model="remote-coder"),
    {"name": "coder:latest"}, local_entry("coder:latest", size=0),
])
def test_cloud_and_unknown_models_are_hidden_and_never_receive_prompts(monkeypatch, entry):
    class Response:
        status_code = 200
        def json(self):
            return {"models": [entry]}
    monkeypatch.setattr(ollama.httpx, "get", lambda *args, **kwargs: Response())
    def no_prompt(*args, **kwargs):
        pytest.fail("Unverified model must never receive prompts")
    monkeypatch.setattr(ollama.httpx, "post", no_prompt)
    monkeypatch.setattr(ollama.httpx, "stream", no_prompt)
    client = ollama.OllamaClient()
    assert client.list_models() == []
    with pytest.raises(ollama.OllamaError):
        client.chat_with_tools([{"role": "user", "content": "private source code"}], [], model=entry["name"])
    with pytest.raises(ollama.OllamaError):
        list(client.stream_chat([], model=entry["name"]))


def test_local_model_preflight_is_cached_for_agent_turns_and_accepts_latest_alias(monkeypatch):
    calls = []
    class Response:
        status_code = 200
        def json(self):
            return {"models": [local_entry("coder:latest")]}
    def inventory(*args, **kwargs):
        calls.append("inventory")
        return Response()
    class ChatResponse:
        status_code = 200
        def json(self):
            return {"message": {"role": "assistant", "content": "done"}}
    monkeypatch.setattr(ollama.httpx, "get", inventory)
    monkeypatch.setattr(ollama.httpx, "post", lambda *args, **kwargs: ChatResponse())
    client = ollama.OllamaClient()
    client.chat_with_tools([], [], model="coder")
    client.chat_with_tools([], [], model="coder:latest")
    assert calls == ["inventory"]


def test_local_model_preflight_fails_closed_when_inventory_unavailable(monkeypatch):
    def unavailable(*args, **kwargs):
        raise ollama.httpx.ConnectError("offline")
    monkeypatch.setattr(ollama.httpx, "get", unavailable)
    monkeypatch.setattr(ollama.httpx, "post", lambda *args, **kwargs: pytest.fail("Prompt must not be sent"))
    with pytest.raises(ollama.OllamaError, match="Unable to query"):
        ollama.OllamaClient().chat_with_tools([], [])



def test_tool_chat_merges_local_context_setting_with_repair_options(monkeypatch):
    captured = {}
    class Response:
        status_code = 200
        def json(self):
            return {"message": {"role": "assistant", "content": "done"}}
    def post(url, **kwargs):
        captured.update(kwargs)
        return Response()
    monkeypatch.setattr(ollama.httpx, "post", post)
    monkeypatch.setattr(ollama.settings, "ollama_context_length", 4096)
    ollama.OllamaClient().chat_with_tools([], [], options={"temperature": 0, "seed": 6})
    assert captured["json"]["options"] == {"num_ctx": 4096, "temperature": 0, "seed": 6}
