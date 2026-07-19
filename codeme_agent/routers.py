import json
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from codeme_agent import agent, changesets, command_runs, crud, models, ollama, repair_agent, schemas, verification, workspace
from codeme_agent.db import get_db

router = APIRouter(prefix="/api")


@router.get("/workspaces", response_model=list[schemas.WorkspaceRead])
def list_workspaces(db: Session = Depends(get_db)):
    return crud.list_workspaces(db)


@router.post("/workspaces", response_model=schemas.WorkspaceRead, status_code=status.HTTP_201_CREATED)
def create_workspace(request: schemas.WorkspaceCreate, db: Session = Depends(get_db)):
    root = workspace.normalize_workspace_root(request.path)
    root_path = str(root)
    existing = crud.get_workspace_by_root(db, root_path)
    if existing:
        return existing
    display_name = request.display_name or root.name or root_path
    return crud.create_workspace(db, display_name, root_path)


@router.delete("/workspaces/{workspace_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_workspace(workspace_id: int, db: Session = Depends(get_db)):
    if crud.get_workspace(db, workspace_id) is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Workspace not found")
    crud.delete_workspace(db, workspace_id)


@router.get("/workspaces/{workspace_id}/files", response_model=schemas.FileListResponse)
def list_files(
    workspace_id: int,
    path: str | None = Query(None),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=250),
    db: Session = Depends(get_db),
):
    workspace_record = crud.get_workspace(db, workspace_id)
    if workspace_record is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Workspace not found")
    entries, has_more = workspace.list_directory(Path(workspace_record.root_path), path, page, page_size)
    return schemas.FileListResponse(entries=entries, page=page, page_size=page_size, has_more=has_more)


@router.get("/workspaces/{workspace_id}/files/metadata", response_model=schemas.FileMetadata)
def get_file_metadata(workspace_id: int, path: str = Query(""), db: Session = Depends(get_db)):
    workspace_record = crud.get_workspace(db, workspace_id)
    if workspace_record is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Workspace not found")
    return workspace.get_file_metadata(Path(workspace_record.root_path), path)


@router.get("/workspaces/{workspace_id}/files/content", response_model=schemas.FileRead)
def read_file(workspace_id: int, path: str = Query(...), db: Session = Depends(get_db)):
    workspace_record = crud.get_workspace(db, workspace_id)
    if workspace_record is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Workspace not found")
    return workspace.read_file(Path(workspace_record.root_path), path)


@router.get("/workspaces/{workspace_id}/search", response_model=schemas.SearchResponse)
def search_code(
    workspace_id: int,
    query: str = Query(..., min_length=1),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    db: Session = Depends(get_db),
):
    workspace_record = crud.get_workspace(db, workspace_id)
    if workspace_record is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Workspace not found")
    return workspace.search_code(Path(workspace_record.root_path), query, page, page_size)


@router.get("/workspaces/{workspace_id}/git/status", response_model=schemas.GitStatusResponse)
def get_git_status(workspace_id: int, db: Session = Depends(get_db)):
    workspace_record = crud.get_workspace(db, workspace_id)
    if workspace_record is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Workspace not found")
    return workspace.get_git_status(Path(workspace_record.root_path))


@router.get("/workspaces/{workspace_id}/git/diff", response_model=schemas.GitDiffResponse)
def get_git_diff(workspace_id: int, path: str | None = Query(None), db: Session = Depends(get_db)):
    workspace_record = crud.get_workspace(db, workspace_id)
    if workspace_record is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Workspace not found")
    return workspace.get_git_diff(Path(workspace_record.root_path), path)


@router.get("/workspaces/{workspace_id}/agents", response_model=schemas.AgentInstructionsResponse)
def get_agent_instructions(workspace_id: int, path: str | None = Query(None), db: Session = Depends(get_db)):
    workspace_record = crud.get_workspace(db, workspace_id)
    if workspace_record is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Workspace not found")
    return workspace.find_agent_instructions(Path(workspace_record.root_path), path)


@router.get("/conversations", response_model=list[schemas.ConversationSummary])
def list_conversations(query: str | None = None, db: Session = Depends(get_db)):
    return crud.list_conversations(db, query)


@router.post("/conversations", response_model=schemas.ConversationSummary, status_code=status.HTTP_201_CREATED)
def create_conversation(conversation: schemas.ConversationCreate, db: Session = Depends(get_db)):
    return crud.create_conversation(db, conversation.title)


