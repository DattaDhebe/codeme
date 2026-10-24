"""Independent lifecycle and evidence tests for durable local coding tasks."""

import json
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from threading import Barrier

import pytest
from sqlalchemy.orm import sessionmaker

from codeme_agent import agent_runs, changesets, command_runs, crud, models, schemas, verification
from codeme_agent.config import settings
from codeme_agent.db import Base, create_database_engine


class RuntimeFake:
    def __init__(self, events):
        self.events = events
        self.calls = []
        self.closed = False

    def run(self, *args, **kwargs):
        self.calls.append((args, kwargs))
        try:
            for event in self.events:
                if isinstance(event, Exception):
                    raise event
                yield event
        finally:
            self.closed = True


@pytest.fixture()
def records(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "model_provider", "ollama")
    monkeypatch.setattr(settings, "agent_max_cycles", 8)
    monkeypatch.setattr(settings, "agent_time_budget_seconds", 900)
    root = tmp_path / "workspace"
    root.mkdir()
    (root / "app.py").write_bytes(b"value = 1\n")
    engine = create_database_engine(f"sqlite:///{(tmp_path / 'agent_runs.db').as_posix()}")
    Base.metadata.create_all(engine)
    db = sessionmaker(bind=engine, future=True)()
    registered = crud.create_workspace(db, "Run workspace", str(root))
    conversation = crud.create_conversation(db, "Durable task")
    yield db, root, registered, conversation
    with agent_runs._registry_lock:
        for record in db.query(models.AgentRun).all():
            agent_runs._active.pop(record.id, None)
    db.close()
    engine.dispose()


def create_task(records, prompt="Fix the value in app.py"):
    db, _root, registered, conversation = records
    return agent_runs.create_run(db, conversation.id, schemas.AgentRequest(
        workspace_id=registered.id, prompt=prompt, model="local-test-model", context="Selected app.py",
    ))


def cycle(records, record, events):
    db, *_ = records
    runtime = RuntimeFake(events)
    cancellation = agent_runs.claim_cycle(db, record)
    emitted = list(agent_runs.stream_cycle(db, record, runtime, cancellation))
    assert runtime.closed
    return emitted, runtime


def final_outcome(events):
    return next(event for event in reversed(events) if event["type"] == "outcome")


def change_event(records):
    _db, root, *_ = records
    prepared = changesets.prepare_change_set(root, "Use value two", [{
        "type": "modify", "relative_path": "app.py", "summary": "Return two",
        "edits": [{"old_text": "value = 1", "new_text": "value = 2"}],
    }])
    return {"type": "proposal", "kind": "change_set", "change_set": prepared}


def command_event(records):
    _db, root, *_ = records
    prepared = command_runs.prepare_command_run(root, {"profile": "pytest", "arguments": ["-q"], "purpose": "Run task tests"})
    return {"type": "proposal", "kind": "command_proposal", "command_run": prepared}


def complete_command(db, command, success=True):
    command_runs.record_decision(db, command, schemas.CommandDecision(
        decision="approve", calculated_risk="BUILD_OR_TEST", risk_explanation="Review exact local tests",
    ))
    command_runs.record_event(db, command, schemas.CommandEventCreate(status="starting"))
    command_runs.record_event(db, command, schemas.CommandEventCreate(status="running"))
    now = datetime.utcnow()
    command_runs.record_result(db, command, schemas.CommandResultCreate(
        status="completed" if success else "failed", exit_code=0 if success else 1,
        started_at=now, completed_at=now, duration_ms=0, stdout_tail="passed" if success else "failed",
    ))


def apply_change(records, record, extra_file=False):
    db, root, *_ = records
    event = change_event(records)
    if extra_file:
        event["change_set"] = changesets.prepare_change_set(root, "Use two and add original companion", [
            {"type": "modify", "relative_path": "app.py", "summary": "Return two", "edits": [{"old_text": "value = 1", "new_text": "value = 2"}]},
            {"type": "create", "relative_path": "original_only.py", "summary": "Add earlier file", "content": "earlier = True\n"},
        ])
    events, _runtime = cycle(records, record, [event, {"type": "outcome", "status": "awaiting_approval", "summary": "Approve edit"}])
    change = db.get(models.ChangeSet, json.loads(record.change_set_ids_json)[0])
    changesets.record_decision(db, change, schemas.ChangeSetDecision(decision="approve"))
    for operation in change.operations:
        (root / operation.relative_path).write_bytes(operation.proposed_content.encode("utf-8"))
    changesets.record_apply_result(db, change, schemas.ChangeSetApplyResult(
        status="applied", result_hashes={operation.relative_path: operation.proposed_sha256 for operation in change.operations}, checkpoint_reference="local-checkpoint.json",
    ))
    return change


