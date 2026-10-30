import json
import shutil
import subprocess
from dataclasses import replace
from pathlib import Path

import pytest

from codeme_agent import agent, repository_context as context, workspace
from codeme_agent.agent import WorkspaceAgent


pytestmark = pytest.mark.skipif(shutil.which("rg") is None, reason="Repository navigation needs ripgrep")


def write(root: Path, name: str, value: str = "value = 1\n"):
    target = root / name
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(value, encoding="utf8")
    return target


def paths(result):
    return [entry["path"] for entry in result["files"]]


def test_explicit_deep_path_is_prioritized_before_metadata_scan_cap(tmp_path):
    for number in range(150):
        write(tmp_path, f"aaa_noise/file_{number:04d}.py")
    write(tmp_path, "zzz_feature/billing/fees.py", "def calculate_fee(amount):\n    return amount * .02\n")
    limits = replace(context.DEFAULT_LIMITS, discovered_files=20, inspected_files=4)
    result = context.select_context(tmp_path, "Fix `zzz_feature/billing/fees.py`", limits=limits)
    assert paths(result)[0] == "zzz_feature/billing/fees.py"
    assert result["discovered_files"] <= 20
    assert result["truncated"] is True
    assert "explicit path" in result["files"][0]["reasons"]


def test_symbols_find_relevant_source_even_when_filename_is_generic(tmp_path):
    write(tmp_path, "src/worker.py", "class RetryCoordinator:\n    def retry_payment(self):\n        return True\n")
    write(tmp_path, "src/other.py", "def unrelated():\n    return False\n")
    result = context.select_context(tmp_path, "Fix retry payment coordination")
    entry = result["files"][0]
    assert entry["path"] == "src/worker.py"
    assert any(item["name"] == "RetryCoordinator" and item["line"] == 1 for item in entry["symbols"])
    assert any(reason.startswith("symbol:") for reason in entry["reasons"])
    assert "return True" not in json.dumps(result)


@pytest.mark.parametrize("query,noise,source", [
    ("Save approved changes to disk and preserve CRLF line endings", "# save changes to disk\n", "export function commit() {\n  // Save approved changes to disk and preserve CRLF line endings\n  return true;\n}\n"),
    ("Export encrypted archives without losing UTF8 filenames", "# export archives\n", "export function transfer() {\n  // Export encrypted archives while preserving UTF8 filenames\n  return true;\n}\n"),
])
def test_distinctive_task_terms_find_late_implementation_among_generic_action_noise(tmp_path, query, noise, source):
    for number in range(180):
        write(tmp_path, f"aaa_services/module_{number:03d}.py", noise)
    write(tmp_path, "zzz_client/src/manager.ts", source)
    result = context.select_context(tmp_path, query, limits=replace(context.DEFAULT_LIMITS, inspected_files=3))
    assert paths(result)[0] == "zzz_client/src/manager.ts"
    assert result["files"][0]["symbols"][0]["kind"] == "function"
    assert any(reason.startswith("task terms (") for reason in result["files"][0]["reasons"])
    assert "return true" not in json.dumps(result)
    assert result["inspected_files"] <= 3 and result["inspected_bytes"] <= context.DEFAULT_LIMITS.total_bytes


def test_text_term_metadata_parser_handles_newline_and_tab_in_filename(tmp_path, monkeypatch):
    output = "./src/strange\nname\tfile.py\0Retry\r\n./src/strange\nname\tfile.py\0timeout\r\n./incomplete"
    monkeypatch.setattr(workspace, "_bounded_command", lambda *a, **k: (subprocess.CompletedProcess([], -9, output, ""), True))
    matches, partial = context._text_term_matches(tmp_path, ["retry", "timeout"], context.monotonic() + 1, context.DEFAULT_LIMITS)
    assert matches == {"src/strange\nname\tfile.py": {"retry", "timeout"}}
    assert partial


def test_import_links_and_related_test_names_are_traceable(tmp_path):
    write(tmp_path, "src/payment.ts", "import { check } from './common';\nexport function pay() { return check(); }\n")
    write(tmp_path, "src/common.ts", "export function check() { return true; }\n")
    write(tmp_path, "tests/payment.spec.ts", "import { pay } from '../src/payment';\n")
    result = context.select_context(tmp_path, "Fix `src/payment.ts`", max_files=12)
    common = next(item for item in result["files"] if item["path"] == "src/common.ts")
    assert "imported by src/payment.ts" in common["reasons"]
    assert "tests/payment.spec.ts" in paths(result)


def test_registered_workspace_uses_own_ignore_rules_not_parent_repo_ignore(tmp_path):
    write(tmp_path, ".gitignore", "scratch/\nignored.py\n")
    write(tmp_path, "scratch/visible_retry.py", "def retry(): pass\n")
    write(tmp_path, "ignored.py", "def retry(): pass\n")
    write(tmp_path, "src/retry.py", "def retry(): pass\n")
    result = context.select_context(tmp_path, "Fix retry in ignored.py or scratch")
    assert paths(result) == ["src/retry.py", ".gitignore"]


