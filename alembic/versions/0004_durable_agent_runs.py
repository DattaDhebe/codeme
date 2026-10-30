"""Add durable local agent tasks and verification file receipts.

Revision ID: 0004_agent_runs
Revises: 0003_verification
"""
from alembic import op
import sqlalchemy as sa

revision = "0004_agent_runs"
down_revision = "0003_verification"
branch_labels = None
depends_on = None


def upgrade():
    bind = op.get_bind()
    tables = set(sa.inspect(bind).get_table_names())
    if "verification_sessions" in tables:
        columns = {column["name"] for column in sa.inspect(bind).get_columns("verification_sessions")}
        if "verified_files_json" not in columns:
            op.add_column("verification_sessions", sa.Column("verified_files_json", sa.Text(), nullable=False, server_default="{}"))
    if "agent_runs" not in tables:
        op.create_table(
            "agent_runs",
            sa.Column("id", sa.String(36), primary_key=True),
            sa.Column("schema_version", sa.Integer(), nullable=False),
            sa.Column("conversation_id", sa.Integer(), sa.ForeignKey("conversations.id", ondelete="CASCADE"), nullable=False),
            sa.Column("workspace_id", sa.Integer(), sa.ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=False),
            sa.Column("goal", sa.Text(), nullable=False),
            sa.Column("editor_context", sa.Text(), nullable=True),
            sa.Column("model", sa.String(250), nullable=False),
            sa.Column("provider", sa.String(32), nullable=False),
            sa.Column("endpoint_fingerprint", sa.String(64), nullable=False),
            sa.Column("status", sa.String(32), nullable=False),
            sa.Column("plan_json", sa.Text(), nullable=False),
            sa.Column("change_set_ids_json", sa.Text(), nullable=False),
            sa.Column("command_run_ids_json", sa.Text(), nullable=False),
            sa.Column("cycle_count", sa.Integer(), nullable=False),
            sa.Column("max_cycles", sa.Integer(), nullable=False),
            sa.Column("time_budget_seconds", sa.Integer(), nullable=False),
            sa.Column("elapsed_ms", sa.Integer(), nullable=False),
            sa.Column("summary", sa.Text(), nullable=False),
            sa.Column("evidence_json", sa.Text(), nullable=False),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        )
        for field in ("conversation_id", "workspace_id", "status"):
            op.create_index(f"ix_agent_runs_{field}", "agent_runs", [field])
    indexes = {index["name"] for index in sa.inspect(bind).get_indexes("agent_runs")}
    if "uq_agent_runs_active_conversation" not in indexes:
        condition = sa.text("status IN ('running', 'awaiting_approval', 'interrupted')")
        op.create_index("uq_agent_runs_active_conversation", "agent_runs", ["conversation_id"], unique=True,
                        sqlite_where=condition, postgresql_where=condition)
    if "agent_run_events" not in tables:
        op.create_table(
            "agent_run_events",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column("run_id", sa.String(36), sa.ForeignKey("agent_runs.id", ondelete="CASCADE"), nullable=False),
            sa.Column("event_type", sa.String(32), nullable=False),
            sa.Column("status", sa.String(32), nullable=False),
            sa.Column("detail_json", sa.Text(), nullable=False),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        )
        op.create_index("ix_agent_run_events_run_id", "agent_run_events", ["run_id"])


def downgrade():
    tables = set(sa.inspect(op.get_bind()).get_table_names())
    for table in ("agent_run_events", "agent_runs"):
        if table in tables:
            op.drop_table(table)
    # Keep additive receipts rather than rebuild a user's SQLite audit tables.
