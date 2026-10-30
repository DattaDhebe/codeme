# CodeMe for VS Code

The repository-aware client for CodeMe's local backend, maintained by [DattaDhebe](https://github.com/DattaDhebe) under the DHEBE Studios brand. Ask questions about code or use Agent mode to inspect a project, review proposed changes, run approved checks, and continue from the results.

The source version is **0.7.0**. Install a locally built VSIX as described below; a public Marketplace listing is not claimed. The existing extension identifier `personal-codex-local.personal-codeme` and `personalCodex.*` configuration/command names remain for compatibility. User-facing branding is CodeMe.

## Install and connect

Prepare CodeMe from the repository root:

```console
python install.py --no-launch
python start.py --backend-only
```

In another terminal, build the extension:

Use **Node.js 24 LTS** for development and packaging. The development tools require Node `^22.12.0 || ^24.0.0 || >=26.0.0`. This build requirement does not change the installed extension's VS Code 1.90 compatibility floor; its host bundle still targets Node 18, and the Markdown library is bundled into the webview.

```console
cd vscode-extension
npm ci
npm run build
npm run package
```

In VS Code, use **Extensions > Install from VSIX...** and select `personal-codeme-0.7.0.vsix`. Reload when prompted. Open the CodeMe Activity Bar view or run **CodeMe: Open Chat**.

The default backend is `http://127.0.0.1:8000`. The sidebar displays automatic model preparation and actual download progress. An installed model is reused; missing Ollama weights are downloaded through the local daemon when setup is enabled. A compatible local server must already have a model loaded. See [Getting started](../docs/getting-started.md) and [Configuration](../docs/configuration.md).

Use **Choose coding models** in the toolbar to browse the optional researched catalog. Each entry links its official Hugging Face/Ollama sources and explains its approximate download size, memory guidance, and local validation status. **Download and use** prepares exactly your choice; it does not download the entire list. The normal setup card shows progress and supports cancel/retry. Other local servers keep their own model installation controls. See [Coding models](../docs/coding-models.md).

## Work with a project

Open one folder in VS Code. Use **Ask** for conversation and attached selection/file/Git context. Choose **Agent** for repository inspection and coding tasks. CodeMe requests consent before registering a new workspace; existing backend registrations are reused.

A coding task follows this flow:

1. Inspect relevant files and scoped `AGENTS.md` instructions.
2. Maintain a short public plan.
3. Propose an exact edit or structured command and pause for review.
4. Apply/run only after approval, then continue from durable recorded results.
5. Review a verification plan; inspect any failure and separately approve a proposed repair.

The task's goal, plan, review state, and bounded result history survive reloads. Resume/cancel controls make interrupted work explicit. Reload never silently restarts a missing process. Stop cancels the task and its tracked command/verification processes; an in-flight local model request may take until its bounded request returns to finish backend cleanup.

## Review edits and restore

Change sets contain complete create/modify proposals with exact diffs and base hashes. Preview the whole set before approval. Immediately before applying, the extension checks real paths, unsaved documents, and current hashes. One `WorkspaceEdit` applies the set; result hashes are checked and failure triggers best-effort rollback.

Every successful application has a checkpoint in VS Code extension global storage, outside your source tree. **Restore** only succeeds while current files still match that set's applied hashes; newer user edits cause a conflict instead of being overwritten. Checkpoints survive reloads and are not automatically pruned. Remove old extension storage only when its restore history is no longer needed.

File deletion and rename are not supported proposal operations. Model Markdown is inert display content and cannot inject UI actions. Legacy whole-file proposals use the same transactional pipeline.

## Run approved checks

Commands use typed profiles for tests, builds, lint, read-only Git, Python modules, and explicitly user-allowlisted executables. The model provides literal arguments and a relative working directory. The extension independently resolves the executable, checks policy and the exact registered workspace, calculates risk, and asks for **Run once** approval.

The runner uses bounded separate stdout/stderr, filtered environments, timeouts, cancellation, and process-tree cleanup. Raw model shell strings remain display-only. Scripts in your own project can have side effects, so review the proposed check and its working directory before approval.

Verification displays the whole Quick or Full plan with its exact steps, limits, and fingerprint. Approval covers only those steps and bounded reruns; changing the plan requires new approval. Applying an edit is not a passing check. Completion depends on required passing checks and file hashes captured before they ran.

Failures become bounded, redacted, explicitly untrusted feedback for local repair mode. Repair mode can inspect and propose a focused edit; it cannot run commands or alter tests to hide a failure. Each repair requires the normal preview/approval/checkpoint flow. Identical failures, equivalent repairs, rejected actions, and exhausted limits remain visible instead of being reported as success.

## Settings

Existing `personalCodex.*` names remain for compatibility:

| Setting | Purpose |
| --- | --- |
| `backendUrl` | Loopback backend URL; default `http://127.0.0.1:8000` |
| `defaultModel` | Preferred local model; default `qwen2.5-coder:7b` |
| `autoRegisterWorkspace` | Whether initialization may request registration; defaults to false |
| `requireWriteApproval` | Retains approval for legacy editor actions |
| `enableUnsafeCommandExecution` | Deprecated; does not enable raw commands or bypass policy |
| `pythonExecutable`, `npmExecutable`, `dotnetExecutable`, `mavenExecutable`, `gradleExecutable`, `gitExecutable` | User-owned executable settings for fixed profiles |
| `customExecutableAllowlist` | Explicit alias-to-executable map, empty by default |
| `commandOutputLimitBytes` | Sidebar output cap: default 1 MB, hard maximum 4 MB |
| `commandTailLimitBytes` | Persisted per-stream tail: default/hard maximum 64 KB |
| `verificationMaximumRepairAttempts` | Default/hard maximum 2 |
| `verificationMaximumReruns` | Default/hard maximum 2 |
| `verificationTimeBudgetSeconds` | Default 600, hard maximum 1200 |
| `showNotifications` | Connection and workspace notifications |

Agent mode supports one workspace folder. Explicit attached editor context is bounded to 175,000 characters; select less code if it exceeds the limit. Repository content cannot add executable allowlist entries or approve actions.

The extension does not provide unattended approval, package installation through agent commands, network verification, commits/pushes, or multi-root execution. Model/runtime installation is handled separately by CodeMe setup.

## Development checks

```console
npm run typecheck
npm test
npm run build
npm run package
```

Vitest uses a VS Code stub. Live-backend and native extension-host checks have separate opt-in/environment requirements. See [Development](../docs/development.md) for shared-contract validation and [Troubleshooting](../docs/troubleshooting.md) for connection, model, conflict, and migration problems.

## Support and license

Use the repository's [support](../SUPPORT.md), [security](../SECURITY.md), and [contribution](../CONTRIBUTING.md) guides. Do not attach credentials, conversation databases, private source, or purchase records to public reports.

This extension retains its [MIT license](LICENSE). The main CodeMe application's restricted terms and separately licensed dependencies/models are described in [the root LICENSE](../LICENSE) and [NOTICE](../NOTICE); the extension license is not a blanket license for the entire repository.
