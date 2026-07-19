"""add controlled command proposals and bounded results

Revision ID: 0002_command_runs
Revises: 0001_change_sets
Create Date: 2026-07-19
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "0002_command_runs"
down_revision: Union[str, None] = "0001_change_sets"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _tables() -> set[str]:
    return set(sa.inspect(op.get_bind()).get_table_names())


def upgrade() -> None:
    tables = _tables()
    if "command_runs" not in tables:
        op.create_table(
            "command_runs",
            sa.Column("id", sa.String(36), primary_key=True),
            sa.Column("schema_version", sa.Integer(), nullable=False),
            sa.Column("conversation_id", sa.Integer(), sa.ForeignKey("conversations.id", ondelete="CASCADE"), nullable=False),
            sa.Column("workspace_id", sa.Integer(), sa.ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=False),
            sa.Column("profile", sa.String(32), nullable=False),
            sa.Column("arguments_json", sa.Text(), nullable=False),
            sa.Column("cwd_relative", sa.String(1024), nullable=False),
            sa.Column("purpose", sa.String(500), nullable=False),
            sa.Column("requested_timeout_seconds", sa.Integer(), nullable=False),
            sa.Column("model_risk_hint", sa.String(32), nullable=True),
            sa.Column("calculated_risk", sa.String(32), nullable=True),
            sa.Column("risk_explanation", sa.String(1000), nullable=True),
            sa.Column("resolved_executable_name", sa.String(255), nullable=True),
            sa.Column("environment_keys_json", sa.Text(), nullable=False),
            sa.Column("decision", sa.String(16), nullable=True),
            sa.Column("status", sa.String(32), nullable=False),
            sa.Column("exit_code", sa.Integer(), nullable=True),
            sa.Column("termination_reason", sa.String(64), nullable=True),
            sa.Column("duration_ms", sa.Integer(), nullable=True),
            sa.Column("stdout_tail", sa.Text(), nullable=False),
            sa.Column("stderr_tail", sa.Text(), nullable=False),
            sa.Column("output_truncated", sa.Integer(), nullable=False),
            sa.Column("timed_out", sa.Integer(), nullable=False),
            sa.Column("cancelled", sa.Integer(), nullable=False),
            sa.Column("failure_reason", sa.Text(), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("decided_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        )
        op.create_index("ix_command_runs_conversation_id", "command_runs", ["conversation_id"])
        op.create_index("ix_command_runs_workspace_id", "command_runs", ["workspace_id"])
        op.create_index("ix_command_runs_status", "command_runs", ["status"])
    if "command_run_events" not in tables:
        op.create_table(
            "command_run_events",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column("command_run_id", sa.String(36), sa.ForeignKey("command_runs.id", ondelete="CASCADE"), nullable=False),
            sa.Column("from_status", sa.String(32), nullable=True),
            sa.Column("to_status", sa.String(32), nullable=False),
            sa.Column("detail", sa.String(2000), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        )
        op.create_index("ix_command_run_events_command_run_id", "command_run_events", ["command_run_id"])


def downgrade() -> None:
    tables = _tables()
    if "command_run_events" in tables:
        op.drop_table("command_run_events")
    if "command_runs" in tables:
        op.drop_table("command_runs")
