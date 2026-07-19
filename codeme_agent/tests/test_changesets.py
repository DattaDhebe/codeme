from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, inspect
from sqlalchemy.orm import Session, sessionmaker

from codeme_agent import agent, changesets, crud, models, schemas
from codeme_agent.config import settings
from codeme_agent.db import Base
from codeme_agent.db import get_db
from codeme_agent.routers import router


@pytest.fixture()
def workspace_root(tmp_path: Path) -> Path:
    root = tmp_path / "workspace"
    root.mkdir()
    return root


@pytest.fixture()
def session(tmp_path: Path):
    engine = create_engine(f"sqlite:///{(tmp_path / 'changes.db').as_posix()}", future=True)
    Base.metadata.create_all(engine)
    local = sessionmaker(bind=engine, future=True)()
    yield local
    local.close()
    engine.dispose()


def modify(path: str, old: str, new: str, replace_all: bool = False) -> dict:
    return {
        "type": "modify",
        "relative_path": path,
        "summary": f"Update {path}",
        "edits": [{"old_text": old, "new_text": new, "replace_all": replace_all}],
    }


def create(path: str, content: str) -> dict:
    return {"type": "create", "relative_path": path, "summary": f"Create {path}", "content": content}


def test_schema_rejects_empty_and_unknown_operation_types():
    with pytest.raises(ValueError):
        schemas.ChangeSetCreate(conversation_id=1, workspace_id=1, summary="Empty", operations=[])
    with pytest.raises(ValueError):
        schemas.ChangeOperationInput(type="delete", relative_path="a.txt", summary="Delete")


def test_modify_generates_verified_hash_diff_and_minimal_edit(workspace_root: Path):
    target = workspace_root / "app.py"
    target.write_bytes(b"value = 1\n")
    prepared = changesets.prepare_change_set(workspace_root, "Update value", [modify("app.py", "1", "2")])
    operation = prepared["operations"][0]
    assert operation["base_sha256"] == changesets.sha256_text("value = 1\n")
    assert operation["proposed_content"] == "value = 2\n"
    assert operation["proposed_sha256"] == changesets.sha256_text("value = 2\n")
    assert "-value = 1" in operation["diff"] and "+value = 2" in operation["diff"]


def test_create_requires_nonexistent_target_and_existing_parent(workspace_root: Path):
    prepared = changesets.prepare_change_set(workspace_root, "Create", [create("new.txt", "hello\n")])
    assert prepared["operations"][0]["base_sha256"] is None
    (workspace_root / "existing.txt").write_text("old", encoding="utf-8")
    with pytest.raises(changesets.ChangeSetError, match="already exists"):
        changesets.prepare_change_set(workspace_root, "Bad", [create("existing.txt", "new")])
    with pytest.raises(changesets.ChangeSetError, match="parent does not exist"):
        changesets.prepare_change_set(workspace_root, "Bad", [create("missing/new.txt", "new")])


def test_duplicate_and_conflicting_paths_are_rejected(workspace_root: Path):
    with pytest.raises(changesets.ChangeSetError, match="Duplicate"):
        changesets.prepare_change_set(workspace_root, "Duplicate", [create("A.txt", "a"), create("a.txt", "b")])


@pytest.mark.parametrize("bad_path", ["../outside.txt", "/absolute.txt", "C:\\outside.txt"])
def test_boundary_paths_are_rejected(workspace_root: Path, bad_path: str):
    with pytest.raises(changesets.ChangeSetError):
        changesets.prepare_change_set(workspace_root, "Bad", [create(bad_path, "x")])


def test_symlink_escape_is_rejected(workspace_root: Path, tmp_path: Path):
    outside = tmp_path / "outside"
    outside.mkdir()
    link = workspace_root / "linked"
    try:
        link.symlink_to(outside, target_is_directory=True)
    except OSError:
        pytest.skip("Creating symlinks is not permitted in this Windows environment")
    with pytest.raises(changesets.ChangeSetError):
        changesets.prepare_change_set(workspace_root, "Escape", [create("linked/file.txt", "x")])


