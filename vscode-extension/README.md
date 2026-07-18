# Personal Codeme for VS Code

Personal Codeme is a local-first, Copilot-style coding assistant powered by Ollama. It connects the VS Code sidebar to the Personal Codeme FastAPI backend and the locally installed `qwen2.5-coder:7b` model.

## Features

- Streaming chat with reusable conversation history
- Search, rename, reopen, and delete conversations
- Attach the current selection, active file, or Git diff as context
- Editor commands for explain, fix, refactor, tests, file questions, and change review
- Markdown and syntax-highlighted code responses
- Copy, open, or apply generated code from any code block
- Explicit approval before generated code modifies the editor
- Installed Ollama model selector and live backend/model status
- Stop generation, retry prompts, and persistent sidebar state
- Workspace registration and local repository context

## Setup

1. Install backend dependencies from the repository root:

   ```powershell
   .\.venv\Scripts\python.exe -m pip install -r requirements.txt
   ```

2. Ensure Ollama is running with the configured model:

   ```powershell
   ollama list
   ```

3. Start the backend:

   ```powershell
   .\.venv\Scripts\python.exe -m uvicorn main:app --host 127.0.0.1 --port 8000
   ```

4. Build or package the extension:

   ```powershell
   cd vscode-extension
   npm install
   npm run build
   npm run package
   ```

The package command generates `personal-codeme-0.2.0.vsix`.

## Configuration

- `personalCodex.backendUrl` — backend URL, default `http://127.0.0.1:8000`
- `personalCodex.defaultModel` — default Ollama model, `qwen2.5-coder:7b`
- `personalCodex.requireWriteApproval` — confirm before applying generated code
- `personalCodex.showNotifications` — show connection and workspace notifications

## Commands

- Personal Codeme: Open Chat
- Personal Codeme: New Chat
- Personal Codeme: Explain Selected Code
- Personal Codeme: Fix Selected Code
- Personal Codeme: Refactor Selected Code
- Personal Codeme: Generate Tests
- Personal Codeme: Ask About Current File
- Personal Codeme: Review Current Changes
- Personal Codeme: Register Workspace
- Personal Codeme: Check Backend Connection
- Personal Codeme: Start Local Backend

## Troubleshooting

- Backend readiness: `http://127.0.0.1:8000/api/health`
- Ollama inventory: `http://127.0.0.1:11434/api/tags`
- Reload VS Code after installing a new VSIX version.
