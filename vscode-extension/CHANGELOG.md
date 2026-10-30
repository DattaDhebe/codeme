# CodeMe extension changelog

This changelog describes development source. The extension version is **0.7.0**; these notes do not imply a published VS Code Marketplace release.

## Unreleased

### Added

- Optional coding-model catalog with official source links, memory/download guidance, validation notes, and explicit download/use actions.
- Selected-model readiness handling, setup progress, cancellation, retry, and visible preference-save errors.
- Durable task plans, explicit resume/cancel, reviewed change sets, approved command profiles, and bounded verification/repair.
- Native editor smoke harness using an explicitly selected installed VS Code executable and isolated test state.
- CodeMe logo, application-facing names, and current repository/support metadata.

### Fixed

- Adopt Marked 18 token-based renderer hooks while retaining escaped HTML, restricted links, blocked images and synchronous rendering.
- Match the declared VS Code 1.90 API with floor-compatible type definitions.
- Update development tools and replace the retired packaging tool with `@vscode/vsce`; keep the VSIX limited to required bundles, assets and notices.
- Saved-file verification, LF/CRLF handling, nested file creation, and guarded rollback/restore.
- Unsaved-buffer and changed-file conflicts; newer user changes are preserved instead of silently overwritten.
- Bounded stream waits and stale-request handling.
- Model capability checks and continuation after rejected or interrupted actions.
- Model-catalog failures remain separate from backend connection state; passive readiness polling does not overwrite a later manual model choice.

### Compatibility and limits

- Extension identity `personal-codex-local.personal-codeme`, command IDs, and `personalCodex.*` settings remain for existing installations.
- Agent mode supports one workspace folder. Edits and commands still require review and approval.
- Local model quality varies; research recommendations are separate from actual CodeMe evaluations.
- The existing extension [MIT license](LICENSE) remains. It does not license the restricted main application.

See the [repository changelog](../CHANGELOG.md), [extension guide](README.md), and [application review](../docs/review-2026-10-30.md) for details.
