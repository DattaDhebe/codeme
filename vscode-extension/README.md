# Personal Codeme for VS Code

Personal Codeme is the repository-aware VS Code client for the local Personal Codex backend and Ollama.

## Features

- Ask and Agent modes with streamed local-model responses.
- Conversation history, search, rename, delete, and model selection.
- Current selection, active file, and Git diff context.
- Repository file reads, ripgrep search, Git inspection, and `AGENTS.md` lookup through the backend agent.
- Transactional create/modify change sets with complete-set preview and approval.
- Base-hash and dirty-editor conflict detection.
- One `WorkspaceEdit` for a complete set, post-apply verification, rollback on failure, and guarded Restore.
- Checkpoints stored in VS Code global storage rather than the source tree.
- Legacy whole-file proposal compatibility through the same change-set pipeline.
- Command proposals displayed without execution by default.

File deletion, rename, automatic tests, commits, pushes, and unattended execution are not implemented in Phase 4.

## Setup

Start the backend from the repository root:

```powershell
.\.venv\Scripts\python.exe -m uvicorn main:app --host 127.0.0.1 --port 8000
```

Build and package the extension:

```powershell
cd vscode-extension
npm ci
npm run typecheck
npm test
npm run build
npm run package
```

The package command creates `personal-codeme-0.3.1.vsix`.

## Settings

- `personalCodex.backendUrl`: local backend, default `http://127.0.0.1:8000`.
- `personalCodex.defaultModel`: default Ollama model, `qwen2.5-coder:7b`.
- `personalCodex.autoRegisterWorkspace`: whether initialization may request workspace registration. Default `false` is honored.
- `personalCodex.requireWriteApproval`: retains approval for legacy editor actions.
- `personalCodex.enableUnsafeCommandExecution`: legacy raw terminal compatibility switch. Default `false`. Enabling it still requires a strong per-command confirmation and is not equivalent to the Phase 5 controlled runner.
- `personalCodex.showNotifications`: connection and workspace notifications.

Workspace registration is scoped to the current VS Code workspace. Existing backend registrations are reused; otherwise the user must consent before Agent mode can inspect the folder.

## Change-set safety

The backend prepares and persists relative paths, verified base hashes, proposed hashes, exact content, and diffs. Immediately before applying, the extension resolves real paths, rejects symlink/junction escapes, verifies hashes, and rejects dirty documents. Restore succeeds only while current files still match the applied hashes.

Phase 4 checkpoints are retained in VS Code global storage so Restore remains available across restarts. They are not removed automatically in this phase; users can remove stale Personal Codeme extension storage through VS Code after they no longer need its restore history. A bounded retention policy is deferred to production hardening so recoverable checkpoints are not deleted aggressively.

## Troubleshooting

- Backend readiness: `http://127.0.0.1:8000/api/health`.
- Ollama inventory: `http://127.0.0.1:11434/api/tags`.
- Database schema: run `..\.venv\Scripts\python.exe -m alembic current` from the repository root.
- Reload VS Code after installing a new VSIX.
