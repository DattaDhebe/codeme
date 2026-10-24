"""Durable goal -> proposal -> reviewed observation -> verification loop.

The model chooses the next step. This controller owns task lifecycle, evidence,
budgets, and completion. Client assertions are never accepted as observations;
continuations read the existing change/command/verification audit records.
"""
import hashlib
import json
import logging
from datetime import datetime
from pathlib import Path
from threading import Event, RLock
from time import monotonic
from uuid import uuid4

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from codeme_agent import changesets, command_runs, crud, diagnostics, models, schemas, verification, workspace
from codeme_agent.config import settings
from codeme_agent.workflow import normalize_plan, public_text

TERMINAL = {"completed", "cancelled", "exhausted"}
_active: dict[str, Event] = {}
_registry_lock = RLock()
logger = logging.getLogger(__name__)


class AgentRunError(workspace.WorkspaceError):
    pass


def _load(value: str | None, default):
    return json.loads(value) if value else default


def _bounded_json(value: object, limit: int = 16_000) -> str:
    encoded = json.dumps(value, ensure_ascii=False, default=str)
    return encoded if len(encoded) <= limit else json.dumps({"truncated": True})


def _endpoint_fingerprint() -> str:
    provider = settings.model_provider
    endpoint = str(settings.ollama_url if provider == "ollama" else settings.local_model_url)
    return hashlib.sha256(f"{provider}\0{endpoint.rstrip('/')}".encode()).hexdigest()


def _audit(db: Session, record: models.AgentRun, event_type: str, detail: dict | None = None):
    record.updated_at = datetime.utcnow()
    db.add(models.AgentRunEvent(
        run_id=record.id, event_type=event_type, status=record.status,
        detail_json=_bounded_json(detail or {}),
    ))


def get_run(db: Session, run_id: str) -> models.AgentRun | None:
    return db.get(models.AgentRun, run_id)


def reconcile(db: Session, record: models.AgentRun) -> models.AgentRun:
    with _registry_lock:
        live = record.id in _active
    if record.status == "running" and not live:
        record.status = "interrupted"
        record.summary = "The previous agent process stopped. Review its recorded actions, then resume explicitly."
        _audit(db, record, "interrupted")
        db.commit()
    return record


def list_runs(db: Session, conversation_id: int) -> list[models.AgentRun]:
    records = list(db.scalars(select(models.AgentRun).where(
        models.AgentRun.conversation_id == conversation_id,
    ).order_by(models.AgentRun.created_at.desc()).limit(50)))
    return [reconcile(db, record) for record in records]


def _related(db: Session, record: models.AgentRun):
    change_ids = _load(record.change_set_ids_json, [])
    command_ids = _load(record.command_run_ids_json, [])
    changes = list(db.scalars(select(models.ChangeSet).where(
        models.ChangeSet.id.in_(change_ids), models.ChangeSet.workspace_id == record.workspace_id,
        models.ChangeSet.conversation_id == record.conversation_id,
    ).order_by(models.ChangeSet.created_at))) if change_ids else []
    commands = list(db.scalars(select(models.CommandRun).where(
        models.CommandRun.id.in_(command_ids), models.CommandRun.workspace_id == record.workspace_id,
        models.CommandRun.conversation_id == record.conversation_id,
    ).order_by(models.CommandRun.created_at))) if command_ids else []
    sessions = list(db.scalars(select(models.VerificationSession).where(
        models.VerificationSession.source_change_set_id.in_(change_ids),
        models.VerificationSession.workspace_id == record.workspace_id,
        models.VerificationSession.conversation_id == record.conversation_id,
    ).order_by(models.VerificationSession.created_at))) if change_ids else []
    return changes, commands, sessions


