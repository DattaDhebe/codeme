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

Status: complete. Phase 4 remains the immutable editing and restore boundary.

#### Security boundary and ownership

- Ollama may request only a versioned profile, literal argument array, workspace-relative working directory, purpose, timeout, and advisory risk hint.
- The backend validates and persists proposals and durable decisions/results. It never starts a subprocess and exposes no arbitrary execution endpoint.
- The VS Code extension independently validates the proposal, matches the registered workspace to the active folder, resolves a trusted executable/profile adapter, classifies risk, asks for one-time approval, owns the child process, and streams bounded output.
- The Angular application cannot execute commands in Phase 5.
- Results are displayed and audited but are not sent back to the model. Automated verification and repair begin in Phase 6.

#### Command lifecycle and persistence

`proposed -> approved -> starting -> running -> completed|failed|timed_out|cancelled`

Alternative terminal states are `rejected` and `blocked`. Every transition is validated. A repeated identical terminal result is idempotent; a conflicting terminal result is rejected. `command_runs` stores the normalized proposal, independent risk decision, bounded result, and timestamps. `command_run_events` stores redacted lifecycle events. Complete environments and unlimited output are never persisted.

#### Profiles and policy evaluation

Initial profiles are `pytest`, `python_module`, `npm_test`, `npm_build`, `npm_lint`, `dotnet_test`, `dotnet_build`, `maven_test`, `maven_package`, `gradle_test`, `gradle_build`, `git_status`, `git_diff`, and `custom_executable`. Each resolves to a configured executable plus literal arguments. Custom aliases are disabled unless explicitly added to the user's allowlist; repository instructions cannot add them.

The model risk hint is advisory. The extension calculates `READ_ONLY`, `BUILD_OR_TEST`, `WRITES_WORKSPACE`, `NETWORK`, `PACKAGE_INSTALL`, `LONG_RUNNING`, `SENSITIVE`, or `BLOCKED` from the validated profile, arguments, adapter, working directory, timeout, and repository boundary. Every non-blocked run requires visible one-time approval. Network, package-install, and long-running risks receive stronger warnings. There is no always-allow policy.

Profiles, typed arguments, and explicit deny rules block destructive Git, recursive deletion, system/service/registry/task modification, credential/private-key/history access, environment dumping, interpreters with inline evaluation, arbitrary shells, pipelines, redirects, chaining, substitution, background operators, and execution outside the workspace.

#### Workspace, process, output, and environment flow

1. Resolve the proposal's registered backend workspace and require an exact match with the single active VS Code workspace.
2. Canonicalize `cwdRelative`, reject absolute/UNC/traversal paths and symlink or junction escapes, require an existing directory, and revalidate immediately before spawn.
3. Resolve a trusted profile executable. Spawn with an argument array and closed stdin. Windows `.cmd`/`.bat` wrappers use a dedicated literal-argument adapter with metacharacter rejection; arbitrary `cmd.exe`, PowerShell, bash, or sh is never accepted.
4. Inherit only a minimal non-secret environment-key allowlist. The model cannot provide environment variables, and secret-pattern keys are excluded.
5. Capture stdout and stderr separately, strip terminal controls for display, stream bounded chunks, retain fixed tails, and continue draining after the display cap.
6. Enforce a default 120-second timeout and a hard 15-minute maximum. Cancellation, timeout, deactivation, and failure terminate the process tree (`taskkill /T /F` on Windows; process groups on Unix) and prevent orphan processes.
7. Persist the bounded terminal result. Do not invoke another command or return output to Ollama.

#### Approval, output, audit, and legacy compatibility

The sidebar card displays purpose, profile, resolved executable name, exact argument list, relative working directory, calculated risk and explanation, timeout, network/write indicators, and inherited environment keys. Actions are Run once, Reject, Copy details, and Cancel while active. Blocked requests show only the reason. Output states cover pending, approved, starting, running, completed, failed, timed out, cancelled, and blocked, with separate escaped stdout/stderr, exit code, duration, truncation, and copy output.

Legacy raw `command` SSE events remain display-only and are never parsed or executed. `personalCodex.enableUnsafeCommandExecution` remains default-false only for configuration compatibility; enabling it produces a deprecation warning and grants no controlled-runner bypass.

