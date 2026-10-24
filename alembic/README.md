# Database migrations

Revision `0001_change_sets` is a non-destructive baseline. It creates missing legacy tables on a clean database and adds the Phase 4 change-set tables to an existing Personal Codex database. Revision `0002_command_runs` adds only the Phase 5 `command_runs` and `command_run_events` tables. Revision `0003_bounded_verification` adds only Phase 6 verification sessions, steps, repair attempts, and events. None of these upgrades drops or recreates workspaces, conversations, messages, change sets, or command history.

Revision `0004_agent_runs` adds durable task/event tables and verification file receipts. Its downgrade removes task tables but retains the additive receipt column to avoid rebuilding a user's SQLite audit tables.

Normal backend startup upgrades automatically. Before a pending upgrade of an existing SQLite schema, it writes a consistent backup under `.runtime/database-backups`; startup stops if the backup fails. Backups include committed WAL contents. Repeat startup at the latest revision does not create another backup. Run the backend with one worker for task ownership and migration coordination.

For a manual upgrade, back up `codeme.db`, then run:

```powershell
.\.venv\Scripts\python.exe -m alembic upgrade head
```

Inspect the current revision with:

```powershell
.\.venv\Scripts\python.exe -m alembic current
```

Downgrading Phase 6 removes only its verification and repair tables:

```powershell
.\.venv\Scripts\python.exe -m alembic downgrade 0002_command_runs
```

Downgrading Phase 5 then removes only its command tables:

```powershell
.\.venv\Scripts\python.exe -m alembic downgrade 0001_change_sets
```

Downgrading to base then removes only the Phase 4 change-set tables. It deliberately leaves legacy user data in place:

```powershell
.\.venv\Scripts\python.exe -m alembic downgrade base
```