def _approved_receipt(db: Session, record: models.AgentRun, receipt: models.VerificationSession) -> bool:
    if receipt.state != "COMPLETED" or not receipt.steps:
        return False
    if receipt.approved_plan_fingerprint != receipt.plan_fingerprint or receipt.approved_plan_version != receipt.plan_version:
        return False
    try:
        fields = {key: getattr(receipt, key) for key in (
            "schema_version", "workspace_id", "source_change_set_id", "mode", "summary",
            "maximum_repair_attempts", "maximum_reruns", "total_time_budget_seconds",
        )}
        fields["steps"] = [schemas.VerificationStepInput(
            step_id=step.plan_step_id, position=step.position, profile=step.profile,
            arguments=_load(step.arguments_json, []), cwd_relative=step.cwd_relative,
            purpose=step.purpose, required=bool(step.required), timeout_seconds=step.timeout_seconds,
            expected_outcome=step.expected_outcome,
        ) for step in receipt.steps]
        if verification.plan_fingerprint(schemas.VerificationPlanInput(**fields)) != receipt.approved_plan_fingerprint:
            return False
    except (ValueError, TypeError):
        return False
    required = [step for step in receipt.steps if step.required]
    if not required:
        return False
    for step in required:
        command = db.get(models.CommandRun, step.command_run_id) if step.command_run_id else None
        if (step.status != "STEP_PASSED" or not command or command.workspace_id != record.workspace_id
                or command.conversation_id != record.conversation_id or command.status != "completed"
                or command.exit_code != 0 or not verification._command_matches_step(command, step)):
            return False
    return verification.receipt_is_current(db, receipt)


def _verified(db: Session, record: models.AgentRun, changes, sessions) -> set[str]:
    # Later reviewed repairs can supersede an earlier task edit to the same file.
    # Evaluate the final task-owned file versions rather than demanding that an
    # earlier edit's obsolete intermediate hash still be present.
    applied = {change.id: change for change in changes if change.status == "applied"}
    for session in sessions:
        for attempt in session.repair_attempts:
            repair = db.get(models.ChangeSet, attempt.repair_change_set_id) if attempt.repair_change_set_id else None
            if (repair and repair.status == "applied" and attempt.result == "applied"
                    and repair.workspace_id == record.workspace_id and repair.conversation_id == record.conversation_id):
                applied[repair.id] = repair
    expected = {}
    for change in sorted(applied.values(), key=lambda item: (item.applied_at or item.created_at, item.created_at)):
        expected.update({operation.relative_path: operation.result_sha256 or operation.proposed_sha256 for operation in change.operations})
    covered = set()
    for receipt in sessions:
        if not _approved_receipt(db, record, receipt):
            continue
        hashes = _load(receipt.verified_files_json, {})
        if not isinstance(hashes, dict) or any(path in expected and expected[path] != digest for path, digest in hashes.items()):
            continue
        newer_failure = False
        for other in sessions:
            if other.state == "COMPLETED" or other.created_at <= (receipt.completed_at or receipt.created_at):
                continue
            other_paths = set(_load(other.verified_files_json, {}))
            if not other_paths:
                source = next((change for change in changes if change.id == other.source_change_set_id), None)
                other_paths = {operation.relative_path for operation in source.operations} if source else set()
            if other_paths.intersection(hashes):
                newer_failure = True
                break
        if not newer_failure:
            covered.update(hashes)
    return {change.id for change in changes if change.status == "applied" and change.operations
            and {operation.relative_path for operation in change.operations}.issubset(covered)}


def serialize_run(db: Session, record: models.AgentRun) -> dict:
    changes, commands, sessions = _related(db, record)
    verified = _verified(db, record, changes, sessions)
    timestamp = lambda value: value.isoformat() if value else None
    return {
        "id": record.id, "schema_version": record.schema_version,
        "conversation_id": record.conversation_id, "workspace_id": record.workspace_id,
        "goal": record.goal, "model": record.model, "provider": record.provider,
        "status": record.status, "plan": _load(record.plan_json, []),
        "cycle_count": record.cycle_count, "max_cycles": record.max_cycles,
        "time_budget_seconds": record.time_budget_seconds, "elapsed_ms": record.elapsed_ms,
        "summary": record.summary, "evidence": _load(record.evidence_json, {}),
        "pending_change_set_ids": [change.id for change in changes if change.status in {"proposed", "approved", "applying"}
                                   or (change.status == "applied" and change.id not in verified)],
        "pending_command_run_ids": [command.id for command in commands if command.status not in command_runs.TERMINAL_STATUSES],
        "requires_verification": any(change.status == "applied" and change.id not in verified for change in changes),
        "created_at": timestamp(record.created_at), "updated_at": timestamp(record.updated_at),
        "completed_at": timestamp(record.completed_at),
    }


