from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from codeme_agent import models


def get_workspace(db: Session, workspace_id: int) -> models.Workspace | None:
    return db.scalar(select(models.Workspace).where(models.Workspace.id == workspace_id))


def list_workspaces(db: Session) -> list[models.Workspace]:
    stmt = select(models.Workspace).order_by(models.Workspace.updated_at.desc())
    return list(db.scalars(stmt))


def get_workspace_by_root(db: Session, root_path: str) -> models.Workspace | None:
    return db.scalar(select(models.Workspace).where(models.Workspace.root_path == root_path))


def create_workspace(db: Session, display_name: str, root_path: str) -> models.Workspace:
    workspace = models.Workspace(display_name=display_name, root_path=root_path)
    db.add(workspace)
    db.commit()
    db.refresh(workspace)
    return workspace


def delete_workspace(db: Session, workspace_id: int) -> None:
    db.execute(delete(models.Workspace).where(models.Workspace.id == workspace_id))
    db.commit()


def get_conversation(db: Session, conversation_id: int) -> models.Conversation | None:
    return db.scalar(select(models.Conversation).where(models.Conversation.id == conversation_id))


def list_conversations(db: Session, query: str | None = None) -> list[models.Conversation]:
    statement = select(models.Conversation).order_by(models.Conversation.updated_at.desc())
    if query:
        statement = statement.filter(models.Conversation.title.ilike(f"%{query}%"))
    return list(db.scalars(statement))


def create_conversation(db: Session, title: str | None = None) -> models.Conversation:
    conversation = models.Conversation(title=title or "New conversation")
    db.add(conversation)
    db.commit()
    db.refresh(conversation)
    return conversation


def rename_conversation(db: Session, conversation_id: int, title: str) -> models.Conversation:
    conversation = get_conversation(db, conversation_id)
    if conversation is None:
        raise ValueError("Conversation not found")
    conversation.title = title
    db.commit()
    db.refresh(conversation)
    return conversation


def delete_conversation(db: Session, conversation_id: int) -> None:
    db.execute(delete(models.Conversation).where(models.Conversation.id == conversation_id))
    db.commit()


def get_messages(db: Session, conversation_id: int) -> list[models.Message]:
    conversation = get_conversation(db, conversation_id)
    return list(conversation.messages) if conversation else []


def add_message(db: Session, conversation_id: int, role: str, content: str) -> models.Message:
    message = models.Message(conversation_id=conversation_id, role=role, content=content)
    db.add(message)
    db.commit()
    db.refresh(message)
    return message


def append_message_content(db: Session, message_id: int, chunk: str) -> models.Message:
    message = db.get(models.Message, message_id)
    if message is None:
        raise ValueError("Message not found")
    message.content += chunk
    db.commit()
    db.refresh(message)
    return message


def get_conversation_messages_for_model(db: Session, conversation_id: int) -> list[dict[str, str]]:
    return [
        {"role": message.role, "content": message.content}
        for message in get_messages(db, conversation_id)
    ]