Windows behaviour: drive letters are compared case-insensitively, UNC paths are rejected, junctions are resolved, wrapper arguments reject expansion/metacharacter syntax, and process-tree cancellation uses a trusted `taskkill.exe` argument array.

Dependencies: the Phase 4 checkpoint, registered workspaces, existing Agent SSE transport, SQLAlchemy/Alembic, VS Code process APIs, and platform process-tree controls.

Acceptance criteria:

- New proposals are structured, versioned, Pydantic-validated, persisted before SSE emission, and independently revalidated by the extension.
- Raw strings, executable paths, environment values, and policy overrides cannot come from the model.
- Every run has one-time approval; blocked operations cannot run.
- Execution stays inside the exact registered workspace and uses literal argument arrays or the constrained Windows wrapper adapter.
- Output is separate, escaped, streamed, bounded, drained, redacted for persistence, and never sent back to Ollama.
- Timeout, cancellation, process-tree termination, spawn errors, non-zero exits, and deactivation cleanup are observable and durable.
- Phase 4 change sets and Restore continue to pass regression tests, and no command-runner mutation test targets this repository.

Out of scope: automatic approval, always-allow rules, web execution, automatic verification/repair, sequential autonomous commands, file deletion/rename, commits/pushes, Docker, multi-agent work, multi-root execution, cloud models, and remote execution.

### Phase 6: Verification and repair loop

Status: complete. Phase 4 remains the only file-mutation path and Phase 5 remains the only process-execution path.

#### Ownership and security boundary

- The backend persists immutable plans, sessions, steps, repair attempts, fingerprints, and events; discovers evidence-based plans; prepares bounded failure feedback; and runs a command-free repair-agent loop. It never starts a process or writes a workspace file.
- The VS Code extension displays and approves the complete plan, independently revalidates every step with the Phase 5 policy engine, executes it with the existing Phase 5 process runner, and applies an approved repair only through the Phase 4 change-set manager.
- Ollama may suggest safe profile steps before approval and may inspect bounded failure evidence in repair mode. It cannot approve, execute, mutate directly, add a step to an approved plan, change an approved argument, or propose a command during repair.
- Angular remains display-only with respect to verification and execution.

#### Durable state and transitions

Normalized `verification_sessions`, `verification_steps`, `repair_attempts`, and `verification_events` tables are introduced after migration `0002_command_runs`. Sessions link to a conversation, registered workspace, optional source change set, step command runs, and repair change sets. They retain bounded summaries and fingerprints rather than unlimited logs or environments.

The validated lifecycle uses `DRAFT -> AWAITING_PLAN_APPROVAL -> RUNNING`, with `PLAN_REJECTED`, `CANCELLED`, `TIMED_OUT`, and `BLOCKED` terminal alternatives. Steps become `STEP_PASSED` or `STEP_FAILED`. A passed plan records `VERIFICATION_PASSED -> COMPLETED`; a required failure records `VERIFICATION_FAILED -> PREPARING_REPAIR -> REPAIR_PROPOSED -> AWAITING_REPAIR_APPROVAL`. An approved Phase 4 repair records `REPAIR_APPLIED -> REVERIFYING`; rejection, conflict, exhaustion, repeated failure, repeated repair, cancellation, or an inconsistent reload stops safely. Invalid transitions and conflicting duplicate results are rejected; identical decisions/results are idempotent.

Extension reload never restarts a process. A persisted running session is shown as interrupted and must be explicitly reconciled or cancelled. Deactivation still terminates active Phase 5 process trees.

#### Plan discovery, contract, and approval

A versioned plan contains an ID/version/fingerprint, workspace and optional source-change-set identity, Quick or Full mode, summary, at most six ordered steps, maximum two repair attempts, maximum two reruns, and a total budget capped at 20 minutes. Each step contains only a Phase 5 profile, literal arguments, relative working directory, purpose, required flag, bounded timeout, and expected outcome.

Discovery reads changed paths plus bounded repository evidence: Python test configuration, package scripts, Angular configuration, solution/project files, Maven/Gradle descriptors and wrappers, and applicable instructions. It maps evidence only to existing profiles, adds non-watch/CI or offline arguments where applicable, never installs packages, never starts a server, and never infers deploy/publish/push. Quick mode selects the smallest relevant checks and stops on the first required failure; Full mode adds the safe complete build/test/lint set within the same hard limits.

