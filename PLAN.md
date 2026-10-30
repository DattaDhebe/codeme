# CodeMe development plan

CodeMe is a local coding assistant with a FastAPI/SQLite backend, an Angular browser app, and a VS Code extension. The current implementation is the starting point for this plan. Detailed usage is in the [README](README.md); contributor commands are in [Development](docs/development.md).

## Delivered foundations

| Area | Current behavior |
| --- | --- |
| Local inference | Native Ollama and trusted loopback OpenAI-compatible servers; cloud aliases and remote endpoints are rejected. |
| First-run setup | Installation and launch scripts, automatic model discovery, installed-model reuse, Ollama downloads with progress, and model loading. |
| Browser | Conversation management, safe Markdown, streaming, model readiness, responsive chat, and a read-only workspace explorer. |
| Repository tools | Registered local roots, bounded reads/search/Git output, path protections, and root-to-folder `AGENTS.md` instructions. |
| Repository navigation | Fresh task-ranked file selection, heuristic symbols/import links, selection reasons, strict scan/output limits, and no edit permission from metadata. |
| Model evaluations | Opt-in installed-model matrix with deterministic task oracles, separate quality/recovery/policy results, bounded inference, and JSON reports. |
| Installation checks | Fresh-copy installer/build/launch/upgrade harness, controlled model-protocol failures, offline relaunch, and a manual Windows/macOS/Linux CI matrix. |
| Task controller | Durable goals, public plans, read-before-edit checks, review pauses, observed-result continuation, explicit resume/cancel, and bounded recovery. |
| Transactional editing | Versioned create/modify sets, complete-set review, base hashes, conflict checks, checkpoints, rollback, and guarded restore in VS Code. |
| Controlled commands | Typed profiles, independent policy validation, one-time approval, workspace-bound execution, output caps, timeout, and process cleanup. |
| Verification and repair | Immutable approved plans, required checks, current-file receipts, bounded failure feedback, reviewed repairs, and exact-plan reruns. |
| Persistence | Conversations and audit records in SQLite, foreign keys, automatic Alembic upgrades, and pre-upgrade backups. |

The [30 October 2026 application review](docs/review-2026-10-30.md) adds model suitability checks, source-read evidence, context budgeting for tools, disk-backed file application, nested creates, bounded UI waits, and stronger recovery tests. Remaining work below is still distinct from the delivered behavior.

Historical implementation names remain in source and tests: **Phase 4** means transactional editing, **Phase 5** means controlled command execution, and **Phase 6** means bounded verification/repair. They are delivered layers, not unfinished prerequisites.

## Boundaries to preserve

- Model inference and repository work stay on the same machine. Initial software/model downloads may use the network.
- Backend workspace tools read source files. The extension owns reviewed source edits and approved project commands.
- Model/runtime setup is a separate installation path. It must not let repository content choose an executable, endpoint, arbitrary download, or shell command.
- Model prose, plan checkboxes, and client-claimed success cannot replace canonical approval, command, and file-verification records.
- A changed verification plan requires new approval. Each repair requires its own edit review.
- Rejected, interrupted, exhausted, cancelled, and failed work must remain visible; reload does not silently restart it.
- Existing databases, checkpoints, settings, and unrelated user edits must survive upgrades.
- Run one backend worker while task ownership and setup coordination use process-local registries.

## Next improvements

| Priority | Work | Completion evidence |
| --- | --- | --- |
| 1 | Improve model suitability and hardware guidance | Clear support checks and actionable low-memory errors across supported local servers, without invented download percentages. |
| 1 | Expand real-model evidence | Run the evaluation suite across more installed local models and hardware; investigate task failures separately from policy-control results. |
| 1 | Complete clean-OS installation evidence | Run the configured OS matrix and representative VMs, including actual runtime installation, missing prerequisites, and real download interruption. Fresh-copy tests on an existing host cover a narrower boundary. |
| 2 | Improve context precision and continuity | Add tokenizer-aware budgets and durable conversation compaction; measure navigation quality on representative large repositories. |
| 2 | Extend repository intelligence | Evaluate incremental local indexing beyond the current bounded fresh symbol/import hints, while preserving scoped guidance and excluded paths. |
| 2 | Extend editor integration | VS Code diagnostics and explicit multi-root ownership without weakening path or approval rules. |
| 3 | Add browser task review | Agent views and diff/approval interfaces backed by the same durable contracts and an explicit execution design. |
| 3 | Improve local operations | Clearer structured logs, request/body limits, backup management, checkpoint retention, and reproducible distributions. |

These are planned improvements, not promises of existing functionality. Cloud inference, remote machine execution, unattended approval, deployment/publishing, and model-controlled commits/pushes are outside the current product scope.

Use [Model evaluations](docs/model-evaluations.md), [Installation testing](docs/installation-testing.md), and [Repository context](docs/repository-context.md) for the implemented commands, evidence boundaries, and remaining limits.

## Validation expectations

Changes to shared contracts should exercise the backend and both clients. Use temporary databases and workspaces; do not test migration or mutation behavior on a user's project. Test model setup with controlled HTTP/process fixtures rather than downloading large weights during unit tests. A live local model smoke test is useful when available and must be reported separately from mocked tests.

Release checks include backend tests, browser tests and production build, extension type checks/tests/build/package, and a diff review for runtime data or credentials. See [Development](docs/development.md) for commands.
