import os
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from threading import RLock
from uuid import uuid4

from alembic import command
from alembic.config import Config
from alembic.runtime.migration import MigrationContext
from alembic.script import ScriptDirectory
from sqlalchemy import create_engine, event, inspect
from sqlalchemy.engine import Engine, make_url
from sqlalchemy.orm import declarative_base, sessionmaker

from codeme_agent.config import settings

def _configure_sqlite(connection, _record):
    # SQLite ignores ON DELETE clauses unless enabled for every connection.
    cursor = connection.cursor()
    cursor.execute("PRAGMA foreign_keys=ON")
    cursor.close()


def _install_sqlite_foreign_keys(database_engine: Engine):
    if not event.contains(database_engine, "connect", _configure_sqlite):
        event.listen(database_engine, "connect", _configure_sqlite)


def create_database_engine(url: str):
    sqlite = make_url(url).get_backend_name() == "sqlite"
    engine = create_engine(url, connect_args={"check_same_thread": False} if sqlite else {}, future=True)
    if sqlite:
        _install_sqlite_foreign_keys(engine)
    return engine


engine = create_database_engine(settings.database_url)
SessionLocal = sessionmaker(bind=engine, autoflush=False, future=True)
Base = declarative_base()

_initialize_lock = RLock()
_repository_root = Path(__file__).resolve().parents[1]


class DatabaseInitializationError(RuntimeError):
    pass


def _sqlite_file(database_engine: Engine) -> bool:
    database = database_engine.url.database
    return (database_engine.dialect.name == "sqlite" and bool(database)
            and database != ":memory:" and not database.startswith("file::memory:")
            and database_engine.url.query.get("mode") != "memory")


def _backup_sqlite(connection, backup_dir: Path) -> Path:
    """Take a consistent SQLite backup, including committed WAL contents."""
    target = None
    reserved = False
    try:
        backup_dir.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
        target = backup_dir / f"codeme-before-upgrade-{stamp}-{uuid4().hex}.sqlite3"
        # Reserve the destination without overwriting another backup or following
        # an existing path. The source database is never copied as a plain file.
        descriptor = os.open(target, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        reserved = True
        os.close(descriptor)
        destination = sqlite3.connect(str(target))
        try:
            connection.connection.driver_connection.backup(destination)
            destination.commit()
        finally:
            destination.close()
        return target
    except Exception as exc:
        if reserved and target is not None:
            try:
                target.unlink(missing_ok=True)
            except OSError:
                pass
        raise DatabaseInitializationError("Unable to back up the existing database; startup stopped before schema changes") from exc


def initialize_database(database_engine: Engine | None = None, *, backup_dir: str | Path | None = None) -> Path | None:
    """Upgrade one local database before serving requests, preserving old data.

    Existing SQLite schemas receive a consistent backup before a pending upgrade.
    A borrowed Alembic connection keeps in-memory engines and their tests intact.
    CodeMe's task registry requires running the backend with a single worker.
    """
    from codeme_agent import models  # noqa: F401; register metadata lazily

    selected_engine = database_engine if database_engine is not None else engine
    config = Config()
    config.set_main_option("script_location", str(_repository_root / "alembic"))
    config.attributes["configure_logger"] = False
    heads = set(ScriptDirectory.from_config(config).get_heads())
    backup = None
    if selected_engine.dialect.name == "sqlite":
        _install_sqlite_foreign_keys(selected_engine)
    with _initialize_lock, selected_engine.connect() as connection:
        if selected_engine.dialect.name == "sqlite":
            connection.exec_driver_sql("PRAGMA foreign_keys=ON")
        current = set(MigrationContext.configure(connection).get_current_heads())
        tables = set(inspect(connection).get_table_names()) - {"alembic_version", "sqlite_sequence"}
        # End inspection's SQLAlchemy transaction before invoking SQLite backup;
        # backup must never run while this connection holds a write transaction.
        connection.rollback()
        if current != heads and tables and _sqlite_file(selected_engine):
            destination = Path(backup_dir) if backup_dir is not None else _repository_root / ".runtime" / "database-backups"
            backup = _backup_sqlite(connection, destination)
        config.attributes["connection"] = connection
        with connection.begin():
            command.upgrade(config, "head")
            Base.metadata.create_all(bind=connection)
    return backup


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
