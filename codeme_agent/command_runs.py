import json
import re
import uuid
from datetime import datetime
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from codeme_agent import models, schemas, workspace

OUTPUT_TAIL_LIMIT = 65_536
EVENT_DETAIL_LIMIT = 2_000
SENSITIVE_OUTPUT = re.compile(
    r"(?i)\b(token|secret|password|api[_-]?key|private[_-]?key|connection[_-]?string|credential|auth|cookie)\b\s*[:=]\s*([^\s]+)"
)
TERMINAL_STATUSES = {"completed", "failed", "timed_out", "cancelled", "rejected", "blocked"}


class CommandRunError(workspace.WorkspaceError):
    pass


def redact(value: str | None, limit: int) -> str | None:
    if not value:
        return None if value is None else ""
    clean = value.replace("\x00", "")
    clean = SENSITIVE_OUTPUT.sub(lambda match: f"{match.group(1)}=[REDACTED]", clean)
    return clean[-limit:]


def validate_cwd(root: Path, cwd_relative: str) -> str:
    if not cwd_relative or "\x00" in cwd_relative:
        raise CommandRunError("A workspace-relative working directory is required")
    candidate = Path(cwd_relative)
    if candidate.is_absolute() or workspace.is_unc_path(candidate):
        raise CommandRunError("Absolute and UNC working directories are not allowed")
    if cwd_relative != "." and any(part in {"", ".", ".."} for part in candidate.parts):
        raise CommandRunError("Traversal and ambiguous working directories are not allowed")
    resolved = (root / candidate).resolve(strict=True)
    try:
        workspace.assert_within_workspace(root, resolved)
    except workspace.WorkspaceSecurityError as exc:
        raise CommandRunError(str(exc)) from exc
    if not resolved.is_dir():
        raise CommandRunError("The command working directory must exist")
    return "." if resolved == root else resolved.relative_to(root).as_posix()


def prepare_command_run(root: Path, raw: dict) -> dict:
    try:
        proposal = schemas.CommandProposalInput.model_validate(raw)
    except Exception as exc:
        raise CommandRunError(f"Invalid command proposal: {exc}") from exc
    cwd_relative = validate_cwd(root, proposal.cwd_relative)
    return {
        "id": str(uuid.uuid4()),
        "schema_version": 1,
        "profile": proposal.profile,
        "arguments": proposal.arguments,
        "cwd_relative": cwd_relative,
        "purpose": proposal.purpose.strip(),
        "requested_timeout_seconds": proposal.requested_timeout_seconds,
        "model_risk_hint": proposal.model_risk_hint,
        "status": "proposed",
    }


def persist_command_run(
    db: Session,
    conversation_id: int,
    workspace_id: int,
    prepared: dict,
) -> models.CommandRun:
    if db.get(models.Conversation, conversation_id) is None:
        raise CommandRunError("Conversation not found")
    if db.get(models.Workspace, workspace_id) is None:
        raise CommandRunError("Workspace not found")
    record = models.CommandRun(
        id=prepared["id"],
        schema_version=prepared["schema_version"],
        conversation_id=conversation_id,
        workspace_id=workspace_id,
        profile=prepared["profile"],
        arguments_json=json.dumps(prepared["arguments"], ensure_ascii=False),
        cwd_relative=prepared["cwd_relative"],
        purpose=prepared["purpose"],
        requested_timeout_seconds=prepared["requested_timeout_seconds"],
        model_risk_hint=prepared.get("model_risk_hint"),
        status="proposed",
    )
    record.events.append(models.CommandRunEvent(from_status=None, to_status="proposed", detail="Command proposed"))
    db.add(record)
    db.commit()
    db.refresh(record)
    return record


def get_command_run(db: Session, command_run_id: str) -> models.CommandRun | None:
    return db.scalar(select(models.CommandRun).where(models.CommandRun.id == command_run_id))


