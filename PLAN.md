# Personal Codex Implementation Plan

## Overview
Personal Codex is a local-first coding assistant with a ChatGPT-style web UI and Ollama-powered model execution. This plan covers Phase 1 only, targeting the minimal viable backend and frontend foundations required to support local Ollama chat streaming and persisted conversations.

## Goals for Phase 1
- Establish backend architecture with FastAPI, SQLite, SQLAlchemy 2, Alembic, Pydantic v2, and Ollama client integration.
- Build conversation persistence and streaming chat API.
- Create a basic Angular 18+ frontend with a chat UI, conversation sidebar, settings placeholder, dark/light themes, markdown rendering, syntax-highlighted code blocks, and streaming assistant output.
- Ensure backend and frontend can run locally without cloud services.
- Produce documentation and setup artifacts for Phase 1.

## Phase 1 Scope
### Backend
1. Backend project structure
   - `backend/` with Python 3.12 target support
   - `backend/app/` package container
   - `backend/app/main.py` FastAPI app
   - `backend/app/config.py` configuration management
   - `backend/app/db/` SQLAlchemy models, session, migrations setup
   - `backend/app/schemas/` Pydantic request/response models
   - `backend/app/routers/` conversation and chat endpoints
   - `backend/app/ollama.py` Ollama HTTP client integration
   - `backend/app/services/` conversation service layer
   - `backend/app/tests/` pytest tests
2. Database and persistence
   - SQLite database bound to backend root
   - SQLAlchemy 2 ORM models for Conversation, Message
   - Alembic migration skeleton and initial migration
3. Ollama local client
   - Use the local Ollama HTTP API endpoint at `http://127.0.0.1:11434` by default
   - Default model `qwen2.5-coder:7b`
   - Chat flow integration using streaming via SSE or chunked response
   - Validate responses and handle offline/unavailable Ollama gracefully
4. Conversation API
   - `/api/conversations` list/create/rename/delete/search
   - `/api/conversations/{id}/messages` retrieval
   - `/api/conversations/{id}/chat` streaming endpoint for assistant generation
   - Backend SSE channel for incremental assistant chunks
5. Security and config
   - Bind backend to `127.0.0.1` only by default
   - Strict CORS allowing only Angular origin from `.env` or default localhost frontend
   - No shell invocation for Ollama or subprocesses in Phase 1
   - Store config in `backend/.env.example`
6. Tests
   - Pytest backend tests for models, conversation CRUD, Ollama offline fallback, streaming endpoint structure, and path/security core behavior.

### Frontend
1. Angular 18+ app scaffold
   - Standalone components only
   - Strict TypeScript configuration
   - Angular Material for UI controls and theming
2. Core UI screens/components
   - `ConversationShellComponent` with sidebar and chat panel
   - `ConversationListComponent` for conversation management
   - `ChatMessageComponent` for markdown and code rendering
   - `SettingsComponent` stub with theme/model selector
   - `AppComponent` minimal routing and layout
3. Features for Phase 1
   - Collapsible conversation sidebar
   - New conversation button
   - Rename and delete conversation actions
   - Responsive chat window with streaming assistant output
   - Markdown rendering and syntax-highlighted code blocks
   - Copy-code button on code blocks
   - Stop-generation button during streaming
   - Dark/light theme toggle
   - Model selector stub wired to settings and API config
   - Error state when backend/Ollama unavailable
4. Testing
   - Vitest or Angular supported test runner for core components and services
   - Basic UI snapshot/behavior test for chat stream rendering

### Documentation and artifacts
- `README.md` updated for local development and Phase 1 startup instructions
- `AGENTS.md` placeholder with high-level agent guidance and phase boundaries
- `.env.example` for backend/frontend local config
- `architecture.md` describing the backend/frontend architecture, Ollama integration, and security boundaries
- `PLAN.md` (this file)

## Phase 1 Deliverables
- Backend application skeleton and conversation API
- Basic frontend chat UI with streaming demo
- Tests for backend and frontend foundations
- Documentation files: README, AGENTS, .env.example, architecture notes
- Exact commands to start backend and frontend

