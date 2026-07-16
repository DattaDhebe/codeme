from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from codeme_agent import crud, ollama, schemas, workspace
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
def get_git_diff(workspace_id: int, path: str = Query(...), db: Session = Depends(get_db)):
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
                    yield f"data: {chunk}\n\n"
            yield "event: done\ndata: [DONE]\n\n"
        except ollama.OllamaError as exc:
            error = {"error": str(exc)}
            yield f"event: error\ndata: {error}\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream")
