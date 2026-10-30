# Changelog

This file records notable development changes. **Unreleased** means changes in the source tree, not a published binary, Marketplace listing, or active paid product. The current application version is **0.7.0**.

## Unreleased

### Added

- Optional researched coding-model catalog with official Hugging Face/Ollama sources, license and memory guidance, explicit selection, progress, cancellation, retry, and installed-model reuse.
- A locally remembered model choice that respects an externally changed configured default.
- Bounded task-ranked repository navigation with symbol/import hints, traceable relevance, ignore/private-path exclusions, and explicit partial-map notices.
- Installed-model evaluation CLI with disposable fixtures, correctness oracles, separate quality/recovery/control results, configuration/source provenance, and bounded inference.
- Fresh-copy installation, upgrade, and relaunch harness plus a manual Windows/macOS/Linux workflow.
- Reproducible customer ZIP tooling, integrity manifests, prerequisite instructions, and private-state exclusions.
- CodeMe brand assets, documentation navigation, contribution/support/security/conduct policies, and issue/PR templates.

### Changed

- Browser stack to Angular 21 with static serving; removed the unused SSR/Express path.
- Local model readiness now distinguishes advertised tool support from successful chat setup.
- Browser and extension connection/stream handling uses bounded waits and clearer request ownership.
- Application-facing identity and repository links use CodeMe while existing extension command/configuration identifiers remain compatible.

### Fixed

- Source-read evidence must actually reach a model turn before it can justify an edit; partial reads cannot authorize whole-file replacement.
- Transactional editor saves verify on-disk content, preserve supported line endings, handle nested creates, and guard rollback/restore against newer changes.
- Original tasks remain intact when context is compacted; oversized tasks fail explicitly rather than silently losing requirements.
- Proposal validation identifies the operation and field without echoing invalid source values.
- Windows launcher cleanup handles owned backend children, and installation checks require distinct server instances with closed ports across relaunch.

### Known limits

- The browser remains a chat and read-only explorer; approved edits and commands use the VS Code extension.
- The latest recorded Qwen 2.5 Coder 7B evaluation passed five of six coding tasks. Multi-file execution remained blocked. Other catalog models are research candidates, not locally validated equivalents.
- Fresh-copy Windows evidence does not establish a clean OS/GPU installation; remote OS matrix runs and broader hardware coverage remain pending.
- The proposed ₹499 Cashfree product and paid-download gate are not live. No successful real purchase is claimed.

## Recorded source milestones

- `ec6d2f4`: hardened local workflow, client reliability, repository context, evaluation tooling, and installation checks.
- `69a5671`: stopped tracking generated Python caches.
- `b084a21`: automated local model setup and refreshed documentation.
- `d6eb6a8`: added the durable local coding workflow and client improvements.

These are Git history references, not release dates or tags. See the [application review](docs/review-2026-10-30.md) for dated evidence and [PLAN.md](PLAN.md) for future work.