def test_secret_binary_and_large_files_are_rejected(workspace_root: Path, monkeypatch):
    (workspace_root / ".env").write_text("TOKEN=redacted", encoding="utf-8")
    with pytest.raises(changesets.ChangeSetError, match="Protected"):
        changesets.prepare_change_set(workspace_root, "Secret", [modify(".env", "redacted", "changed")])

    (workspace_root / "binary.dat").write_bytes(b"\x00\x01\x02")
    with pytest.raises(changesets.ChangeSetError, match="Binary"):
        changesets.prepare_change_set(workspace_root, "Binary", [modify("binary.dat", "x", "y")])

    monkeypatch.setattr(settings, "max_file_size", 4)
    (workspace_root / "large.txt").write_text("12345", encoding="utf-8")
    with pytest.raises(changesets.ChangeSetError, match="exceeds"):
        changesets.prepare_change_set(workspace_root, "Large", [modify("large.txt", "1", "2")])


def test_malformed_ambiguous_and_overlapping_edits_are_rejected(workspace_root: Path):
    (workspace_root / "text.txt").write_text("abc abc", encoding="utf-8")
    with pytest.raises(changesets.ChangeSetError, match="did not match"):
        changesets.prepare_change_set(workspace_root, "No match", [modify("text.txt", "xyz", "x")])
    with pytest.raises(changesets.ChangeSetError, match="ambiguous"):
        changesets.prepare_change_set(workspace_root, "Ambiguous", [modify("text.txt", "abc", "x")])
    operation = modify("text.txt", "abc", "x", replace_all=True)
    operation["edits"].append({"old_text": "bc", "new_text": "z", "replace_all": True})
    with pytest.raises(changesets.ChangeSetError, match="overlap"):
        changesets.prepare_change_set(workspace_root, "Overlap", [operation])


def test_crlf_is_preserved_for_structured_new_text(workspace_root: Path):
    (workspace_root / "windows.txt").write_bytes(b"one\r\ntwo\r\n")
    prepared = changesets.prepare_change_set(workspace_root, "CRLF", [modify("windows.txt", "two\r\n", "three\nfour\n")])
    assert prepared["operations"][0]["proposed_content"] == "one\r\nthree\r\nfour\r\n"
    assert prepared["operations"][0]["line_ending"] == "crlf"


def test_legacy_whole_file_proposal_enters_hashed_change_set(workspace_root: Path):
    (workspace_root / "legacy.txt").write_bytes(b"old\n")
    prepared = changesets.prepare_legacy_change_set(workspace_root, "legacy.txt", "new\n", "Legacy update")
    operation = prepared["operations"][0]
    assert prepared["legacy"] is True
    assert operation["type"] == "modify"
    assert operation["base_sha256"] == changesets.sha256_text("old\n")


def _persist(session: Session, workspace_root: Path):
    workspace_record = crud.get_workspace_by_root(session, str(workspace_root)) or crud.create_workspace(session, "Test", str(workspace_root))
    conversation = crud.create_conversation(session, "Changes")
    (workspace_root / "app.txt").write_text("old", encoding="utf-8")
    prepared = changesets.prepare_change_set(workspace_root, "Update", [modify("app.txt", "old", "new")])
    return changesets.persist_change_set(session, conversation.id, workspace_record.id, prepared)


def test_decisions_results_and_restore_are_durable(session: Session, workspace_root: Path):
    record = _persist(session, workspace_root)
    changesets.record_decision(session, record, schemas.ChangeSetDecision(decision="approve"))
    operation = record.operations[0]
    changesets.record_apply_result(session, record, schemas.ChangeSetApplyResult(
        status="applied",
        result_hashes={operation.relative_path: operation.proposed_sha256},
        checkpoint_reference=f"{record.id}.json",
    ))
    changesets.record_restore_result(session, record, schemas.ChangeSetRestoreResult(status="restored"))
    session.expire_all()
    persisted = changesets.get_change_set(session, record.id)
    assert persisted is not None and persisted.status == "restored"
    assert [event.to_status for event in persisted.events] == ["proposed", "approved", "applying", "applied", "restored"]


def test_rejection_and_invalid_result_hash_are_recorded_or_rejected(session: Session, workspace_root: Path):
    rejected = _persist(session, workspace_root)
    changesets.record_decision(session, rejected, schemas.ChangeSetDecision(decision="reject"))
    assert rejected.status == "rejected"

    approved = _persist(session, workspace_root)
    changesets.record_decision(session, approved, schemas.ChangeSetDecision(decision="approve"))
    with pytest.raises(changesets.ChangeSetError, match="does not match"):
        changesets.record_apply_result(session, approved, schemas.ChangeSetApplyResult(
            status="applied",
            result_hashes={approved.operations[0].relative_path: "0" * 64},
            checkpoint_reference="bad.json",
        ))


