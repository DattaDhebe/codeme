# CodeMe · Personal Codex

CodeMe is a local coding assistant using Ollama or a local OpenAI-compatible model server such as LM Studio or llama.cpp. It includes a FastAPI/SQLite backend, an Angular chat interface, and a repository-aware VS Code extension. It has no hosted model integration.

## Current capabilities

- Local chat with SSE streaming and model discovery across both inference protocols.
- Persistent conversations and registered workspaces.
- Workspace-bounded file listing, ranged reading, bounded ripgrep search, Git status/diff, and root-to-folder `AGENTS.md` guidance.
- A bounded model/tool loop with structured plans, read-before-edit checks, observed execution feedback, and explicit outcomes.
- Durable task goals, approval pauses, safe result-driven continuation, recovery after reload, cancellation, and cycle/time budgets.
- A Copilot-style VS Code sidebar with Ask and Agent modes.
- Versioned transactional create/modify change sets with base SHA-256 hashes, deterministic diffs, complete-set approval, conflict detection, out-of-tree checkpoints, rollback, and guarded restore.
- Legacy `file_change` events remain compatible but are translated into the same transactional pipeline.
- Versioned command proposals for controlled test, build, lint, read-only Git, Python-module, and explicitly allowlisted custom-executable profiles.
- Independent extension-side policy checks, one-time approval, workspace-bound argument-array execution, filtered environments, bounded streaming output, timeout, cancellation, process-tree termination, and durable command audit records.
- Legacy raw command proposals remain visible but are always display-only; the deprecated compatibility setting cannot enable them.
- Durable Quick/Full verification sessions with immutable whole-plan approval, sequential Phase 5 execution, bounded diagnostics, local Qwen repair proposals, Phase 4 repair approval/checkpoints/Restore, exact-plan reruns, and no-progress limits.
- Responsive browser chat and workspace explorer, searchable/renameable conversation history, local-model selection, explicit readiness/reconnect states, and keyboard-friendly streaming controls.
- VS Code task status, review counts, draft preservation, jump-to-latest, accessible controls, and theme-aware proposal/output cards.
- Bounded model history and repository context, scoped instructions on file reads, and honest tool-failure and incomplete-stream reporting.
- Loopback-only inference transport, browser Origin/Host validation, proxy bypass, and Ollama local-weight checks that exclude cloud model aliases.

The root `/generate` endpoint is retained for compatibility and is a placeholder. Use `/api/conversations/{id}/chat` or `/api/conversations/{id}/agent` for real local inference.

## Coding task workflow

In the VS Code sidebar, choose **Agent** and describe the intended result. CodeMe inspects scoped project guidance and relevant files, maintains a public plan, proposes an exact edit or command, and pauses for review. After the extension reports the actual reviewed result, the same task continues with its original goal and bounded failure evidence.

Applying an edit creates a verification plan that still needs approval. Completion requires at least one required passing check, matching approved plan/command receipts, and unchanged source hashes captured before the checks. Verification covers the final task-owned file versions across successive edits and repairs. A model-requested check after an unverified edit becomes an explicit verification plan requiring approval. Failed checks can lead to a reviewed repair. Rejected actions, missing evidence, repeated tool failures, interruptions, and exhausted budgets remain visible and never count as success. Reload restores state without silently restarting execution.

`AGENT_MAX_CYCLES` defaults to 8 and `AGENT_TIME_BUDGET_SECONDS` to 900 active seconds; time waiting for review does not consume this model budget. Each cycle also bounds model turns, tools, repeated failures, and context. Stop cancels the model task and its tracked extension processes; an in-flight model HTTP request may take until its bounded request returns before backend cleanup completes.