## Out of scope for Phase 1
- Full tool execution system and typed agent tools
- Workspace filesystem tools and path enforcement beyond future design
- Approval workflow and change management UI
- Git diff viewer and tool execution cards
- Multi-model orchestration beyond default model selection
- Docker Compose production stack beyond placeholder compose files

## Phase 3 Scope
### Workspace registration and browsing
- Register local workspace roots securely with canonical path normalization.
- Block UNC paths when disabled and prevent traversal outside the registered project.
- Hide excluded directories and sensitive files from listings and content previews.
- Provide read-only file browsing and file content preview.

### Repository tools
- Search code using ripgrep and return paginated matches.
- Expose Git status and diff details for tracked repositories.
- Read AGENTS.md instructions from workspace roots in a secure read-only manner.

### Security guarantees
- All workspace requests are confined to the registered root.
- Binary files, excluded directories, and secret files are not exposed.
- File reads are capped by configured file size limits.

## Phase 3.5 Scope
### Personal Codex VS Code extension
- Build a thin local VS Code client only.
- Do not duplicate AI model execution or conversation storage.
- Reuse the existing FastAPI backend for all chat, workspace, and code tooling.
- Maintain strictly local-only connectivity and no cloud APIs.

### User interface and integration
- Add a Personal Codex Activity Bar pane using `WebviewViewProvider`.
- Provide a sidebar with conversation list, new-chat action, chat UI, model selector, backend status, workspace status, approval controls, and tool execution cards.
- Render markdown securely and highlight code using bundled syntax highlighting.
- Use VS Code theme variables for native appearance.
- Enforce a strict CSP with nonces; block remote resources and unsafe inline execution.

### Backend connectivity
- Add VS Code settings for backend URL, default model, auto-register workspace, write approval, and notifications.
- Check backend health with timeout, retry/backoff, and friendly offline messages.
- Stream assistant output from `/api/conversations/{id}/chat` and support cancellation.
- Use a typed client for all backend API calls.

### Workspace integration
- Detect open `vscode.workspace.workspaceFolders` and support multi-root workspaces.
- Ask the user before registering folders with the backend; do not silently register.
- Send canonical workspace paths and let the backend authorize final access.
- Show active registered workspace state in the sidebar.

### Editor commands and context
- Contribute commands for chat, new chat, explain selected code, fix selected code, refactor selected code, generate tests, ask about current file, review current changes, register workspace, check connection, and start the local backend.
- Add editor context menu entries for selected-code actions.
- Send selected text, relative path, language ID, selection range, and workspace ID to the backend.
- Support references such as `@currentFile`, `@selection`, `@workspace`, `@problems`, and `@gitDiff` by resolving them in the extension before sending.
- Enforce explicit selection for large context and apply client-side size limits.

### Diagnostics and Git integration
- Use `vscode.languages.getDiagnostics` to collect diagnostics for current files.
- Allow commands to explain diagnostics, suggest fixes, and send selected diagnostics to chat without editing.
- Use VS Code/Git APIs to show current branch, modified files, staged files, and untracked files.
- Send only diff metadata and relevant file information to the backend.

### Security and boundaries
- Default to localhost backend connection only; warn on non-local URLs.
- Do not read outside opened workspace folders.
- Do not read excluded or secret files from the extension.
- Do not execute shell commands or perform file writes during Phase 3.5.
- Treat webview messages as untrusted and validate all message payloads at runtime.
- Escape rendered markdown and disable raw HTML in the UI.

### Testing and packaging
- Add unit tests with Vitest and integration tests with `@vscode/test-electron`.
- Add scripts for build, watch, lint, test, test:integration, and package.
- Package a local `.vsix` file for manual installation.

## Next steps
1. Review PLAN.md and approve Phase 3.5 extension design.
2. Implement the `vscode-extension/` folder and build the local VS Code client.
3. Run unit and integration tests, then package `personal-codex-0.1.0.vsix`.