def verify_change(records, change, success=True, arguments=None):
    db, _root, registered, conversation = records
    session = verification.create_session(db, schemas.VerificationSessionCreate(
        conversation_id=conversation.id, workspace_id=registered.id, source_change_set_id=change.id,
        original_request="Verify the applied task edit", mode="quick", total_time_budget_seconds=600,
        steps=[{"step_id": "tests", "position": 0, "profile": "pytest", "arguments": arguments if arguments is not None else ["-q"],
                "cwd_relative": ".", "purpose": "Run tests", "required": True, "timeout_seconds": 120, "expected_outcome": "Tests pass"}],
    ))
    verification.decide_plan(db, session, schemas.VerificationPlanDecision(decision="approve", plan_fingerprint=session.plan_fingerprint))
    session, command = verification.start_step(db, session, "tests", schemas.VerificationStepStart(plan_fingerprint=session.plan_fingerprint))
    complete_command(db, command, success=success)
    verification.record_step_result(db, session, "tests", schemas.VerificationStepResult(plan_fingerprint=session.plan_fingerprint, command_run_id=command.id))
    assert session.state == ("COMPLETED" if success else "VERIFICATION_FAILED")
    return session, command


def test_create_claim_and_complete_persist_goal_history_and_plan(records):
    db, _root, _registered, conversation = records
    record = create_task(records, "Inspect app.py")
    steps = [{"id": "inspect", "description": "Read app.py", "status": "completed"}]
    events, runtime = cycle(records, record, [
        {"type": "plan", "steps": steps}, {"type": "outcome", "status": "completed", "summary": "Read app.py", "evidence": {"inspected_paths": ["app.py"], "untrusted_extra": "discard"}},
        {"type": "message", "content": "app.py sets value to one."},
    ])
    assert record.status == "completed" and record.cycle_count == 1 and record.completed_at
    assert runtime.calls[0][0][0] == "Inspect app.py"
    assert runtime.calls[0][1]["context"] == "Selected app.py"
    assert json.loads(record.plan_json) == steps
    assert "untrusted_extra" not in json.loads(record.evidence_json)
    assert crud.get_conversation_messages_for_model(db, conversation.id)[-1]["content"] == "app.py sets value to one."
    assert [item.event_type for item in record.events] == ["created", "cycle_started", "plan", "outcome"]
    assert final_outcome(events)["status"] == "completed"


def test_file_proposal_is_durable_and_pending_review_blocks_resume(records):
    db, root, *_ = records
    record = create_task(records)
    events, _runtime = cycle(records, record, [change_event(records), {"type": "outcome", "status": "completed", "summary": "Already done"}])
    body = agent_runs.serialize_run(db, record)
    assert final_outcome(events)["status"] == "awaiting_approval"
    assert len(body["pending_change_set_ids"]) == 1
    assert db.get(models.ChangeSet, body["pending_change_set_ids"][0]).status == "proposed"
    assert (root / "app.py").read_text(encoding="utf-8") == "value = 1\n"
    with pytest.raises(agent_runs.AgentRunError, match="pending file change"):
        agent_runs.claim_cycle(db, record)
    assert record.cycle_count == 1


def test_pending_command_blocks_resume_until_decision(records):
    db, *_ = records
    record = create_task(records, "Run tests")
    events, _runtime = cycle(records, record, [command_event(records), {"type": "outcome", "status": "completed", "summary": "Tests passed"}])
    assert final_outcome(events)["status"] == "awaiting_approval"
    command = db.get(models.CommandRun, json.loads(record.command_run_ids_json)[0])
    assert command.status == "proposed"
    with pytest.raises(agent_runs.AgentRunError, match="pending command"):
        agent_runs.claim_cycle(db, record)


