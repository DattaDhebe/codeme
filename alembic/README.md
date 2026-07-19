# Database migrations

Revision `0001_change_sets` is a non-destructive baseline. It creates missing legacy tables on a clean database and adds the Phase 4 change-set tables to an existing Personal Codex database. Revision `0002_command_runs` adds only the Phase 5 `command_runs` and `command_run_events` tables. Revision `0003_bounded_verification` adds only Phase 6 verification sessions, steps, repair attempts, and events. None of these upgrades drops or recreates workspaces, conversations, messages, change sets, or command history.

Back up `codeme.db`, then upgrade with:

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
