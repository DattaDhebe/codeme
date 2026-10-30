# Troubleshooting

Start with the status shown in CodeMe. Model preparation, backend availability, and a coding task's approval state are different things: a running API can still be waiting for a model, and a ready model does not approve project commands.

## Installation stops before the app opens

Check `python --version`, `node --version`, and `npm --version` in a new terminal. Python 3.10+ and an Angular 21-supported Node runtime must be installed before `python install.py` can build the app; Node.js 24 LTS is recommended. If an operating-system model-runtime installer is blocked or unavailable, install Ollama yourself and rerun the installer, or use `--skip-ollama` when managing a different local provider.

The installer keeps an existing `.env`; an old unsupported setting can therefore stop backend configuration validation. Compare its keys with [`.env.example`](../.env.example). Do not share a file containing local credentials or private paths when reporting a problem.

## The backend is unavailable

Run `python start.py` from the repository root and keep that terminal open. For extension-only work, `python start.py --backend-only` is enough. A successful `GET http://127.0.0.1:8000/health` shows that FastAPI is alive; `/api/health` checks the selected model provider as well.

If a port is already occupied, stop the old CodeMe launcher or intentionally configure a different local port. Do not run a second backend against the same database to work around an error. Task ownership and setup coordination require one backend worker.

If the browser works but the extension cannot connect, compare `personalCodex.backendUrl` with the backend URL. If a custom browser port is rejected, add that exact local origin to `CORS_ORIGINS`. Remote IPs and `0.0.0.0` are not supported workarounds.

## Setup says the runtime is missing

For Ollama, rerun `python install.py` so it can prepare the runtime, or install/start Ollama yourself. If installation just finished, open a new terminal so PATH changes are visible. CodeMe also checks supported common local installation paths.

The app can start an installed Ollama daemon; it does not perform operating-system package installation through a chat request. A package-manager or administrator prompt belongs to the explicit installer. Compatible providers need their own application/server running with a model loaded.

## A download seems stuck or the percentage goes backwards

The percentage describes the **current Ollama layer**, not an estimated total across the entire model. It may reset for another layer. Manifest, verification, and loading stages may show a status without a percentage. Wait for “ready” before expecting chat.

Check internet access and free disk space. Cancel and retry after resolving a problem; Ollama can reuse layers it already downloaded. Restarting CodeMe does not intentionally redownload installed weights. Do not delete the model cache as the first troubleshooting step.

Setup errors stay visible with retry guidance. The status API is `GET /api/model-setup`; `POST` starts/retries preparation and `DELETE` cancels it. With `AUTO_MODEL_SETUP=false`, preparation requires an explicit action instead of starting automatically.

## The model is installed but cannot load

Loading requires enough RAM/GPU memory, even when the weights fit on disk. Close other memory-heavy programs, choose a smaller local coding model, or lower `OLLAMA_CONTEXT_LENGTH` within the supported range and restart CodeMe. The default model is a starting preference, not a hardware guarantee.

A generation-capable model may still lack useful tool support. Use a tool-capable coding model for Agent mode. Embedding/reranking-only models are not chat models and are skipped during automatic selection.

You can inspect Ollama's local inventory with `ollama list`. If the runtime reports a download/load error directly, address that runtime error before retrying CodeMe. Never paste private prompts or code into a public issue to reproduce a model problem.

## LM Studio or llama.cpp is not ready

Confirm `MODEL_PROVIDER=openai_compatible`, the correct `LOCAL_MODEL_URL`, and a locally loaded model listed by that server's `/v1/models`. CodeMe uses that exact model ID. Loading/downloading through the server's own UI is required when its inventory is empty; the common chat protocol does not provide a universal downloader.

Use a trusted local-only daemon without API-key authentication and disable remote connectors. Agent mode additionally needs tool-call support. CodeMe does not fall back to a hosted account or silently change providers.

## Chat stops early or Agent keeps asking for review

An incomplete stream or model error is reported as incomplete, and any partial reply is saved. Retry after checking model readiness. Stop may wait for an already-running bounded model request to return before backend cleanup finishes.

An edit, command, verification plan, and repair are separate reviewable actions. Applying a file change still requires approving its verification plan. A plan checkbox or model claim does not replace passing checks on current file versions. Inspect the relevant review card and approve only the exact action you intend.

After a reload or disconnection, use the task's explicit resume/cancel controls. CodeMe restores history without silently restarting processes. Repeated failures or exhausted budgets require investigation or a new focused request, rather than counting as a completed task.

## An edit conflicts or Restore is refused

Save or review dirty editor buffers, inspect the diff, and request a fresh proposal based on current content. CodeMe deliberately refuses stale base hashes, escaping paths, and conflicting unsaved documents.

Restore only succeeds while files still match that change set's applied hashes. If you edited them afterward, preserve your work and reconcile the differences manually. Checkpoints live in VS Code global storage, not in the repository; removing extension storage can remove restore history.

## The database cannot upgrade

Keep the database and error log. Check disk space and write permissions for the database directory and `.runtime/database-backups/`. Startup stops before a pending schema upgrade when it cannot create a consistent backup.

Do not delete `codeme.db` to bypass migration errors. Stop the backend before manual investigation, inspect the current revision, and follow the [migration guide](../alembic/README.md). Backups may contain project snippets and should remain private.

## Browser tests or a build fail

Run the command from the correct client folder after `npm ci`. Browser tests need Chrome/Chromium-compatible headless support; Windows discovery includes Edge, and `CHROME_BIN` can point to an explicit installation. A production bundle warning is different from a build failure; include the actual error and command when reporting it.

For development and release checks, see [Development](development.md). Include your operating system, Python/Node versions, selected local provider/model, reproduction steps, and sanitized relevant errors in a bug report. State whether you used a real model or test fixtures.