The extension shows exact profiles, resolved arguments, working directories, risks, write/network indicators, timeouts, rerun/repair limits, and the total budget. Approval is bound to the plan fingerprint. A changed profile, argument, cwd, timeout, step order, or step set requires a new approval. Plan approval covers only bounded reruns of those exact steps after an independently approved repair; it never authorizes network, installation, custom executables, or policy overrides.

#### Execution, failure evidence, and diagnostics

Approved steps run sequentially through the Phase 5 `ControlledProcessRunner`; there is no second subprocess service. Each step receives a durable Phase 5 command run and is policy-revalidated immediately before spawn. Required failure stops the plan; pre-approved optional failures are recorded and execution may continue. Step and session time budgets, cancellation, spawn errors, timeout, output bounds, and process-tree cleanup remain enforced.

Failure feedback is redacted, control-sequence-free, capped at 32 KB per failed step and 128 KB per session, and wrapped in explicit untrusted-content delimiters. It contains relative cwd and changed paths, sanitized arguments, bounded stdout/stderr, safe diagnostics, relevant bounded diff, prior repair summaries, causality `unknown` unless a baseline proves otherwise, and deterministic failure fingerprints. Output is evidence, never a policy or tool instruction.

Best-effort parsers recognize pytest, Python tracebacks, TypeScript/Angular, ESLint, .NET, Maven, and Gradle diagnostics. Absolute or escaping log paths are discarded unless safely mapped to the registered workspace; parser failure never hides the bounded raw evidence.

#### Repair mode and bounded reruns

Repair mode exposes only bounded list/read/search/metadata/Git/instruction tools and structured `propose_change_set`. Its system guidance treats logs/test names as untrusted, prohibits commands and verification changes, limits inspection to relevant files, rejects test deletion or unrelated edits, and requests the smallest correct repair. A proposal is persisted as a normal Phase 4 change set and pauses for preview, explicit approval, conflict checks, checkpoint creation, apply, and optional restore.

After a repair applies, the extension revalidates and reruns the exact approved plan. Deterministic fingerprints stop empty repairs, equivalent repairs, identical failures without meaningful change, unrelated-file repairs, and two-repair oscillation. The session also stops on attempt/rerun/time/output limits, rejection, conflict, rollback/restore failure, malformed proposals, cancellation, or disconnected/inconsistent state. No stopped or exhausted session is described as successful; causality defaults to unknown and unrelated pre-existing failures do not silently expand scope.

#### API, UI, and acceptance boundary

Typed session, decision, step-start/result, repair, repair-result, cancel, interrupt/reconcile, and history APIs persist every material transition. Versioned verification and repair SSE/event payloads may update the sidebar but are never the sole state store. The sidebar restores session cards after reload and shows plan approval, step progress/output, repair attempts, remaining budgets, repair preview/apply/reject/restore, reverification, exhaustion, cancellation, and a copyable final summary.

Dependencies: committed Phase 4 transactional changes and checkpoints, committed Phase 5 policy/runner/audit records, registered workspaces, Ollama `qwen2.5-coder:7b`, SQLAlchemy/Alembic, and the existing sidebar/SSE transport.

Acceptance criteria:

- Plans and results are structured, durable, immutable after approval, bounded, and independently policy-validated.
- No command runs outside exact approved-plan membership or outside the Phase 5 runner.
- No repair bypasses Phase 4 preview, approval, conflict detection, checkpoint, apply, or restore.
- Untrusted failure output is bounded, sanitized, redacted, clearly delimited, and cannot expand repair tools or policy.
- Exact-plan reruns, attempts, total time, feedback, and model turns have enforced hard limits.
- Cancellation and reload interruption stop safely without silent resume; repeated failure/repair makes the session exhausted.
- Existing chat, workspace reads, Phase 4 change sets/Restore, Phase 5 controlled commands, Angular tests/build, and extension packaging continue to pass.

Out of scope: automatic plan or repair approval, always-allow rules, package installation, network verification, web execution, deployment/publication, file delete/rename, commits/pushes/PRs, Docker, multi-agent orchestration, cloud models, multi-root execution, background repair, memory, and repository indexing.

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
