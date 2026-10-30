# CodeMe browser app

This Angular 18 app provides local chat, automatic model setup with progress, conversation management, and a read-only workspace explorer. It uses the same FastAPI backend as the VS Code extension.

For normal installation and launch, use `python install.py` and `python start.py` from the repository root. See [Getting started](../docs/getting-started.md).

## First launch

The app shows the backend's model setup state while CodeMe checks installed models, downloads missing Ollama weights when needed, and loads the chosen model. Download percentages describe the current layer; stages with no known byte total show a status instead. Ready models become available for chat without a manual integration step. Errors explain the next action and provide retry controls.

Automatic preparation can be disabled in the backend with `AUTO_MODEL_SETUP=false`. An explicit setup action remains available. Compatible local servers must have a model loaded through their own application; their common chat API does not define model installation.

## Development

From this folder:

```console
npm ci
npm start
```

The development app uses `http://127.0.0.1:4200`. Start the backend separately with one worker; see [Development](../docs/development.md).

```console
npm test -- --watch=false
npm run build
```

Tests need a headless Chrome-compatible browser. On Windows, Karma checks Chrome and Edge; set `CHROME_BIN` if needed. The production browser output is under `dist/frontend/browser/`. `start.py` serves the built browser app locally with a single-page application fallback. An optional Angular SSR server can also be built, but it is not the normal launcher path.

## Runtime configuration

`public/runtime-config.json` is loaded before browser startup:

```json
{
  "backendUrl": "http://127.0.0.1:8000",
  "defaultModel": "qwen2.5-coder:7b"
}
```

The backend URL must be HTTP(S) on a loopback host and contain no embedded credentials. `start.py` supplies the configured backend URL when serving its production browser app. For a separately served build, update the runtime file and approve that local browser origin in the backend's `CORS_ORIGINS`.

The legacy `allowRemoteBackend` key does not enable network access. The prepared backend model takes precedence over an unavailable default; an available explicit selection can still be used.

## Responsibilities

The browser streams Markdown replies, manages conversations, displays model readiness, and lets users register and inspect local workspaces. Generated Markdown passes through Angular sanitization and additional URL/element checks. SSE parsing handles fragmented frames and JSON payloads, and each stream owns its UI updates so stale responses do not appear in another conversation.

Repository tools here are read-only. Agent task review, transactional file application, checkpoints, controlled commands, and verification/repair are provided by the [VS Code extension](../vscode-extension/README.md).
