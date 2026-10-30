# Developing CodeMe

The repository contains a Python backend, an Angular browser client, and a TypeScript VS Code extension. Read [Architecture](architecture.md) before changing shared task, proposal, command, or verification contracts.

## Prepare the environment

Use Python 3.10+ and Node/npm supported by Angular 21; Node.js 24 LTS is recommended. Git and ripgrep are required for the corresponding repository tools. From the repository root:

```console
python install.py --no-launch
```

This prepares the normal local setup. If you manage your own local model server, configure `.env` first or use `--skip-ollama`. See [Getting started](getting-started.md) for a manual environment.

All backend commands below use the Windows environment path. On macOS/Linux, replace `.venv\Scripts\python.exe` with `.venv/bin/python`.

## Run while editing

Backend, from the root:

```powershell
.\.venv\Scripts\python.exe -m uvicorn main:app --host 127.0.0.1 --port 8000 --workers 1 --reload
```

Browser, in another terminal:

```console
cd frontend
npm start
```

Open `http://127.0.0.1:4200`. Stop an existing `start.py` launcher first so the development servers can use their ports. Use one backend worker. Auto-reload interrupts in-flight tasks and model setup; it is a development convenience, not process recovery.

Extension:

```console
cd vscode-extension
npm ci
npm run build
```

Open that folder in VS Code and launch its extension development host using your VS Code development configuration, or package/install a VSIX as described in the [extension guide](../vscode-extension/README.md).

## Validate changes

Backend, from the root:

```powershell
.\.venv\Scripts\python.exe -B -m pytest codeme_agent/tests
```

Browser:

```console
cd frontend
npm test -- --watch=false
npm run build
```

The browser tests need Chrome or Chromium-compatible headless support. On Windows the Karma configuration looks for Chrome or Edge. Set `CHROME_BIN` explicitly if discovery does not find your browser.

Extension:

```console
cd vscode-extension
npm run typecheck
npm test
npm run build
npm run package
```

`npm test` runs the Vitest suite with a VS Code test stub. Optional live-backend tests and native extension-host smoke tests have additional environment requirements; passing unit tests does not imply a real local model was exercised. Read the test's opt-in requirements before running it. The package is `personal-codeme-0.7.0.vsix` and is a generated artifact.

To exercise actual editor saves, new folders, line endings, restore, and save hooks, select an installed VS Code executable explicitly:

```powershell
$env:CODEME_VSCODE_EXECUTABLE = 'C:\Users\you\AppData\Local\Programs\Microsoft VS Code\Code.exe'
npm run test:integration
```

On macOS/Linux, set the same variable to the installed editor's executable path. The harness does not download VS Code. It opens an isolated profile, extensions directory and fixture workspace; artifacts and logs are under `.runtime/native-vscode-*`. Native checks are distinct from browser visual inspection and from real-model evaluation.

Before submitting:

```console
git diff --check
git status --short
```

Run checks appropriate to your change. Shared API changes usually affect the backend and both clients. Report live-model, clean-install, and native UI checks separately from fixture-based tests.

## Evaluate models and installation

These commands show the available cases and installation plan without inference or dependency installation:

```console
python -B scripts/evaluate_models.py
python -B scripts/install_smoke.py
```

Use CodeMe's virtualenv Python for model evaluations. Add `--run --model INSTALLED_ID` to evaluate installed weights in disposable repositories. The suite never downloads a model, approves a proposal, or executes model-generated code. Quality, injected recovery, and policy-control results are reported separately; passing a cancellation control is not evidence of model coding ability. See [Model evaluations](model-evaluations.md) for limits and reports.

Add `--run` to the installation command to create a fresh source snapshot, install Python/npm dependencies there, and exercise the actual launcher with a controlled local model server. This uses public package registries. It does not install Ollama, download weights, or change the host's CodeMe data. A manual GitHub Actions workflow runs the same harness on Windows, macOS, and Linux; a workflow definition alone is not a passing result. See [Installation testing](installation-testing.md).

For navigation changes, run `codeme_agent/tests/test_repository_context.py` and the agent tests. Verify that ignored/private files stay excluded, scan/output budgets remain bounded, optional hints yield to the original goal, and metadata never authorizes edits. See [Repository context](repository-context.md).

## Preserve the important boundaries

- Use `create_model_client()` rather than adding another inference transport.
- Keep model/runtime setup separate from repository command execution. Never accept a repository-controlled runtime executable or arbitrary download URL.
- Keep canonical task continuation and completion evidence in `agent_runs.py`.
- Keep source edits in the extension's transactional change-set pipeline and project commands in its independently validated controlled runner.
- Preserve approval fingerprints, current-file verification receipts, cancellation, and reload interruption behavior.
- Treat Markdown, file contents, logs, and model tool arguments as untrusted input.
- Use bounded outputs and relative workspace paths. Preserve real-path, hash, dirty-document, and secret protections.
- Keep tests isolated with temporary databases/workspaces and mocked model downloads. Do not test migrations on `codeme.db` or fetch multi-gigabyte weights during a unit suite.

## Data and generated files

Do not commit `.env`, credentials, `codeme.db`, `.runtime/`, model weights, Python caches, `node_modules/`, or packaged VSIX files. Some existing extension `dist/` assets are tracked; rebuild them when changing the extension so the committed bundle matches its source. Preserve unrelated user changes.

Changes to database tables require a new Alembic revision and a data-preserving upgrade. See [Database migrations](../alembic/README.md). Do not rewrite historical migrations to change an already-installed schema.

## Documentation maintenance

Update the user-facing guide with the actual behavior and defaults when changing setup, permissions, models, or launch commands. Keep the root README short and put detailed explanations in `docs/`. `PLAN.md` separates delivered features from future work. Keep `CURRENT_IMPLEMENTATION_REPORT.md` aligned with the current source; the original audit under `docs/archive/` is historical and should not be used as the current feature matrix.
