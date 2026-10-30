# Evaluating local coding models

CodeMe includes a repeatable evaluation suite for the real `WorkspaceAgent` loop and its local model clients. It checks concrete source proposals and observed tool use. It does not ask another model to grade an answer.

Use the suite to compare models you already have installed, or to check an agent change against the same small tasks. A passing result describes these fixtures and this configuration; it does not establish general coding ability or readiness for unattended work.

The current suite uses small Python fixtures, including a larger synthetic repository for navigation. It does not yet measure other programming languages, real-project test repair, approved command execution, or sustained autonomous sessions.

## Start without inference

From the repository root on Windows:

```powershell
# List cases. This does not contact a model server or start inference.
.\.venv\Scripts\python.exe -B scripts/evaluate_models.py

# Read the running local server's installed inventory. No inference or download.
.\.venv\Scripts\python.exe -B scripts/evaluate_models.py --list-models
```

On macOS or Linux, replace `.\.venv\Scripts\python.exe` with `.venv/bin/python`.

The local runtime must already be running. This script does not install a runtime, start model setup, pull weights, or fall back to a cloud service. `--run` is required before it sends an inference request. An uninstalled model is reported as `not_installed`.

## Run installed models

```powershell
# One installed Ollama model, all cases.
.\.venv\Scripts\python.exe -B scripts/evaluate_models.py --run --model qwen2.5-coder:7b --output .runtime/evaluations/qwen.json

# Compare installed models with the same cases and limits.
.\.venv\Scripts\python.exe -B scripts/evaluate_models.py --run --model qwen2.5-coder:7b --model YOUR_OTHER_INSTALLED_MODEL --case exact_bugfix --case noisy_repository

# Explicitly select every locally installed model. This can load large weights.
.\.venv\Scripts\python.exe -B scripts/evaluate_models.py --run --all-installed

# An already running compatible local server; this URL must be loopback.
.\.venv\Scripts\python.exe -B scripts/evaluate_models.py --run --provider openai_compatible --endpoint http://127.0.0.1:1234/v1 --model YOUR_INSTALLED_MODEL
```

Both protocols use CodeMe's existing loopback URL and local-model checks. Model capability metadata remains visible in the report. A model known to lack completion or tool support is marked `unsupported`, rather than counted as a successful task. Missing capability metadata is recorded as unknown; a real request can still establish observed behavior.

Ollama aliases that resolve to the same installed ID, such as `name` and `name:latest`, are evaluated once and retained as `requested_aliases`. They do not inflate evaluated-model coverage or quality totals.

Defaults allow six inference requests per case, 180 seconds per request, 240 seconds per case, and 1,800 seconds for a matrix. Override these together when testing slower hardware:

```powershell
.\.venv\Scripts\python.exe -B scripts/evaluate_models.py --run --model qwen2.5-coder:7b --max-requests 6 --request-seconds 120 --case-seconds 180 --total-seconds 1200
```

Requests are clipped to the remaining case and matrix deadlines. Cancellation and time budgets are checked between agent operations. These are cooperative bounds, not a hard real-time process kill: local filesystem operations, transport preflight checks, HTTP timeout semantics, and cleanup can add some time. Cancellation before inference must produce zero model requests. An operator interruption checkpoints completed results, marks the current case cancelled, and skips later cases.

For meaningful timing comparisons, run the matrix after installations, builds, and other inference jobs have finished. Use the same effective context length, limits, suite version, and server/model defaults. A timeout under competing CPU or memory load is an observed environment/request failure; it does not by itself establish that the model cannot solve the task.

## What the cases check

| Case | Category | Required result |
| --- | --- | --- |
| `exact_bugfix` | Model quality | Read a function and propose its exact operator repair. |
| `multi_file` | Model quality | Read both sources and propose both repairs in one complete change set. |
| `nested_create` | Model quality | Propose a specified module under parent directories that do not exist. |
| `source_inspection` | Model quality | Read authoritative source and return the requested exact JSON facts, ignoring an outdated README example. |
| `scoped_guidance` | Model quality | Apply deeper `AGENTS.md` guidance to a source edit. |
| `noisy_repository` | Model quality | Find a deep implementation among 128 unrelated modules from a symbol-only request, read it, and propose the minimal repair. |
| `read_error_recovery` | Injected fault recovery | Retry a deliberately failed first read, then produce the correct proposal. |
| `unread_write_guard` | Injected policy control | Reject a synthetic unread replacement, then recover through actual model inspection and a correct proposal. |
| `cancel_before_inference` | Policy control | Cancel before any model request or proposal. |

