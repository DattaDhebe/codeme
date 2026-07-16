import os

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from codeme_agent import crud, db, models
from codeme_agent.db import Base


@pytest.fixture(scope="module")
def engine():
    url = "sqlite:///./test_codeme.db"
    engine = create_engine(url, connect_args={"check_same_thread": False}, future=True)
    Base.metadata.create_all(bind=engine)
    yield engine
    engine.dispose()
    if os.path.exists("./test_codeme.db"):
        os.remove("./test_codeme.db")


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
