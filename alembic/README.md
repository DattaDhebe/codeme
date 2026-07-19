# Database migrations

The first revision is a non-destructive baseline. It creates missing legacy tables on a clean database and adds the Phase 4 change-set tables to an existing Personal Codex database. It never drops or recreates `workspaces`, `conversations`, or `messages` during upgrade.

Back up `codeme.db`, then upgrade with:

```powershell
.\.venv\Scripts\python.exe -m alembic upgrade head
```

Inspect the current revision with:

```powershell
.\.venv\Scripts\python.exe -m alembic current
```

The downgrade removes only the Phase 4 change-set tables. It deliberately leaves legacy user data in place:

```powershell
.\.venv\Scripts\python.exe -m alembic downgrade base
```
