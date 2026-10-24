"""Protocol and isolation checks independent of an installed model daemon."""

import json
from contextlib import closing

import httpx
import pytest
from pydantic import ValidationError

from codeme_agent import local_models, model_client, ollama
from codeme_agent.config import Settings
from codeme_agent.model_messages import VisibleText, compatible_messages, normalize_assistant


class Response:
    status_code = 200

    def __init__(self, payload, status=200):
        self.payload = payload
        self.status_code = status

    def json(self):
        return self.payload


@pytest.fixture
def inventory(monkeypatch):
    calls = []
    def get(url, **kwargs):
        calls.append((url, kwargs))
        return Response({"data": [{"id": "local-coder", "owned_by": "huggingface"}]})
    monkeypatch.setattr(local_models.httpx, "get", get)
    return calls


def completion(message=None, finish="stop"):
    return {"choices": [{"index": 0, "message": message or {"role": "assistant", "content": "Done"}, "finish_reason": finish}]}


def delta(content=None, finish=None, **extra):
    return {"choices": [{"index": 0, "delta": {"content": content, **extra}, "finish_reason": finish}]}


class ByteStream(httpx.SyncByteStream):
    def __init__(self, chunks):
        self.chunks = chunks

    def __iter__(self):
        yield from self.chunks


def stream_response(events, *, fragmented=False, terminal=True):
    text = ": keepalive\r\n\r\n" + "".join("data: " + json.dumps(item) + "\r\n\r\n" for item in events)
    if terminal:
        text += "data: [DONE]\r\n\r\n"
    encoded = text.encode()
    chunks = [encoded[offset:offset + 3] for offset in range(0, len(encoded), 3)] if fragmented else [encoded]
    return closing(httpx.Response(200, stream=ByteStream(chunks)))


def client():
    return local_models.LocalCompatibleClient(default_model="local-coder")


@pytest.mark.parametrize("url", [
    "https://api.openai.com/v1", "http://192.168.1.20:1234/v1", "http://0.0.0.0:1234/v1",
    "http://token@localhost:1234/v1", "http://localhost:1234/v1?api_key=secret", "http://localhost:1234/v1#secret",
])
def test_compatible_provider_rejects_nonlocal_authenticated_or_ambiguous_urls(url):
    with pytest.raises(ollama.OllamaError):
        local_models.LocalCompatibleClient(base_url=url)
    with pytest.raises(ValidationError):
        Settings(_env_file=None, local_model_url=url)


def test_factory_selects_only_supported_local_providers(monkeypatch):
    monkeypatch.setattr(model_client.settings, "model_provider", "ollama")
    assert isinstance(model_client.create_model_client(), ollama.OllamaClient)
    monkeypatch.setattr(model_client.settings, "model_provider", "openai_compatible")
    assert isinstance(model_client.create_model_client(), local_models.LocalCompatibleClient)
    with pytest.raises(ValidationError):
        Settings(_env_file=None, model_provider="openai")


def test_loopback_default_paths_and_inventory_transport_are_safe(inventory):
    assert local_models.LocalCompatibleClient(base_url="http://127.0.0.1:8080").base_url == "http://127.0.0.1:8080/v1"
    assert client().list_models() == ["local-coder"]
    url, options = inventory[0]
    assert url == "http://127.0.0.1:1234/v1/models"
    assert options["trust_env"] is False and options["follow_redirects"] is False
    assert "headers" not in options and "auth" not in options


@pytest.mark.parametrize("entry", [
    {"id": "coder:cloud"}, {"id": "coder-7b-cloud"}, {"id": "alias", "remote_host": "https://example.com"},
    {"id": "alias", "meta": {"remote_model": "model"}}, {"id": "alias", "cloud": True},
    {"id": "alias", "backend": "openai"}, {"id": "alias", "is_remote": True},
])
def test_explicit_cloud_inventory_never_receives_prompts(monkeypatch, entry):
    monkeypatch.setattr(local_models.httpx, "get", lambda *args, **kwargs: Response({"data": [entry]}))
    monkeypatch.setattr(local_models.httpx, "post", lambda *args, **kwargs: pytest.fail("Private prompt must stay local"))
    assert client().list_models() == []
    with pytest.raises(ollama.OllamaError):
        client().chat_with_tools([{"role": "user", "content": "private code"}], [], model=entry["id"])


@pytest.mark.parametrize("payload", [None, [], {"data": {}}, {"data": None}])
def test_invalid_inventory_fails_closed(monkeypatch, payload):
    monkeypatch.setattr(local_models.httpx, "get", lambda *args, **kwargs: Response(payload))
    monkeypatch.setattr(local_models.httpx, "post", lambda *args, **kwargs: pytest.fail("No prompt on failed preflight"))
    with pytest.raises(ollama.OllamaError, match="inventory"):
        client().chat_with_tools([], [])


def test_inventory_rechecks_before_each_prompt_and_refuses_redirect(monkeypatch, inventory):
    monkeypatch.setattr(local_models.httpx, "post", lambda *args, **kwargs: Response(completion()))
    model = client()
    model.chat_with_tools([], [])
    model.chat_with_tools([], [])
    assert len(inventory) == 2
    monkeypatch.setattr(local_models.httpx, "get", lambda *args, **kwargs: Response({}, 302))
    with pytest.raises(ollama.OllamaError, match="302"):
        model.chat_with_tools([], [])


