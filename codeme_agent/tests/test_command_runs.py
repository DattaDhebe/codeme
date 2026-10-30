from datetime import datetime, timedelta
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.orm import Session, sessionmaker

from codeme_agent import agent, command_runs, crud, models, schemas
from codeme_agent.db import Base, get_db
from codeme_agent.routers import router


@pytest.fixture()
def workspace_root(tmp_path: Path) -> Path:
    root = tmp_path / "workspace"
    root.mkdir()
    (root / "subdir").mkdir()
    return root


@pytest.fixture()
def session(tmp_path: Path):
    engine = create_engine(f"sqlite:///{(tmp_path / 'commands.db').as_posix()}", future=True)
    Base.metadata.create_all(engine)
    local = sessionmaker(bind=engine, future=True)()
    yield local
    local.close()
    engine.dispose()


def proposal(**overrides):
    value = {
        "profile": "pytest",
        "arguments": ["tests", "-q"],
        "cwd_relative": ".",
        "purpose": "Run the test suite",
        "requested_timeout_seconds": 120,
        "model_risk_hint": "BUILD_OR_TEST",
    }
    value.update(overrides)
    return value


def persisted(session: Session, root: Path):
    workspace_record = crud.get_workspace_by_root(session, str(root)) or crud.create_workspace(session, "Commands", str(root))
    conversation = crud.create_conversation(session, "Commands")
    prepared = command_runs.prepare_command_run(root, proposal())
    return command_runs.persist_command_run(session, conversation.id, workspace_record.id, prepared)


def result(status="completed", **overrides):
    started = datetime.utcnow()
    value = {
        "status": status,
        "exit_code": 0 if status == "completed" else 1,
        "termination_reason": "exit",
        "started_at": started,
        "completed_at": started + timedelta(milliseconds=25),
        "duration_ms": 25,
        "stdout_tail": "ok",
        "stderr_tail": "",
        "output_truncated": False,
        "timed_out": status == "timed_out",
        "cancelled": status == "cancelled",
    }
    value.update(overrides)
    return schemas.CommandResultCreate(**value)


def test_command_schema_rejects_invalid_profiles_arguments_and_cwd(workspace_root: Path):
    with pytest.raises(ValidationError):
        schemas.CommandProposalInput(**proposal(profile="shell"))
    with pytest.raises(ValidationError):
        schemas.CommandProposalInput(**proposal(arguments=["tests && whoami"]))
    with pytest.raises(command_runs.CommandRunError):
        command_runs.prepare_command_run(workspace_root, proposal(cwd_relative="C:\\Windows"))
    with pytest.raises(command_runs.CommandRunError):
        command_runs.prepare_command_run(workspace_root, proposal(cwd_relative="../outside"))


def test_command_profiles_reject_inline_and_destructive_arguments():
    with pytest.raises(ValidationError):
        schemas.CommandProposalInput(**proposal(profile="python_module", arguments=["-c", "print(1)"]))
    with pytest.raises(ValidationError):
        schemas.CommandProposalInput(**proposal(profile="git_diff", arguments=["reset", "--hard"]))


@pytest.mark.parametrize("bad_cwd", [
    "C:\\Windows", "C:/Windows", "C:Windows", "C:", "\\Windows", "/Windows",
    "\\\\server\\share", "//server/share", "\\\\?\\C:\\Windows", "\\\\.\\C:\\Windows",
    "subdir\\..\\outside", "subdir/../outside",
])
def test_command_cwd_rejects_foreign_absolute_and_traversal_syntax(workspace_root: Path, bad_cwd: str):
    with pytest.raises(command_runs.CommandRunError):
        command_runs.prepare_command_run(workspace_root, proposal(cwd_relative=bad_cwd))


def test_command_cwd_normalizes_relative_separators_and_keeps_workspace_root(workspace_root: Path):
    (workspace_root / "subdir" / "nested folder").mkdir()
    assert command_runs.validate_cwd(workspace_root, "subdir\\nested folder") == "subdir/nested folder"
    assert command_runs.validate_cwd(workspace_root, "./subdir") == "subdir"
    assert command_runs.validate_cwd(workspace_root, ".") == "."