Plans and summaries show public work progress. Private model reasoning is discarded. CodeMe follows a comparable task/observation/verification pattern to the [documented Codex goal workflow](https://developers.openai.com/cookbook/examples/codex/using_goals_in_codex); local models determine its reasoning quality, so this is not a claim of identical Codex intelligence or all Codex features.

Task APIs: initial `/api/conversations/{id}/agent` SSE; list `/api/agent-runs?conversation_id=...`; get, continue, and cancel under `/api/agent-runs/{id}`. Continuation accepts no client-claimed results: the backend reads its durable command, change-set, and verification records.

## Requirements

- Python 3.10 or newer. Python 3.12 is recommended.
- Node.js 18.19+, 20.11+, or 22+ for Angular 18. The extension bundle targets Node 18.
- npm.
- Git and ripgrep for repository tools.
- A local tool-capable coding model served through Ollama (default `qwen2.5-coder:7b`) or a local OpenAI-compatible server.
- VS Code 1.90+ for the extension.

## Backend setup

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
ollama pull qwen2.5-coder:7b
.\.venv\Scripts\python.exe -m uvicorn main:app --host 127.0.0.1 --port 8000 --workers 1
```

The selected model server must be running before chat can generate replies. Run the backend with **one worker**: task ownership/cancellation use a local process registry. For an Ollama-only daemon, set `OLLAMA_NO_CLOUD=1` in the environment of `ollama serve` and restart any already-running service. With the Ollama provider, CodeMe rejects remote URLs, cloud tags, remote aliases, and inventory entries without verifiable local weights before sending a prompt. See the [official Ollama cloud-disable instructions](https://docs.ollama.com/faq#how-do-i-disable-ollamas-cloud-features).

`OLLAMA_CONTEXT_LENGTH` defaults to 8192 and is sent as Ollama's `num_ctx` option. For a compatible server, configure its actual context window in that server and match this setting to keep CodeMe's budget appropriate. Context selection uses conservative character budgets; exact tokenizer-aware compaction remains future work.

For LM Studio or llama.cpp, set these values in `.env` and restart the backend:

```dotenv
MODEL_PROVIDER=openai_compatible
LOCAL_MODEL_URL=http://127.0.0.1:1234/v1
DEFAULT_MODEL=your-exact-local-model-id
```

Use the model ID returned by your server's `/v1/models`, and the loopback port on which you started it. The adapter uses `/v1/chat/completions` with tool calls, not a hosted OpenAI account. See [LM Studio tool-use setup](https://lmstudio.ai/docs/developer/openai-compat/tools). The daemon must serve local weights with remote connectors disabled: a compatible protocol's model inventory cannot prove that a local proxy will not forward requests. CodeMe rejects explicit remote/cloud metadata and never follows redirects or environment proxies. This adapter expects a trusted loopback daemon without API-key authentication.

Readiness endpoints:

- `http://127.0.0.1:8000/health`: FastAPI process health.
- `http://127.0.0.1:8000/api/health`: selected provider connection, configured model, and local model inventory.

## Database upgrade

Startup now runs idempotent Alembic upgrades before serving requests. Before a pending upgrade of an existing SQLite database, it creates a consistent backup under `.runtime/database-backups`; backup failure stops startup before schema writes. Repeated startup at the current revision does not create additional backups. Clean databases initialize through the same migration path.

For a manual upgrade, back up the database first, then run:

```powershell
.\.venv\Scripts\python.exe -m alembic upgrade head
```

Migration `0001` preserves existing chats/workspaces while adding change sets; `0002` adds command records; `0003` adds verification/repair records; `0004` adds durable agent tasks and verification file receipts. Existing receipts default empty and do not count as newly verified work. See `alembic/README.md` for inspection and rollback commands. Do not delete or recreate `codeme.db` during an upgrade.

## Angular application

```powershell
cd frontend
npm ci
npm start
```

The browser opens at `http://localhost:4200`. Runtime defaults are in `frontend/public/runtime-config.json`; that file can be replaced without recompiling JavaScript. Backend URLs must use localhost or a loopback IP. The old `allowRemoteBackend` escape hatch no longer enables network endpoints.

The browser provides local chat and read-only repository exploration. Reviewable edits, controlled commands, checkpoints, and verification run through the VS Code extension. No browser action applies a file proposal or runs a terminal command.

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

The package command creates `personal-codeme-0.7.0.vsix`.

Workspace registration requires consent. `personalCodex.autoRegisterWorkspace=false` prevents automatic registration; entering Agent mode prompts before the first registration. Existing backend registrations are reused.

Applied change-set checkpoints are kept under VS Code extension global storage, outside the source repository. Restore verifies applied hashes and refuses to overwrite later user edits.

Controlled commands are proposed by the local model and executed only by the VS Code extension after independent policy evaluation and visible approval. The backend records proposals, decisions, lifecycle events, and bounded redacted results; it has no arbitrary subprocess endpoint. The durable task controller returns bounded/redacted outcomes to the local model as explicitly untrusted evidence on continuation.

Verification starts from an applied change set's **Verify** action or a task's approved edit. The complete discovered plan must be approved once. Only its exact profiles, arguments, working directories, order, and timeouts can run or rerun. A required failure is sanitized, redacted, marked untrusted, and sent through command-free local repair mode. Repairs pause for preview and approval; installation, network verification, test changes in repair mode, unrelated changes, automatic approval, commits, and pushes remain blocked.

Verification APIs are rooted at `/api/verification-sessions`: create/list/get, exact plan decision, step start/result, repair preparation/result, cancellation, interruption, and persisted versioned event streaming at `/{id}/events`.

## Configuration

Backend environment names and safe defaults are shown in `.env.example`. Non-loopback bind settings, Ollama endpoints, browser origins, and UNC workspaces are rejected. HTTP requests require a loopback peer, loopback Host, and an approved local Origin when a browser supplies one. Custom browser development ports must be explicitly included in `CORS_ORIGINS`. This is a single-machine application; other processes running under your local account remain inside its trust boundary.

New messages update conversation order and automatically title untitled chats. Chat tokens stream immediately while SQLite writes are batched; partial replies are saved when the generator closes or reports an error. SQLite foreign keys are enabled on every application connection so future chat deletions also remove associated messages and proposals. Conversation/workspace deletion is refused while recorded commands, file application, or verification are active. Existing orphaned records are not removed automatically.

See `PLAN.md` for Phase 4 transactional editing, Phase 5 controlled execution, Phase 6 bounded verification/repair, acceptance criteria, and the boundaries of later work.
