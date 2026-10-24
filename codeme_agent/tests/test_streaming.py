import json

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from codeme_agent import crud, ollama, routers
from codeme_agent.db import Base, create_database_engine, get_db


class FakeClient:
    def __init__(self, chunks, failure=None):
        self.chunks = chunks
        self.failure = failure
        self.closed = False

    def stream_chat(self, _history, model=None):
        try:
            yield from self.chunks
            if self.failure:
                raise self.failure
        finally:
            self.closed = True


def test_tokens_stream_immediately_but_are_saved_before_done(monkeypatch):
    writes = []
    monkeypatch.setattr(crud, "append_message_content", lambda _db, _id, text: writes.append(text))
    monkeypatch.setattr(routers, "monotonic", lambda: 0)
    client = FakeClient(["Hello", " ", "world"])
    events = routers._chat_events(client, None, 1, [], None)

    assert json.loads(next(events).removeprefix("data: ").strip()) == "Hello"
    assert writes == []
    rest = list(events)
    assert rest[-1] == "event: done\ndata: [DONE]\n\n"
    assert writes == ["Hello world"]
    assert client.closed


def test_closing_chat_saves_partial_reply_and_closes_model_stream(monkeypatch):
    writes = []
    monkeypatch.setattr(crud, "append_message_content", lambda _db, _id, text: writes.append(text))
    client = FakeClient(["First", "Never delivered"])
    events = routers._chat_events(client, None, 1, [], None)
    assert "First" in next(events)
    events.close()
    assert writes == ["First"]
    assert client.closed


def test_model_failure_saves_partial_reply_without_false_done(monkeypatch):
    writes = []
    monkeypatch.setattr(crud, "append_message_content", lambda _db, _id, text: writes.append(text))
    client = FakeClient(["Partial"], ollama.OllamaError("Connection lost"))
    events = list(routers._chat_events(client, None, 1, [], None))
    assert writes == ["Partial"]
    assert events[-1].startswith("event: error")
    assert not any("event: done" in event for event in events)
    assert client.closed


def test_large_reply_has_bounded_pending_buffer(monkeypatch):
    writes = []
    monkeypatch.setattr(crud, "append_message_content", lambda _db, _id, text: writes.append(text))
    monkeypatch.setattr(routers, "monotonic", lambda: 0)
    list(routers._chat_events(FakeClient(["x" * 1024] * 10), None, 1, [], None))
    assert len(writes) == 5
    assert all(len(write) == 2048 for write in writes)


def test_chat_http_stream_and_reloaded_history_agree(monkeypatch, tmp_path):
    engine = create_database_engine(f"sqlite:///{(tmp_path / 'chat.db').as_posix()}")
    Base.metadata.create_all(engine)
    try:
        with Session(engine) as session:
            conversation = crud.create_conversation(session)
            app = FastAPI()
            app.include_router(routers.router)

            def database():
                yield session

            app.dependency_overrides[get_db] = database
            monkeypatch.setattr(routers, "create_model_client", lambda: FakeClient(["Local ", "response"]))
            client = TestClient(app)
            response = client.post(f"/api/conversations/{conversation.id}/chat", json={
                "messages": [{"role": "user", "content": "Review streaming"}],
            })

            assert response.status_code == 200
            assert response.headers["cache-control"] == "no-cache"
            assert response.text.endswith("event: done\ndata: [DONE]\n\n")
            history = client.get(f"/api/conversations/{conversation.id}/messages").json()
            assert [item["content"] for item in history] == ["Review streaming", "Local response"]
            assert client.get("/api/conversations").json()[0]["title"] == "Review streaming"
    finally:
        engine.dispose()