def test_missing_command_cwd_raises_a_controlled_domain_error(workspace_root: Path):
    with pytest.raises(command_runs.CommandRunError, match="must exist"):
        command_runs.prepare_command_run(workspace_root, proposal(cwd_relative="missing"))


def test_persistence_requires_existing_relationships(session: Session, workspace_root: Path):
    prepared = command_runs.prepare_command_run(workspace_root, proposal())
    with pytest.raises(command_runs.CommandRunError, match="Conversation"):
        command_runs.persist_command_run(session, 999, 999, prepared)


def test_approval_rejection_and_state_transitions_are_durable(session: Session, workspace_root: Path):
    record = persisted(session, workspace_root)
    approved = command_runs.record_decision(session, record, schemas.CommandDecision(
        decision="approve", calculated_risk="BUILD_OR_TEST", risk_explanation="Runs tests",
        resolved_executable_name="python", environment_keys=["PATH", "TEMP"],
    ))
    command_runs.record_event(session, approved, schemas.CommandEventCreate(status="starting"))
    command_runs.record_event(session, approved, schemas.CommandEventCreate(status="running"))
    completed = command_runs.record_result(session, approved, result())
    assert completed.status == "completed"
    assert [event.to_status for event in completed.events] == ["proposed", "approved", "starting", "running", "completed"]

    other = persisted(session, workspace_root)
    rejected = command_runs.record_decision(session, other, schemas.CommandDecision(
        decision="reject", calculated_risk="BUILD_OR_TEST", risk_explanation="User rejected",
    ))
    assert rejected.status == "rejected" and rejected.decision == "reject"
    with pytest.raises(command_runs.CommandRunError):
        command_runs.record_event(session, rejected, schemas.CommandEventCreate(status="starting"))


def test_blocked_command_cannot_be_approved(session: Session, workspace_root: Path):
    record = persisted(session, workspace_root)
    with pytest.raises(command_runs.CommandRunError, match="blocked"):
        command_runs.record_decision(session, record, schemas.CommandDecision(
            decision="approve", calculated_risk="BLOCKED", risk_explanation="Destructive",
        ))


def test_event_output_bounds_redaction_and_idempotent_result(session: Session, workspace_root: Path):
    record = persisted(session, workspace_root)
    approved = command_runs.record_decision(session, record, schemas.CommandDecision(
        decision="approve", calculated_risk="BUILD_OR_TEST", risk_explanation="Runs tests",
    ))
    with pytest.raises(ValidationError):
        schemas.CommandEventCreate(status="starting", detail="x" * 8001)
    with pytest.raises(ValidationError):
        schemas.CommandDecision(
            decision="approve", calculated_risk="BUILD_OR_TEST", risk_explanation="Runs tests",
            environment_keys=["AUTH_TOKEN"],
        )
    command_runs.record_event(session, approved, schemas.CommandEventCreate(
        status="starting", detail="TOKEN=do-not-store " + "x" * 4000,
    ))
    request = result(
        stdout_tail="x" * 80_000 + "\nPASSWORD=top-secret",
        stderr_tail="API_KEY=hidden",
        output_truncated=True,
    )
    completed = command_runs.record_result(session, approved, request)
    assert len(completed.stdout_tail) <= command_runs.OUTPUT_TAIL_LIMIT
    assert "top-secret" not in completed.stdout_tail
    assert "hidden" not in completed.stderr_tail
    assert "do-not-store" not in completed.events[-2].detail
    assert command_runs.record_result(session, completed, request).id == completed.id
    with pytest.raises(command_runs.CommandRunError, match="conflicting"):
        command_runs.record_result(session, completed, result(stdout_tail="different"))


def _alembic_config(database: Path) -> Config:
    config = Config(str(Path(__file__).parents[2] / "alembic.ini"))
    config.set_main_option("script_location", str(Path(__file__).parents[2] / "alembic"))
    config.set_main_option("sqlalchemy.url", f"sqlite:///{database.as_posix()}")
    return config


