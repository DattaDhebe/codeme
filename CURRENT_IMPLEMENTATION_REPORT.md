# CodeMe current implementation

Updated for the source as of **30 October 2026**. This report describes implemented behavior and known limits; it is not a model-quality benchmark or a percentage-readiness estimate. The earlier audit is preserved unchanged in [the historical archive](docs/archive/implementation-audit-historical.md).

## Product and entry points

CodeMe is a local coding assistant with a FastAPI/SQLite backend, an Angular browser app, and a VS Code extension. It uses Ollama or a trusted loopback OpenAI-compatible server such as LM Studio or llama.cpp. Inference does not require a hosted account or API key. Dependency installation and initial weight downloads use the network.

The repository entry points are `python install.py` for installation and `python start.py` for later launches. Installation prepares the Python environment and browser build, preserves existing configuration/data, and prepares the Ollama runtime when needed. The launcher serves the built browser app locally and runs one backend worker. See [Getting started](docs/getting-started.md).

## Implemented capabilities

| Area | Implementation |
| --- | --- |
| Model preparation | Automatic local inventory checks, installed-model reuse, missing Ollama model downloads with daemon-reported layer progress, and a load check before ready. |
| Provider integration | Shared local model interface; native Ollama chat/tool calls and loopback OpenAI-compatible discovery/chat/tool transport. |
| Browser experience | Streamed Markdown chat, conversation search/rename/delete, model readiness and retry controls, responsive layout, and read-only workspace exploration. |
| VS Code experience | Ask/Agent modes, bounded selection/file/Git context, task plans, resume/cancel, proposal cards, native diff preview, and approved action execution. |
| Repository inspection | Registered local roots, bounded file listing/ranged reads/search, read-only Git, and scoped root-to-folder `AGENTS.md` guidance. |
| Task workflow | Durable original goals, structured public plans, read-before-edit checks, explicit review pauses, canonical result-driven continuation, and bounded correction. |
| Editing | Versioned transactional create/modify sets, hashes/diffs, complete-set approval, dirty-editor/conflict checks, checkpoints, rollback, and guarded restore. |
| Commands | Structured test/build/lint/read-only Git/module/allowlisted profiles; independent extension policy checks, exact approval, filtered environment, bounded output, timeout, and cancellation. |
| Verification and repair | Reviewed immutable plans, sequential controlled checks, bounded/redacted failure evidence, command-free repair proposals, separate repair approval, and exact-plan reruns. |
| Completion evidence | Required passing checks, approved plan/command identity, and current task-owned file hashes captured before verification; later edits can invalidate receipts. |
| Persistence and upgrades | SQLite conversation/audit records, foreign keys, automatic Alembic upgrades, and consistent backups before pending upgrades of existing data. |

Private model reasoning is discarded; public plans and progress are work summaries. Reasoning quality depends on the local model and hardware. A familiar inspect/plan/act/verify pattern does not imply identical intelligence, internals, or feature parity with Codex.

## Automatic model behavior

With `AUTO_MODEL_SETUP=true`, the backend prepares its configured provider on startup. For Ollama it checks the configured model first, then suitable installed alternatives. If none is suitable, it pulls `DEFAULT_MODEL`, verifies local inventory, and loads it. Concurrent clients share setup state through `/api/model-setup` rather than owning separate downloads.

Progress bytes and percentage describe the current Ollama download layer; verification/loading can have no numeric percentage. Cancelled preparation can be retried using cached layers. The chosen model becomes the running backend default without rewriting `.env`. Model weights remain in Ollama's own storage.

An OpenAI-compatible server must already expose a loaded local generation model. The compatible protocol has no universal installer or download endpoint. CodeMe discovers and checks available models but does not silently switch providers. See [Configuration](docs/configuration.md) and [Troubleshooting](docs/troubleshooting.md).

## Ownership and local boundary

The backend inspects source files and prepares/persists proposals. The extension owns source application, checkpoints, and approved project processes. Model-runtime preparation is a separate narrow setup path, not arbitrary command execution for a coding task. The browser does not apply source edits or run project commands.

Inference/backends accept loopback endpoints, bypass environment proxies, and refuse redirects. The API validates local peers, Host, and browser Origin. Ollama inventory must verify local weights; compatible providers require a trusted daemon with remote connectors disabled because inventory alone cannot prove a local proxy's behavior.

Repository text, model Markdown, and logs are untrusted evidence. They cannot approve actions, add executable allowlist entries, or expand repair tools. This remains a single-machine application without user-account authentication; processes under the same local account are within its trust boundary.

## Current limits

- One active VS Code workspace folder; no multi-root execution.
- Browser chat/exploration does not provide edit/command/verification parity with the extension.
- Context budgets estimate characters; tokenizer-exact compaction and repository symbol indexing remain future work.
- Chat-capable model selection does not guarantee reliable Agent tool use or adequate hardware memory.
- No file deletion/rename proposals, unattended approvals, network verification, agent package installation, deployment, or commit/push tools.
- Task ownership, cancellation, and setup coordination require one backend worker.
- Reload restores durable state but does not silently restart interrupted processes.
- The deprecated `/generate` route remains a placeholder; normal chat/Agent routes use real inference.

## Validation and maintenance

Backend tests, browser tests/build, extension type checks/tests/build/package, and setup fixtures are the relevant validation layers. Their runnable commands and environment requirements are in [Development](docs/development.md). Unit fixtures avoid real model downloads; live model generation and clean operating-system installation must be checked and reported separately when performed.

See [Architecture](docs/architecture.md) for code ownership/API maps, [Database migrations](alembic/README.md) for upgrade/recovery behavior, and [PLAN.md](PLAN.md) for future work. Update this report when those contracts or capabilities change.