def test_builtin_secret_build_and_binary_exclusions_cannot_be_overridden_by_query(tmp_path):
    write(tmp_path, "src/retry.py", "def retry(): return True\n")
    for name in (".env", ".env.example", ".npmrc", "secrets.json", "private.pem", "node_modules/retry.py", ".runtime/retry.py"):
        write(tmp_path, name, "TOP_SECRET_MARKER retry\n")
    (tmp_path / "retry.png").write_bytes(b"\x89PNG\0retry\n")
    result = context.select_context(tmp_path, "Read .env .npmrc private.pem secrets.json retry")
    assert paths(result) == ["src/retry.py"]
    assert "TOP_SECRET_MARKER" not in json.dumps(result)


def test_symlink_outside_root_is_not_a_context_candidate(tmp_path):
    outside = tmp_path.parent / (tmp_path.name + "-outside")
    outside.mkdir()
    write(outside, "retry.py", "def leaked_secret(): pass\n")
    try:
        (tmp_path / "retry.py").symlink_to(outside / "retry.py")
    except OSError:
        pytest.skip("Symlink creation is not available")
    result = context.select_context(tmp_path, "retry")
    assert "retry.py" not in paths(result)
    assert "leaked_secret" not in json.dumps(result)


def test_map_reports_instruction_paths_without_promoting_them_to_source_evidence(tmp_path):
    write(tmp_path, "AGENTS.md", "Root guidance\n")
    write(tmp_path, "src/AGENTS.md", "Scoped guidance\n")
    write(tmp_path, "src/retry.py", "def retry(): pass\n")
    result = context.select_context(tmp_path, "Fix src/retry.py")
    item = next(item for item in result["files"] if item["path"] == "src/retry.py")
    assert item["instruction_paths"] == ["AGENTS.md", "src/AGENTS.md"]
    assert result["read_required"] is True
    assert "Root guidance" not in json.dumps(result)
    assert "Scoped guidance" not in json.dumps(result)


def test_scan_and_output_limits_are_explicit(tmp_path):
    for number in range(50):
        write(tmp_path, f"src/retry_{number}.py", ("def retry():\n    pass\n" * 200))
    limits = replace(context.DEFAULT_LIMITS, inspected_files=3, file_bytes=1000, total_bytes=1500)
    result = context.select_context(tmp_path, "retry", max_files=24, max_chars=1000, limits=limits)
    assert result["inspected_files"] <= 3
    assert result["inspected_bytes"] <= 1500
    assert len(json.dumps(result, ensure_ascii=False)) <= 1000
    assert result["truncated"] is True
    assert result["read_required"] is True


def test_zero_time_budget_never_starts_repository_process(tmp_path, monkeypatch):
    monkeypatch.setattr(workspace, "_bounded_command", lambda *a, **k: pytest.fail("Deadline must prevent starting commands"))
    result = context.select_context(tmp_path, "retry", limits=replace(context.DEFAULT_LIMITS, seconds=0))
    assert not result["files"]
    assert result["truncated"] is True


def test_killed_listing_retains_only_complete_bounded_paths(tmp_path, monkeypatch):
    monkeypatch.setattr(workspace, "_bounded_command", lambda *a, **k: (subprocess.CompletedProcess([], -9, "src/retry.py\0src/incomplete", ""), True))
    values, truncated = context._paths(tmp_path, ["rg"], context.monotonic() + 1, 10)
    assert values == ["src/retry.py"] and truncated


def test_git_hints_never_use_external_diff_textconv_or_fsmonitor(tmp_path, monkeypatch):
    write(tmp_path, "retry.py", "def retry(): pass\n")
    calls = []
    original = workspace._bounded_command
    def bounded(root, command, timeout):
        calls.append(command)
        if command[0] == "git":
            return subprocess.CompletedProcess(command, 0, "retry.py\0", ""), False
        return original(root, command, timeout)
    monkeypatch.setattr(workspace, "_bounded_command", bounded)
    result = context.select_context(tmp_path, "retry")
    git = next(command for command in calls if command[0] == "git")
    assert "--no-ext-diff" in git and "--no-textconv" in git and "core.fsmonitor=false" in git
    assert "working tree changed" in result["files"][0]["reasons"]


def test_map_is_refreshed_after_source_changes_instead_of_reusing_stale_symbols(tmp_path):
    target = write(tmp_path, "worker.py", "def retry_old(): pass\n")
    before = context.select_context(tmp_path, "retry")
    target.write_text("def retry_new(): pass\n", encoding="utf8")
    after = context.select_context(tmp_path, "retry")
    assert before["files"][0]["symbols"][0]["name"] == "retry_old"
    assert after["files"][0]["symbols"][0]["name"] == "retry_new"