@router.patch("/conversations/{conversation_id}", response_model=schemas.ConversationSummary)
def rename_conversation(conversation_id: int, update: schemas.ConversationUpdate, db: Session = Depends(get_db)):
    try:
        return crud.rename_conversation(db, conversation_id, update.title)
    except ValueError:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Conversation not found")


@router.delete("/conversations/{conversation_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_conversation(conversation_id: int, db: Session = Depends(get_db)):
    if crud.get_conversation(db, conversation_id) is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Conversation not found")
    crud.delete_conversation(db, conversation_id)


@router.get("/conversations/{conversation_id}/messages", response_model=list[schemas.MessageRead])
def get_messages(conversation_id: int, db: Session = Depends(get_db)):
    if crud.get_conversation(db, conversation_id) is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Conversation not found")
    return crud.get_messages(db, conversation_id)


@router.post("/change-sets", response_model=schemas.ChangeSetRead, status_code=status.HTTP_201_CREATED)
def create_change_set(request: schemas.ChangeSetCreate, db: Session = Depends(get_db)):
    if crud.get_conversation(db, request.conversation_id) is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Conversation not found")
    workspace_record = crud.get_workspace(db, request.workspace_id)
    if workspace_record is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Workspace not found")
    try:
        prepared = changesets.prepare_change_set(
            Path(workspace_record.root_path),
            request.summary,
            [operation.model_dump() for operation in request.operations],
        )
    except changesets.ChangeSetError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=str(exc)) from exc
    record = changesets.persist_change_set(db, request.conversation_id, request.workspace_id, prepared)
    return changesets.serialize_change_set(record)


@router.get("/change-sets/{change_set_id}", response_model=schemas.ChangeSetRead)
def get_change_set(change_set_id: str, db: Session = Depends(get_db)):
    record = changesets.get_change_set(db, change_set_id)
    if record is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Change set not found")
    return changesets.serialize_change_set(record)


@router.post("/change-sets/{change_set_id}/decision", response_model=schemas.ChangeSetRead)
def decide_change_set(change_set_id: str, request: schemas.ChangeSetDecision, db: Session = Depends(get_db)):
    record = changesets.get_change_set(db, change_set_id)
    if record is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Change set not found")
    try:
        return changesets.serialize_change_set(changesets.record_decision(db, record, request))
    except changesets.ChangeSetError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc


@router.post("/change-sets/{change_set_id}/result", response_model=schemas.ChangeSetRead)
def record_change_set_result(change_set_id: str, request: schemas.ChangeSetApplyResult, db: Session = Depends(get_db)):
    record = changesets.get_change_set(db, change_set_id)
    if record is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Change set not found")
    try:
        return changesets.serialize_change_set(changesets.record_apply_result(db, record, request))
    except changesets.ChangeSetError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc


@router.post("/change-sets/{change_set_id}/restore", response_model=schemas.ChangeSetRead)
def record_change_set_restore(change_set_id: str, request: schemas.ChangeSetRestoreResult, db: Session = Depends(get_db)):
    record = changesets.get_change_set(db, change_set_id)
    if record is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Change set not found")
    try:
        return changesets.serialize_change_set(changesets.record_restore_result(db, record, request))
    except changesets.ChangeSetError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc


@router.get("/command-runs/{command_run_id}", response_model=schemas.CommandRunRead)
def get_command_run(command_run_id: str, db: Session = Depends(get_db)):
    record = command_runs.get_command_run(db, command_run_id)
    if record is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Command run not found")
    return command_runs.serialize_command_run(record)


@router.post("/command-runs/{command_run_id}/decision", response_model=schemas.CommandRunRead)
def decide_command_run(command_run_id: str, request: schemas.CommandDecision, db: Session = Depends(get_db)):
    record = command_runs.get_command_run(db, command_run_id)
    if record is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Command run not found")
    try:
        return command_runs.serialize_command_run(command_runs.record_decision(db, record, request))
    except command_runs.CommandRunError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc


@router.post("/command-runs/{command_run_id}/events", response_model=schemas.CommandRunRead)
def record_command_event(command_run_id: str, request: schemas.CommandEventCreate, db: Session = Depends(get_db)):
    record = command_runs.get_command_run(db, command_run_id)
    if record is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Command run not found")
    try:
        return command_runs.serialize_command_run(command_runs.record_event(db, record, request))
    except command_runs.CommandRunError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc


