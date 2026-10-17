<h1 align="center">Codeme</h1>
<p align="center"><strong>A local AI coding assistant with your workspace in context.</strong><br>FastAPI · Ollama · Angular · VS Code</p>
<p align="center"><a href="#getting-started">Get started</a> · <a href="vscode-extension/README.md">VS Code extension</a> · <a href="#project-structure">Explore the code</a></p>

Codeme connects local language models to a repository-aware development workflow. Use streaming conversations, attach code and Git context, and review proposed file changes or terminal commands before they run.

## What you can explore

- **Local model workflow:** Ollama integration with the default `qwen2.5-coder:7b` model.
- **Workspace context:** repository browsing, ripgrep search, file previews, Git status and diffs.
- **Persistent conversations:** a FastAPI backend with SQLite and SQLAlchemy.
- **Two interfaces:** an Angular web client and a Copilot-style VS Code sidebar.
- **Ask and Agent modes:** focused code questions or workspace tools with visible activity.
- **Explicit control:** file writes and terminal commands require approval in VS Code.

**Status:** personal development project. Capabilities and setup are documented in the source and [extension guide](vscode-extension/README.md); this is not a hosted service or an official OpenAI product.

## Getting started

Use a Python environment compatible with [requirements.txt](requirements.txt), Node.js/npm compatible with Angular 18, and a local Ollama installation. Repository search also requires `rg` on your PATH.

### 1. Prepare the backend

Run from the repository root:

```bash
python -m venv .venv
```

Activate with `source .venv/bin/activate` on Linux/macOS or `.\.venv\Scripts\Activate.ps1` in PowerShell, then:

```bash
python -m pip install -r requirements.txt
```

Use [.env.example](.env.example) for optional configuration. The backend defaults to SQLite in `codeme.db` and Ollama at `http://127.0.0.1:11434`.

### 2. Prepare the model

```bash
ollama pull qwen2.5-coder:7b
```

Ensure the Ollama service is running. Local inference speed depends on the available model, memory and hardware.

### 3. Start the API and web client

From the repository root:

```bash
python -m uvicorn main:app --host 127.0.0.1 --port 8000 --reload
```

In a second terminal:

```bash
cd frontend
npm install
npm start
```

Open `http://localhost:4200`. API documentation is at `http://127.0.0.1:8000/docs`.

| Check | URL |
| --- | --- |
| API process | `http://127.0.0.1:8000/health` |
| Ollama/model readiness | `http://127.0.0.1:8000/api/health` |
| Application API | `http://127.0.0.1:8000/api` |

### 4. Use the VS Code extension

See the [extension setup, commands and configuration](vscode-extension/README.md). Its build and packaging scripts live in [vscode-extension/package.json](vscode-extension/package.json).

## Project structure

| Location | Purpose |
| --- | --- |
| [main.py](main.py) | FastAPI application, lifecycle and health endpoints |
| [codeme_agent](codeme_agent) | Model client, workspace tools, API routes and persistence |
| [frontend](frontend) | Angular web interface |
| [vscode-extension](vscode-extension) | VS Code sidebar, editor commands and agent UI |
| [codeme_agent/tests](codeme_agent/tests) | Backend test suite |

## Development checks

```bash
python -m pytest codeme_agent/tests
```

Frontend build: `npm run build` inside `frontend`. Extension checks: `npm run typecheck` and `npm test` inside `vscode-extension`.

These are available developer checks, not a claim that every environment has been validated.

## Design priorities

Keep model execution local, ground answers in repository evidence, make tool activity visible, and keep human approval between a proposal and a consequential workspace action.
