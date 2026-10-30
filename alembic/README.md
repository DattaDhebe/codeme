# Database migrations

CodeMe keeps conversations and coding history in SQLite. Normal backend startup brings the schema to the latest Alembic revision; you do not need to delete your database when updating the application.

## Automatic upgrades

Before a pending upgrade of an existing SQLite schema, startup creates a consistent backup under `.runtime/database-backups/`. The SQLite backup API includes committed WAL contents. If backup creation fails, startup stops before changing the schema. Starting again at the current revision does not create another upgrade backup.

Run the backend with **one worker**. Database startup coordination and durable task ownership are designed for one local backend process.

| Revision | Adds |
| --- | --- |
| `0001_change_sets` | Missing legacy tables on clean installs and transactional change-set records |
| `0002_command_runs` | Controlled-command records and events |
| `0003_verification` | Verification sessions, steps, repairs, and events |
| `0004_agent_runs` | Durable tasks/events and verification file receipts |

Upgrades preserve existing conversations, workspaces, and audit history. Older verification sessions receive empty file receipts and do not become proof of newly verified work.

## Inspect or upgrade manually

Stop the running backend before a manual schema operation. From the repository root on Windows:

```powershell
.\.venv\Scripts\python.exe -m alembic current
.\.venv\Scripts\python.exe -m alembic history
```

For a manual upgrade, make a consistent backup first; the CLI does not invoke the application's automatic pre-upgrade backup helper:

```powershell
.\.venv\Scripts\python.exe -m alembic upgrade head
```

On macOS/Linux use `.venv/bin/python` in place of `.venv\Scripts\python.exe`. These commands use the database configured for the repository environment.

## Downgrades and recovery

A downgrade removes the newer feature's history. Treat it as a data-removal operation and retain a backup before proceeding. Application startup upgrades again, so use a compatible application version when investigating an older schema.

To remove only durable task tables:

```powershell
.\.venv\Scripts\python.exe -m alembic downgrade 0003_verification
```

The `0004` downgrade retains the additive `verified_files_json` column instead of rebuilding existing SQLite audit tables. Downgrading further to `0002_command_runs` removes verification/repair tables; `0001_change_sets` removes command tables; `base` removes the change-set tables while intentionally retaining legacy conversations and workspaces.

To recover from an upgrade failure, keep the error log and original database, stop all CodeMe backend processes, and restore a known-good SQLite backup to the configured database path. Do not copy a live database file while another process may be writing it. Check database location, disk space, and directory permissions before retrying startup.
