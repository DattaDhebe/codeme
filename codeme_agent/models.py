from datetime import datetime

from sqlalchemy import Column, DateTime, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import relationship

from codeme_agent.db import Base


class Workspace(Base):
    __tablename__ = "workspaces"

    id = Column(Integer, primary_key=True, index=True)
    display_name = Column(String(200), nullable=False)
    root_path = Column(String(1024), nullable=False, unique=True)
    created_at = Column(DateTime(timezone=True), default=datetime.utcnow, nullable=False)
    updated_at = Column(
        DateTime(timezone=True),
        default=datetime.utcnow,
        onupdate=datetime.utcnow,
        nullable=False,
    )


class Conversation(Base):
    __tablename__ = "conversations"

    id = Column(Integer, primary_key=True, index=True)
    title = Column(String(200), nullable=False, default="New conversation")
    created_at = Column(DateTime(timezone=True), default=datetime.utcnow, nullable=False)
    updated_at = Column(
        DateTime(timezone=True),
        default=datetime.utcnow,
        onupdate=datetime.utcnow,
        nullable=False,
    )
    messages = relationship(
        "Message",
        back_populates="conversation",
        cascade="all, delete-orphan",
        order_by="Message.created_at",
    )


class Message(Base):
    __tablename__ = "messages"

    id = Column(Integer, primary_key=True, index=True)
    conversation_id = Column(Integer, ForeignKey("conversations.id", ondelete="CASCADE"), nullable=False)
    role = Column(String(16), nullable=False)
    content = Column(Text, nullable=False)
    created_at = Column(DateTime(timezone=True), default=datetime.utcnow, nullable=False)

    conversation = relationship("Conversation", back_populates="messages")


class ChangeSet(Base):
    __tablename__ = "change_sets"

    id = Column(String(36), primary_key=True)
    schema_version = Column(Integer, nullable=False, default=1)
    conversation_id = Column(Integer, ForeignKey("conversations.id", ondelete="CASCADE"), nullable=False, index=True)
    workspace_id = Column(Integer, ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=False, index=True)
    summary = Column(String(500), nullable=False)
    status = Column(String(32), nullable=False, default="proposed", index=True)
    checkpoint_reference = Column(String(255), nullable=True)
    failure_reason = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime(timezone=True), default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)
    decided_at = Column(DateTime(timezone=True), nullable=True)
    applied_at = Column(DateTime(timezone=True), nullable=True)
    restored_at = Column(DateTime(timezone=True), nullable=True)

    operations = relationship(
        "ChangeOperation",
        back_populates="change_set",
        cascade="all, delete-orphan",
        order_by="ChangeOperation.position",
    )
    events = relationship(
        "ChangeSetEvent",
        back_populates="change_set",
        cascade="all, delete-orphan",
        order_by="ChangeSetEvent.created_at",
    )


class ChangeOperation(Base):
    __tablename__ = "change_operations"
    __table_args__ = (UniqueConstraint("change_set_id", "relative_path", name="uq_change_operation_path"),)

    id = Column(String(36), primary_key=True)
    change_set_id = Column(String(36), ForeignKey("change_sets.id", ondelete="CASCADE"), nullable=False, index=True)
    position = Column(Integer, nullable=False)
    operation_type = Column(String(16), nullable=False)
    relative_path = Column(String(1024), nullable=False)
    summary = Column(String(500), nullable=False)
    base_sha256 = Column(String(64), nullable=True)
    proposed_sha256 = Column(String(64), nullable=False)
    result_sha256 = Column(String(64), nullable=True)
    encoding = Column(String(32), nullable=False, default="utf-8")
    line_ending = Column(String(16), nullable=False, default="lf")
    edits_json = Column(Text, nullable=False, default="[]")
    proposed_content = Column(Text, nullable=False)
    diff = Column(Text, nullable=False)
    created_at = Column(DateTime(timezone=True), default=datetime.utcnow, nullable=False)

    change_set = relationship("ChangeSet", back_populates="operations")


class ChangeSetEvent(Base):
    __tablename__ = "change_set_events"

    id = Column(Integer, primary_key=True, index=True)
    change_set_id = Column(String(36), ForeignKey("change_sets.id", ondelete="CASCADE"), nullable=False, index=True)
    from_status = Column(String(32), nullable=True)
    to_status = Column(String(32), nullable=False)
    detail = Column(String(1000), nullable=True)
    created_at = Column(DateTime(timezone=True), default=datetime.utcnow, nullable=False)

    change_set = relationship("ChangeSet", back_populates="events")


class CommandRun(Base):
    __tablename__ = "command_runs"

    id = Column(String(36), primary_key=True)
    schema_version = Column(Integer, nullable=False, default=1)
    conversation_id = Column(Integer, ForeignKey("conversations.id", ondelete="CASCADE"), nullable=False, index=True)
    workspace_id = Column(Integer, ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=False, index=True)
    profile = Column(String(32), nullable=False)
    arguments_json = Column(Text, nullable=False, default="[]")
    cwd_relative = Column(String(1024), nullable=False, default=".")
    purpose = Column(String(500), nullable=False)
    requested_timeout_seconds = Column(Integer, nullable=False, default=120)
    model_risk_hint = Column(String(32), nullable=True)
    calculated_risk = Column(String(32), nullable=True)
    risk_explanation = Column(String(1000), nullable=True)
    resolved_executable_name = Column(String(255), nullable=True)
    environment_keys_json = Column(Text, nullable=False, default="[]")
    decision = Column(String(16), nullable=True)
    status = Column(String(32), nullable=False, default="proposed", index=True)
    exit_code = Column(Integer, nullable=True)
    termination_reason = Column(String(64), nullable=True)
    duration_ms = Column(Integer, nullable=True)
    stdout_tail = Column(Text, nullable=False, default="")
    stderr_tail = Column(Text, nullable=False, default="")
    output_truncated = Column(Integer, nullable=False, default=0)
    timed_out = Column(Integer, nullable=False, default=0)
    cancelled = Column(Integer, nullable=False, default=0)
    failure_reason = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime(timezone=True), default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)
    decided_at = Column(DateTime(timezone=True), nullable=True)
    started_at = Column(DateTime(timezone=True), nullable=True)
    completed_at = Column(DateTime(timezone=True), nullable=True)

    events = relationship(
        "CommandRunEvent",
        back_populates="command_run",
        cascade="all, delete-orphan",
        order_by="CommandRunEvent.created_at",
    )


class CommandRunEvent(Base):
    __tablename__ = "command_run_events"

    id = Column(Integer, primary_key=True, index=True)
    command_run_id = Column(String(36), ForeignKey("command_runs.id", ondelete="CASCADE"), nullable=False, index=True)
    from_status = Column(String(32), nullable=True)
    to_status = Column(String(32), nullable=False)
    detail = Column(String(2000), nullable=True)
    created_at = Column(DateTime(timezone=True), default=datetime.utcnow, nullable=False)

    command_run = relationship("CommandRun", back_populates="events")
