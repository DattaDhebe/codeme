import pytest
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from codeme_agent import changesets, crud, db, models
from codeme_agent.db import Base


@pytest.fixture()
def engine(tmp_path):
    url = f"sqlite:///{(tmp_path / 'test_codeme.db').as_posix()}"
    engine = db.create_database_engine(url)
    Base.metadata.create_all(bind=engine)
    yield engine
    engine.dispose()


@pytest.fixture()
def session(engine):
    SessionLocal = db.sessionmaker(bind=engine, autoflush=False, future=True)
    session = SessionLocal()
    yield session
    session.close()


def test_create_and_list_conversation(session: Session):
    conversation = crud.create_conversation(session, title="Test conversation")
    assert conversation.id is not None
    assert conversation.title == "Test conversation"

    conversations = crud.list_conversations(session)
    assert any(item.id == conversation.id for item in conversations)


def test_rename_conversation(session: Session):
    conversation = crud.create_conversation(session, title="Rename me")
    renamed = crud.rename_conversation(session, conversation.id, "Renamed")
    assert renamed.title == "Renamed"


def test_delete_conversation(session: Session):
    conversation = crud.create_conversation(session, title="Delete me")
    crud.delete_conversation(session, conversation.id)
    assert crud.get_conversation(session, conversation.id) is None


def test_explicit_sqlite_driver_enables_foreign_keys(tmp_path):
    engine = db.create_database_engine(f"sqlite+pysqlite:///{(tmp_path / 'driver.db').as_posix()}")
    try:
        with engine.connect() as connection:
            assert connection.scalar(text("PRAGMA foreign_keys")) == 1
    finally:
        engine.dispose()


def test_messages_refresh_history_title_and_conversation_order(session: Session):
    first = crud.create_conversation(session)
    second = crud.create_conversation(session, "Other task")
    assert crud.get_messages(session, first.id) == []

    user = crud.add_message(session, first.id, "user", "  Fix the\n streaming issue  ")
    reply = crud.add_message(session, first.id, "assistant", "")
    crud.append_message_content(session, reply.id, "Investigated and fixed.")

    assert first.title == "Fix the streaming issue"
    assert crud.list_conversations(session)[0].id == first.id
    assert [item.id for item in crud.get_messages(session, first.id)] == [user.id, reply.id]
    assert second.title == "Other task"


def test_manual_conversation_title_is_preserved(session: Session):
    conversation = crud.create_conversation(session, "My project")
    crud.add_message(session, conversation.id, "user", "Rewrite this title")
    assert conversation.title == "My project"


def test_model_history_is_bounded_without_deleting_stored_messages(session: Session):
    conversation = crud.create_conversation(session)
    for index in range(45):
        crud.add_message(session, conversation.id, "user", f"Message {index}: " + "x" * 1000)
    crud.add_message(session, conversation.id, "assistant", "")

    history = crud.get_conversation_messages_for_model(session, conversation.id)

    assert 0 < len(history) <= 40
    assert sum(len(message["content"]) for message in history) <= 32_000
    assert history[-1]["content"].startswith("Message 44:")
    assert len(crud.get_messages(session, conversation.id)) == 46


def test_deleting_conversation_cascades_messages_and_proposals(session: Session, tmp_path):
    workspace = crud.create_workspace(session, "Test", str(tmp_path))
    conversation = crud.create_conversation(session, "Delete all chat data")
    message = crud.add_message(session, conversation.id, "user", "Create a file")
    prepared = changesets.prepare_change_set(tmp_path, "New file", [{
        "type": "create", "relative_path": "new.txt", "content": "hello", "summary": "New file",
    }])
    proposal = changesets.persist_change_set(session, conversation.id, workspace.id, prepared)
    message_id, proposal_id = message.id, proposal.id

    crud.delete_conversation(session, conversation.id)
    session.expire_all()

    assert session.scalar(select(models.Message).where(models.Message.id == message_id)) is None
    assert session.scalar(select(models.ChangeSet).where(models.ChangeSet.id == proposal_id)) is None
    assert session.scalar(select(models.ChangeOperation)) is None
    assert session.scalar(select(models.ChangeSetEvent)) is None
    assert crud.get_workspace(session, workspace.id) is not None
