import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from codeme_agent import changesets, crud, models, routers, schemas
from codeme_agent.db import Base, create_database_engine, get_db


@pytest.fixture
def records(tmp_path):
    engine = create_database_engine(f"sqlite:///{(tmp_path / 'lifecycle.db').as_posix()}")
    Base.metadata.create_all(engine)
    with Session(engine) as session:
        workspace = crud.create_workspace(session, "Local", str(tmp_path))
        conversation = crud.create_conversation(session)
        app = FastAPI()
        app.include_router(routers.router)

        def database():
            yield session

        app.dependency_overrides[get_db] = database
        yield session, TestClient(app), workspace, conversation
    engine.dispose()


@pytest.mark.parametrize("collection", ["conversations", "workspaces"])
@pytest.mark.parametrize("state", ["approved", "starting", "running"])
def test_active_command_records_cannot_be_deleted(records, collection, state):
    session, client, workspace, conversation = records
    command = models.CommandRun(
        id="active-command", conversation_id=conversation.id, workspace_id=workspace.id,
        profile="pytest", purpose="Test locally", status=state,
    )
    session.add(command)
    session.commit()
    owner = conversation if collection == "conversations" else workspace

    response = client.delete(f"/api/{collection}/{owner.id}")

    assert response.status_code == 409
    assert session.get(models.CommandRun, command.id) is not None
    command.status = "cancelled"
    session.commit()
    assert client.delete(f"/api/{collection}/{owner.id}").status_code == 204


def test_approved_change_cannot_lose_its_audit_during_apply(records, tmp_path):
    session, client, workspace, conversation = records
    prepared = changesets.prepare_change_set(tmp_path, "Create file", [{
        "type": "create", "relative_path": "new.txt", "content": "hello", "summary": "New file",
    }])
    proposal = changesets.persist_change_set(session, conversation.id, workspace.id, prepared)
    changesets.record_decision(session, proposal, schemas.ChangeSetDecision(decision="approve"))

    assert client.delete(f"/api/conversations/{conversation.id}").status_code == 409
    assert proposal.status == "approved"
    assert not (tmp_path / "new.txt").exists()
