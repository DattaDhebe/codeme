# Codeme Agent

A standalone Python FastAPI scaffold for a code-generation assistant inspired by OpenAI Codex.

## Features
- FastAPI backend
- `/generate` API endpoint for code prompt requests
- Request/response schemas using Pydantic
- Local prompt handling and a simple generation stub

## Getting started

1. Create and activate a Python environment:
   ```powershell
   python -m venv .venv
   .\.venv\Scripts\Activate.ps1
   ```

2. Install dependencies:
   ```powershell
   pip install -r requirements.txt
   ```

3. Run the app:
   ```powershell
   uvicorn main:app --reload
   ```

4. Send a request to `http://127.0.0.1:8000/generate`.

## Example request payload

```json
{
  "language": "python",
  "task": "build a function to reverse a string",
  "context": "Use Python standard library only."
}
```
