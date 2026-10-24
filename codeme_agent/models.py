from datetime import datetime

from sqlalchemy import Column, DateTime, ForeignKey, Index, Integer, String, Text, UniqueConstraint
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


class VerificationSession(Base):
    __tablename__ = "verification_sessions"

    id = Column(String(36), primary_key=True)
    schema_version = Column(Integer, nullable=False, default=1)
    conversation_id = Column(Integer, ForeignKey("conversations.id", ondelete="CASCADE"), nullable=False, index=True)
    workspace_id = Column(Integer, ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=False, index=True)
    source_change_set_id = Column(String(36), ForeignKey("change_sets.id", ondelete="SET NULL"), nullable=True, index=True)
    mode = Column(String(16), nullable=False)
    summary = Column(String(500), nullable=False)
    original_request = Column(Text, nullable=False)
    state = Column(String(48), nullable=False, index=True)
    plan_version = Column(Integer, nullable=False, default=1)
    approved_plan_version = Column(Integer, nullable=True)
    plan_fingerprint = Column(String(64), nullable=False)
    approved_plan_fingerprint = Column(String(64), nullable=True)
    maximum_repair_attempts = Column(Integer, nullable=False, default=2)
    maximum_reruns = Column(Integer, nullable=False, default=2)
    total_time_budget_seconds = Column(Integer, nullable=False, default=1200)
    current_attempt = Column(Integer, nullable=False, default=0)
    current_rerun = Column(Integer, nullable=False, default=0)
    final_summary = Column(Text, nullable=True)
    failure_reason = Column(Text, nullable=True)
    cancellation_reason = Column(Text, nullable=True)
    verified_files_json = Column(Text, nullable=False, default="{}")
    created_at = Column(DateTime(timezone=True), default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime(timezone=True), default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)
    approved_at = Column(DateTime(timezone=True), nullable=True)
    started_at = Column(DateTime(timezone=True), nullable=True)
    completed_at = Column(DateTime(timezone=True), nullable=True)

    steps = relationship(
        "VerificationStep",
        back_populates="session",
        cascade="all, delete-orphan",
        order_by="VerificationStep.position",
    )
    repair_attempts = relationship(
        "RepairAttempt",
        back_populates="session",
        cascade="all, delete-orphan",
        order_by="RepairAttempt.attempt_number",
    )
    events = relationship(
        "VerificationEvent",
        back_populates="session",
        cascade="all, delete-orphan",
        order_by="VerificationEvent.created_at",
    )


class VerificationStep(Base):
    __tablename__ = "verification_steps"
    __table_args__ = (
        UniqueConstraint("session_id", "plan_step_id", name="uq_verification_plan_step_id"),
        UniqueConstraint("session_id", "position", name="uq_verification_step_position"),
    )

    id = Column(String(36), primary_key=True)
    session_id = Column(String(36), ForeignKey("verification_sessions.id", ondelete="CASCADE"), nullable=False, index=True)
    plan_step_id = Column(String(64), nullable=False)
    position = Column(Integer, nullable=False)
    profile = Column(String(32), nullable=False)
    arguments_json = Column(Text, nullable=False, default="[]")
    cwd_relative = Column(String(1024), nullable=False, default=".")
    purpose = Column(String(500), nullable=False)
    required = Column(Integer, nullable=False, default=1)
    timeout_seconds = Column(Integer, nullable=False, default=120)
    expected_outcome = Column(String(500), nullable=False)
    status = Column(String(32), nullable=False, default="PENDING", index=True)
    command_run_id = Column(String(36), ForeignKey("command_runs.id", ondelete="SET NULL"), nullable=True, index=True)
    exit_code = Column(Integer, nullable=True)
    failure_fingerprint = Column(String(64), nullable=True)
    result_summary = Column(Text, nullable=True)
    started_at = Column(DateTime(timezone=True), nullable=True)
    completed_at = Column(DateTime(timezone=True), nullable=True)

    session = relationship("VerificationSession", back_populates="steps")