def test_rejected_edit_cannot_be_reported_as_completed(records):
    db, *_ = records
    record = create_task(records)
    cycle(records, record, [change_event(records)])
    change = db.get(models.ChangeSet, json.loads(record.change_set_ids_json)[0])
    changesets.record_decision(db, change, schemas.ChangeSetDecision(decision="reject"))
    events, runtime = cycle(records, record, [{"type": "outcome", "status": "completed", "summary": "Implemented fix"}, {"type": "message", "content": "Everything was changed."}])
    assert final_outcome(events)["status"] == "blocked"
    assert runtime.calls[0][0][0] == record.goal
    assert runtime.calls[0][1]["execution_feedback"]["changes"][0]["status"] == "rejected"
    assert "Everything was changed" not in str(events)


def test_failed_command_requires_addressing_result_before_completion(records):
    db, *_ = records
    record = create_task(records, "Run tests")
    cycle(records, record, [command_event(records)])
    command = db.get(models.CommandRun, json.loads(record.command_run_ids_json)[0])
    complete_command(db, command, success=False)
    events, runtime = cycle(records, record, [{"type": "outcome", "status": "completed", "summary": "All tests passed"}])
    assert final_outcome(events)["status"] == "blocked"
    assert runtime.calls[0][1]["execution_feedback"]["commands"][0]["exit_code"] == 1


def test_successful_exact_command_retry_can_complete(records):
    db, *_ = records
    record = create_task(records, "Run tests")
    cycle(records, record, [command_event(records)])
    first = db.get(models.CommandRun, json.loads(record.command_run_ids_json)[0])
    complete_command(db, first, success=False)
    cycle(records, record, [command_event(records)])
    second = db.get(models.CommandRun, json.loads(record.command_run_ids_json)[-1])
    complete_command(db, second)
    events, _runtime = cycle(records, record, [{"type": "outcome", "status": "completed", "summary": "The rerun passed"}])
    assert final_outcome(events)["status"] == "completed"


def test_applied_edit_can_continue_planning_but_cannot_complete_without_verification(records):
    db, *_ = records
    record = create_task(records)
    change = apply_change(records, record)
    assert agent_runs.execution_feedback(db, record)["requires_verification"]
    assert agent_runs.serialize_run(db, record)["pending_change_set_ids"] == [change.id]
    events, _runtime = cycle(records, record, [{"type": "outcome", "status": "completed", "summary": "No checks were necessary"}])
    assert final_outcome(events)["status"] == "awaiting_approval"


def test_approved_passing_receipt_for_current_files_allows_completion(records):
    db, *_ = records
    record = create_task(records)
    change = apply_change(records, record)
    verify_change(records, change)
    feedback = agent_runs.execution_feedback(db, record)
    assert feedback["verified_change_set_ids"] == [change.id]
    assert not feedback["requires_verification"]
    events, _runtime = cycle(records, record, [{"type": "outcome", "status": "completed", "summary": "Applied and verified"}])
    assert final_outcome(events)["status"] == "completed"


def test_later_file_edit_invalidates_the_passing_receipt(records):
    db, root, *_ = records
    record = create_task(records)
    change = apply_change(records, record)
    verify_change(records, change)
    (root / "app.py").write_text("value = 99\n", encoding="utf-8")
    feedback = agent_runs.execution_feedback(db, record)
    assert feedback["requires_verification"] and not feedback["verified_change_set_ids"]
    events, _runtime = cycle(records, record, [{"type": "outcome", "status": "completed", "summary": "The old pass still counts"}])
    assert final_outcome(events)["status"] == "awaiting_approval"


def test_later_failed_verification_supersedes_an_older_pass(records):
    db, *_ = records
    record = create_task(records)
    change = apply_change(records, record)
    verify_change(records, change)
    failed, _command = verify_change(records, change, success=False)
    feedback = agent_runs.execution_feedback(db, record)
    assert feedback["requires_verification"] and not feedback["verified_change_set_ids"]
    # Failure unlocks inspection/repair rather than trapping the task behind a
    # request to rerun the same unchecked success claim.
    events, runtime = cycle(records, record, [{"type": "outcome", "status": "completed", "summary": "Still done"}])
    assert final_outcome(events)["status"] == "awaiting_approval"
    assert runtime.calls[0][1]["execution_feedback"]["verification"][-1]["id"] == failed.id


