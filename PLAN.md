# Personal Codex Development Plan

## Product direction

Personal Codex is a local-first coding assistant powered by Ollama. It has two supported clients: an Angular web application for ChatGPT-style local chat and a VS Code extension for repository-aware coding work. The backend remains FastAPI with SQLAlchemy and SQLite. Cloud or paid model APIs are not part of this plan.

The effective Python requirement is Python 3.10 or newer because the backend uses PEP 604 union syntax. Python 3.12 is the recommended development version. Angular 18 requires a supported Node 18.19+, Node 20.11+, or Node 22+ runtime; the extension bundle targets Node 18.

## Completed or substantially completed

### Phase 1: Local backend, Ollama chat, and persistence

Implemented:

- FastAPI application and local Uvicorn startup task.
- Native Ollama `/api/chat` streaming and `/api/tags` inventory.
- Configurable local model with `qwen2.5-coder:7b` as the default.
- SQLite conversations and messages.
- Local health and Ollama-aware readiness endpoints.

Partial:

- Streaming messages are committed chunk by chunk rather than through a durable message lifecycle.
- Database tables are still created through SQLAlchemy metadata for clean installs.
- `/generate` is a retained legacy placeholder, not the primary model path.

Dependencies: Python 3.10+, FastAPI, SQLAlchemy, SQLite, HTTPX, and a running Ollama service.

Acceptance criteria: local chat can stream from an installed Ollama model and conversations survive backend restarts.

Out of scope for this completed phase: remote model providers and production authentication.

### Phase 2: ChatGPT-style Angular interface foundation

Implemented:

- Standalone Angular application with conversation sidebar and message view.
- Conversation creation, history loading, Markdown, syntax highlighting, streaming, cancellation, and workspace settings route.
- Angular Material foundation and SSR build configuration.

Partial:

- Conversation rename, delete, and search exist in backend contracts but are not exposed in the web chat.
- Theme, model settings, responsive polish, web agent mode, tool cards, and change approval are incomplete.
- Phase 4A stabilizes Markdown, SSE parsing, runtime configuration, and stale tests.

Dependencies: Phase 1 API contracts, Angular 18, Node supported by Angular 18, and npm.

Acceptance criteria: the production build succeeds and browser chat handles safe Markdown and the backend SSE contract correctly.

Out of scope: web change-set application until Phase 8.

### Phase 3: Workspace and repository read tools

Implemented:

- Workspace registration.
- Workspace-root canonicalization and traversal prevention.
- Text file listing and reading with binary, secret-name, and size checks.
- ripgrep search.
- Read-only Git status and diff.
- Nearest applicable `AGENTS.md` lookup.

Partial:

- Repository mapping is heuristic.
- Symbol extraction, hierarchical instruction merging, content secret detection, and large-repository indexing are not implemented.
- Search output and generated-directory exclusions need further bounding.

Dependencies: Phase 1, local filesystem access, Git, and ripgrep.

Acceptance criteria: all returned paths are workspace-relative and read tools cannot escape the registered root.

Out of scope: writes and command execution.

### Phase 3.5: VS Code extension and bounded repository agent

Implemented:

- Activity Bar webview, Ask and Agent modes, conversation history, model selection, current-file/selection/Git context, Markdown, code actions, and backend health controls.
- Bounded Ollama tool loop with repository read tools.
- File and command proposal events.
- Native diff preview and approval-gated `WorkspaceEdit` application.
- VSIX packaging script.

Partial:

- Only the first workspace folder is supported.
- Diagnostics are not collected.
- Structured create/modify change sets are now preferred; verified legacy complete-file proposals are translated into the same transactional pipeline.
- Command proposals use an unsafe raw terminal path; Phase 4A disables it by default, and Phase 5 replaces it.
- Tool events are not retained with old conversation messages.

Dependencies: Phases 1 and 3, VS Code 1.90+, and the local backend.

Acceptance criteria: extension chat and read-only agent inspection operate against a registered local workspace with explicit consent.

Out of scope: unattended autonomy.

## Remaining phases

### Phase 4A: Critical baseline stabilization

Status: implemented in this task; final verification commands are recorded in the handoff.

Scope:

- Use Angular's maintained allowlist sanitizer for generated Markdown.
- Correct fragmented and combined SSE parsing and JSON data decoding.
- Centralize Angular backend/model runtime configuration.
- Honor workspace registration consent in the extension.
- Preserve command proposals while disabling unsafe execution by default.
- Repair scoped tests and inaccurate documentation.

Dependencies: existing Angular chat contract and extension settings.

Acceptance criteria:

- Model HTML cannot retain executable elements, handlers, unsafe URLs, SVG script payloads, or injected style content.
- Escaped text, Unicode, code blocks, split frames, multiple frames, errors, completion, and cancellation behave correctly.
- Angular uses one validated runtime backend URL and obtains model inventory from `/api/health`.
- Workspaces are never silently registered while automatic registration is disabled.
- Raw terminal commands cannot execute unless the user explicitly enables the unsafe compatibility setting and approves each command.
- Scoped tests and production builds pass, excluding clearly documented environment-only runner failures.

Out of scope: controlled command execution, autonomous tests, cloud models, multi-root support, and web agent parity.

### Phase 4B: Transactional Safe Change Sets

Status: implemented in this task; later controlled execution and autonomous verification remain deliberately out of scope.

#### Architecture and ownership

The backend owns the versioned change-set contract, workspace path validation, base/proposed hashing, deterministic proposed content, diffs, durable state, and state-transition validation. It never writes source files.

