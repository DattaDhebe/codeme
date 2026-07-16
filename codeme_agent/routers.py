from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from codeme_agent import crud, ollama, schemas
from codeme_agent.db import get_db

router = APIRouter(prefix="/api")


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