def test_tool_calls_are_normalized_without_private_reasoning(monkeypatch, inventory):
    message = {
        "role": "assistant", "content": [{"type": "reasoning", "text": "private"}, {"type": "text", "text": "<think>secret</think>Inspecting"}],
        "reasoning_content": "private reasoning", "thinking": "hidden",
        "tool_calls": [{"id": "first", "type": "function", "function": {"name": "read_file", "arguments": '{"path":"one.py"}'}},
                       {"id": "second", "type": "function", "function": {"name": "read_file", "arguments": {"path": "two.py"}}}],
    }
    captured = {}
    def post(url, **kwargs):
        captured.update(url=url, **kwargs)
        return Response(completion(message, "tool_calls"))
    monkeypatch.setattr(local_models.httpx, "post", post)
    result = client().chat_with_tools([], [{"type": "function", "function": {"name": "read_file"}}], options={"num_ctx": 4096, "seed": 7, "num_predict": 200})
    assert result["content"] == "Inspecting"
    assert "reasoning_content" not in result and "thinking" not in result
    assert [call["id"] for call in result["tool_calls"]] == ["first", "second"]
    assert result["tool_calls"][0]["function"]["arguments"] == {"path": "one.py"}
    assert captured["url"].endswith("/v1/chat/completions")
    assert captured["trust_env"] is False and captured["follow_redirects"] is False
    assert captured["json"]["seed"] == 7 and captured["json"]["max_tokens"] == 200
    assert "num_ctx" not in captured["json"] and "api_key" not in captured["json"]


def test_two_results_replay_with_original_call_ids(monkeypatch, inventory):
    assistant = normalize_assistant({"tool_calls": [
        {"id": "one", "function": {"name": "read_file", "arguments": {"path": "a"}}},
        {"id": "two", "function": {"name": "read_file", "arguments": {"path": "b"}}},
    ]})
    captured = {}
    def post(url, **kwargs):
        captured.update(kwargs)
        return Response(completion())
    monkeypatch.setattr(local_models.httpx, "post", post)
    messages = [assistant, {"role": "tool", "tool_call_id": "one", "tool_name": "read_file", "content": "A"},
                {"role": "tool", "tool_call_id": "two", "tool_name": "read_file", "content": "B"}]
    client().chat_with_tools(messages, [])
    sent = captured["json"]["messages"]
    assert sent[0]["tool_calls"][0]["function"]["arguments"] == '{"path": "a"}'
    assert [message["tool_call_id"] for message in sent[1:]] == ["one", "two"]
    assert [message["name"] for message in sent[1:]] == ["read_file", "read_file"]
    with pytest.raises(ValueError, match="tool_call_id"):
        compatible_messages([{"role": "tool", "content": "orphan"}])
    with pytest.raises(ValueError, match="text content"):
        compatible_messages([{"role": "user", "content": [{"type": "image_url", "image_url": {"url": "https://example.com/private"}}]}])


@pytest.mark.parametrize("payload", [None, {}, {"error": {"message": "prompt secret"}}, {"choices": []},
    completion(finish="length"), completion(finish="content_filter"), completion(finish=[]),
    completion({"role": "assistant", "content": {}, "tool_calls": []}),
    completion({"role": "assistant", "tool_calls": [{"function": {"name": "read_file", "arguments": "[]"}}]}),
])
def test_malformed_and_incomplete_generation_is_controlled(monkeypatch, inventory, payload):
    monkeypatch.setattr(local_models.httpx, "post", lambda *args, **kwargs: Response(payload))
    with pytest.raises(ollama.OllamaError):
        client().chat_with_tools([], [])


def test_sse_handles_fragmented_bytes_content_parts_and_reasoning(monkeypatch, inventory):
    events = [delta(None, reasoning_content="private"), delta("<thi"), delta("nk>secret"),
              delta("</think>Hi "), delta([{"type": "text", "text": "world"}, {"type": "reasoning", "text": "secret"}]), delta(None, "stop")]
    monkeypatch.setattr(local_models.httpx, "stream", lambda *args, **kwargs: stream_response(events, fragmented=True))
    assert "".join(client().stream_chat([])) == "Hi world"


@pytest.mark.parametrize("events, terminal", [([delta("partial")], False), ([delta("partial")], True),
    ([delta("partial"), delta(None, "length")], True), ([delta(None, "content_filter")], True),
    ([delta(None, tool_calls=[{"id": "unexpected"}])], True), ([{"error": "private prompt"}], True),
])
def test_incomplete_or_invalid_sse_does_not_succeed(monkeypatch, inventory, events, terminal):
    monkeypatch.setattr(local_models.httpx, "stream", lambda *args, **kwargs: stream_response(events, terminal=terminal))
    with pytest.raises(ollama.OllamaError):
        list(client().stream_chat([]))


def test_sse_finish_reason_at_eof_is_valid_without_done_sentinel(monkeypatch, inventory):
    monkeypatch.setattr(local_models.httpx, "stream", lambda *args, **kwargs: stream_response([delta("Done"), delta(None, "stop")], terminal=False))
    assert "".join(client().stream_chat([])) == "Done"


def test_visible_text_filters_nested_unclosed_and_fragmented_blocks():
    sanitizer = VisibleText()
    assert sanitizer.feed("Shown <ana") == "Shown "
    assert sanitizer.feed("lysis>private<think>hidden</think>") == ""
    assert sanitizer.feed("</analysis>Answer") == "Answer"
    assert sanitizer.feed("<think>unfinished", final=True) == ""
    assert normalize_assistant({"content": "<think>secret</think>Answer", "thinking": "secret"}) == {"role": "assistant", "content": "Answer"}


def test_duplicate_call_ids_are_rejected():
    call = {"id": "same", "function": {"name": "read_file", "arguments": {}}}
    with pytest.raises(ValueError, match="duplicate"):
        normalize_assistant({"tool_calls": [call, call]})
