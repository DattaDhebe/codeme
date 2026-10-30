# Privacy and local data

This guide describes the CodeMe application in this repository. The DHEBE Studios website, payment provider, VS Code, model runtime and package registries are separate services with their own policies. The planned paid website download is not live yet.

## Where your work goes

CodeMe sends chat messages, attached editor context, selected source excerpts and relevant tool results to the configured **loopback model server** on your computer. Supported endpoints are restricted to localhost or loopback addresses. Known cloud model aliases are rejected. Use a trusted local runtime serving local weights; CodeMe cannot audit the internals of an independently managed compatible server.

Repository tools stay inside registered local roots and apply private-path exclusions. The model receives only the evidence supplied by those tools and your attachments, rather than an automatic copy of the whole repository. Navigation hints do not authorize file edits. The extension requires separate approval for changes and project commands.

Private reasoning blocks are discarded by the model-response handling. That does not make conversation history empty: visible responses, plans, source excerpts, action proposals and recorded results can still contain project information.

## What is stored

| Data | Default location |
| --- | --- |
| Conversations, workspace paths, task state and action records | SQLite database, normally `codeme.db` |
| Database upgrade backups and runtime/setup logs | Application `.runtime/` directory |
| Browser drafts and client preferences | Browser storage for the local application origin |
| Extension view state and edit checkpoints | VS Code extension storage; checkpoints are outside the edited project |
| Model weights and cached download layers | Your runtime's model storage |
| Explicit catalog preference | Application `.runtime/model-choice.json`, containing an allowlisted model ID and a configuration fingerprint |

CodeMe does not provide application-level encryption for these local files. Your operating-system account, disk protection and backup settings control access. Treat conversations, logs, backups and checkpoints as potentially containing source or other project information.

Deleting a conversation removes its associated database records when no active work blocks deletion. It does not uninstall model weights, erase independent backups, or promise deletion of external editor checkpoints. Stop the application before maintaining its database or backups. See [Configuration](configuration.md#where-local-data-lives) and [Troubleshooting](troubleshooting.md).

## When internet access is used

Initial installation downloads Python/npm dependencies and may install a local runtime. Automatic setup or an explicit catalog choice may download weights through Ollama. These are software/model downloads; they do not require sending a coding prompt with the pull request. Viewing an official model card or a repository/support link opens an external site at your request.

The current CodeMe clients do not include a built-in usage analytics or advertising integration. This statement does not cover telemetry or network activity implemented by VS Code, a model runtime, installed dependencies, browser extensions or a project's own approved scripts.

## Reports and support

The evaluation suite uses synthetic repositories. Installation tests use isolated application copies and controlled model-protocol fixtures. Reports and customer packages exclude application secrets, user databases and model weights, but review any files before you share them.

For a bug report, include versions and a minimal reproduction. Remove credentials, private source, customer data, local paths and conversation contents that are not necessary. Use [Support](../SUPPORT.md) for ordinary issues and [Security](../SECURITY.md) for sensitive reports. Never place payment secrets or model-server credentials in a GitHub issue.