The VS Code extension owns final path revalidation, dirty-document checks, complete-set preview, approval, checkpoint storage outside the source tree, atomic `WorkspaceEdit` application, post-apply hash verification, rollback, and restore. It reports durable decisions and outcomes to the backend.

One internal pipeline handles both structured change sets and valid legacy `file_change` proposals. Legacy events retain their current fields during migration but carry a backend-created change set. Markdown code blocks are not authoritative changes.

#### Persistence model

- `change_sets`: identity, schema version, conversation/workspace ownership, summary, status, checkpoint reference, failure reason, and timestamps.
- `change_operations`: ordered create/modify operations with relative path, encoding, line-ending policy, base/proposed hashes, structured edits, proposed content, diff, and result hash.
- `change_set_events`: durable status transitions and redacted decision/result details.

Checkpoints are stored in the extension global-storage area, not in the source repository. The backend stores only an opaque checkpoint reference.

#### State transitions

`proposed -> approved -> applying -> applied -> restored`

Alternative terminal states are `rejected`, `failed`, and `restore_failed`. Invalid transitions are rejected. Approval, rejection, application, failure, restore, and restore failure are durable.

#### Preview, approval, apply, failure, and restore flow

1. The model submits a structured proposal tool call.
2. The backend validates operations, reads verified base files, applies structured edits in memory, computes hashes/diffs, persists the proposal, and emits it through SSE.
3. The extension shows the complete set and allows every file to be previewed against the verified base.
4. Apply records approval, revalidates real paths and hashes, rejects dirty/stale files, and writes a checkpoint.
5. One `WorkspaceEdit` applies all operations. Result hashes are verified and reported.
6. Any failure triggers best-effort rollback from the checkpoint and a durable failed result.
7. Restore first verifies each current result hash. Newer user changes cause a conflict instead of overwrite. Only files owned by that set are restored.

#### Required invariants

1. Operations cannot target outside the selected registered workspace.
2. API and model-visible paths are workspace-relative.
3. The backend canonicalizes and validates paths.
4. The extension revalidates real paths immediately before application.
5. Traversal, absolute, symlink, and junction escapes are rejected.
6. Modify operations contain a verified base SHA-256.
7. Create operations prove the target does not exist.
8. Preview and apply use the same base version.
9. Stale proposals are rejected.
10. Dirty editor content is never silently overwritten.
11. Multi-file changes apply together or roll back.
12. Every successful apply has a checkpoint.
13. Restore touches only files owned by the set.
14. Restore refuses to overwrite newer user changes.
15. Decisions and results are durable.
16. Phase 4 never runs a terminal command.

Dependencies: Phase 4A, registered workspaces, existing SSE proposals, SQLAlchemy models, Alembic baseline, VS Code virtual documents, `vscode.diff`, and `WorkspaceEdit`.

Acceptance criteria:

- Create and modify operations are schema validated; delete and rename are rejected.
- Modifications use structured exact search/replace edits or a validated legacy adapter.
- Empty sets, duplicate paths, bad hashes, malformed/overlapping edits, secret/binary/large files, and boundary escapes are rejected.
- A complete set is previewed and approved as one unit.
- Hash conflicts and dirty editors block application.
- Applied sets have recoverable out-of-tree checkpoints.
- Restore is hash guarded.
- Legacy proposal fields remain consumable, but there is only one apply pipeline.
- Existing chat, workspace, Git, Ask, and Agent contracts remain compatible.

Out of scope: deletion, rename, terminal execution, tests by the agent, commits, pushes, repair loops, and autonomous mode.

### Phase 5: Controlled command execution

Scope: structured requests, risk classification, allow/confirm/block policy, argument-array execution where possible, controlled shell fallback, workspace `cwd`, timeout, cancellation, bounded output, process-tree termination, environment filtering, and audit records.

Dependencies: durable Phase 4 decisions, checkpoint capability, and platform-specific process control.

Acceptance criteria: commands cannot run without policy evaluation; results and termination state return to the agent; destructive defaults are blocked.

Out of scope: automatic repair loops and remote execution.

### Phase 6: Verification and repair loop

Scope: formatting, compilation, linting, test execution, diagnostics capture, failure feedback, bounded repairs, and final verification summary.

Dependencies: Phase 5 controlled runner and Phase 4 rollback.

Acceptance criteria: each attempt is bounded and auditable, failures are fed back structurally, and final claims are backed by captured results.

Out of scope: indefinite autonomy.

### Phase 7: Repository intelligence and context management

Scope: repository map, symbols, relevant-file selection, context budgets, conversation compaction, hierarchical `AGENTS.md`, prompt-injection boundaries, secret detection, and large-repository handling.

Dependencies: stable read tools and an explicit context policy.

Acceptance criteria: context is relevant, budgeted, traceable, instruction scopes merge deterministically, and protected content is excluded.

Out of scope: embedding services that require a cloud provider.

### Phase 8: Editor and web parity

Scope: VS Code diagnostics, multi-root workspaces, inline actions, change-set history, Angular agent mode, web diff/approvals, conversation parity, model/theme settings, responsiveness, and accessibility.

Dependencies: Phases 4-7 contracts.

Acceptance criteria: both clients expose consistent safe workflows while respecting platform-specific capabilities.

Out of scope: marketplace publishing.

### Phase 9: Production hardening and packaging

Scope: Alembic lifecycle, local authentication, loopback enforcement, rate/body limits, structured logging, durable audit, health/observability, installer/startup experience, VSIX packaging, backup/restore, and security documentation.

Dependencies: stable schemas and execution model.

Acceptance criteria: upgrades preserve local data, network exposure is secure by default, recovery is documented, and distributable artifacts are reproducible.

Out of scope: paid hosted services.
