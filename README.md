# Personal Codex

Personal Codex is a local-first coding assistant powered by Ollama. It includes a FastAPI/SQLite backend, an Angular chat interface, and a repository-aware VS Code extension. It does not use a paid or cloud model API.

## Current capabilities

- Ollama chat with SSE streaming and installed-model discovery.
- Persistent conversations and registered workspaces.
- Workspace-bounded file listing, reading, ripgrep search, Git status/diff, and nearest `AGENTS.md` lookup.
- A bounded Ollama tool loop for repository inspection.
- A Copilot-style VS Code sidebar with Ask and Agent modes.
- Versioned transactional create/modify change sets with base SHA-256 hashes, deterministic diffs, complete-set approval, conflict detection, out-of-tree checkpoints, rollback, and guarded restore.
- Legacy `file_change` events remain compatible but are translated into the same transactional pipeline.
- Versioned command proposals for controlled test, build, lint, read-only Git, Python-module, and explicitly allowlisted custom-executable profiles.
- Independent extension-side policy checks, one-time approval, workspace-bound argument-array execution, filtered environments, bounded streaming output, timeout, cancellation, process-tree termination, and durable command audit records.
- Legacy raw command proposals remain visible but are always display-only; the deprecated compatibility setting cannot enable them.

The root `/generate` endpoint is retained for compatibility and is a placeholder. Use `/api/conversations/{id}/chat` or `/api/conversations/{id}/agent` for real Ollama execution.

## Requirements

- Python 3.10 or newer. Python 3.12 is recommended.
- Node.js 18.19+, 20.11+, or 22+ for Angular 18. The extension bundle targets Node 18.
- npm.
- Git and ripgrep for repository tools.
- Ollama running locally with an installed coding model, default `qwen2.5-coder:7b`.
- VS Code 1.90+ for the extension.

## Backend setup

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
ollama pull qwen2.5-coder:7b
.\.venv\Scripts\python.exe -m uvicorn main:app --host 127.0.0.1 --port 8000
```

Readiness endpoints:

- `http://127.0.0.1:8000/health`: FastAPI process health.
- `http://127.0.0.1:8000/api/health`: Ollama connection, configured model, and installed-model list.

## Database upgrade

Clean databases continue to initialize through SQLAlchemy metadata. Existing databases should be backed up and stamped/upgraded through the new non-destructive Alembic baseline:

```powershell
.\.venv\Scripts\python.exe -m alembic upgrade head
```

Migration `0001` preserves existing workspaces, conversations, and messages while adding change-set tables. Migration `0002` adds normalized command runs and events without recreating the database. See `alembic/README.md` for inspection and rollback commands. Do not delete or recreate `codeme.db` during an upgrade.

## Angular application

```powershell
cd frontend
npm ci
npm start
```

The browser opens at `http://localhost:4200`. Runtime defaults are in `frontend/public/runtime-config.json`; that file can be replaced in a built deployment without recompiling JavaScript. Non-local backend URLs are rejected unless `allowRemoteBackend` is explicitly enabled.

Verification:

```powershell
npm test -- --watch=false
npm run build
```

## VS Code extension

```powershell
cd vscode-extension
npm ci
npm run typecheck
npm test
npm run build
npm run package
```

The package command creates `personal-codeme-0.4.0.vsix`.

Workspace registration requires consent. `personalCodex.autoRegisterWorkspace=false` prevents automatic registration; entering Agent mode prompts before the first registration. Existing backend registrations are reused.

Applied change-set checkpoints are kept under VS Code extension global storage, outside the source repository. Restore verifies applied hashes and refuses to overwrite later user edits.

Controlled commands are proposed by Ollama but executed only by the VS Code extension after independent policy evaluation and a visible Run once approval. The backend records proposals, decisions, lifecycle events, and bounded redacted results; it has no arbitrary subprocess endpoint. Output is not returned to the model in Phase 5.

## Configuration

Backend environment names and safe defaults are shown in `.env.example`. The default backend and Ollama bindings are loopback-only. Do not expose this unauthenticated development backend to a network.

See `PLAN.md` for Phase 4 transactional editing, Phase 5 controlled execution, acceptance criteria, and the boundaries of later work.