def test_failure_feedback_keeps_latest_logs_redacts_secrets_and_stays_structured(records):
    db, *_ = records
    record = create_task(records)
    change = apply_change(records, record)
    older, old_command = verify_change(records, change)
    latest, command = verify_change(records, change, success=False)
    old_command.stderr_tail = "older verification result"
    command.stdout_tail = "old output\n" * 3000 + "\x1b[31mTOKEN=private-value\x1b[0m\nLATEST_STDOUT"
    command.stderr_tail = "old error\n" * 3000 + "PASSWORD=private-password\napp.py:1: latest assertion failed LATEST_STDERR"
    db.commit()
    feedback = agent_runs.execution_feedback(db, record)
    encoded = json.dumps(feedback, ensure_ascii=False)
    assert len(encoded) <= 14000
    assert feedback["requires_verification"]
    assert feedback["verification"][-1]["id"] == latest.id
    latest_step = feedback["verification"][-1]["steps"][0]
    assert latest_step["status"] == "STEP_FAILED" and latest_step["exit_code"] == 1
    assert "LATEST_STDOUT" in latest_step["stdout_tail"] and "LATEST_STDERR" in latest_step["stderr_tail"]
    assert "private-value" not in encoded and "private-password" not in encoded and "\\u001b" not in encoded
    assert "[REDACTED]" in encoded
    # Controller feedback remains parseable data when passed into a fresh cycle.
    events, runtime = cycle(records, record, [{"type": "outcome", "status": "blocked", "summary": "Investigate the latest failure"}])
    observed = runtime.calls[0][1]["execution_feedback"]
    assert json.loads(json.dumps(observed))["requires_verification"]
    assert final_outcome(events)["status"] == "awaiting_approval"


@pytest.mark.parametrize("alter", ["approval", "command_arguments", "command_exit", "receipt"])
def test_receipt_requires_exact_approved_successful_command_and_file_binding(records, alter):
    db, *_ = records
    record = create_task(records)
    change = apply_change(records, record)
    session, command = verify_change(records, change)
    if alter == "approval":
        session.approved_plan_fingerprint = "0" * 64
    elif alter == "command_arguments":
        command.arguments_json = '["different-task"]'
    elif alter == "command_exit":
        command.exit_code = 1
    else:
        session.verified_files_json = "{}"
    db.commit()
    feedback = agent_runs.execution_feedback(db, record)
    assert feedback["requires_verification"]
    assert not feedback["verified_change_set_ids"]


def test_cancel_live_cycle_stops_before_persisting_another_action(records):
    db, *_ = records
    record = create_task(records)
    runtime = RuntimeFake([change_event(records)])
    cancellation = agent_runs.claim_cycle(db, record)
    stream = agent_runs.stream_cycle(db, record, runtime, cancellation)
    assert next(stream)["type"] == "task"
    agent_runs.cancel_run(db, record, "User stopped the task")
    assert cancellation.is_set()
    events = list(stream)
    assert final_outcome(events)["status"] == "cancelled"
    assert not json.loads(record.change_set_ids_json)
    assert runtime.closed and record.id not in agent_runs._active


def test_disconnected_stream_preserves_proposal_and_becomes_interrupted(records):
    db, *_ = records
    record = create_task(records)
    runtime = RuntimeFake([change_event(records), {"type": "message", "content": "Approve the edit"}])
    cancellation = agent_runs.claim_cycle(db, record)
    stream = agent_runs.stream_cycle(db, record, runtime, cancellation)
    assert next(stream)["type"] == "task"
    assert next(stream)["type"] == "proposal"
    stream.close()
    assert runtime.closed and record.status == "interrupted"
    assert record.id not in agent_runs._active
    assert db.get(models.ChangeSet, json.loads(record.change_set_ids_json)[0]).status == "proposed"
    with pytest.raises(agent_runs.AgentRunError, match="pending file change"):
        agent_runs.claim_cycle(db, record)


def test_reconcile_marks_orphaned_running_cycle_interrupted(records):
    db, *_ = records
    record = create_task(records)
    agent_runs.claim_cycle(db, record)
    assert agent_runs.reconcile(db, record).status == "running"
    agent_runs._active.pop(record.id)
    assert agent_runs.reconcile(db, record).status == "interrupted"
    assert record.events[-1].event_type == "interrupted"


