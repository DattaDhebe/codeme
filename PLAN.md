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

## Next steps
1. Review PLAN.md and approve Phase 3 implementation.
2. Add Phase 3.5 for local VS Code extension tooling after workspace browser completion.
