# Getting started

The simplest setup uses Ollama. CodeMe can reuse a model already installed there or download its default coding model and show the download progress.

## Before you install

- Install Python 3.10 or newer. Python 3.12 is recommended.
- Install Node.js with npm for the first browser build. Use Node.js 24 LTS. Angular 21 also accepts Node.js 20.19+ or 22.12+ within those major versions. The installer rejects unsupported versions before installing dependencies.
- Install Git and ripgrep to enable repository status, diff, and code search.
- Allow enough disk space for the application dependencies and your model. Model weights may be several gigabytes. Loading a model also requires sufficient RAM and, when used, GPU memory.
- Install VS Code 1.90+ if you want reviewed edits and controlled test/build execution.

Run commands from the CodeMe repository root unless a step says otherwise. On a machine where Python is named `python3`, substitute that for `python`.

Use a supported Node major version even when a newer release is available; the installer checks compatibility before preparing dependencies.

## Install and launch

```console
python install.py
```

The installer:

1. Creates or reuses `.venv` and installs `requirements.txt`.
2. Copies `.env.example` to `.env` only when `.env` does not already exist.
3. Prepares Ollama when the Ollama provider is selected and no runtime is installed.
4. Installs browser dependencies and builds the Angular application.
5. Starts the backend and browser app, then opens the local app.

Runtime installation uses Windows `winget`, macOS Homebrew, or the official Ollama Linux installer. Your operating system may request permission or an administrator password. Python and Node/npm are prerequisites, rather than tools CodeMe installs silently.

Useful options:

| Command | Effect |
| --- | --- |
| `python install.py --no-launch` | Prepare dependencies and the browser build without starting services |
| `python install.py --skip-ollama` | Leave runtime installation to you |
| `python install.py --no-browser` | Install and start without opening a browser window |
| `python start.py` | Start an already installed copy |
| `python start.py --no-browser` | Start without opening the browser automatically |
| `python start.py --backend-only` | Start only the API, for example when using VS Code |

Keep the launcher terminal running. **Ctrl+C** stops the backend and browser processes it owns. It does not remove installed models or your database. The browser build is served locally; Node is needed for the initial build and development, not for serving that existing build on subsequent launches.

Default addresses:

- Browser: `http://127.0.0.1:4200`
- Backend API: `http://127.0.0.1:8000`
- Ollama: `http://127.0.0.1:11434`

## What happens to the model

With the default Ollama configuration, setup checks for an installed runtime and starts it if needed. It then looks for a suitable installed model: the configured model first, then coding/tool-capable alternatives, then other text-generation models. Embedding-only and reranking models are not selected for chat.

If no suitable model is present, CodeMe asks the local Ollama daemon to download `DEFAULT_MODEL`. The app shows the daemon's status, transferred bytes, and percentage when a layer has a known size. **The percentage is for the current download layer**, so it can reset when the next layer begins. Verification and loading stages may not have a percentage. CodeMe marks setup ready only after the model is available and a load check succeeds.

You can cancel preparation and retry later. Ollama keeps downloaded layers for reuse; cancellation does not promise immediate deletion or rollback of its cache. Starting setup from two clients does not intentionally create two downloads.

Setup chooses the model for the running backend; it does not overwrite `DEFAULT_MODEL` in `.env`. The next launch rediscovers installed models. To keep a particular preference, set `DEFAULT_MODEL` yourself. Set `AUTO_MODEL_SETUP=false` to stop automatic preparation; an explicit setup/retry action is still available.

LM Studio and llama.cpp users should follow [Configuration](configuration.md#another-local-model-server). CodeMe can discover and use an available model, but their common chat protocol has no universal model-download API.

## Use the browser

Wait for the model status to become ready, choose a local model if you want another available one, and send a message. Conversations are stored locally. Open **Workspace explorer** to register a local folder, inspect files, search code, or view Git changes.

The browser's repository tools are read-only. Use VS Code to approve and apply proposed edits or run project checks.

## Install the VS Code extension

Build the extension from the repository:

```console
cd vscode-extension
npm ci
npm run build
npm run package
```

In VS Code, open **Extensions**, choose **Install from VSIX...**, and select `personal-codeme-0.7.0.vsix`. Reload when prompted. Open the CodeMe Activity Bar view, or run **Personal Codeme: Open Chat** from the Command Palette.

Keep the backend running. You can use `python start.py --backend-only` from the repository root. The extension's backend setting defaults to `http://127.0.0.1:8000`.

Open a single project folder and choose **Agent** for coding tasks. Approve workspace registration when asked. Start with a concrete request such as “Inspect this repository and explain how its tests run,” then review any proposed change or command before approval. See the [extension guide](../vscode-extension/README.md) for checkpoints, verification, and settings.

## Manual setup

If you prefer managing dependencies and services directly, the Windows backend commands are:

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
Copy-Item .env.example .env
.\.venv\Scripts\python.exe -m uvicorn main:app --host 127.0.0.1 --port 8000 --workers 1
```

Only copy `.env.example` if you do not already have a `.env`. On macOS/Linux:

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
test -f .env || cp .env.example .env
.venv/bin/python -m uvicorn main:app --host 127.0.0.1 --port 8000 --workers 1
```

Install Ollama separately if needed; with automatic setup enabled, CodeMe handles the model download after the daemon is available. For a manual model download, run `ollama pull qwen2.5-coder:7b`. In another terminal:

```console
cd frontend
npm ci
npm start
```

Use one backend worker. To use a different backend port, keep the launch arguments, browser runtime config, extension setting, and approved browser origins consistent. See [Configuration](configuration.md).

## Updating an existing installation

Stop CodeMe, update the source, and rerun `python install.py`. Your existing `.env`, database, and Ollama weights are reused. Package and reinstall the extension after its source changes.

Backend startup applies schema upgrades automatically and creates a consistent SQLite backup before a pending upgrade of existing data. Keep your own backups too; see [Database migrations](../alembic/README.md). Never delete `codeme.db` just to make an upgrade succeed.