def test_duplicate_creation_and_claim_are_rejected(records):
    db, *_ = records
    record = create_task(records)
    with pytest.raises(agent_runs.AgentRunError, match="existing task"):
        create_task(records)
    cancellation = agent_runs.claim_cycle(db, record)
    with pytest.raises(agent_runs.AgentRunError, match="active model request"):
        agent_runs.claim_cycle(db, record)
    assert record.cycle_count == 1
    list(agent_runs.stream_cycle(db, record, RuntimeFake([]), cancellation))


def test_concurrent_sessions_cannot_both_claim_the_same_run(records):
    db, *_ = records
    record = create_task(records)
    local_sessions = sessionmaker(bind=db.get_bind(), future=True)
    barrier = Barrier(2)

    def claim_from_separate_session():
        with local_sessions() as local:
            candidate = agent_runs.get_run(local, record.id)
            barrier.wait(timeout=10)
            try:
                agent_runs.claim_cycle(local, candidate)
                return "claimed"
            except agent_runs.AgentRunError:
                return "rejected"

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _index: claim_from_separate_session(), range(2)))
    assert sorted(results) == ["claimed", "rejected"]
    db.refresh(record)
    assert record.cycle_count == 1
    agent_runs.cancel_run(db, record, "End concurrency test")


def test_another_task_owning_conversation_blocks_old_task_resume(records):
    db, *_ = records
    older = create_task(records)
    cycle(records, older, [{"type": "outcome", "status": "blocked", "summary": "Needs more work"}])
    newer = create_task(records)
    with pytest.raises(agent_runs.AgentRunError, match="Another task owns"):
        agent_runs.claim_cycle(db, older)
    assert newer.status == "interrupted"


def test_provider_endpoint_change_requires_a_fresh_explicit_task(records, monkeypatch):
    db, *_ = records
    record = create_task(records)
    monkeypatch.setattr(settings, "ollama_url", "http://127.0.0.1:11435")
    with pytest.raises(agent_runs.AgentRunError, match="provider changed"):
        agent_runs.claim_cycle(db, record)
    assert record.cycle_count == 0


@pytest.mark.parametrize("exhaust", ["cycles", "time"])
def test_task_limits_stop_new_cycles_and_preserve_existing_records(records, exhaust):
    db, *_ = records
    record = create_task(records)
    if exhaust == "cycles":
        record.cycle_count = record.max_cycles
    else:
        record.elapsed_ms = record.time_budget_seconds * 1000
    db.commit()
    with pytest.raises(agent_runs.AgentRunError, match="budget"):
        agent_runs.claim_cycle(db, record)
    assert record.status == "exhausted"
    assert record.events[-1].event_type == "exhausted"


def test_last_permitted_cycle_can_finish_successfully(records):
    db, *_ = records
    record = create_task(records, "Inspect app.py")
    record.max_cycles = 1
    db.commit()
    events, _runtime = cycle(records, record, [{"type": "outcome", "status": "completed", "summary": "Inspected"}])
    assert final_outcome(events)["status"] == "completed"
    assert record.cycle_count == 1
    with pytest.raises(agent_runs.AgentRunError, match="completed task"):
        agent_runs.claim_cycle(db, record)


def test_last_cycle_proposal_remains_reviewable_after_budget_exhaustion(records):
    db, *_ = records
    record = create_task(records)
    record.max_cycles = 1
    db.commit()
    cycle(records, record, [change_event(records)])
    change_id = json.loads(record.change_set_ids_json)[0]
    with pytest.raises(agent_runs.AgentRunError, match="budget"):
        agent_runs.claim_cycle(db, record)
    assert record.status == "exhausted"
    change = db.get(models.ChangeSet, change_id)
    assert change.status == "proposed"
    changesets.record_decision(db, change, schemas.ChangeSetDecision(decision="reject"))
    assert change.status == "rejected"


def test_active_deadline_stops_before_persisting_a_proposal(records, monkeypatch):
    db, *_ = records
    record = create_task(records)
    record.time_budget_seconds = 1
    db.commit()
    cancellation = agent_runs.claim_cycle(db, record)
    ticks = iter([0.0, 2.0, 2.0])
    monkeypatch.setattr(agent_runs, "monotonic", lambda: next(ticks))
    runtime = RuntimeFake([change_event(records)])
    events = list(agent_runs.stream_cycle(db, record, runtime, cancellation))
    assert final_outcome(events)["status"] == "exhausted"
    assert not json.loads(record.change_set_ids_json)
    assert record.elapsed_ms == 2000
    assert runtime.closed and record.id not in agent_runs._active