def execution_feedback(db: Session, record: models.AgentRun) -> dict:
    changes, commands, sessions = _related(db, record)
    verified = _verified(db, record, changes, sessions)
    feedback = {
        "schema_version": 1, "cycle": record.cycle_count,
        "changes": [{
            "id": change.id, "status": change.status, "summary": change.summary,
            "failure_reason": diagnostics.sanitize_output(change.failure_reason, 1000),
            "operations": [{"relative_path": operation.relative_path, "result_sha256": operation.result_sha256}
                           for operation in change.operations],
        } for change in changes[-16:]],
        "commands": [{
            "id": command.id, "profile": command.profile, "status": command.status,
            "arguments": _load(command.arguments_json, []), "cwd_relative": command.cwd_relative,
            "exit_code": command.exit_code, "output_truncated": bool(command.output_truncated),
            "stdout_tail": diagnostics.sanitize_output(command.stdout_tail, 8000),
            "stderr_tail": diagnostics.sanitize_output(command.stderr_tail, 8000),
            "timed_out": bool(command.timed_out), "cancelled": bool(command.cancelled),
        } for command in commands[-8:]],
        "verification": [{
            "id": session.id, "state": session.state, "summary": session.summary,
            "final_summary": diagnostics.sanitize_output(session.final_summary, 2000),
            "source_change_set_id": session.source_change_set_id,
            "steps": [{
                "profile": step.profile, "status": step.status, "exit_code": step.exit_code,
                "stdout_tail": diagnostics.sanitize_output(command.stdout_tail, 4000) if command else "",
                "stderr_tail": diagnostics.sanitize_output(command.stderr_tail, 4000) if command else "",
            } for step in session.steps for command in [db.get(models.CommandRun, step.command_run_id) if step.command_run_id else None]],
        } for session in sessions[-8:]],
        "requires_verification": any(change.status == "applied" and change.id not in verified for change in changes),
        "verified_change_set_ids": sorted(verified),
    }
    # Preserve structured feedback and the newest failure instead of slicing a
    # JSON string and losing the verification flags at its end.
    while len(json.dumps(feedback, ensure_ascii=False)) > 14_000:
        reduced = False
        for key in ("commands", "verification", "changes"):
            if len(feedback[key]) > 1:
                feedback[key].pop(0)
                reduced = True
                break
        if reduced:
            continue
        for command in feedback["commands"]:
            command["stdout_tail"] = command["stdout_tail"][-1000:]
            command["stderr_tail"] = command["stderr_tail"][-1000:]
            command["arguments"] = [argument[:100] for argument in command["arguments"][:10]]
        for session in feedback["verification"]:
            for step in session["steps"]:
                step["stdout_tail"] = step["stdout_tail"][-500:]
                step["stderr_tail"] = step["stderr_tail"][-500:]
        for change in feedback["changes"]:
            change["operations"] = [{**operation, "relative_path": operation["relative_path"][:256]}
                                    for operation in change["operations"][:20]]
        feedback["feedback_truncated"] = True
        break
    if len(json.dumps(feedback, ensure_ascii=False)) > 14_000:
        for change in feedback["changes"]:
            change["summary"] = change["summary"][:200]
            change["failure_reason"] = change["failure_reason"][:200]
            change["operations"] = change["operations"][:8]
        for command in feedback["commands"]:
            command["arguments"] = command["arguments"][:5]
            command["stdout_tail"] = command["stdout_tail"][-500:]
            command["stderr_tail"] = command["stderr_tail"][-500:]
        for session in feedback["verification"]:
            session["summary"] = session["summary"][:200]
            session["final_summary"] = session["final_summary"][:500]
            for step in session["steps"]:
                step["stdout_tail"] = step["stdout_tail"][-200:]
                step["stderr_tail"] = step["stderr_tail"][-200:]
        feedback["feedback_truncated"] = True
    if len(json.dumps(feedback, ensure_ascii=False)) > 14_000:
        raise AgentRunError("Execution evidence exceeds the context budget; inspect the saved command results before continuing")
    return feedback


