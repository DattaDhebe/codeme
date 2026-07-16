# Personal Codex

Personal Codex is a local-first coding assistant with a ChatGPT-style interface.

## Phase 2 Status
- Backend: FastAPI, SQLite, SQLAlchemy 2, Alembic, Ollama local HTTP client
- Frontend: Angular 18+ standalone app scaffold
- Streaming chat and conversation persistence implemented

## Phase 3 Status
- Workspace registration and secure root path canonicalization
- Repository browsing with file listing and content preview
- Read-only local workspace search with ripgrep integration
- Git status and diff support for registered repositories

## Setup

1. Create and activate a Python environment:
   ```powershell
   python -m venv .venv
   .\.venv\Scripts\Activate.ps1
   ```

2. Install backend dependencies:
   ```powershell
   python -m pip install -r requirements.txt
   ```

3. Install frontend dependencies:
   ```powershell
   cd frontend
   npm install
   ```

4. Run the backend:
   ```powershell
   uvicorn main:app --reload
   ```

5. Run the frontend:
   ```powershell
   cd frontend
   npm start
   ```

## Notes
- Ollama must be running locally and accessible at `http://127.0.0.1:11434`.
- The default model is `qwen2.5-coder:7b`.
- API Base URL: `http://127.0.0.1:8000/api`.