def test_migration_from_0001_preserves_existing_data(tmp_path: Path):
    database = tmp_path / "from-0001.db"
    config = _alembic_config(database)
    command.upgrade(config, "0001_change_sets")
    engine = create_engine(f"sqlite:///{database.as_posix()}", future=True)
    with engine.begin() as connection:
        connection.execute(text(
            "INSERT INTO conversations (id, title, created_at, updated_at) VALUES (1, 'kept', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)"
        ))
    command.upgrade(config, "head")
    with engine.connect() as connection:
        assert connection.scalar(text("SELECT title FROM conversations WHERE id=1")) == "kept"
    assert {"command_runs", "command_run_events"} <= set(inspect(engine).get_table_names())
    engine.dispose()


def test_clean_database_migrates_to_command_schema(tmp_path: Path):
    database = tmp_path / "clean.db"
    command.upgrade(_alembic_config(database), "head")
    engine = create_engine(f"sqlite:///{database.as_posix()}", future=True)
    tables = set(inspect(engine).get_table_names())
    engine.dispose()
    assert {"workspaces", "conversations", "change_sets", "command_runs", "command_run_events"} <= tables


def test_phase5_downgrade_removes_only_command_tables(tmp_path: Path):
    database = tmp_path / "downgrade.db"
    config = _alembic_config(database)
    command.upgrade(config, "head")
    engine = create_engine(f"sqlite:///{database.as_posix()}", future=True)
    with engine.begin() as connection:
        connection.execute(text(
            "INSERT INTO conversations (id, title, created_at, updated_at) VALUES (1, 'kept', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)"
        ))
    engine.dispose()
    command.downgrade(config, "0001_change_sets")
    engine = create_engine(f"sqlite:///{database.as_posix()}", future=True)
    tables = set(inspect(engine).get_table_names())
    with engine.connect() as connection:
        assert connection.scalar(text("SELECT title FROM conversations WHERE id=1")) == "kept"
    engine.dispose()
    assert "change_sets" in tables
    assert "command_runs" not in tables and "command_run_events" not in tables


def test_agent_sse_persists_structured_command_and_preserves_existing_apis(session: Session, workspace_root: Path, monkeypatch):
    workspace_record = crud.create_workspace(session, "Agent command", str(workspace_root))
    conversation = crud.create_conversation(session, "Agent command")
    prepared = command_runs.prepare_command_run(workspace_root, proposal())

    class FakeAgent:
        def __init__(self, _root):
            pass

        def run(self, *_args, **_kwargs):
            yield {"type": "proposal", "kind": "command_proposal", "command_run": prepared}
            yield {"type": "message", "content": "Prepared a controlled command."}

    monkeypatch.setattr(agent, "WorkspaceAgent", FakeAgent)
    app = FastAPI()
    app.include_router(router)

    def override_db():
        yield session

    app.dependency_overrides[get_db] = override_db
    client = TestClient(app)
    response = client.post(f"/api/conversations/{conversation.id}/agent", json={
        "prompt": "Run tests", "workspace_id": workspace_record.id,
    })
    assert response.status_code == 200
    assert '"kind": "command_proposal"' in response.text
    assert '"profile": "pytest"' in response.text
    record = session.query(models.CommandRun).one()
    assert record.status == "proposed"
    assert client.get(f"/api/command-runs/{record.id}").status_code == 200
    decision = {
        "decision": "approve", "calculated_risk": "BUILD_OR_TEST", "risk_explanation": "Runs tests",
        "resolved_executable_name": "python", "environment_keys": ["PATH"],
    }
    assert client.post(f"/api/command-runs/{record.id}/decision", json=decision).status_code == 200
    assert client.post(f"/api/command-runs/{record.id}/events", json={"status": "starting"}).status_code == 200
    assert client.post(f"/api/command-runs/{record.id}/events", json={"status": "running"}).status_code == 200
    result_body = result().model_dump(mode="json")
    assert client.post(f"/api/command-runs/{record.id}/result", json=result_body).status_code == 200
    assert client.post(f"/api/command-runs/{record.id}/result", json=result_body).status_code == 200
    conflicting = {**result_body, "stdout_tail": "different"}
    assert client.post(f"/api/command-runs/{record.id}/result", json=conflicting).status_code == 409
    assert client.get("/api/conversations").status_code == 200
    assert client.get("/api/workspaces").status_code == 200
