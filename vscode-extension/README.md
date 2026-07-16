# Personal Codex VS Code Extension

This extension is a thin local client for the Personal Codex FastAPI backend.
It connects to the backend on localhost, provides a sidebar chat interface, and routes selected-code and workspace context to the backend.

## Setup

1. Install dependencies:
   ```bash
   cd vscode-extension
   npm install
   ```

2. Build the extension:
   ```bash
   npm run build
   ```

3. Launch the extension in VS Code with the debugger (F5).

## Packaging

Create a local VSIX package with:

```bash
npm run package
```

This generates `personal-codex-0.1.0.vsix` in the `vscode-extension` folder.

## Configuration

- `personalCodex.backendUrl` - local backend URL, default `http://127.0.0.1:8000`
- `personalCodex.defaultModel` - model requested by the extension
- `personalCodex.autoRegisterWorkspace` - ask before registering workspace folders
- `personalCodex.requireWriteApproval` - require approval for write/tool actions
- `personalCodex.showNotifications` - show status notifications

## Commands

- Personal Codex: Open Chat
- Personal Codex: New Chat
- Personal Codex: Explain Selected Code
- Personal Codex: Fix Selected Code
- Personal Codex: Refactor Selected Code
- Personal Codex: Generate Tests
- Personal Codex: Ask About Current File
- Personal Codex: Review Current Changes
- Personal Codex: Register Workspace
- Personal Codex: Check Backend Connection
- Personal Codex: Start Local Backend

## Troubleshooting

- Ensure the backend is running locally on `http://127.0.0.1:8000`.
- If the extension reports a connection failure, verify the backend health endpoint at `/health`.
- The extension does not execute shell commands or start the backend automatically.
