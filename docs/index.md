# CodeMe documentation

CodeMe has a local Python backend, a browser client for chat and read-only exploration, and a VS Code client for reviewed coding work. Choose the guide for the job you want to do.

## Install and use

| Task | Guide |
| --- | --- |
| Install, start, and connect the extension | [Getting started](getting-started.md) |
| Choose a local runtime, model, or configuration | [Configuration](configuration.md) |
| Understand local data and network use | [Privacy and local data](privacy.md) |
| Compare the optional download choices | [Coding models](coding-models.md) |
| Resolve startup, download, or workspace problems | [Troubleshooting](troubleshooting.md) |
| Use reviewed editing and approved checks in VS Code | [Extension guide](../vscode-extension/README.md) |

## Understand behavior and limits

| Topic | Guide |
| --- | --- |
| Components, local transport, ownership, and APIs | [Architecture](architecture.md) |
| How relevant files and symbols are selected | [Repository context](repository-context.md) |
| What the application review actually verified | [30 October 2026 review](review-2026-10-30.md) |
| Delivered foundations and future work | [Development plan](../PLAN.md) |
| Database upgrades and migration history | [Migration guide](../alembic/README.md) |

The browser does not apply source edits or run project commands. The extension requires review and records approvals, command results, checkpoints, and verification. Tool support metadata does not prove model coding quality. Only Qwen 2.5 Coder 7B has a recorded local CodeMe evaluation in this repository's current review; other catalog entries remain research candidates.

## Develop, evaluate, and release

| Task | Guide |
| --- | --- |
| Set up development and run appropriate checks | [Development](development.md) |
| Submit a focused change | [Contributing](../CONTRIBUTING.md) |
| Evaluate installed models using disposable tasks | [Model evaluations](model-evaluations.md) |
| Exercise a fresh-copy installation | [Installation testing](installation-testing.md) |
| Build and review a customer ZIP | [Release checklist](release-checklist.md) |
| Use the CodeMe logo and colors | [Brand guide](brand/README.md) |

Repository validation is configured in [CI](../.github/workflows/ci.yml). Monthly dependency update proposals are configured in [Dependabot](../.github/dependabot.yml). These definitions are not evidence of a successful remote run or an accepted dependency update.

## Project policies and status

- [Support](../SUPPORT.md): installation questions, reproducible problems, and contact routes.
- [Security](../SECURITY.md): private-first reporting and the boundaries that reports should describe.
- [Code of conduct](../CODE_OF_CONDUCT.md): expectations for repository participation.
- [Changelog](../CHANGELOG.md): development changes without implying a published release.
- [LICENSE](../LICENSE) and [NOTICE](../NOTICE): main-application restrictions and separately licensed components.

The source version is **0.7.0**. A release artifact generated locally is not a public release. The planned **₹499** website product and Cashfree-protected download are not live yet. No Marketplace publication or successful real customer payment is established by these guides.

Historical material is kept under [the archive](archive/README.md). Historical readiness scores and missing-feature lists should not be treated as the current behavior specification.
