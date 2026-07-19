import difflib
import hashlib
import json
import re
import uuid
from datetime import datetime
from pathlib import Path

from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.orm import Session

from codeme_agent import models, schemas, workspace
from codeme_agent.config import settings

SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")
SECRET_DETAIL_PATTERN = re.compile(r"(?i)(token|password|secret|api[_-]?key)\s*[:=]\s*\S+")


class ChangeSetError(workspace.WorkspaceError):
    pass


def sha256_text(content: str) -> str:
    return hashlib.sha256(content.encode("utf-8")).hexdigest()


def _safe_detail(detail: str | None) -> str | None:
    if not detail:
        return None
    return SECRET_DETAIL_PATTERN.sub(r"\1=[REDACTED]", detail.replace("\x00", ""))[:1000]


def _detect_line_ending(content: str) -> str:
    has_crlf = "\r\n" in content
    has_lf = "\n" in content.replace("\r\n", "")
    if has_crlf and has_lf:
        return "mixed"
    if has_crlf:
        return "crlf"
    if has_lf:
        return "lf"
    return "none"


def _normalize_new_text(content: str, line_ending: str) -> str:
    if line_ending not in {"lf", "crlf"}:
        return content
    normalized = content.replace("\r\n", "\n").replace("\r", "\n")
    return normalized.replace("\n", "\r\n") if line_ending == "crlf" else normalized


def _target(root: Path, relative_path: str) -> tuple[str, Path]:
    if not relative_path or "\x00" in relative_path:
        raise ChangeSetError("A workspace-relative path is required")
    candidate = Path(relative_path)
    if candidate.is_absolute() or workspace.is_unc_path(candidate):
        raise ChangeSetError("Absolute and UNC paths are not allowed")
    if any(part in {"", ".", ".."} for part in candidate.parts):
        raise ChangeSetError("Traversal and ambiguous path segments are not allowed")
    resolved = (root / candidate).resolve(strict=False)
    try:
        workspace.assert_within_workspace(root, resolved)
    except workspace.WorkspaceSecurityError as exc:
        raise ChangeSetError(str(exc)) from exc
    if workspace.is_excluded_path(resolved, root):
        raise ChangeSetError("Protected or secret files cannot be changed")
    return resolved.relative_to(root).as_posix(), resolved


def _read_base(root: Path, relative_path: str) -> tuple[str, Path, str]:
    normalized, target = _target(root, relative_path)
    if not target.exists() or not target.is_file():
        raise ChangeSetError(f"Modify target does not exist: {normalized}")
    if workspace.is_binary_file(target):
        raise ChangeSetError(f"Binary files cannot be changed: {normalized}")
    if target.stat().st_size > settings.max_file_size:
        raise ChangeSetError(f"File exceeds the configured limit: {normalized}")
    try:
        content = target.read_bytes().decode("utf-8")
    except UnicodeDecodeError as exc:
        raise ChangeSetError(f"Only UTF-8 text files are supported: {normalized}") from exc
    return normalized, target, content


def _apply_edits(base: str, edits: list[schemas.SearchReplaceEdit], line_ending: str) -> str:
    replacements: list[tuple[int, int, str]] = []
    for edit in edits:
        positions = []
        start = 0
        while True:
            index = base.find(edit.old_text, start)
            if index < 0:
                break
            positions.append(index)
            start = index + max(1, len(edit.old_text))
        if not positions:
            raise ChangeSetError("A structured edit did not match the verified base content")
        if not edit.replace_all and len(positions) != 1:
            raise ChangeSetError("A structured edit is ambiguous; old_text must match exactly once")
        selected = positions if edit.replace_all else positions[:1]
        replacement = _normalize_new_text(edit.new_text, line_ending)
        replacements.extend((position, position + len(edit.old_text), replacement) for position in selected)

    replacements.sort(key=lambda item: (item[0], item[1]))
    for previous, current in zip(replacements, replacements[1:]):
        if current[0] < previous[1]:
            raise ChangeSetError("Structured edits overlap")

    result = base
    for start, end, replacement in reversed(replacements):
        result = result[:start] + replacement + result[end:]
    return result


def _diff(relative_path: str, base: str, proposed: str, operation_type: str) -> str:
    before = base.replace("\r\n", "\n").replace("\r", "\n").splitlines(keepends=True)
    after = proposed.replace("\r\n", "\n").replace("\r", "\n").splitlines(keepends=True)
    from_name = "/dev/null" if operation_type == "create" else f"a/{relative_path}"
    return "".join(difflib.unified_diff(before, after, fromfile=from_name, tofile=f"b/{relative_path}"))