The injected replacement is supplied by the harness, not generated by the tested model. It is counted separately from actual inference and native tool calls. These control and recovery scores are separate from the six model-quality tasks. The agent's automatic initial plan is also separate from measured model `update_plan` calls.

Every case uses a newly created disposable workspace containing synthetic fixture files. The harness never supplies user repository source, approves a proposal, runs model-generated code, executes a project command, or applies a change. All fixture bytes must remain unchanged. Read-only agent inspection may use the repository's existing bounded search utilities.

## How results are graded

For an editing task, the oracle requires the applicable exact source reads, a single proposal covering exactly the expected paths, valid create/modify operation types and canonical proposal hashes, and an `awaiting_approval` outcome. Read evidence uses the agent's canonical paths from results actually delivered in fitted model requests. Equivalent paths such as `./math_utils.py` count correctly. Python source must match the complete expected AST. Formatting and quote style can differ; extra functions, statements, or source files fail. These tiny fixtures use a 64 KiB source-oracle limit: larger proposed fixture source fails, and parser recursion or memory errors reject the source safely. This evaluation bound does not change the application's file-size limit. These checks inspect source without executing it. They are not a substitute for running the project's tests after a reviewed change is applied.

Inspection uses a strict JSON oracle for the requested source path and numeric rate, together with the authoritative return line and fixture hash observed in an actual model request, and no proposal. Reading an empty range or only the function header does not establish the rate. A partial answer, an invented completion, an incorrect proposal, and a transport error remain distinct outcomes. Unexpected oracle failures become per-case `error` results with `error_category: oracle`; model-client request/response failures use `model_client`. One failed oracle does not abort later cases.

The JSON report records:

- The requested and actual selected model IDs, installed model inventory, advertised capabilities, suite version, fixture-definition digest, import-time source hashes, and a fingerprint of the loaded agent-loop code.
- The effective agent context length and client options (`num_ctx` for Ollama), client type, and all request/case/matrix limits. The evaluator does not send temperature, seed, or output-token overrides; unknown server/model defaults stay explicitly unknown. The compatible protocol does not send Ollama's `num_ctx` option.
- Per-case correctness failures, public outcome, source-read/tool trace, tool errors, and bounded proposed fixture-source excerpts for diagnosis.
- Actual request counts, per-request elapsed time and tool signatures, and native tool calls versus tool JSON recovered from assistant content **before** the agent compatibility parser.
- Request/case errors, unsupported cases, missing models, skipped work, cancellation, exercised fault probes, and request-budget exhaustion.
- Separate quality, fault-recovery, and policy-control counts. Quality totals include requested but unsupported or unavailable coverage; `quality_evaluated` shows how many attempted a model-client call, including calls that returned an error. Failed attempts do not count as quality passes.

Raw model responses, private reasoning blocks, and message histories are not written. Public diagnostic excerpts are bounded and have known private-reasoning tags removed. Token throughput is not reported because the current client response does not provide a reliable end-to-end token count.

Reports are checkpointed atomically after each completed case. The default is `.runtime/evaluations/report.json`; workspaces under its `workspaces` sibling are removed after each case. Use a different output filename for each comparison. The CLI exits `0` when requested checks pass, `1` for task failures/errors or incomplete/unsupported coverage, `2` for setup or argument errors, and `130` for operator cancellation.

The automated harness tests use scripted clients and label that inference `test_fixture`. Those tests validate the evaluator, not a model's coding performance. Live coverage requires a report labeled `live_local`; multiple fake clients do not establish multiple-model coverage. Re-run in a fresh Python process after agent or context-selection changes so the recorded loaded code represents the implementation under test.

Suite version 2 makes the shared fixture guidance conditional: a change set is required **when edits are requested**. Earlier version 1 guidance requested a proposal unconditionally, which introduced ambiguity for the read-only inspection case. Preserve earlier reports as historical evidence, but compare inspection results using the same suite version. The inspection oracle remains unchanged: exact source facts in the requested JSON format, an observed source read, and no proposal.
