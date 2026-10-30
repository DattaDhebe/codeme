# How CodeMe works

CodeMe has one backend and two clients. They use the same local model configuration and conversation store, while the VS Code extension owns the parts that change a project.

| Component | Responsibility | Main source |
| --- | --- | --- |
| FastAPI service | API, streaming, persistence, workspace inspection, proposals, task coordination, model setup | `main.py`, `codeme_agent/routers.py` |
| Local model adapters | Model inventory, chat, tool calls, local transport checks, visible-text filtering | `model_client.py`, `ollama.py`, `local_models.py`, `model_messages.py` |
| Setup coordinator | Local runtime/model preparation and observable setup state | `model_setup.py` |
| Task controller | Durable original goal, plan, action ownership, result-driven continuation, completion evidence | `agent_runs.py`, `agent.py`, `workflow.py` |
| Browser app | Chat, setup progress, history, and read-only repository exploration | `frontend/src/app/` |
| VS Code extension | Editor context, review UI, transactional edits, checkpoints, approved process execution | `vscode-extension/src/` |
| SQLite/Alembic | Conversations and durable audit records, schema upgrades | `models.py`, `db.py`, `alembic/` |

Backend filenames in the table are under `codeme_agent/` unless shown otherwise. See [Development](development.md) for repository commands.

## Model setup and inference

Model setup is distinct from a coding task. It checks the configured local server, discovers installed models, prepares an Ollama model when necessary, and exposes progress through `/api/model-setup`. Both clients display the same backend-owned status. A reused model does not need another weights download.

Chat readiness and Agent suitability are separate. Setup reports advertised capabilities and `tool_support`; the extension checks `/api/model-capabilities` for an explicitly selected model. Known chat-only models remain usable in Ask mode. An older daemon or compatible protocol can leave tool support unknown; a successful capability check does not prove model quality. Ollama local-weight inventory is rechecked before each prompt, including later turns of the same task.

Ollama downloads weights through its local daemon. A download is network traffic; inference sends prompts to the loopback daemon. For OpenAI-compatible servers, the standard chat API provides discovery and generation, not a universal model installer. Those servers must already have a local model loaded.

Inference adapters bypass environment proxies and refuse redirects. Ollama inventory must describe local weights. Compatible server metadata cannot prove that a local proxy will never forward a prompt, so that provider requires a trusted local-only daemon with remote connectors disabled.

## A task from request to evidence

1. The extension sends the request, workspace identity, chosen model, and bounded editor context.
2. The backend stores a task and streams public plan/progress events while the model inspects relevant files and instructions.
3. The model proposes one exact change set or structured command and pauses.
4. The extension displays the proposal, validates it independently, records approval/rejection, and performs the approved action.
5. The controller reads canonical action records and continues the original goal. It does not accept client prose as proof of execution.
6. Applied changes require a reviewed verification plan. Checks use the existing controlled runner; failures may produce a separately reviewed repair.
7. Completion requires passing required checks tied to approved plan/command identities and the actual file versions captured before verification.

Later edits or restores can invalidate earlier verification receipts. A failure can be investigated and superseded by an appropriate later passing check; an old unrelated pass cannot stand in for current evidence. Public plans summarize work and do not expose private model reasoning.

## Who can change a project

The backend prepares source edits in memory and persists their paths, hashes, exact content, and diffs. Edit permission comes from source content actually delivered to a subsequent model turn, with its source hash; a partial read cannot authorize a whole-file replacement. Reads preserve CRLF instead of silently normalizing the source. Context budgeting includes tool definitions and preserves the original task goal.

Before inference, a bounded fresh repository map ranks candidate paths from task terms, filenames, symbol hints, import relationships, and safe Git metadata. The read-only `repository_context` tool can refresh those hints during a task. Selection respects repository ignore rules and built-in private/generated-path exclusions; it returns reasons and partial-map notices. It has no persistent source cache and does not grant source-read evidence. Optional navigation hints are removed before the original task or applicable instructions when context is tight. Requests exceeding the agent's 16,000-character task limit receive an explicit error. See [Repository context](repository-context.md) for scan limits and fallback behavior.