def create_run(db: Session, conversation_id: int, request: schemas.AgentRequest) -> models.AgentRun:
    existing = db.scalar(select(models.AgentRun.id).where(
        models.AgentRun.conversation_id == conversation_id,
        models.AgentRun.status.in_({"running", "awaiting_approval", "interrupted"}),
    ).limit(1))
    if existing:
        raise AgentRunError("Resume or cancel the existing task before starting another task in this conversation")
    record = models.AgentRun(
        id=str(uuid4()), conversation_id=conversation_id, workspace_id=request.workspace_id,
        goal=request.prompt, editor_context=request.context, model=request.model or settings.default_model,
        provider=settings.model_provider, endpoint_fingerprint=_endpoint_fingerprint(),
        status="interrupted", max_cycles=settings.agent_max_cycles,
        time_budget_seconds=settings.agent_time_budget_seconds,
    )
    try:
        db.add(record)
        db.flush()
        _audit(db, record, "created")
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise AgentRunError("Another task already owns this conversation") from exc
    db.refresh(record)
    return record


def _assert_reviewed(db: Session, record: models.AgentRun):
    changes, commands, sessions = _related(db, record)
    if any(change.status in {"proposed", "approved", "applying"} for change in changes):
        raise AgentRunError("Review the pending file change before continuing")
    if any(command.status not in command_runs.TERMINAL_STATUSES for command in commands):
        raise AgentRunError("Approve, reject, or finish the pending command before continuing")
    verified = _verified(db, record, changes, sessions)
    for change in changes:
        if change.status == "applied" and change.id not in verified:
            related = [session for session in sessions if session.source_change_set_id == change.id]
            latest = related[-1] if related else None
            if latest and latest.state not in verification.TERMINAL_STATES | {"VERIFICATION_FAILED"}:
                raise AgentRunError("Review or finish the active verification plan before continuing")


def claim_cycle(db: Session, record: models.AgentRun) -> Event:
    with _registry_lock:
        if record.id in _active:
            raise AgentRunError("This task already has an active model request")
        reconcile(db, record)
        if record.status in TERMINAL:
            raise AgentRunError(f"Cannot resume a {record.status} task")
        if record.provider != settings.model_provider or record.endpoint_fingerprint != _endpoint_fingerprint():
            raise AgentRunError("The local model provider changed. Cancel this task and start a new task explicitly")
        if record.cycle_count >= record.max_cycles or record.elapsed_ms >= record.time_budget_seconds * 1000:
            record.status = "exhausted"
            record.summary = "The task reached its model-cycle or active-time budget. No further actions were started."
            _audit(db, record, "exhausted")
            db.commit()
            raise AgentRunError(record.summary)
        _assert_reviewed(db, record)
        other = db.scalar(select(models.AgentRun.id).where(
            models.AgentRun.conversation_id == record.conversation_id,
            models.AgentRun.id != record.id,
            models.AgentRun.status.in_({"running", "awaiting_approval", "interrupted"}),
        ).limit(1))
        if other:
            raise AgentRunError("Another task owns this conversation")
        cancellation = Event()
        _active[record.id] = cancellation
        try:
            record.status = "running"
            record.cycle_count += 1
            record.summary = "Inspecting evidence and choosing the next step."
            _audit(db, record, "cycle_started", {"cycle": record.cycle_count})
            db.commit()
        except IntegrityError as exc:
            _active.pop(record.id, None)
            db.rollback()
            raise AgentRunError("Another task acquired this conversation before this cycle could start") from exc
        except BaseException:
            _active.pop(record.id, None)
            raise
        return cancellation


def cancel_run(db: Session, record: models.AgentRun, reason: str) -> models.AgentRun:
    if record.status in TERMINAL:
        return record
    with _registry_lock:
        cancellation = _active.get(record.id)
        if cancellation:
            cancellation.set()
    record.status = "cancelled"
    record.summary = diagnostics.sanitize_output(reason, 1000)
    record.completed_at = datetime.utcnow()
    _audit(db, record, "cancelled", {"reason": record.summary})
    db.commit()
    return record


def cleanup_cycle(db: Session, run_id: str):
    """Also release a claim when a response ends before its iterator starts."""
    with _registry_lock:
        cancellation = _active.pop(run_id, None)
    if cancellation is not None:
        cancellation.set()
        db.rollback()
        record = get_run(db, run_id)
        if record is not None and record.status == "running":
            record.status = "interrupted"
            record.summary = "The response ended before the task cycle completed. Resume explicitly."
            _audit(db, record, "interrupted")
            db.commit()