@router.post("/command-runs/{command_run_id}/result", response_model=schemas.CommandRunRead)
def record_command_result(command_run_id: str, request: schemas.CommandResultCreate, db: Session = Depends(get_db)):
    record = command_runs.get_command_run(db, command_run_id)
    if record is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Command run not found")
    try:
        return command_runs.serialize_command_run(command_runs.record_result(db, record, request))
    except command_runs.CommandRunError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc


@router.post("/verification-sessions", response_model=schemas.VerificationSessionRead, status_code=status.HTTP_201_CREATED)
def create_verification_session(request: schemas.VerificationSessionCreate, db: Session = Depends(get_db)):
    try:
        return verification.serialize_session(verification.create_session(db, request))
    except verification.VerificationError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc


@router.get("/verification-sessions", response_model=list[schemas.VerificationSessionRead])
def list_verification_sessions(
    workspace_id: int = Query(...),
    active_only: bool = Query(False),
    db: Session = Depends(get_db),
):
    return [verification.serialize_session(record) for record in verification.list_sessions(db, workspace_id, active_only)]


@router.get("/verification-sessions/{session_id}", response_model=schemas.VerificationSessionRead)
def get_verification_session(session_id: str, db: Session = Depends(get_db)):
    record = verification.get_session(db, session_id)
    if record is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Verification session not found")
    return verification.serialize_session(record)


@router.get("/verification-sessions/{session_id}/events")
def stream_verification_events(session_id: str, db: Session = Depends(get_db)):
    record = verification.get_session(db, session_id)
    if record is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Verification session not found")
    events = list(record.events)

    def event_stream():
        for event in events:
            payload = {
                "schema_version": 1,
                "session_id": record.id,
                "type": event.event_type,
                "from_state": event.from_state,
                "to_state": event.to_state,
                "detail": event.detail,
                "created_at": event.created_at.isoformat(),
            }
            yield f"event: {event.event_type}\ndata: {json.dumps(payload)}\n\n"
        yield "event: done\ndata: [DONE]\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream")


@router.post("/verification-sessions/{session_id}/decision", response_model=schemas.VerificationSessionRead)
def decide_verification_plan(session_id: str, request: schemas.VerificationPlanDecision, db: Session = Depends(get_db)):
    record = verification.get_session(db, session_id)
    if record is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Verification session not found")
    try:
        return verification.serialize_session(verification.decide_plan(db, record, request))
    except verification.VerificationError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc


@router.post("/verification-sessions/{session_id}/steps/{step_id}/start", response_model=schemas.VerificationStepStartRead)
def start_verification_step(
    session_id: str,
    step_id: str,
    request: schemas.VerificationStepStart,
    db: Session = Depends(get_db),
):
    record = verification.get_session(db, session_id)
    if record is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Verification session not found")
    try:
        session, command = verification.start_step(db, record, step_id, request)
        return {
            "session": verification.serialize_session(session),
            "command_run": command_runs.serialize_command_run(command),
        }
    except verification.VerificationError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc


@router.post("/verification-sessions/{session_id}/steps/{step_id}/result", response_model=schemas.VerificationSessionRead)
def record_verification_step_result(
    session_id: str,
    step_id: str,
    request: schemas.VerificationStepResult,
    db: Session = Depends(get_db),
):
    record = verification.get_session(db, session_id)
    if record is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Verification session not found")
    try:
        return verification.serialize_session(verification.record_step_result(db, record, step_id, request))
    except verification.VerificationError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc


@router.post("/verification-sessions/{session_id}/repair", response_model=schemas.VerificationSessionRead)
def prepare_verification_repair(
    session_id: str,
    request: schemas.VerificationRepairRequest,
    db: Session = Depends(get_db),
):
    record = verification.get_session(db, session_id)
    if record is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Verification session not found")
    try:
        attempt, feedback = verification.begin_repair(db, record)
        workspace_record = db.get(models.Workspace, record.workspace_id)
        analysis, prepared = repair_agent.RepairAgent(Path(workspace_record.root_path)).run(
            record.original_request, feedback, model=request.model,
        )
        change_set = changesets.persist_change_set(
            db, record.conversation_id, record.workspace_id, prepared,
        ) if prepared else None
        return verification.serialize_session(verification.attach_repair(db, record, attempt, change_set, analysis))
    except (verification.VerificationError, workspace.WorkspaceError) as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    except ollama.OllamaError as exc:
        if 'attempt' in locals():
            verification.attach_repair(db, record, attempt, None, f"Repair model unavailable: {exc}")
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(exc)) from exc


