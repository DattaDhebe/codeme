# Configuration

CodeMe reads backend settings from environment variables and the repository's `.env` file. The installer creates `.env` from [`.env.example`](../.env.example) only if it is missing. Restart the backend after changing these settings. Unknown `.env` keys are rejected, so use supported names rather than adding arbitrary application settings.

## Ollama: the default

```dotenv
MODEL_PROVIDER=ollama
OLLAMA_URL=http://127.0.0.1:11434
DEFAULT_MODEL=qwen2.5-coder:7b
AUTO_MODEL_SETUP=true
OLLAMA_CONTEXT_LENGTH=8192
```

CodeMe automatically checks for local models, reuses a suitable one, or downloads the configured default when none is suitable. It loads the selected model before showing ready. See [Getting started](getting-started.md#what-happens-to-the-model) for the selection and progress behavior.

To choose another freely downloadable model, open **Coding models** in the browser or **Choose coding models** in VS Code. The [researched catalog](coding-models.md) includes official Hugging Face sources, approximate download sizes, memory guidance, and local evaluation limits. **Download and use** prepares exactly that choice through Ollama, with progress, cancel and retry. Merely opening the catalog downloads nothing. Successful explicit choices are remembered locally without rewriting `.env`; an external `DEFAULT_MODEL` change takes precedence.

Ready means the model can load for chat. The extension checks tool support separately before Agent tasks. A known chat-only model stays available in Ask mode; unknown support is shown as unverified. Capability metadata is a compatibility hint, not a benchmark or a guarantee that a small model will complete a complex task.

`AUTO_MODEL_SETUP=false` stops automatic startup/client preparation. You can still explicitly start/retry setup. This is useful when you manage downloads yourself or want to inspect configuration before allowing a download.

`DEFAULT_MODEL` is a preference, not proof that weights exist. Setup may choose an installed alternative and use it for the current backend process. The `.env` value is not silently rewritten. To request a smaller or different model, change the preference and restart; review its model requirements and tool support before using Agent mode.

`OLLAMA_CONTEXT_LENGTH` is sent as `num_ctx` and defaults to 8192. Larger context windows can require more memory. For a daemon dedicated to local-only use, run it with `OLLAMA_NO_CLOUD=1`; an already-running service must be restarted with that setting. CodeMe rejects cloud aliases and entries without verifiable local-weight metadata before sending prompts.

## Another local model server

For LM Studio or llama.cpp:

```dotenv
MODEL_PROVIDER=openai_compatible
LOCAL_MODEL_URL=http://127.0.0.1:1234/v1
DEFAULT_MODEL=your-exact-local-model-id
```

Start the server with a locally loaded text-generation model and use its actual loopback port. CodeMe queries `/v1/models`, selects an available local model, and uses `/v1/chat/completions`. Agent work also requires the model/server to support tool calls. A model that can chat is not necessarily reliable at repository tools.

The shared compatible API does not define model download or runtime installation. Install/load weights through that application's own controls. CodeMe's setup status explains when no model or server is available; it does not switch providers or download an Ollama model behind that configuration.

Use a trusted daemon with remote connectors disabled. A compatible inventory cannot prove that a local proxy will not forward prompts elsewhere. CodeMe rejects affirmative remote/cloud metadata, bypasses environment proxies, refuses redirects, and expects a loopback server without API-key authentication. No hosted OpenAI account is involved.

## Backend settings

| Name | Default | Purpose |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Local backend bind address; must be loopback |
| `PORT` | `8000` | Backend port |
| `CORS_ORIGINS` | Local browser URLs on port 4200 | JSON array of approved local browser origins |
| `DATABASE_URL` | `sqlite:///./codeme.db` | Conversation and audit database |
| `MODEL_PROVIDER` | `ollama` | `ollama` or `openai_compatible` |
| `OLLAMA_URL` | `http://127.0.0.1:11434` | Local Ollama API |
| `LOCAL_MODEL_URL` | `http://127.0.0.1:1234/v1` | Compatible local API |
| `DEFAULT_MODEL` | `qwen2.5-coder:7b` | Preferred model; also the Ollama download target when needed |
| `AUTO_MODEL_SETUP` | `true` | Allow automatic preparation on startup |
| `OLLAMA_CONTEXT_LENGTH` | `8192` | Ollama context window and context budgeting guidance |
| `AGENT_MAX_CYCLES` | `8` | Maximum task continuation cycles |
| `AGENT_TIME_BUDGET_SECONDS` | `900` | Active model-time budget, excluding waits for review |
| `DEFAULT_WORKSPACE_ROOT` | `.` | Default workspace-root setting; explicit registration still applies |
| `ALLOW_UNC_PATHS` | `false` | Must remain false; network shares are unsupported |
| `MAX_FILE_SIZE` | `1500000` | Maximum file size accepted by workspace tools |

Context/history budgets are conservative character estimates, not exact tokenizer counts. Per-cycle tool, time, and repeated-failure limits also apply. Verification has separate reviewed plan/session limits.

The application accepts loopback peers, validates Host, and checks browser Origin before local API actions. Adding a local browser development port requires updating `CORS_ORIGINS`. Remote bind/model endpoints and UNC workspaces are rejected.

## Browser settings

The browser loads `frontend/public/runtime-config.json` before startup:

```json
{
  "backendUrl": "http://127.0.0.1:8000",
  "defaultModel": "qwen2.5-coder:7b"
}
```

`backendUrl` must be an HTTP(S) loopback URL without credentials. The app uses the backend's prepared model when ready and preserves an available explicit selection. This file is the default served runtime configuration; `start.py` supplies the launched backend URL to its served browser app. For a separate browser deployment, keep its runtime file and backend origins consistent.

The old `allowRemoteBackend` key does not enable remote access. The browser can chat and inspect workspaces but does not apply edits or execute commands.

## VS Code settings

The extension retains the existing `personalCodex.*` configuration names for compatibility. Start with `personalCodex.backendUrl` and, if desired, `personalCodex.defaultModel`. Only loopback backends are accepted.

Project registration requires consent. Executable profile settings and a custom executable allowlist are user-owned configuration; model output and repository instructions cannot populate them. Write/command approval cannot be bypassed by enabling the deprecated unsafe-command setting. See the [extension settings guide](../vscode-extension/README.md#settings).

## Where local data lives

| Data | Location |
| --- | --- |
| Conversations, registered paths, tasks, and audit records | Configured SQLite database, normally `codeme.db` |
| Pre-upgrade SQLite backups and setup/runtime logs | `.runtime/` |
| Model weights and downloaded layers | Ollama's own model storage |
| Applied-edit checkpoints | VS Code extension global storage, outside the project |
| Backend configuration | `.env` and environment variables |

Protect database/backups like project data: conversations and tool records can contain source snippets. Deleting a chat removes its associated database records when no active execution blocks deletion; it does not uninstall model weights or promise removal of external checkpoints.
