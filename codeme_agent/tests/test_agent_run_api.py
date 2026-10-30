import json
from datetime import datetime, timedelta

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from codeme_agent import agent, changesets, command_runs, crud, models, routers
from codeme_agent.db import Base, create_database_engine, get_db


@pytest.fixture
def api(tmp_path):
    engine = create_database_engine(f"sqlite:///{(tmp_path / 'agent-api.db').as_posix()}")
    Base.metadata.create_all(engine)
    with Session(engine) as session:
        workspace = crud.create_workspace(session, "Project", str(tmp_path))
        conversation = crud.create_conversation(session)
        app = FastAPI()
        app.include_router(routers.router)

        def database():
            yield session

        app.dependency_overrides[get_db] = database
        yield TestClient(app), session, workspace, conversation, tmp_path
    engine.dispose()


def events(response):
    assert response.status_code == 200, response.text
    result = []
    for frame in response.text.split("\n\n"):
        for line in frame.splitlines():
            if line.startswith("data: ") and line != "data: [DONE]":
                result.append(json.loads(line[6:]))
    assert response.text.endswith("event: done\ndata: [DONE]\n\n")
    return result


def install_change_agent(monkeypatch, verification_proposal=False):
    observations = []

    class FakeAgent:
        def __init__(self, root):
            self.root = root

        def run(self, goal, _history, **kwargs):
            observations.append((goal, kwargs))
            yield {"type": "plan", "steps": [{"id": "work", "description": "Implement and verify", "status": "in_progress"}]}
            if len(observations) == 1:
                prepared = changesets.prepare_change_set(self.root, "Create feature", [{
                    "type": "create", "relative_path": "feature.py", "content": "VALUE = 2\n", "summary": "Add feature",
                }])
                yield {"type": "proposal", "kind": "change_set", "change_set": prepared}
                yield {"type": "outcome", "status": "completed", "summary": "Unsupported premature completion"}
            elif verification_proposal and len(observations) == 2:
                prepared = command_runs.prepare_command_run(self.root, {
                    "profile": "pytest", "arguments": [], "cwd_relative": ".", "purpose": "Verify current task files",
                })
                yield {"type": "proposal", "kind": "command_proposal", "command_run": prepared}
                yield {"type": "outcome", "status": "awaiting_approval", "summary": "Approve verification"}
            else:
                yield {"type": "plan", "steps": [{"id": "work", "description": "Implement and verify", "status": "completed"}]}
                yield {"type": "outcome", "status": "completed", "summary": "Implemented and verified the feature"}
                yield {"type": "message", "content": "Implemented and verified the feature"}

    monkeypatch.setattr(agent, "WorkspaceAgent", FakeAgent)
    return observations


def start_change_task(api, monkeypatch, verification_proposal=False):
    client, _session, workspace, conversation, _root = api
    observations = install_change_agent(monkeypatch, verification_proposal)
    emitted = events(client.post(f"/api/conversations/{conversation.id}/agent", json={
        "prompt": "Implement the local feature", "workspace_id": workspace.id,
    }))
    run = [event["run"] for event in emitted if event["type"] == "task"][-1]
    change = next(event["change_set"] for event in emitted if event["type"] == "proposal")
    return run, change, observations, emitted


def apply_change(api, change):
    client, _session, _workspace, _conversation, root = api
    assert client.post(f"/api/change-sets/{change['id']}/decision", json={"decision": "approve"}).status_code == 200
    for operation in change["operations"]:
        (root / operation["relative_path"]).write_bytes(operation["proposed_content"].encode("utf-8"))
    assert client.post(f"/api/change-sets/{change['id']}/result", json={
        "status": "applied", "checkpoint_reference": "test-checkpoint.json",
        "result_hashes": {operation["relative_path"]: operation["proposed_sha256"] for operation in change["operations"]},
    }).status_code == 200


def verify_change(api, change):
    client, _session, workspace, conversation, _root = api
    response = client.post("/api/verification-sessions", json={
        "conversation_id": conversation.id, "workspace_id": workspace.id,
        "source_change_set_id": change["id"], "original_request": "Verify the feature",
        "total_time_budget_seconds": 120,
        "steps": [{"step_id": "test", "position": 0, "profile": "pytest", "arguments": [],
                   "cwd_relative": ".", "purpose": "Check the feature", "required": True,
                   "timeout_seconds": 30, "expected_outcome": "Exit code zero"}],
    })
    assert response.status_code == 201, response.text
    verification = response.json()
    fingerprint = verification["plan_fingerprint"]
    base = f"/api/verification-sessions/{verification['id']}"
    assert client.post(base + "/decision", json={"decision": "approve", "plan_fingerprint": fingerprint}).status_code == 200
    started = client.post(base + "/steps/test/start", json={"plan_fingerprint": fingerprint})
    assert started.status_code == 200, started.text
    command = started.json()["command_run"]
    command_base = f"/api/command-runs/{command['id']}"
    assert client.post(command_base + "/decision", json={
        "decision": "approve", "calculated_risk": "BUILD_OR_TEST", "risk_explanation": "Approved test",
    }).status_code == 200
    assert client.post(command_base + "/events", json={"status": "starting"}).status_code == 200
    assert client.post(command_base + "/events", json={"status": "running"}).status_code == 200
    now = datetime.utcnow()
    assert client.post(command_base + "/result", json={
        "status": "completed", "exit_code": 0, "started_at": now.isoformat(),
        "completed_at": (now + timedelta(milliseconds=1)).isoformat(), "duration_ms": 1,
        "stdout_tail": "1 passed",
    }).status_code == 200
    result = client.post(base + "/steps/test/result", json={
        "plan_fingerprint": fingerprint, "command_run_id": command["id"],
    })
    assert result.status_code == 200, result.text
    assert result.json()["state"] == "COMPLETED"
    return result.json()