def test_alembic_upgrades_an_existing_legacy_schema(tmp_path: Path):
    database = tmp_path / "legacy.db"
    engine = create_engine(f"sqlite:///{database.as_posix()}", future=True)
    Base.metadata.create_all(engine, tables=[models.Workspace.__table__, models.Conversation.__table__, models.Message.__table__])
    engine.dispose()

    config = Config(str(Path(__file__).parents[2] / "alembic.ini"))
    config.set_main_option("script_location", str(Path(__file__).parents[2] / "alembic"))
    config.set_main_option("sqlalchemy.url", f"sqlite:///{database.as_posix()}")
    command.upgrade(config, "head")

    migrated = create_engine(f"sqlite:///{database.as_posix()}", future=True)
    tables = set(inspect(migrated).get_table_names())
    migrated.dispose()
    assert {"workspaces", "conversations", "messages", "change_sets", "change_operations", "change_set_events", "alembic_version"} <= tables


def test_change_set_api_preserves_conversation_and_workspace_contracts(session: Session, workspace_root: Path):
    workspace_record = crud.create_workspace(session, "API", str(workspace_root))
    conversation = crud.create_conversation(session, "API conversation")
    (workspace_root / "api.txt").write_text("before", encoding="utf-8")

    app = FastAPI()
    app.include_router(router)

    def override_db():
        yield session

    app.dependency_overrides[get_db] = override_db
    client = TestClient(app)
    response = client.post("/api/change-sets", json={
        "conversation_id": conversation.id,
        "workspace_id": workspace_record.id,
        "summary": "API change",
        "operations": [modify("api.txt", "before", "after")],
    })
    assert response.status_code == 201
    change_set = response.json()
    assert change_set["operations"][0]["base_sha256"]
    assert client.get(f"/api/change-sets/{change_set['id']}").status_code == 200
    assert client.get("/api/conversations").status_code == 200
    assert client.get("/api/workspaces").status_code == 200


def test_change_set_api_reports_validation_and_state_conflicts(session: Session, workspace_root: Path):
    workspace_record = crud.create_workspace(session, "Conflicts", str(workspace_root))
    conversation = crud.create_conversation(session, "Conflicts")
    (workspace_root / "state.txt").write_text("before", encoding="utf-8")
    app = FastAPI()
    app.include_router(router)

    def override_db():
        yield session

    app.dependency_overrides[get_db] = override_db
    client = TestClient(app)
    invalid = client.post("/api/change-sets", json={
        "conversation_id": conversation.id,
        "workspace_id": workspace_record.id,
        "summary": "Escape",
        "operations": [create("../outside.txt", "no")],
    })
    assert invalid.status_code == 422

    created = client.post("/api/change-sets", json={
        "conversation_id": conversation.id,
        "workspace_id": workspace_record.id,
        "summary": "State",
        "operations": [modify("state.txt", "before", "after")],
    }).json()
    assert client.post(f"/api/change-sets/{created['id']}/decision", json={"decision": "reject"}).status_code == 200
    conflict = client.post(f"/api/change-sets/{created['id']}/decision", json={"decision": "approve"})
    assert conflict.status_code == 409


def test_agent_sse_preserves_legacy_fields_and_adds_persisted_change_set(session: Session, workspace_root: Path, monkeypatch):
    workspace_record = crud.create_workspace(session, "Agent", str(workspace_root))
    conversation = crud.create_conversation(session, "Agent conversation")
    (workspace_root / "legacy.txt").write_text("old", encoding="utf-8")

    class FakeAgent:
        def __init__(self, _root):
            pass

        def run(self, *_args, **_kwargs):
            yield {"type": "proposal", "kind": "file_change", "path": "legacy.txt", "content": "new", "explanation": "Update legacy"}
            yield {"type": "message", "content": "Prepared one change."}

    monkeypatch.setattr(agent, "WorkspaceAgent", FakeAgent)
    app = FastAPI()
    app.include_router(router)

    def override_db():
        yield session

    app.dependency_overrides[get_db] = override_db
    response = TestClient(app).post(f"/api/conversations/{conversation.id}/agent", json={
        "prompt": "Update legacy.txt",
        "workspace_id": workspace_record.id,
    })
    assert response.status_code == 200
    assert '"kind": "file_change"' in response.text
    assert '"path": "legacy.txt"' in response.text
    assert '"change_set"' in response.text
    persisted = session.query(models.ChangeSet).all()
    assert len(persisted) == 1 and persisted[0].operations[0].base_sha256
