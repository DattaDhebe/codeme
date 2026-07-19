# Personal Codex Angular client

This Angular 18 standalone application provides local conversation history, Markdown chat, Ollama model discovery, streaming cancellation, and workspace read tools.

## Runtime configuration

`public/runtime-config.json` is loaded in the browser before startup. Supported keys are:

```json
{
  "backendUrl": "http://127.0.0.1:8000",
  "defaultModel": "qwen2.5-coder:7b",
  "allowRemoteBackend": false
}
```

The URL must be HTTP(S), may not contain embedded credentials, and must resolve to `localhost`, `127.0.0.1`, or `::1` unless remote access is explicitly enabled. The built asset can be replaced at deployment time without rebuilding the Angular bundles.

## Commands

```powershell
npm ci
npm start
npm test -- --watch=false
npm run build
```

The development application uses port 4200. The optional Angular SSR server uses port 4000 after a production build.

Generated Markdown is passed through Angular's maintained HTML sanitizer and additional URL/element policy checks. SSE parsing is frame-aware and decodes the backend's JSON `data:` payloads.

The Angular client does not yet provide Agent mode or transactional change-set approval; those are planned for Phase 8.
