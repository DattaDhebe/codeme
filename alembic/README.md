# Database migrations

Revision `0001_change_sets` is a non-destructive baseline. It creates missing legacy tables on a clean database and adds the Phase 4 change-set tables to an existing Personal Codex database. Revision `0002_command_runs` adds only the Phase 5 `command_runs` and `command_run_events` tables. Neither upgrade drops or recreates `workspaces`, `conversations`, `messages`, or change sets.

Back up `codeme.db`, then upgrade with:

```powershell
.\.venv\Scripts\python.exe -m alembic upgrade head
```

Inspect the current revision with:

```powershell
.\.venv\Scripts\python.exe -m alembic current
```

Downgrading one revision removes only the Phase 5 command tables:

```powershell
.\.venv\Scripts\python.exe -m alembic downgrade 0001_change_sets
```

Downgrading to base then removes only the Phase 4 change-set tables. It deliberately leaves legacy user data in place:

```powershell
.\.venv\Scripts\python.exe -m alembic downgrade base
```