def test_disconnect_before_runtime_starts_releases_claim(records):
    db, *_ = records
    record = create_task(records)
    cancellation = agent_runs.claim_cycle(db, record)
    runtime = RuntimeFake([change_event(records)])
    stream = agent_runs.stream_cycle(db, record, runtime, cancellation)
    next(stream)
    stream.close()
    assert not runtime.calls
    assert record.status == "interrupted"
    assert record.id not in agent_runs._active


def test_cancellation_is_idempotent_and_does_not_rewrite_completed_tasks(records):
    db, *_ = records
    record = create_task(records)
    cancelled = agent_runs.cancel_run(db, record, "Stop")
    count = len(cancelled.events)
    agent_runs.cancel_run(db, record, "Stop again")
    assert record.summary == "Stop" and len(record.events) == count
    another = create_task(records, "Inspect app.py")
    cycle(records, another, [{"type": "outcome", "status": "completed", "summary": "Read"}])
    agent_runs.cancel_run(db, another, "Too late")
    assert another.status == "completed" and another.summary == "Read"


def test_runtime_error_after_proposal_preserves_approval_gate(records):
    record = create_task(records)
    events, _runtime = cycle(records, record, [change_event(records), RuntimeError("internal private details")])
    assert final_outcome(events)["status"] == "awaiting_approval"
    assert "internal private details" not in str(events)


@pytest.mark.parametrize("bad_status", ["made_up", None, ["completed"]])
def test_malformed_outcomes_fail_closed_and_release_claim(records, bad_status):
    record = create_task(records)
    events, _runtime = cycle(records, record, [{"type": "outcome", "status": bad_status, "summary": "Do not trust this"}])
    assert final_outcome(events)["status"] == "blocked"
    assert record.id not in agent_runs._active


def test_evidence_is_bounded_in_storage_and_streamed_outcome(records):
    record = create_task(records, "Inspect app.py")
    events, _runtime = cycle(records, record, [{"type": "outcome", "status": "completed", "summary": "Read", "evidence": {"inspected_paths": ["x" * 20000]}}])
    assert len(record.evidence_json) <= 16000
    assert len(json.dumps(final_outcome(events)["evidence"])) <= 16000


def test_plan_and_final_message_never_expose_private_reasoning(records):
    db, *_ = records
    record = create_task(records, "Inspect app.py")
    events, _runtime = cycle(records, record, [
        {"type": "plan", "steps": [{"id": "inspect", "description": "<think>private plan</think>Read app.py", "status": "completed"}], "explanation": "<analysis>private explanation</analysis>Focused scope"},
        {"type": "outcome", "status": "completed", "summary": "<think>private outcome</think>Read app.py"},
        {"type": "message", "content": "<think>private final</think>app.py defines a value."},
    ])
    assert "private" not in str(events)
    assert "private" not in record.plan_json
    assert "private" not in str(crud.get_conversation_messages_for_model(db, record.conversation_id))


def test_invalid_multiple_active_plan_steps_are_not_persisted(records):
    record = create_task(records)
    bad_plan = [{"id": str(index), "description": "Inspect", "status": "in_progress"} for index in range(2)]
    events, _runtime = cycle(records, record, [{"type": "plan", "steps": bad_plan}, {"type": "outcome", "status": "completed", "summary": "Done"}])
    assert final_outcome(events)["status"] == "blocked"
    assert json.loads(record.plan_json) == []


def apply_followup_change(records, record):
    db, root, *_ = records
    prepared = changesets.prepare_change_set(root, "Correct value and add companion", [
        {"type": "modify", "relative_path": "app.py", "summary": "Return three", "edits": [{"old_text": "value = 2", "new_text": "value = 3"}]},
        {"type": "create", "relative_path": "companion.py", "summary": "Add companion", "content": "companion = True\n"},
    ])
    cycle(records, record, [{"type": "proposal", "kind": "change_set", "change_set": prepared}])
    followup = db.get(models.ChangeSet, json.loads(record.change_set_ids_json)[-1])
    changesets.record_decision(db, followup, schemas.ChangeSetDecision(decision="approve"))
    for operation in followup.operations:
        (root / operation.relative_path).write_bytes(operation.proposed_content.encode("utf-8"))
    changesets.record_apply_result(db, followup, schemas.ChangeSetApplyResult(
        status="applied", result_hashes={operation.relative_path: operation.proposed_sha256 for operation in followup.operations},
        checkpoint_reference="followup-checkpoint.json",
    ))
    return followup