class RepairAttempt(Base):
    __tablename__ = "repair_attempts"
    __table_args__ = (UniqueConstraint("session_id", "attempt_number", name="uq_repair_attempt_number"),)

    id = Column(String(36), primary_key=True)
    session_id = Column(String(36), ForeignKey("verification_sessions.id", ondelete="CASCADE"), nullable=False, index=True)
    attempt_number = Column(Integer, nullable=False)
    failure_fingerprint = Column(String(64), nullable=False)
    model_analysis = Column(Text, nullable=True)
    repair_change_set_id = Column(String(36), ForeignKey("change_sets.id", ondelete="SET NULL"), nullable=True, index=True)
    repair_content_fingerprint = Column(String(64), nullable=True)
    relevant_diff_fingerprint = Column(String(64), nullable=True)
    decision = Column(String(16), nullable=True)
    result = Column(String(32), nullable=True)
    created_at = Column(DateTime(timezone=True), default=datetime.utcnow, nullable=False)
    decided_at = Column(DateTime(timezone=True), nullable=True)
    completed_at = Column(DateTime(timezone=True), nullable=True)

    session = relationship("VerificationSession", back_populates="repair_attempts")


class VerificationEvent(Base):
    __tablename__ = "verification_events"

    id = Column(Integer, primary_key=True, index=True)
    session_id = Column(String(36), ForeignKey("verification_sessions.id", ondelete="CASCADE"), nullable=False, index=True)
    event_type = Column(String(64), nullable=False)
    from_state = Column(String(48), nullable=True)
    to_state = Column(String(48), nullable=False)
    detail = Column(String(4000), nullable=True)
    created_at = Column(DateTime(timezone=True), default=datetime.utcnow, nullable=False)

    session = relationship("VerificationSession", back_populates="events")


class AgentRun(Base):
    __tablename__ = "agent_runs"

    id = Column(String(36), primary_key=True)
    schema_version = Column(Integer, nullable=False, default=1)
    conversation_id = Column(Integer, ForeignKey("conversations.id", ondelete="CASCADE"), nullable=False, index=True)
    workspace_id = Column(Integer, ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=False, index=True)
    goal = Column(Text, nullable=False)
    editor_context = Column(Text, nullable=True)
    model = Column(String(250), nullable=False)
    provider = Column(String(32), nullable=False, default="ollama")
    endpoint_fingerprint = Column(String(64), nullable=False)
    status = Column(String(32), nullable=False, default="interrupted", index=True)
    plan_json = Column(Text, nullable=False, default="[]")
    change_set_ids_json = Column(Text, nullable=False, default="[]")
    command_run_ids_json = Column(Text, nullable=False, default="[]")
    cycle_count = Column(Integer, nullable=False, default=0)
    max_cycles = Column(Integer, nullable=False, default=8)
    time_budget_seconds = Column(Integer, nullable=False, default=900)
    elapsed_ms = Column(Integer, nullable=False, default=0)
    summary = Column(Text, nullable=False, default="")
    evidence_json = Column(Text, nullable=False, default="{}")
    created_at = Column(DateTime(timezone=True), default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime(timezone=True), default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)
    completed_at = Column(DateTime(timezone=True), nullable=True)

    events = relationship(
        "AgentRunEvent", back_populates="run", cascade="all, delete-orphan", order_by="AgentRunEvent.id",
    )


class AgentRunEvent(Base):
    __tablename__ = "agent_run_events"

    id = Column(Integer, primary_key=True)
    run_id = Column(String(36), ForeignKey("agent_runs.id", ondelete="CASCADE"), nullable=False, index=True)
    event_type = Column(String(32), nullable=False)
    status = Column(String(32), nullable=False)
    detail_json = Column(Text, nullable=False, default="{}")
    created_at = Column(DateTime(timezone=True), default=datetime.utcnow, nullable=False)

    run = relationship("AgentRun", back_populates="events")


Index(
    "uq_agent_runs_active_conversation", AgentRun.conversation_id, unique=True,
    sqlite_where=AgentRun.status.in_(["running", "awaiting_approval", "interrupted"]),
    postgresql_where=AgentRun.status.in_(["running", "awaiting_approval", "interrupted"]),
)