def _persist_proposal(db: Session, record: models.AgentRun, event: dict) -> dict:
    kind = event.get("kind")
    if kind == "command_proposal" and event.get("command_run"):
        prepared_command = event["command_run"]
        changes, _commands, sessions = _related(db, record)
        verified = _verified(db, record, changes, sessions)
        due = [change for change in changes if change.status == "applied" and change.id not in verified]
        verification_profiles = {"pytest", "python_module", "npm_test", "npm_build", "npm_lint", "dotnet_test", "dotnet_build", "maven_test", "maven_package", "gradle_test", "gradle_build"}
        if due and prepared_command["profile"] in verification_profiles:
            step = schemas.VerificationStepInput(
                step_id="task-check", position=0, profile=prepared_command["profile"],
                arguments=prepared_command["arguments"], cwd_relative=prepared_command["cwd_relative"],
                purpose=prepared_command["purpose"], timeout_seconds=prepared_command["requested_timeout_seconds"],
            )
            session = verification.create_session(db, schemas.VerificationSessionCreate(
                conversation_id=record.conversation_id, workspace_id=record.workspace_id,
                source_change_set_id=due[-1].id, original_request=record.goal[:8000], steps=[step],
                total_time_budget_seconds=max(600, step.timeout_seconds),
            ))
            event = {"type": "proposal", "kind": "verification_plan", "verification_session": verification.serialize_session(session)}
        else:
            command = command_runs.persist_command_run(db, record.conversation_id, record.workspace_id, prepared_command)
            ids = _load(record.command_run_ids_json, [])
            record.command_run_ids_json = json.dumps([*ids, command.id])
            event = {**event, "command_run": command_runs.serialize_command_run(command)}
    else:
        prepared = event.get("change_set") if kind == "change_set" else None
        if kind == "file_change":
            root = Path(db.get(models.Workspace, record.workspace_id).root_path)
            prepared = changesets.prepare_legacy_change_set(root, str(event.get("path", "")),
                str(event.get("content", "")), str(event.get("explanation", "")))
        if not prepared:
            # Legacy terminal strings remain display-only, never task actions.
            return event
        change = changesets.persist_change_set(db, record.conversation_id, record.workspace_id, prepared)
        ids = _load(record.change_set_ids_json, [])
        record.change_set_ids_json = json.dumps([*ids, change.id])
        event = {**event, "change_set": changesets.serialize_change_set(change)}
    record.status = "awaiting_approval"
    _audit(db, record, "proposal", {"kind": event.get("kind", kind)})
    db.commit()
    return event


def _finish(db: Session, record: models.AgentRun, outcome: dict, elapsed: int) -> dict:
    db.refresh(record)
    record.elapsed_ms += elapsed
    if record.status == "cancelled":
        db.commit()
        return {"type": "outcome", "status": "cancelled", "summary": record.summary}
    requested_status = outcome.get("status", "blocked")
    status = requested_status if requested_status in {"completed", "awaiting_approval", "blocked", "exhausted"} else "blocked"
    summary = diagnostics.sanitize_output(public_text(outcome.get("summary")) or "The model stopped without a validated outcome.", 4000)
    changes, commands, sessions = _related(db, record)
    verified = _verified(db, record, changes, sessions)
    pending = any(change.status in {"proposed", "approved", "applying"} for change in changes)
    pending |= any(command.status not in command_runs.TERMINAL_STATUSES for command in commands)
    unverified = any(change.status == "applied" and change.id not in verified for change in changes)
    if pending or unverified:
        status = "awaiting_approval"
        summary = "Review the proposed action to continue." if pending else "Changes were applied. Approve and run verification before this task can be completed."
    elif status == "completed":
        if changes and not any(change.status == "applied" for change in changes):
            status, summary = "blocked", "The proposed changes were rejected, failed, or restored. The task has not been completed."
        latest_commands = {}
        observed_commands = {command.id: command for command in commands}
        for session in sessions:
            for step in session.steps:
                command = db.get(models.CommandRun, step.command_run_id) if step.command_run_id and step.required else None
                if command and command.workspace_id == record.workspace_id and command.conversation_id == record.conversation_id:
                    observed_commands[command.id] = command
        for command in sorted(observed_commands.values(), key=lambda item: item.created_at):
            latest_commands[(command.profile, command.cwd_relative, command.arguments_json)] = command
        if any(command.status != "completed" or command.exit_code != 0 for command in latest_commands.values()):
            status, summary = "blocked", "A required task command did not succeed. Its recorded result must be addressed before completion."
    if record.elapsed_ms >= record.time_budget_seconds * 1000 and status not in {"completed", "cancelled"}:
        status, summary = "exhausted", "The task reached its active-time budget. Recorded proposals remain available for review."
    record.status, record.summary = status, summary
    evidence = outcome.get("evidence") if isinstance(outcome.get("evidence"), dict) else {}
    evidence = {key: value for key, value in evidence.items() if key in {"inspected_paths", "tool_calls", "proposal_count", "reason", "verification_status"}}
    evidence["verified_change_set_ids"] = sorted(verified)
    evidence["verification_status"] = "passed" if verified and not unverified else "required" if unverified else "not_applicable"
    record.evidence_json = _bounded_json(evidence)
    if status in TERMINAL:
        record.completed_at = datetime.utcnow()
    _audit(db, record, "outcome", {"summary": summary})
    db.commit()
    return {"type": "outcome", "status": status, "summary": summary, "evidence": _load(record.evidence_json, {})}