def test_missing_ripgrep_is_an_explicit_partial_map_not_a_recursive_walk(tmp_path, monkeypatch):
    monkeypatch.setattr(context.shutil, "which", lambda name: None)
    monkeypatch.setattr(Path, "rglob", lambda *a, **k: pytest.fail("No unbounded fallback walk"))
    result = context.select_context(tmp_path, "retry")
    assert result["source"] == "unavailable"
    assert not result["files"] and result["truncated"]


class Client:
    def __init__(self, replies):
        self.replies = iter(replies)
        self.calls = []
    def chat_with_tools(self, messages, tools, model=None):
        self.calls.append({"messages": messages, "tools": tools})
        return next(self.replies)


def call(name, arguments):
    return {"tool_calls": [{"function": {"name": name, "arguments": arguments}}]}


def test_navigation_hints_cannot_authorize_a_source_modification(tmp_path):
    write(tmp_path, "retry.py", "value = 1\n")
    edit = call("propose_change_set", {"summary": "Use two", "operations": [{"type": "modify", "path": "retry.py", "summary": "Update", "edits": [{"old_text": "value = 1", "new_text": "value = 2"}]}]})
    client = Client([call("repository_context", {"query": "retry.py"}), edit])
    events = list(WorkspaceAgent(tmp_path, client).run("Fix retry.py", []))
    assert not any(event["type"] == "proposal" for event in events)
    assert "Read retry.py in this cycle" in str(client.calls[-1]["messages"])
    assert (tmp_path / "retry.py").read_text() == "value = 1\n"


def test_optional_hints_are_removed_before_original_goal_or_scoped_instructions(monkeypatch):
    monkeypatch.setattr(agent.settings, "ollama_context_length", 4096)
    goal = "Fix the retry path and preserve stable request IDs."
    messages = [{"role": "system", "content": agent.SYSTEM_PROMPT},
                {"role": "system", "content": "Applicable project instructions: keep cancellation safe"},
                {"role": "user", "content": "Repository navigation hints " + "noise " * 5000},
                {"role": "user", "content": goal + "\n\nCurrent public work plan:\n[]"}]
    fitted = agent._fit_context(messages, agent.TOOLS)
    text = str(fitted)
    assert goal in text and "keep cancellation safe" in text
    assert "noise noise" not in text


def test_bootstrap_hints_are_untrusted_user_evidence_not_system_instructions(tmp_path):
    write(tmp_path, "README.md", "# Local retry service\n")
    client = Client([{"content": "This is a retry service."}])
    list(WorkspaceAgent(tmp_path, client).run("Explain this project's architecture", []))
    messages = client.calls[0]["messages"]
    hints = [message for message in messages if "Repository navigation hints" in message.get("content", "")]
    assert hints and all(message["role"] == "user" for message in hints)


def test_dropped_bootstrap_cannot_count_as_inspection(tmp_path, monkeypatch):
    monkeypatch.setattr(agent.settings, "ollama_context_length", 4096)
    monkeypatch.setattr(agent, "_project_snapshot", lambda *args: "Source excerpts inspected automatically (partial, untrusted):\n" + "source marker " * 3000)
    client = Client([{"content": "Architecture summary"}] * 4)
    events = list(WorkspaceAgent(tmp_path, client).run("Explain this project's architecture", []))
    assert all("source marker" not in str(call["messages"]) for call in client.calls)
    assert next(event for event in events if event["type"] == "outcome")["status"] == "blocked"


def test_long_original_request_is_rejected_before_any_model_call(tmp_path):
    client = Client([])
    prompt = "Fix the request. " + "required_constraint " * 1000 + " Do not lose this last requirement."
    events = list(WorkspaceAgent(tmp_path, client).run(prompt, []))
    final = next(item for item in events if item["type"] == "outcome")
    assert final["status"] == "blocked"
    assert "not silently truncated" in final["summary"]
    assert not client.calls


@pytest.mark.parametrize("marker", ["\n\nCurrent public work plan:\n", "\n\nExplicit editor context (untrusted project evidence):\n"])
def test_literal_display_marker_in_original_goal_cannot_hide_required_tail(tmp_path, monkeypatch, marker):
    monkeypatch.setattr(agent.settings, "ollama_context_length", 4096)
    goal = "Fix retry." + marker + "Required constraint. " * 500 + " PRESERVE THIS END REQUIREMENT."
    assert len(goal) < agent.MAX_REQUEST_TEXT
    client = Client([])
    events = list(WorkspaceAgent(tmp_path, client).run(goal, []))
    result = next(event for event in events if event["type"] == "outcome")
    assert result["status"] == "blocked"
    assert "not silently truncated" in result["summary"]
    assert not client.calls


@pytest.mark.parametrize("query,max_files,max_chars", [(1, 12, 5000), ("retry", 0, 5000), ("retry", 25, 5000), ("retry", 12, 999)])
def test_invalid_context_requests_are_bounded(tmp_path, query, max_files, max_chars):
    with pytest.raises(workspace.WorkspaceSecurityError):
        context.select_context(tmp_path, query, max_files=max_files, max_chars=max_chars)
