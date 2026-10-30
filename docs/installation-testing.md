# Testing a fresh installation

CodeMe now has three distinct installation validation layers. Their results should be reported separately.

| Layer | What it establishes | What it does not establish |
| --- | --- | --- |
| Offline unit tests | Missing-tool failures, supported Node versions, platform installer command construction, safe source snapshots, and user-state isolation | A real OS package manager or newly installed GPU runtime works |
| Fresh-copy smoke | A new Python environment and browser dependency tree can install/build, launch, reuse a model, handle interrupted setup, and preserve a fixture conversation/configuration across an upgrade | The existing host is a clean VM or the fixture performed real inference/downloads |
| Hosted runner matrix | The same fresh-copy checks run on independent Windows, macOS and Linux runners | Every desktop/GPU/ISP configuration works; the runtime fixture is still simulated |

## Inspect the plan

From the repository root:

```console
python scripts/install_smoke.py
```

This command is read-only and does not install dependencies. To perform an actual isolated dependency installation:

```console
python scripts/install_smoke.py --run
```

Python and a supported Node/npm must already be installed. Public Python/npm packages may be downloaded. The script never installs Ollama, another OS runtime, or model weights. It creates a new `.runtime/install-smoke-*/source` copy from application source, excluding `.git`, existing `.venv`, `node_modules`, nested `.env*`, databases, credential/key files, package-manager authentication, build output, caches and runtime files. Only the root `.env.example` template is included. Source symlinks are refused.

The subprocess environment keeps an explicit allowlist of OS/tool variables such as `PATH` and `SystemRoot`, then supplies isolated home, app-data, temporary and package-manager configuration directories. User tokens, proxies, application settings and Python/Node injection variables are not inherited. A machine that needs a private dependency proxy or custom certificate configuration may need a separate, deliberately configured test environment; the smoke uses the public package registries.

The smoke uses a fresh virtual environment without system-site packages and a fresh browser dependency directory. An optional explicit `--npm-cache PATH` or `--pip-cache PATH` can reuse downloaded package archives; use absolute cache paths. Doing so does not reuse installed environments and must be disclosed with the result.

## Checks performed

1. Run the real installer with `--no-launch --skip-ollama` in the new copy.
2. Reuse the installed model described by a controlled loopback HTTP daemon, with zero pull requests.
3. Observe a deliberately interrupted pull, retain accurate partial progress, retry from fixture cache, and reach ready only after inventory/load checks.
4. Cancel a held pull and ensure a failed low-memory load never reports ready.
5. Run the real local launcher and serve the built browser's SPA route.
6. Create a disposable conversation, rerun the installer with external dependency access disabled, and confirm `.env` and that conversation survive.
7. Confirm the first backend's port closes, then relaunch the installed copy and require a distinct backend process using its existing build/dependencies while the controlled local daemon remains available.

The “offline” check disables dependency indexes and uses unusable environment proxies, while preserving required loopback access. It is not an operating-system firewall test. Retry progress is a protocol fixture, not proof that every registry or Ollama version resumes real weights identically.

The fixture uses a non-root API path so CodeMe cannot automatically launch an installed real Ollama executable if that fixture fails. All model names, data and conversation content belong to the test. Existing user configuration, database and model storage are never copied or modified.

For headless hosts, a harness wrapper runs the real `start.py` and polls a unique control file inside the marked run directory. Creating that file interrupts the launcher's main thread so its normal cleanup runs without requiring a Windows console. A bounded process-tree fallback targets only that owned launcher. Reports record each launcher/backend PID, its exit code and the closed backend port; reusing an old server cannot satisfy the restart check.

## Reports and CI

The command prints the artifact directory. `report.json` records host/platform, bootstrap Python, source fingerprint (including this harness and `.env.example`), cache reuse, phase durations, evidence kind, pass/fail and the detailed probe result. Installation, upgrade and launcher logs are retained there. Failed copies are preserved for diagnosis; the script does not recursively remove arbitrary directories.

The manual [installation workflow](../.github/workflows/install-smoke.yml) runs Python 3.12 and Node 24 on a Windows/macOS/Linux matrix. It uploads only the test reports/logs, not the source copy, dependencies, `.env` or database. Creating the workflow is not evidence that those remote jobs have run. Dispatch it after committing the relevant source and inspect each platform's report.

Real hardware testing remains necessary for OS Ollama installation, GPU driver discovery, memory pressure, large model downloads, and offline operation with actual installed weights. Record those as separate device-specific results; do not substitute mock-daemon passes for them.

## Recorded local result: 30 October 2026

The Windows fresh-copy run passed on an existing Windows host with Python 3.10.11 and Node 24.14.1. It created new `.venv` and `node_modules` directories, reused explicitly selected pip/npm package archives, installed/built in 126.72 seconds, then completed the controlled-daemon launch/upgrade/relaunch checks in 138.42 seconds. Both launchers exited successfully; backend PIDs 51864 and 46948 were distinct and both backend ports closed after shutdown. The 38 focused installer/harness tests also passed.

Local evidence is retained in `.runtime/install-smoke-52au63dk/report.json`, `probe-result.json`, `source-validation.json` and the phase logs. The installed snapshot fingerprint begins `3dd943c5`; the final privacy-validation snapshot begins `811c63d5`. Production source matched exactly. After the installed snapshot was captured, only the harness's excluded secret-file suffixes and their sentinel tests expanded; the separate final source validation records that difference. Earlier smoke artifacts did not prove backend replacement and are superseded by this run.

This was an isolated copy on the existing host, not a clean Windows VM. The remote Windows/macOS/Linux workflow has been configured but has not been dispatched. No real runtime installation, model-weight download, inference, GPU or minimal-OS test is claimed by these installation results.

The workflow uses the official [checkout](https://github.com/actions/checkout), [Python setup](https://github.com/actions/setup-python), [Node setup](https://github.com/actions/setup-node), and [artifact upload](https://github.com/actions/upload-artifact) actions. Local contributor checks are in [Development](development.md).