def _prepare_operation(root: Path, operation: schemas.ChangeOperationInput) -> dict:
    normalized, target = _target(root, operation.relative_path)
    if operation.type == "create":
        if target.exists():
            raise ChangeSetError(f"Create target already exists: {normalized}")
        if not target.parent.exists() or not target.parent.is_dir():
            raise ChangeSetError(f"Create target parent does not exist: {normalized}")
        proposed = operation.content or ""
        if len(proposed.encode("utf-8")) > settings.max_file_size:
            raise ChangeSetError(f"Proposed file exceeds the configured limit: {normalized}")
        base = ""
        base_hash = None
        line_ending = _detect_line_ending(proposed)
    else:
        normalized, _target_path, base = _read_base(root, operation.relative_path)
        base_hash = sha256_text(base)
        line_ending = _detect_line_ending(base)
        proposed = _apply_edits(base, operation.edits, line_ending)
    if proposed == base and operation.type == "modify":
        raise ChangeSetError(f"Modify operation does not change content: {normalized}")
    return {
        "operation_id": str(uuid.uuid4()),
        "type": operation.type,
        "relative_path": normalized,
        "summary": operation.summary,
        "base_sha256": base_hash,
        "proposed_sha256": sha256_text(proposed),
        "result_sha256": None,
        "encoding": "utf-8",
        "line_ending": line_ending,
        "edits": [edit.model_dump() for edit in operation.edits],
        "proposed_content": proposed,
        "diff": _diff(normalized, base, proposed, operation.type),
    }


def prepare_change_set(root: Path, summary: str, raw_operations: list[dict]) -> dict:
    if not raw_operations:
        raise ChangeSetError("A change set must contain at least one operation")
    if len(raw_operations) > 50:
        raise ChangeSetError("A change set cannot contain more than 50 operations")
    try:
        operations = [schemas.ChangeOperationInput.model_validate(item) for item in raw_operations]
    except ValidationError as exc:
        raise ChangeSetError(f"Invalid change-set operation: {exc.errors()[0]['msg']}") from exc
    prepared = [_prepare_operation(root, operation) for operation in operations]
    paths = [item["relative_path"].casefold() for item in prepared]
    if len(paths) != len(set(paths)):
        raise ChangeSetError("Duplicate or conflicting paths are not allowed")
    normalized_summary = summary.strip()
    if not normalized_summary:
        raise ChangeSetError("A change-set summary is required")
    return {
        "id": str(uuid.uuid4()),
        "schema_version": 1,
        "summary": normalized_summary[:500],
        "status": "proposed",
        "operations": prepared,
    }


def prepare_legacy_change_set(root: Path, relative_path: str, content: str, explanation: str) -> dict:
    normalized, target = _target(root, relative_path)
    if len(content.encode("utf-8")) > settings.max_file_size:
        raise ChangeSetError("Proposed file exceeds the configured limit")
    if target.exists():
        normalized, _target_path, base = _read_base(root, relative_path)
        operation_type = "modify"
        base_hash = sha256_text(base)
        line_ending = _detect_line_ending(base)
    else:
        base = ""
        operation_type = "create"
        base_hash = None
        line_ending = _detect_line_ending(content)
    if operation_type == "modify" and base == content:
        raise ChangeSetError("The legacy proposal does not change the target")
    return {
        "id": str(uuid.uuid4()),
        "schema_version": 1,
        "summary": (explanation or f"Update {normalized}")[:500],
        "status": "proposed",
        "legacy": True,
        "operations": [{
            "operation_id": str(uuid.uuid4()),
            "type": operation_type,
            "relative_path": normalized,
            "summary": (explanation or f"Update {normalized}")[:500],
            "base_sha256": base_hash,
            "proposed_sha256": sha256_text(content),
            "result_sha256": None,
            "encoding": "utf-8",
            "line_ending": line_ending,
            "edits": [],
            "proposed_content": content,
            "diff": _diff(normalized, base, content, operation_type),
        }],
    }


def persist_change_set(db: Session, conversation_id: int, workspace_id: int, prepared: dict) -> models.ChangeSet:
    record = models.ChangeSet(
        id=prepared["id"],
        schema_version=prepared["schema_version"],
        conversation_id=conversation_id,
        workspace_id=workspace_id,
        summary=prepared["summary"],
        status="proposed",
    )
    for position, operation in enumerate(prepared["operations"]):
        record.operations.append(models.ChangeOperation(
            id=operation["operation_id"],
            position=position,
            operation_type=operation["type"],
            relative_path=operation["relative_path"],
            summary=operation["summary"],
            base_sha256=operation["base_sha256"],
            proposed_sha256=operation["proposed_sha256"],
            encoding=operation["encoding"],
            line_ending=operation["line_ending"],
            edits_json=json.dumps(operation["edits"], ensure_ascii=False),
            proposed_content=operation["proposed_content"],
            diff=operation["diff"],
        ))
    record.events.append(models.ChangeSetEvent(from_status=None, to_status="proposed", detail="Change set proposed"))
    db.add(record)
    db.commit()
    db.refresh(record)
    return record