def test_task_api_pauses_proposal_and_recovers_plan_after_history_reload(api, monkeypatch):
    client, session, _workspace, conversation, _root = api
    run, change, _observations, emitted = start_change_task(api, monkeypatch)
    assert run["status"] == "awaiting_approval"
    assert run["pending_change_set_ids"] == [change["id"]]
    assert emitted[-2]["content"] != "Unsupported premature completion"
    session.expire_all()
    restored = client.get(f"/api/agent-runs?conversation_id={conversation.id}").json()[0]
    assert restored["plan"][0]["id"] == "work"
    assert restored["goal"] == "Implement the local feature"
    assert client.post(f"/api/agent-runs/{run['id']}/continue", json={}).status_code == 409


def test_apply_requires_fresh_approved_verification_then_resumes_same_goal(api, monkeypatch):
    client, _session, _workspace, _conversation, _root = api
    run, change, observations, _emitted = start_change_task(api, monkeypatch)
    apply_change(api, change)
    assert client.get(f"/api/agent-runs/{run['id']}").json()["requires_verification"]
    receipt = verify_change(api, change)
    assert receipt["verified_files"]["feature.py"] == change["operations"][0]["proposed_sha256"]
    resumed = events(client.post(f"/api/agent-runs/{run['id']}/continue", json={}))
    completed = resumed[-1]["run"]
    assert completed["status"] == "completed"
    assert completed["cycle_count"] == 2
    assert not completed["requires_verification"]
    assert observations[0][0] == observations[1][0]
    assert observations[1][1]["execution_feedback"]["verified_change_set_ids"] == [change["id"]]


def test_later_edits_invalidate_a_passing_task_receipt(api, monkeypatch):
    client, _session, _workspace, _conversation, root = api
    run, change, _observations, _emitted = start_change_task(api, monkeypatch)
    apply_change(api, change)
    verify_change(api, change)
    (root / "feature.py").write_bytes(b"VALUE = 999\n")
    assert client.get(f"/api/agent-runs/{run['id']}").json()["requires_verification"]
    resumed = events(client.post(f"/api/agent-runs/{run['id']}/continue", json={}))
    assert resumed[-1]["run"]["status"] == "awaiting_approval"
    assert resumed[-1]["run"]["requires_verification"]


def test_model_verification_command_becomes_an_explicit_plan_without_spawning(api, monkeypatch):
    client, session, _workspace, _conversation, _root = api
    run, change, _observations, _emitted = start_change_task(api, monkeypatch, verification_proposal=True)
    apply_change(api, change)
    resumed = events(client.post(f"/api/agent-runs/{run['id']}/continue", json={}))
    proposal = next(event for event in resumed if event["type"] == "proposal")
    assert proposal["kind"] == "verification_plan"
    assert proposal["verification_session"]["state"] == "AWAITING_PLAN_APPROVAL"
    assert proposal["verification_session"]["steps"][0]["profile"] == "pytest"
    assert session.query(models.CommandRun).count() == 0
    assert client.post(f"/api/agent-runs/{run['id']}/continue", json={}).status_code == 409


def test_cancellation_is_durable_and_cannot_be_resumed(api, monkeypatch):
    client, _session, _workspace, _conversation, _root = api
    run, _change, _observations, _emitted = start_change_task(api, monkeypatch)
    cancelled = client.post(f"/api/agent-runs/{run['id']}/cancel", json={"reason": "Stop this task"})
    assert cancelled.status_code == 200
    assert cancelled.json()["status"] == "cancelled"
    assert client.post(f"/api/agent-runs/{run['id']}/continue", json={}).status_code == 409


def test_continue_rejects_client_claimed_execution_results(api, monkeypatch):
    client, _session, _workspace, _conversation, _root = api
    run, _change, _observations, _emitted = start_change_task(api, monkeypatch)
    assert client.post(f"/api/agent-runs/{run['id']}/continue", json={
        "execution_feedback": {"verified_change_set_ids": ["forged"]},
    }).status_code == 422


def test_second_task_cannot_replace_a_goal_waiting_for_review(api, monkeypatch):
    client, _session, workspace, conversation, _root = api
    run, _change, _observations, _emitted = start_change_task(api, monkeypatch)
    conflict = client.post(f"/api/conversations/{conversation.id}/agent", json={
        "prompt": "Different goal", "workspace_id": workspace.id,
    })
    assert conflict.status_code == 409
    assert client.get(f"/api/agent-runs/{run['id']}").json()["goal"] == "Implement the local feature"