def serialize_command_run(record: models.CommandRun) -> dict:
    timestamp = lambda value: value.isoformat() if value is not None else None
    return {
        "id": record.id,
        "schema_version": record.schema_version,
        "conversation_id": record.conversation_id,
        "workspace_id": record.workspace_id,
        "profile": record.profile,
        "arguments": json.loads(record.arguments_json or "[]"),
        "cwd_relative": record.cwd_relative,
        "purpose": record.purpose,
        "requested_timeout_seconds": record.requested_timeout_seconds,
        "model_risk_hint": record.model_risk_hint,
        "calculated_risk": record.calculated_risk,
        "risk_explanation": record.risk_explanation,
        "resolved_executable_name": record.resolved_executable_name,
        "environment_keys": json.loads(record.environment_keys_json or "[]"),
        "decision": record.decision,
        "status": record.status,
        "exit_code": record.exit_code,
        "termination_reason": record.termination_reason,
        "duration_ms": record.duration_ms,
        "stdout_tail": record.stdout_tail or "",
        "stderr_tail": record.stderr_tail or "",
        "output_truncated": bool(record.output_truncated),
        "timed_out": bool(record.timed_out),
        "cancelled": bool(record.cancelled),
        "failure_reason": record.failure_reason,
        "created_at": timestamp(record.created_at),
        "updated_at": timestamp(record.updated_at),
        "started_at": timestamp(record.started_at),
        "completed_at": timestamp(record.completed_at),
        "events": [{
            "from_status": event.from_status,
            "to_status": event.to_status,
            "detail": event.detail,
            "created_at": timestamp(event.created_at),
        } for event in record.events],
    }


def _transition(record: models.CommandRun, allowed: set[str], new_status: str, detail: str | None = None) -> None:
    if record.status not in allowed:
        raise CommandRunError(f"Cannot transition command from {record.status} to {new_status}")
    previous = record.status
    record.status = new_status
    record.events.append(models.CommandRunEvent(
        from_status=previous,
        to_status=new_status,
        detail=redact(detail, EVENT_DETAIL_LIMIT),
    ))


def record_decision(db: Session, record: models.CommandRun, request: schemas.CommandDecision) -> models.CommandRun:
    target = {"approve": "approved", "reject": "rejected", "block": "blocked"}[request.decision]
    if request.decision == "approve" and request.calculated_risk == "BLOCKED":
        raise CommandRunError("A blocked command cannot be approved")
    if request.decision == "block" and request.calculated_risk != "BLOCKED":
        raise CommandRunError("Blocked decisions require BLOCKED risk")
    _transition(record, {"proposed"}, target, request.risk_explanation)
    record.decision = request.decision
    record.calculated_risk = request.calculated_risk
    record.risk_explanation = redact(request.risk_explanation, 1000)
    record.resolved_executable_name = request.resolved_executable_name
    record.environment_keys_json = json.dumps(sorted(set(request.environment_keys)))
    record.decided_at = datetime.utcnow()
    db.commit()
    db.refresh(record)
    return record


def record_event(db: Session, record: models.CommandRun, request: schemas.CommandEventCreate) -> models.CommandRun:
    if request.status == "starting":
        _transition(record, {"approved"}, "starting", request.detail or "Process starting")
        record.started_at = record.started_at or datetime.utcnow()
    else:
        _transition(record, {"starting"}, "running", request.detail or "Process running")
    db.commit()
    db.refresh(record)
    return record


def _result_fingerprint(record: models.CommandRun) -> tuple:
    return (
        record.status, record.exit_code, record.termination_reason, record.duration_ms,
        record.stdout_tail or "", record.stderr_tail or "", bool(record.output_truncated),
        bool(record.timed_out), bool(record.cancelled), record.failure_reason,
    )


def record_result(db: Session, record: models.CommandRun, request: schemas.CommandResultCreate) -> models.CommandRun:
    stdout_tail = redact(request.stdout_tail, OUTPUT_TAIL_LIMIT) or ""
    stderr_tail = redact(request.stderr_tail, OUTPUT_TAIL_LIMIT) or ""
    failure_reason = redact(request.failure_reason, 2000)
    incoming = (
        request.status, request.exit_code, request.termination_reason, request.duration_ms,
        stdout_tail, stderr_tail, request.output_truncated, request.timed_out,
        request.cancelled, failure_reason,
    )
    if record.status in {"completed", "failed", "timed_out", "cancelled"}:
        if _result_fingerprint(record) == incoming:
            return record
        raise CommandRunError("A conflicting terminal result was already recorded")
    _transition(record, {"approved", "starting", "running"}, request.status, failure_reason or request.termination_reason)
    record.started_at = record.started_at or request.started_at
    record.completed_at = request.completed_at
    record.exit_code = request.exit_code
    record.termination_reason = request.termination_reason
    record.duration_ms = request.duration_ms
    record.stdout_tail = stdout_tail
    record.stderr_tail = stderr_tail
    record.output_truncated = int(request.output_truncated)
    record.timed_out = int(request.timed_out or request.status == "timed_out")
    record.cancelled = int(request.cancelled or request.status == "cancelled")
    record.failure_reason = failure_reason
    db.commit()
    db.refresh(record)
    return record
