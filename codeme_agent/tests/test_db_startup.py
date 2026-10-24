"""Startup upgrades exercise temporary databases only, never the user's DB."""

import logging
import asyncio
import sqlite3
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from alembic.runtime.migration import MigrationContext
from alembic.script import ScriptDirectory
from sqlalchemy import create_engine, inspect, text

from codeme_agent import db


def migration_config(connection=None):
    config = Config()
    config.set_main_option("script_location", str(Path(__file__).parents[2] / "alembic"))
    config.attributes["configure_logger"] = False
    if connection is not None:
        config.attributes["connection"] = connection
    return config


def legacy_database(tmp_path: Path, *, unversioned=False):
    database = tmp_path / "legacy.db"
    engine = db.create_database_engine(f"sqlite:///{database.as_posix()}")
    with engine.connect() as connection:
        connection.exec_driver_sql("PRAGMA journal_mode=WAL")
        connection.commit()
        with connection.begin():
            command.upgrade(migration_config(connection), "0003_verification")
            connection.execute(text("INSERT INTO conversations (id,title,created_at,updated_at) VALUES (1,'keep my conversation',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)"))
            connection.execute(text("INSERT INTO messages (id,conversation_id,role,content,created_at) VALUES (1,1,'user','keep my message',CURRENT_TIMESTAMP)"))
            if unversioned:
                connection.execute(text("DROP TABLE alembic_version"))
    return engine, database


def test_new_database_migrates_all_tables_without_backup(tmp_path):
    engine = db.create_database_engine(f"sqlite:///{(tmp_path / 'new.db').as_posix()}")
    backups = tmp_path / "backups"
    try:
        assert db.initialize_database(engine, backup_dir=backups) is None
        assert not backups.exists()
        assert {"conversations", "verification_sessions", "agent_runs", "agent_run_events"} <= set(inspect(engine).get_table_names())
        assert "verified_files_json" in {column["name"] for column in inspect(engine).get_columns("verification_sessions")}
        with engine.connect() as connection:
            assert set(MigrationContext.configure(connection).get_current_heads()) == set(ScriptDirectory.from_config(migration_config()).get_heads())
            assert connection.exec_driver_sql("PRAGMA foreign_keys").scalar() == 1
    finally:
        engine.dispose()


@pytest.mark.parametrize("unversioned", [False, True])
def test_legacy_startup_backs_up_before_upgrade_preserves_data_and_is_idempotent(tmp_path, unversioned):
    engine, _database = legacy_database(tmp_path, unversioned=unversioned)
    backups = tmp_path / "backups"
    root_logger = logging.getLogger()
    sentinel = logging.NullHandler()
    root_logger.addHandler(sentinel)
    handlers = list(root_logger.handlers)
    try:
        backup = db.initialize_database(engine, backup_dir=backups)
        assert backup is not None and backup.parent == backups
        assert list(backups.glob("*.sqlite3")) == [backup]
        # A genuine pre-upgrade SQLite snapshot includes committed WAL records.
        saved = sqlite3.connect(f"file:{backup.as_posix()}?mode=ro", uri=True)
        try:
            assert saved.execute("SELECT content FROM messages WHERE id=1").fetchone()[0] == "keep my message"
            assert "verified_files_json" not in {row[1] for row in saved.execute("PRAGMA table_info(verification_sessions)")}
            assert saved.execute("SELECT count(*) FROM sqlite_master WHERE type='table' AND name='agent_runs'").fetchone()[0] == 0
        finally:
            saved.close()
        with engine.connect() as connection:
            assert connection.scalar(text("SELECT title FROM conversations WHERE id=1")) == "keep my conversation"
            assert connection.scalar(text("SELECT content FROM messages WHERE id=1")) == "keep my message"
            assert connection.exec_driver_sql("PRAGMA foreign_keys").scalar() == 1
        assert "verified_files_json" in {column["name"] for column in inspect(engine).get_columns("verification_sessions")}
        assert db.initialize_database(engine, backup_dir=backups) is None
        assert len(list(backups.glob("*.sqlite3"))) == 1
        assert root_logger.handlers == handlers
    finally:
        root_logger.removeHandler(sentinel)
        engine.dispose()


def test_startup_keeps_foreign_keys_enabled_for_every_connection(tmp_path):
    engine, _database = legacy_database(tmp_path)
    try:
        db.initialize_database(engine, backup_dir=tmp_path / "backups")
        engine.dispose()
        with engine.begin() as connection:
            assert connection.exec_driver_sql("PRAGMA foreign_keys").scalar() == 1
            connection.execute(text("DELETE FROM conversations WHERE id=1"))
            assert connection.scalar(text("SELECT count(*) FROM messages")) == 0
    finally:
        engine.dispose()


def test_in_memory_startup_uses_the_same_supplied_connection(tmp_path):
    engine = create_engine("sqlite:///:memory:", future=True)
    try:
        assert db.initialize_database(engine, backup_dir=tmp_path / "backups") is None
        with engine.begin() as connection:
            connection.execute(text("INSERT INTO conversations (id,title,created_at,updated_at) VALUES (1,'memory',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)"))
        assert db.initialize_database(engine, backup_dir=tmp_path / "backups") is None
        with engine.connect() as connection:
            assert connection.scalar(text("SELECT title FROM conversations WHERE id=1")) == "memory"
            assert connection.exec_driver_sql("PRAGMA foreign_keys").scalar() == 1
    finally:
        engine.dispose()


def test_alembic_supplied_connection_ignores_configured_database_url(tmp_path):
    engine = db.create_database_engine("sqlite:///:memory:")
    untouched = tmp_path / "never-opened.db"
    try:
        with engine.begin() as connection:
            config = migration_config(connection)
            config.set_main_option("sqlalchemy.url", f"sqlite:///{untouched.as_posix()}")
            command.upgrade(config, "head")
            assert "agent_runs" in inspect(connection).get_table_names()
        assert not untouched.exists()
    finally:
        engine.dispose()


def test_backup_failure_stops_before_any_schema_write(tmp_path):
    engine, _database = legacy_database(tmp_path, unversioned=True)
    blocked_directory = tmp_path / "cannot-be-a-directory"
    blocked_directory.write_text("keep this file", encoding="utf-8")
    try:
        with engine.connect() as connection:
            before = connection.execute(text("SELECT type,name,sql FROM sqlite_master ORDER BY type,name")).all()
        with pytest.raises(db.DatabaseInitializationError, match="before schema changes"):
            db.initialize_database(engine, backup_dir=blocked_directory)
        with engine.connect() as connection:
            after = connection.execute(text("SELECT type,name,sql FROM sqlite_master ORDER BY type,name")).all()
            assert after == before
            assert connection.scalar(text("SELECT content FROM messages WHERE id=1")) == "keep my message"
        assert "verified_files_json" not in {column["name"] for column in inspect(engine).get_columns("verification_sessions")}
        assert blocked_directory.read_text(encoding="utf-8") == "keep this file"
    finally:
        engine.dispose()


def test_app_lifespan_calls_initializer_without_touching_default_database(monkeypatch):
    import main
    selected_engine = object()
    calls = []
    monkeypatch.setattr(main, "engine", selected_engine)
    monkeypatch.setattr(main, "initialize_database", lambda value: calls.append(value))
    async def startup():
        async with main.lifespan(main.app):
            assert calls == [selected_engine]
    asyncio.run(startup())