def test_latest_global_receipt_verifies_successive_edits_to_the_same_file(records):
    db, root, *_ = records
    record = create_task(records)
    first = apply_change(records, record, extra_file=True)
    verify_change(records, first, success=False)
    followup = apply_followup_change(records, record)
    receipt, _command = verify_change(records, followup)
    hashes = json.loads(receipt.verified_files_json)
    assert set(hashes) == {"app.py", "companion.py", "original_only.py"}
    assert hashes["app.py"] == followup.operations[0].result_sha256
    assert hashes["app.py"] != first.operations[0].result_sha256
    feedback = agent_runs.execution_feedback(db, record)
    assert set(feedback["verified_change_set_ids"]) == {first.id, followup.id}
    assert not feedback["requires_verification"]
    events, _runtime = cycle(records, record, [{"type": "outcome", "status": "completed", "summary": "The complete current task result passed"}])
    assert final_outcome(events)["status"] == "completed"
    assert (root / "app.py").read_bytes() == b"value = 3\n"


@pytest.mark.parametrize("invalidate", ["new_failed_check", "later_file_edit"])
def test_global_receipt_never_hides_a_later_failure_or_stale_file(records, invalidate):
    db, root, *_ = records
    record = create_task(records)
    first = apply_change(records, record)
    verify_change(records, first, success=False)
    followup = apply_followup_change(records, record)
    verify_change(records, followup)
    if invalidate == "new_failed_check":
        verify_change(records, followup, success=False)
    else:
        (root / "companion.py").write_bytes(b"companion = False\n")
    feedback = agent_runs.execution_feedback(db, record)
    assert feedback["requires_verification"]
    assert not feedback["verified_change_set_ids"]
    events, _runtime = cycle(records, record, [{"type": "outcome", "status": "completed", "summary": "The previous pass is enough"}])
    assert final_outcome(events)["status"] == "awaiting_approval"


def test_post_edit_controlled_test_proposal_becomes_an_approval_gated_verification_plan(records):
    db, *_ = records
    record = create_task(records)
    change = apply_change(records, record)
    assert db.query(models.CommandRun).count() == 0
    events, _runtime = cycle(records, record, [command_event(records), {"type": "outcome", "status": "completed", "summary": "Checks passed"}])
    proposal = next(event for event in events if event["type"] == "proposal")
    assert proposal["kind"] == "verification_plan"
    body = proposal["verification_session"]
    assert body["source_change_set_id"] == change.id
    assert body["state"] == "AWAITING_PLAN_APPROVAL"
    assert body["steps"][0]["profile"] == "pytest"
    assert body["steps"][0]["arguments"] == ["-q"]
    assert db.query(models.CommandRun).count() == 0
    assert json.loads(record.command_run_ids_json) == []
    assert final_outcome(events)["status"] == "awaiting_approval"
    session = db.get(models.VerificationSession, body["id"])
    assert session.approved_plan_fingerprint is None
    with pytest.raises(agent_runs.AgentRunError, match="verification"):
        agent_runs.claim_cycle(db, record)
    # Exact plan approval and step start are the first point at which a command
    # record may exist, preserving the existing execution approval boundary.
    verification.decide_plan(db, session, schemas.VerificationPlanDecision(decision="approve", plan_fingerprint=session.plan_fingerprint))
    verification.start_step(db, session, session.steps[0].plan_step_id, schemas.VerificationStepStart(plan_fingerprint=session.plan_fingerprint))
    assert db.query(models.CommandRun).count() == 1


@pytest.mark.parametrize("same_command", [True, False])
def test_later_verification_satisfies_only_the_exact_failed_baseline_command(records, same_command):
    db, *_ = records
    record = create_task(records)
    cycle(records, record, [command_event(records)])
    baseline = db.get(models.CommandRun, json.loads(record.command_run_ids_json)[0])
    complete_command(db, baseline, success=False)
    change = apply_change(records, record)
    verify_change(records, change, arguments=["-q"] if same_command else ["other_tests"])
    events, _runtime = cycle(records, record, [{"type": "outcome", "status": "completed", "summary": "Applied change passed verification"}])
    assert final_outcome(events)["status"] == ("completed" if same_command else "blocked")