def get_change_set(db: Session, change_set_id: str) -> models.ChangeSet | None:
    return db.scalar(select(models.ChangeSet).where(models.ChangeSet.id == change_set_id))


def serialize_change_set(record: models.ChangeSet) -> dict:
    timestamp = lambda value: value.isoformat() if value is not None else None
    return {
        "id": record.id,
        "schema_version": record.schema_version,
        "conversation_id": record.conversation_id,
        "workspace_id": record.workspace_id,
        "summary": record.summary,
        "status": record.status,
        "checkpoint_reference": record.checkpoint_reference,
        "failure_reason": record.failure_reason,
        "created_at": timestamp(record.created_at),
        "updated_at": timestamp(record.updated_at),
        "operations": [{
            "operation_id": item.id,
            "type": item.operation_type,
            "relative_path": item.relative_path,
            "summary": item.summary,
            "base_sha256": item.base_sha256,
            "proposed_sha256": item.proposed_sha256,
            "result_sha256": item.result_sha256,
            "encoding": item.encoding,
            "line_ending": item.line_ending,
            "edits": json.loads(item.edits_json or "[]"),
            "proposed_content": item.proposed_content,
            "diff": item.diff,
        } for item in record.operations],
        "events": [{
            "from_status": event.from_status,
            "to_status": event.to_status,
            "detail": event.detail,
            "created_at": timestamp(event.created_at),
        } for event in record.events],
    }


def _transition(record: models.ChangeSet, allowed: set[str], new_status: str, detail: str | None = None) -> None:
    if record.status not in allowed:
        raise ChangeSetError(f"Cannot transition change set from {record.status} to {new_status}")
    previous = record.status
    record.status = new_status
    record.events.append(models.ChangeSetEvent(
        from_status=previous,
        to_status=new_status,
        detail=_safe_detail(detail),
    ))


def record_decision(db: Session, record: models.ChangeSet, request: schemas.ChangeSetDecision) -> models.ChangeSet:
    now = datetime.utcnow()
    if request.decision == "approve":
        _transition(record, {"proposed"}, "approved", request.detail or "Approved in VS Code")
    else:
        _transition(record, {"proposed"}, "rejected", request.detail or "Rejected in VS Code")
    record.decided_at = now
    db.commit()
    db.refresh(record)
    return record


def record_apply_result(db: Session, record: models.ChangeSet, request: schemas.ChangeSetApplyResult) -> models.ChangeSet:
    if request.status == "applied":
        if not request.checkpoint_reference:
            raise ChangeSetError("An applied change set requires a checkpoint reference")
        expected_paths = {operation.relative_path for operation in record.operations}
        if set(request.result_hashes) != expected_paths:
            raise ChangeSetError("Result hashes must cover every operation")
        for operation in record.operations:
            result_hash = request.result_hashes[operation.relative_path].lower()
            if not SHA256_PATTERN.fullmatch(result_hash) or result_hash != operation.proposed_sha256:
                raise ChangeSetError(f"Result hash does not match proposal for {operation.relative_path}")
        _transition(record, {"approved"}, "applying", "Application started")
        for operation in record.operations:
            result_hash = request.result_hashes[operation.relative_path].lower()
            operation.result_sha256 = result_hash
        record.checkpoint_reference = request.checkpoint_reference
        record.applied_at = datetime.utcnow()
        _transition(record, {"applying"}, "applied", "All operations applied and verified")
    else:
        _transition(record, {"approved"}, "applying", "Application started")
        record.failure_reason = _safe_detail(request.failure_reason or "Application failed")
        _transition(record, {"applying"}, "failed", record.failure_reason)
    db.commit()
    db.refresh(record)
    return record


def record_restore_result(db: Session, record: models.ChangeSet, request: schemas.ChangeSetRestoreResult) -> models.ChangeSet:
    if request.status == "restored":
        _transition(record, {"applied", "restore_failed"}, "restored", "Checkpoint restored")
        record.restored_at = datetime.utcnow()
    else:
        record.failure_reason = _safe_detail(request.failure_reason or "Restore failed")
        _transition(record, {"applied", "restore_failed"}, "restore_failed", record.failure_reason)
    db.commit()
    db.refresh(record)
    return record