@router.post("/verification-sessions/{session_id}/repair-result", response_model=schemas.VerificationSessionRead)
def record_verification_repair_result(
    session_id: str,
    request: schemas.VerificationRepairResult,
    db: Session = Depends(get_db),
):
    record = verification.get_session(db, session_id)
    if record is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Verification session not found")
    try:
        return verification.serialize_session(verification.record_repair_result(db, record, request))
    except verification.VerificationError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc


@router.post("/verification-sessions/{session_id}/cancel", response_model=schemas.VerificationSessionRead)
def cancel_verification_session(session_id: str, request: schemas.VerificationCancel, db: Session = Depends(get_db)):
    record = verification.get_session(db, session_id)
    if record is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Verification session not found")
    try:
        return verification.serialize_session(verification.cancel_session(db, record, request.reason))
    except verification.VerificationError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc


@router.post("/verification-sessions/{session_id}/interrupt", response_model=schemas.VerificationSessionRead)
def interrupt_verification_session(session_id: str, request: schemas.VerificationCancel, db: Session = Depends(get_db)):
    record = verification.get_session(db, session_id)
    if record is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Verification session not found")
    try:
        return verification.serialize_session(verification.cancel_session(db, record, request.reason, interrupted=True))
    except verification.VerificationError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc


@router.post("/conversations/{conversation_id}/chat")
def chat(conversation_id: int, request: schemas.ChatRequest, db: Session = Depends(get_db)):
    conversation = crud.get_conversation(db, conversation_id)
    if conversation is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Conversation not found")

    history = crud.get_conversation_messages_for_model(db, conversation_id)
    for message in request.messages:
        history.append({"role": message.role, "content": message.content})
        crud.add_message(db, conversation_id, role=message.role, content=message.content)

    assistant_message = crud.add_message(db, conversation_id, role="assistant", content="")
    client = ollama.OllamaClient()

    def event_stream():
        try:
            for chunk in client.stream_chat(history, model=request.model):
                if chunk:
                    crud.append_message_content(db, assistant_message.id, chunk)
                    yield f"data: {json.dumps(chunk)}\n\n"
            yield "event: done\ndata: [DONE]\n\n"
        except ollama.OllamaError as exc:
            error = json.dumps({"error": str(exc)})
            yield f"event: error\ndata: {error}\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream")


@router.post("/conversations/{conversation_id}/agent")
def run_agent(conversation_id: int, request: schemas.AgentRequest, db: Session = Depends(get_db)):
    conversation = crud.get_conversation(db, conversation_id)
    if conversation is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Conversation not found")
    workspace_record = crud.get_workspace(db, request.workspace_id)
    if workspace_record is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Workspace not found")

    history = crud.get_conversation_messages_for_model(db, conversation_id)
    crud.add_message(db, conversation_id, role="user", content=request.prompt)
    runtime = agent.WorkspaceAgent(Path(workspace_record.root_path))

    def event_stream():
        final_content = ""
        try:
            for event in runtime.run(request.prompt, history, model=request.model, context=request.context):
                if event.get("type") == "proposal":
                    if event.get("kind") == "command_proposal":
                        prepared_command = event.get("command_run")
                        if prepared_command:
                            command_record = command_runs.persist_command_run(
                                db, conversation_id, request.workspace_id, prepared_command
                            )
                            event = {**event, "command_run": command_runs.serialize_command_run(command_record)}
                        prepared = None
                    elif event.get("kind") == "change_set":
                        prepared = event.get("change_set")
                    elif event.get("kind") == "file_change":
                        prepared = changesets.prepare_legacy_change_set(
                            Path(workspace_record.root_path),
                            str(event.get("path", "")),
                            str(event.get("content", "")),
                            str(event.get("explanation", "")),
                        )
                    else:
                        prepared = None
                    if prepared:
                        record = changesets.persist_change_set(db, conversation_id, request.workspace_id, prepared)
                        event = {**event, "change_set": changesets.serialize_change_set(record)}
                if event.get("type") == "message":
                    final_content = str(event.get("content", ""))
                event_name = str(event.get("type", "agent"))
                yield f"event: {event_name}\ndata: {json.dumps(event)}\n\n"
            if final_content:
                crud.add_message(db, conversation_id, role="assistant", content=final_content)
            yield "event: done\ndata: [DONE]\n\n"
        except (ollama.OllamaError, workspace.WorkspaceError) as exc:
            error = json.dumps({"error": str(exc)})
            yield f"event: error\ndata: {error}\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream")
