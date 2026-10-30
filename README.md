<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/brand/codeme-wordmark-dark.svg">
  <img src="docs/brand/codeme-wordmark-light.svg" alt="CodeMe" width="340">
</picture>

# CodeMe

A coding assistant that works with models and projects on your own computer. CodeMe includes a browser chat app and a VS Code extension for inspecting repositories, reviewing edits, running approved checks, and repairing failures.

Maintained by [DattaDhebe](https://github.com/DattaDhebe) under the DHEBE Studios brand. **Development version: 0.7.0.** The INR 499 one-time website package is published at [dhebe.com/products/codeme](https://www.dhebe.com/products/codeme/). A GitHub Release and Marketplace listing remain unpublished.

[Getting started](docs/getting-started.md) · [Documentation](docs/index.md) · [Report a bug](https://github.com/DattaDhebe/codeme/issues/new/choose) · [DHEBE Studios](https://www.dhebe.com/)

Inference uses **Ollama** or a trusted **local OpenAI-compatible server**, such as LM Studio or llama.cpp. No hosted model account or API key is required. Installing dependencies and downloading model weights requires an internet connection; prompts and code are sent to the local model server.

## Start here

These setup instructions are for authorized users and contributors with the maintainer's permission. See [Distribution and licensing](#distribution-and-licensing) before using or redistributing the main application.

You need Python 3.10+ and Node.js/npm for the initial installation. Python 3.12 and Node.js 24 LTS are recommended. The Angular 21 browser also supports Node.js 20.19+ and 22.12+ within those major versions. Git and ripgrep enable the repository tools.

Open a terminal in this repository and run:

```console
python install.py
```

The installer creates a Python environment, installs dependencies, builds the browser app, prepares Ollama when needed, and starts CodeMe. An operating-system installer may ask for permission. It preserves an existing `.env` and database.

On first launch, CodeMe checks the local model server. It reuses a suitable installed model when available. Otherwise, the Ollama setup downloads the configured model and shows real progress, then loads it for use. The default is `qwen2.5-coder:7b`; the download can be several gigabytes, and generation speed depends on your hardware.

For later launches:

```console
python start.py
```

Open [CodeMe in your browser](http://127.0.0.1:4200). Keep the launcher running and press **Ctrl+C** to stop its services. See [Getting started](docs/getting-started.md) for manual installation, installer options, and the VS Code setup.

## Choose how you work

| | Browser app | VS Code extension |
| --- | --- | --- |
| Local model setup and download progress | Yes | Yes |
| Streamed chat and conversation history | Yes | Yes |
| Browse files, search code, and inspect Git changes | Read-only explorer | Agent tools and attached editor context |
| Public task plan and resumable coding workflow | Chat and exploration | Yes, in Agent mode |
| Review and apply multi-file edits | Use the extension | Yes, with checkpoints and conflict checks |
| Run tests, builds, and lint | Use the extension | Yes, after approval |
| Verify a change and review a proposed repair | Use the extension | Yes |

For repository work, open one project folder in VS Code, install the extension, and choose **Agent**. CodeMe asks before registering a new workspace. The browser is useful for local chat and exploring registered projects.

## How a coding task works

1. **Inspect:** read the relevant files and scoped `AGENTS.md` guidance.
2. **Plan:** keep a short public plan and show the next action.
3. **Propose:** prepare a reviewable edit or a structured command.
4. **Approve:** you review the complete edit, command, or verification plan in VS Code.
5. **Observe and verify:** continue from recorded results, run approved checks, and propose a repair when necessary.

The model cannot approve its own changes or commands. Applying an edit does not automatically prove the task is complete. Completion depends on recorded checks and the actual file versions they verified. Task state survives reloads; interrupted execution does not silently restart.

CodeMe shows work summaries, tool results, and outcomes. Private model reasoning is discarded. Its effectiveness depends on the selected local model and the project; it does not claim identical intelligence or internal behavior to another coding agent.

## What is implemented

- Ollama and loopback OpenAI-compatible chat/tool transports, local model discovery, and automatic Ollama model preparation.
- A researched optional coding-model catalog with Hugging Face sources, download sizes, memory guidance, explicit selection, and installed-model reuse.
- Persistent conversations, workspaces, task plans, review decisions, command results, and verification history in SQLite.
- Workspace-bounded file reads, ranged previews, bounded ripgrep search, Git inspection, and scoped project instructions.
- Bounded, task-ranked repository navigation with file-selection reasons, symbol hints, and import links. Exact source reads remain required before editing.
- Transactional create/modify proposals with exact diffs, base hashes, dirty-editor checks, external checkpoints, rollback, and guarded restore.
- Approval-gated test/build/lint command profiles with independent extension policy checks, bounded output, timeout, and cancellation.
- Bounded verification and repair with exact-plan approval, sanitized failure evidence, separately reviewed repairs, and rerun limits.
- Automatic database upgrades with a consistent backup before upgrading an existing SQLite database.

The current limits include one VS Code workspace folder at a time, estimated rather than tokenizer-exact context budgets, and no web-based edit/command execution. File deletion/rename, unattended approvals, persistent repository indexing, and commit/push tools are outside the current workflow. The legacy `/generate` endpoint is a placeholder; normal chat and Agent endpoints perform real inference.

## Documentation

Start with the [documentation index](docs/index.md) for guides grouped by task.

| Need | Guide |
| --- | --- |
| Install, launch, and connect VS Code | [Getting started](docs/getting-started.md) |
| Choose a model or local server | [Configuration](docs/configuration.md) |
| Understand local storage, network use and deletion | [Privacy and local data](docs/privacy.md) |
| Choose and optionally download a researched coding model | [Coding model catalog](docs/coding-models.md) |
| Fix startup, download, or connection problems | [Troubleshooting](docs/troubleshooting.md) |
| Understand ownership, data, and API contracts | [Architecture](docs/architecture.md) |
| Develop, test, and package changes | [Development](docs/development.md) |
| Compare installed local models on repeatable tasks | [Model evaluations](docs/model-evaluations.md) |
| Test installation in an isolated fresh copy | [Installation testing](docs/installation-testing.md) |
| Understand relevant-file selection and its limits | [Repository context](docs/repository-context.md) |
| Review reliability fixes and remaining gaps | [Application review](docs/review-2026-10-30.md) |
| Read the earlier implementation report | [Implementation report](CURRENT_IMPLEMENTATION_REPORT.md) |
| See delivered capabilities and remaining work | [Development plan](PLAN.md) |
| Inspect database migrations | [Migration guide](alembic/README.md) |
| Build and review a customer distribution | [Release checklist](docs/release-checklist.md) |
| Use the logo and application identity | [Brand guide](docs/brand/README.md) |

These guides describe the current source. The [original implementation audit](docs/archive/implementation-audit-historical.md) is retained unchanged for historical reference; its readiness estimate and missing-feature list do not describe the current implementation.

## Contribute, get help, and report problems

Read [Contributing](CONTRIBUTING.md) before proposing changes and [Support](SUPPORT.md) for the right reporting route. Reproducible bug reports and focused pull requests are welcome. The [Code of conduct](CODE_OF_CONDUCT.md) applies to repository participation. Report security weaknesses using the private-first process in [Security](SECURITY.md), rather than publishing credentials or exploit details in an issue.

## Distribution and licensing

The main CodeMe application is restricted software, governed by [LICENSE](LICENSE). Public source visibility is not a general redistribution grant. The existing VS Code extension retains its [MIT license](vscode-extension/LICENSE); dependencies and model weights keep their own terms. [NOTICE](NOTICE) explains these boundaries.

The DHEBE Studios product is a **₹499 one-time packaged download**, published with production Cashfree checkout and protected delivery. Server configuration and unpaid-download rejection were verified; a real customer purchase has not been tested. See [deployment verification](web-product/DEPLOYMENT.md). This repository does not include model weights, a standalone Windows executable, or bundled Python/Node/Ollama runtimes.