def stream_cycle(db: Session, record: models.AgentRun, runtime, cancellation: Event):
    started = monotonic()
    previous_ms = record.elapsed_ms
    deadline = started + max(0, record.time_budget_seconds - previous_ms / 1000)
    final_message = ""
    outcome = {"status": "blocked", "summary": "The model ended without a validated task outcome."}
    iterator = None
    finished = False
    try:
        yield {"type": "task", "run": serialize_run(db, record)}
        history = crud.get_conversation_messages_for_model(db, record.conversation_id)
        # The goal is sent separately on every cycle; avoid duplicating it from
        # the persisted user message in the recent conversational context.
        if history and history[-1] == {"role": "user", "content": record.goal}:
            history.pop()
        iterator = runtime.run(
            record.goal, history, model=record.model, context=record.editor_context,
            execution_feedback=execution_feedback(db, record), plan=_load(record.plan_json, []),
            should_cancel=lambda: cancellation.is_set() or monotonic() >= deadline,
        )
        for event in iterator:
            if cancellation.is_set() or monotonic() >= deadline:
                outcome = {"status": "cancelled" if cancellation.is_set() else "exhausted", "summary": "Stopped before starting another action."}
                break
            kind = event.get("type")
            if kind == "proposal":
                event = _persist_proposal(db, record, event)
            elif kind == "plan":
                steps = normalize_plan(event.get("steps"))
                if len(steps) > 20 or len({step["id"] for step in steps}) != len(steps):
                    raise AgentRunError("The model returned an invalid bounded plan")
                record.plan_json = json.dumps(steps, ensure_ascii=False)
                _audit(db, record, "plan", {"steps": steps})
                db.commit()
                event = {"type": "plan", "steps": steps, "explanation": public_text(event.get("explanation"))[:1000]}
            elif kind == "outcome":
                outcome = event
                continue
            elif kind == "message":
                final_message = public_text(event.get("content"))[:100_000]
                continue
            yield event
        final = _finish(db, record, outcome, int((monotonic() - started) * 1000))
        finished = True
        yield final
        content = final_message if final["status"] == "completed" and final_message else final["summary"]
        if content:
            crud.add_message(db, record.conversation_id, "assistant", content)
            yield {"type": "message", "content": content}
        yield {"type": "task", "run": serialize_run(db, record)}
    except Exception as exc:
        db.rollback()
        if isinstance(exc, (workspace.WorkspaceError, ValueError, TypeError)) or exc.__class__.__name__ == "OllamaError":
            summary = diagnostics.sanitize_output(str(exc), 2000)
        else:
            logger.exception("Local agent task %s failed", record.id)
            summary = "The task encountered an internal error. Its recorded actions were preserved; inspect the local backend log before retrying."
        final = _finish(db, record, {"status": "blocked", "summary": summary}, int((monotonic() - started) * 1000))
        finished = True
        yield final
        yield {"type": "message", "content": final["summary"]}
        yield {"type": "task", "run": serialize_run(db, record)}
    finally:
        if iterator is not None:
            close = getattr(iterator, "close", None)
            if close:
                close()
        if not finished:
            db.rollback()
            db.refresh(record)
            if record.status not in TERMINAL:
                record.status = "interrupted"
                record.summary = "The stream disconnected. Review any recorded proposal and resume explicitly."
                record.elapsed_ms += int((monotonic() - started) * 1000)
                _audit(db, record, "interrupted")
                db.commit()
        with _registry_lock:
            _active.pop(record.id, None)