The extension rechecks real paths, disk hashes, and dirty documents immediately before applying one complete `WorkspaceEdit`. It saves the editor documents, verifies their on-disk bytes, and sets the reviewed LF/CRLF style explicitly. Mixed/bare-CR proposals are refused before mutation because the editor cannot preserve them exactly. Approved create paths can include missing parent folders; preview remains read-only. Checkpoints record which folders were created so rollback/restore remove only owned empty folders and preserve files added later by the user.

Checkpoints stay outside the source tree. Rollback and restore refuse to overwrite unexpected current content. An ambiguous partial create can leave a file in place with an explicit recovery checkpoint rather than risk removing a concurrently created user file. Save failures and save-time formatters that change the reviewed bytes cannot be reported as successful application.

For project commands, the model supplies a fixed profile and literal argument array. The extension chooses the configured executable, recomputes risk, checks the registered workspace and working directory, and asks for approval. It captures separate bounded stdout/stderr and owns timeout, cancellation, and process cleanup. Legacy raw shell strings are display-only.

The backend's model-runtime preparation and the user-invoked installer have a narrow setup purpose. They do not create an arbitrary subprocess or package-install capability for coding tasks.

## Persistence and restart behavior

SQLite stores conversations, messages, workspaces, change sets, command runs, verification sessions/repairs, durable agent tasks, and their material events. Partial chat replies are retained; model-token persistence is batched. The task controller enforces one active task per conversation, bounded cycles, and an active model-time budget.

Reload restores task/review history. A missing process is treated as interrupted instead of being silently restarted. Run the backend with **one worker** because execution ownership, cancellation, and setup coordination use process-local state.

Startup applies Alembic upgrades. An existing SQLite schema receives a consistent backup before a pending upgrade. Backup failure stops startup before schema writes. See [Database migrations](../alembic/README.md).

## API map

| Route | Purpose |
| --- | --- |
| `GET /health` | Backend liveness |
| `GET /api/health` | Selected local provider/model readiness and inventory |
| `GET /api/model-setup` | Model preparation state and progress |
| `POST /api/model-setup` | Start/retry preparation without creating duplicate work |
| `DELETE /api/model-setup` | Cancel preparation; already downloaded layers remain reusable |
| `GET /api/model-capabilities?model=...` | Inspect installed-model Agent suitability without downloading or generating |
| `GET /api/model-catalog` | Inspect reviewed local coding models, research sources, memory guidance and installed state; no downloads or generation |
| `/api/conversations` | Conversation management and messages |
| `POST /api/conversations/{id}/chat` | Normal chat stream |
| `POST /api/conversations/{id}/agent` | Initial coding-task stream |
| `/api/agent-runs` | Task history, current state, continue, and cancel |
| `/api/workspaces` | Registered roots, file reads, search, Git, and instructions |
| `/api/change-sets` | Exact proposals, decisions, apply/restore results, and audit |
| `/api/command-runs` | Structured proposals, decisions, lifecycle, and bounded results |
| `/api/verification-sessions` | Plans, decisions, steps, repair, cancellation, and events |

Interactive API descriptions are available at the running backend's `/docs`. The deprecated root `/generate` route is a compatibility placeholder, not a model-inference route.

## Local trust boundary

The service accepts loopback clients and validates Host and browser Origin. Backend/model URLs and workspaces must stay local; UNC workspaces are rejected. This is a single-machine tool without user-account authentication. Other processes running under the same local account are within its trust boundary.

Repository content, model Markdown, and command output are treated as untrusted evidence. They cannot replace operating rules, register executables, approve actions, or expand repair permissions. Output/context caps and scoped reads reduce accidental overreach; they do not make an arbitrary project's test scripts safe to execute without review.
