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

Building and testing the extension requires Node.js 22.12+ within 22.x, or Node.js 24 LTS (recommended). This is a development-tool requirement; the bundled extension retains its VS Code 1.90 runtime floor. The normal browser installer retains its separately documented Node.js support.

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

The [CI workflow](../.github/workflows/ci.yml) is configured for pull requests, pushes, and manual runs. It covers backend checks on Windows/Python 3.10 and Linux/Python 3.12, plus browser and extension checks on Node 24. Inspect the actual GitHub run result; a workflow file or passing local check does not establish a passing remote run. [Dependabot](../.github/dependabot.yml) proposes monthly Python, npm, and GitHub Actions updates for review.

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

Use the [documentation index](index.md), [contribution guide](../CONTRIBUTING.md), and [release checklist](release-checklist.md) for repository navigation, review expectations, and packaging. Preserve historical audits and unrelated owner edits; record new verified behavior in the current guides and review notes. A local build or generated customer ZIP does not establish publication, a Marketplace listing, or a working paid checkout.

## Dependency updates and failed build emails

GitHub failure emails describe the commit that ran, even after a newer commit fixes it. Follow the run link, compare its commit with the current pull request, and inspect the current checks before changing working code. The early repository-polish failures were missing test-output directories and Windows path handling on Linux; both are covered by the current Windows/Python 3.10 and Linux/Python 3.12 checks.

Dependabot keeps its monthly schedule. Related Angular packages and browser test-runner packages are grouped so their peer dependencies can move together. The following compatibility boundaries need an explicit migration before changing them:

| Dependency | Current boundary | Reason |
| --- | --- | --- |
| Angular | Keep the supported 21.x line for automated version updates | Angular 22 requires a coordinated framework, Node and TypeScript migration; updating `@angular/common` alone breaks peer dependencies. |
| Jasmine and its types | Jasmine 5 with reporter 2.3; review major upgrades with Zone.js | The earlier reporter 2.1 only supported Jasmine 4/5. Reporter 2.3 supports newer Jasmine, but an actual Jasmine 7 browser run fails because Zone.js 0.16 patches a now read-only `describe` API. Keep the tested runner until that integration is migrated. |
| Pydantic Settings | 2.15.0; versions 2.16+ excluded while Python 3.10 is supported | 2.15 supports Python 3.10 and the existing Pydantic pin. 2.16 requires Python 3.11. |
| VS Code API types | 1.90.x, matching the declared extension engine floor | Compiling against a newer API can produce an extension that fails on its advertised minimum VS Code version. |

These constraints do not disable build checks, secret scanning or vulnerability alerts. CI also checks Python dependency consistency and rejects high or critical npm advisories in both clients. If a security fix needs a newer runtime, review that runtime migration promptly; do not treat an ignored version range as a permanent security exception. Update the manifest, lockfile, compatibility constraint and documented runtime floor together, then run the relevant tests and packaging checks. Marked renderer changes must preserve escaping, safe links, disabled remote images and synchronous output.

Sources: [Dependabot grouping and ignore options](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference), [Angular compatibility](https://angular.dev/reference/versions), [Pydantic Settings 2.15 metadata](https://pypi.org/pypi/pydantic-settings/2.15.0/json), [Pydantic Settings 2.16 metadata](https://pypi.org/pypi/pydantic-settings/2.16.1/json), and [VS Code extension compatibility](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#visual-studio-code-compatibility).

## Repository About information

The reviewable description, homepage, and topic list live in [.github/repository-metadata.json](../.github/repository-metadata.json). Inspect the plan without changing GitHub:

```console
python -B scripts/configure_repository.py
```

Apply those fields only with authorized repository access:

```console
python -B scripts/configure_repository.py --apply
```

The apply command requires a valid `GH_TOKEN`/`GITHUB_TOKEN` or authenticated GitHub CLI session and verifies the saved fields. Keep tokens outside source and logs. Repository visibility, source publication, releases, and checkout activation are separate decisions; editing the local metadata file does not perform them. If authentication is unavailable, retain the plan and report that the remote About fields were not applied.
