# CodeMe development plan

CodeMe is a local coding assistant with a FastAPI/SQLite backend, an Angular browser app, and a VS Code extension. The current implementation is the starting point for this plan. Detailed usage is in the [README](README.md); contributor commands are in [Development](docs/development.md).

## Delivered foundations

| Area | Current behavior |
| --- | --- |
| Local inference | Native Ollama and trusted loopback OpenAI-compatible servers; cloud aliases and remote endpoints are rejected. |
| First-run setup | Installation and launch scripts, automatic model discovery, installed-model reuse, Ollama downloads with progress, and model loading. |
| Browser | Conversation management, safe Markdown, streaming, model readiness, responsive chat, and a read-only workspace explorer. |
| Repository tools | Registered local roots, bounded reads/search/Git output, path protections, and root-to-folder `AGENTS.md` instructions. |
| Task controller | Durable goals, public plans, read-before-edit checks, review pauses, observed-result continuation, explicit resume/cancel, and bounded recovery. |
| Transactional editing | Versioned create/modify sets, complete-set review, base hashes, conflict checks, checkpoints, rollback, and guarded restore in VS Code. |
| Controlled commands | Typed profiles, independent policy validation, one-time approval, workspace-bound execution, output caps, timeout, and process cleanup. |
| Verification and repair | Immutable approved plans, required checks, current-file receipts, bounded failure feedback, reviewed repairs, and exact-plan reruns. |
| Persistence | Conversations and audit records in SQLite, foreign keys, automatic Alembic upgrades, and pre-upgrade backups. |

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
| 1 | Broaden first-install testing | Clean-machine checks for Windows/macOS/Linux, missing tools, interrupted downloads, reused models, and offline relaunch. |
| 2 | Improve context selection | Traceable relevant-file selection, tokenizer-aware budgets, and durable conversation compaction. |
| 2 | Add repository intelligence | Bounded symbol/index support that respects scoped guidance, excluded paths, and local-only storage. |
| 2 | Extend editor integration | VS Code diagnostics and explicit multi-root ownership without weakening path or approval rules. |
| 3 | Add browser task review | Agent views and diff/approval interfaces backed by the same durable contracts and an explicit execution design. |
| 3 | Improve local operations | Clearer structured logs, request/body limits, backup management, checkpoint retention, and reproducible distributions. |

These are planned improvements, not promises of existing functionality. Cloud inference, remote machine execution, unattended approval, deployment/publishing, and model-controlled commits/pushes are outside the current product scope.

## Validation expectations

Changes to shared contracts should exercise the backend and both clients. Use temporary databases and workspaces; do not test migration or mutation behavior on a user's project. Test model setup with controlled HTTP/process fixtures rather than downloading large weights during unit tests. A live local model smoke test is useful when available and must be reported separately from mocked tests.

Release checks include backend tests, browser tests and production build, extension type checks/tests/build/package, and a diff review for runtime data or credentials. See [Development](docs/development.md) for commands.
