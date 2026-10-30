# Contributing to CodeMe

Start with the [README](README.md), [architecture](docs/architecture.md), and the guidance in [.github/copilot-instructions.md](.github/copilot-instructions.md). CodeMe is maintained by [DattaDhebe](https://github.com/DattaDhebe). Its main application is governed by the [restricted license](LICENSE); the existing extension and third-party components retain the terms described in [NOTICE](NOTICE).

## Before changing code

For a bug, check existing [issues](https://github.com/DattaDhebe/codeme/issues) and provide a minimal reproduction. For a substantial feature or shared-contract change, describe the user problem and proposed scope before building a large implementation. Do not post security weaknesses, credentials, private repository source, conversation databases, or unredacted logs in public issues; use [SECURITY.md](SECURITY.md).

Create a focused branch and keep unrelated changes out of the pull request. Include only work you have permission to share. Confirm licensing with the maintainer before contributing material with unclear or incompatible terms; do not replace existing notices or assume a repository-wide MIT grant.

The main application's development setup also requires the maintainer's permission under its restricted license. Public source visibility and the extension's MIT license do not establish authorization to use the other components.

## Development setup

Use Python 3.10+ and a supported Node/npm version; Python 3.12 and Node 24 LTS are recommended. Git and ripgrep enable their corresponding repository tools. From the root:

```console
python install.py --no-launch
```

Use `--skip-ollama` if you manage the local runtime yourself. Installing dependencies and model weights can use the network. Ordinary unit tests must use controlled clients and temporary state rather than download models or alter a user's project. See [Development](docs/development.md) for manual setup and client-specific commands.

## Preserve the application contract

- Keep inference on the configured loopback model server. Do not add hosted fallback or let model output choose a download URL or executable.
- Keep backend workspace tools read-only. The VS Code extension owns transactional source writes and approved project commands.
- Treat source, model output, and command results as untrusted input. Preserve path checks, scoped instructions, source hashes, output bounds, and read-before-edit evidence.
- Keep durable task completion in canonical action and verification records. A model's claim or plan checkbox cannot prove that a change was applied or checked.
- Keep automatic runtime/model setup separate from project command execution. Catalog downloads require a reviewed ID; listing the catalog must not pull weights.
- Preserve configuration, conversations, checkpoints, and unrelated user edits. Add a migration for schema changes; do not rewrite historical migrations.

## Validate the changed behavior

Run the checks relevant to the change and record their actual result. Mark a check not run rather than implying it passed. Backend work usually uses:

```powershell
.\.venv\Scripts\python.exe -B -m pytest codeme_agent/tests
```

On macOS/Linux, use `.venv/bin/python`. Browser changes need relevant tests and `npm run build` in `frontend/`. Extension changes need `npm run typecheck`, relevant tests, `npm run build`, and a package check in `vscode-extension/`. Shared API changes need both clients considered. Native editor, live-model, and clean-install evidence are separate from mocked tests; see the [validation commands](docs/development.md#validate-changes).

Rebuild tracked extension `dist/` assets after changing their source. Do not commit `.env`, databases, `.runtime/`, model weights, caches, dependency directories, generated VSIX/ZIP files, or private checkout data.

## Submit a pull request

Explain the concrete problem and resulting behavior. Include relevant validation, limitations, and documentation updates. Use a small example when it makes a contract change easier to review. The PR template is a guide, not a claim that every test must run for every change.

Before submitting:

```console
git diff --check
git status --short
```

Follow the [Code of conduct](CODE_OF_CONDUCT.md). There is no guaranteed review or support response time.
