"""baseline existing schema and add transactional change sets

Revision ID: 0001_change_sets
Revises:
Create Date: 2026-07-19
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "0001_change_sets"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _tables() -> set[str]:
    return set(sa.inspect(op.get_bind()).get_table_names())


def upgrade() -> None:
    tables = _tables()
    if "workspaces" not in tables:
        op.create_table(
            "workspaces",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column("display_name", sa.String(200), nullable=False),
            sa.Column("root_path", sa.String(1024), nullable=False, unique=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        )
    if "conversations" not in tables:
        op.create_table(
            "conversations",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column("title", sa.String(200), nullable=False),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        )
    if "messages" not in tables:
        op.create_table(
            "messages",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column("conversation_id", sa.Integer(), sa.ForeignKey("conversations.id", ondelete="CASCADE"), nullable=False),
            sa.Column("role", sa.String(16), nullable=False),
            sa.Column("content", sa.Text(), nullable=False),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        )

    tables = _tables()
    if "change_sets" not in tables:
        op.create_table(
            "change_sets",
            sa.Column("id", sa.String(36), primary_key=True),
            sa.Column("schema_version", sa.Integer(), nullable=False),
            sa.Column("conversation_id", sa.Integer(), sa.ForeignKey("conversations.id", ondelete="CASCADE"), nullable=False),
            sa.Column("workspace_id", sa.Integer(), sa.ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=False),
            sa.Column("summary", sa.String(500), nullable=False),
            sa.Column("status", sa.String(32), nullable=False),
            sa.Column("checkpoint_reference", sa.String(255), nullable=True),
            sa.Column("failure_reason", sa.Text(), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("decided_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("applied_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("restored_at", sa.DateTime(timezone=True), nullable=True),
        )
        op.create_index("ix_change_sets_conversation_id", "change_sets", ["conversation_id"])
        op.create_index("ix_change_sets_workspace_id", "change_sets", ["workspace_id"])
        op.create_index("ix_change_sets_status", "change_sets", ["status"])
    if "change_operations" not in tables:
        op.create_table(
            "change_operations",
            sa.Column("id", sa.String(36), primary_key=True),
            sa.Column("change_set_id", sa.String(36), sa.ForeignKey("change_sets.id", ondelete="CASCADE"), nullable=False),
            sa.Column("position", sa.Integer(), nullable=False),
            sa.Column("operation_type", sa.String(16), nullable=False),
            sa.Column("relative_path", sa.String(1024), nullable=False),
            sa.Column("summary", sa.String(500), nullable=False),
            sa.Column("base_sha256", sa.String(64), nullable=True),
            sa.Column("proposed_sha256", sa.String(64), nullable=False),
            sa.Column("result_sha256", sa.String(64), nullable=True),
            sa.Column("encoding", sa.String(32), nullable=False),
            sa.Column("line_ending", sa.String(16), nullable=False),
            sa.Column("edits_json", sa.Text(), nullable=False),
            sa.Column("proposed_content", sa.Text(), nullable=False),
            sa.Column("diff", sa.Text(), nullable=False),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.UniqueConstraint("change_set_id", "relative_path", name="uq_change_operation_path"),
        )
        op.create_index("ix_change_operations_change_set_id", "change_operations", ["change_set_id"])
    if "change_set_events" not in tables:
        op.create_table(
            "change_set_events",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column("change_set_id", sa.String(36), sa.ForeignKey("change_sets.id", ondelete="CASCADE"), nullable=False),
            sa.Column("from_status", sa.String(32), nullable=True),
            sa.Column("to_status", sa.String(32), nullable=False),
            sa.Column("detail", sa.String(1000), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        )
        op.create_index("ix_change_set_events_change_set_id", "change_set_events", ["change_set_id"])


def downgrade() -> None:
    tables = _tables()
    for table in ("change_set_events", "change_operations", "change_sets"):
        if table in tables:
            op.drop_table(table)
