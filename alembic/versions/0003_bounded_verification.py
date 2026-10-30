"""add bounded verification and repair records

Revision ID: 0003_verification
Revises: 0002_command_runs
Create Date: 2026-07-19
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "0003_verification"
down_revision: Union[str, None] = "0002_command_runs"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _tables() -> set[str]:
    return set(sa.inspect(op.get_bind()).get_table_names())


def upgrade() -> None:
    tables = _tables()
    if "verification_sessions" not in tables:
        op.create_table(
            "verification_sessions",
            sa.Column("id", sa.String(36), primary_key=True),
            sa.Column("schema_version", sa.Integer(), nullable=False),
            sa.Column("conversation_id", sa.Integer(), sa.ForeignKey("conversations.id", ondelete="CASCADE"), nullable=False),
            sa.Column("workspace_id", sa.Integer(), sa.ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=False),
            sa.Column("source_change_set_id", sa.String(36), sa.ForeignKey("change_sets.id", ondelete="SET NULL"), nullable=True),
            sa.Column("mode", sa.String(16), nullable=False),
            sa.Column("summary", sa.String(500), nullable=False),
            sa.Column("original_request", sa.Text(), nullable=False),
            sa.Column("state", sa.String(48), nullable=False),
            sa.Column("plan_version", sa.Integer(), nullable=False),
            sa.Column("approved_plan_version", sa.Integer(), nullable=True),
            sa.Column("plan_fingerprint", sa.String(64), nullable=False),
            sa.Column("approved_plan_fingerprint", sa.String(64), nullable=True),
            sa.Column("maximum_repair_attempts", sa.Integer(), nullable=False),
            sa.Column("maximum_reruns", sa.Integer(), nullable=False),
            sa.Column("total_time_budget_seconds", sa.Integer(), nullable=False),
            sa.Column("current_attempt", sa.Integer(), nullable=False),
            sa.Column("current_rerun", sa.Integer(), nullable=False),
            sa.Column("final_summary", sa.Text(), nullable=True),
            sa.Column("failure_reason", sa.Text(), nullable=True),
            sa.Column("cancellation_reason", sa.Text(), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("approved_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        )
        op.create_index("ix_verification_sessions_conversation_id", "verification_sessions", ["conversation_id"])
        op.create_index("ix_verification_sessions_workspace_id", "verification_sessions", ["workspace_id"])
        op.create_index("ix_verification_sessions_source_change_set_id", "verification_sessions", ["source_change_set_id"])
        op.create_index("ix_verification_sessions_state", "verification_sessions", ["state"])
    if "verification_steps" not in tables:
        op.create_table(
            "verification_steps",
            sa.Column("id", sa.String(36), primary_key=True),
            sa.Column("session_id", sa.String(36), sa.ForeignKey("verification_sessions.id", ondelete="CASCADE"), nullable=False),
            sa.Column("plan_step_id", sa.String(64), nullable=False),
            sa.Column("position", sa.Integer(), nullable=False),
            sa.Column("profile", sa.String(32), nullable=False),
            sa.Column("arguments_json", sa.Text(), nullable=False),
            sa.Column("cwd_relative", sa.String(1024), nullable=False),
            sa.Column("purpose", sa.String(500), nullable=False),
            sa.Column("required", sa.Integer(), nullable=False),
            sa.Column("timeout_seconds", sa.Integer(), nullable=False),
            sa.Column("expected_outcome", sa.String(500), nullable=False),
            sa.Column("status", sa.String(32), nullable=False),
            sa.Column("command_run_id", sa.String(36), sa.ForeignKey("command_runs.id", ondelete="SET NULL"), nullable=True),
            sa.Column("exit_code", sa.Integer(), nullable=True),
            sa.Column("failure_fingerprint", sa.String(64), nullable=True),
            sa.Column("result_summary", sa.Text(), nullable=True),
            sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
            sa.UniqueConstraint("session_id", "plan_step_id", name="uq_verification_plan_step_id"),
            sa.UniqueConstraint("session_id", "position", name="uq_verification_step_position"),
        )
        op.create_index("ix_verification_steps_session_id", "verification_steps", ["session_id"])
        op.create_index("ix_verification_steps_status", "verification_steps", ["status"])
        op.create_index("ix_verification_steps_command_run_id", "verification_steps", ["command_run_id"])
    if "repair_attempts" not in tables:
        op.create_table(
            "repair_attempts",
            sa.Column("id", sa.String(36), primary_key=True),
            sa.Column("session_id", sa.String(36), sa.ForeignKey("verification_sessions.id", ondelete="CASCADE"), nullable=False),
            sa.Column("attempt_number", sa.Integer(), nullable=False),
            sa.Column("failure_fingerprint", sa.String(64), nullable=False),
            sa.Column("model_analysis", sa.Text(), nullable=True),
            sa.Column("repair_change_set_id", sa.String(36), sa.ForeignKey("change_sets.id", ondelete="SET NULL"), nullable=True),
            sa.Column("repair_content_fingerprint", sa.String(64), nullable=True),
            sa.Column("relevant_diff_fingerprint", sa.String(64), nullable=True),
            sa.Column("decision", sa.String(16), nullable=True),
            sa.Column("result", sa.String(32), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("decided_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
            sa.UniqueConstraint("session_id", "attempt_number", name="uq_repair_attempt_number"),
        )
        op.create_index("ix_repair_attempts_session_id", "repair_attempts", ["session_id"])
        op.create_index("ix_repair_attempts_repair_change_set_id", "repair_attempts", ["repair_change_set_id"])
    if "verification_events" not in tables:
        op.create_table(
            "verification_events",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column("session_id", sa.String(36), sa.ForeignKey("verification_sessions.id", ondelete="CASCADE"), nullable=False),
            sa.Column("event_type", sa.String(64), nullable=False),
            sa.Column("from_state", sa.String(48), nullable=True),
            sa.Column("to_state", sa.String(48), nullable=False),
            sa.Column("detail", sa.String(4000), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        )
        op.create_index("ix_verification_events_session_id", "verification_events", ["session_id"])


def downgrade() -> None:
    tables = _tables()
    for table in ("verification_events", "repair_attempts", "verification_steps", "verification_sessions"):
        if table in tables:
            op.drop_table(table)
