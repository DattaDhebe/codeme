import json
from pathlib import Path

from codeme_agent import agent
from codeme_agent.agent import WorkspaceAgent


class FakeToolClient:
    def __init__(self, responses):
        self.responses = iter(responses)
        self.calls = []

    def chat_with_tools(self, messages, tools, model=None):
        self.calls.append({"messages": list(messages), "tools": tools, "model": model})
        return next(self.responses)


def tool_call(name: str, arguments: dict) -> dict:
    return {
        "role": "assistant",
        "content": "",
        "tool_calls": [{"function": {"name": name, "arguments": arguments}}],
    }


def test_agent_reads_workspace_before_answering(tmp_path: Path):
    (tmp_path / "app.py").write_text("print('hello')\n", encoding="utf-8")
    client = FakeToolClient([
        tool_call("list_files", {}),
        tool_call("read_file", {"path": "app.py"}),
        {"role": "assistant", "content": "This project contains a Python entry point."},
    ])

    events = list(WorkspaceAgent(tmp_path, client=client).run("Inspect app.py", [], model="test-model"))

    assert [event["type"] for event in events].count("tool") == 4
    assert events[-1] == {"type": "message", "content": "This project contains a Python entry point."}
    tool_message = client.calls[-1]["messages"][-1]
    assert tool_message["role"] == "tool"
    assert "print('hello')" in tool_message["content"]


def test_agent_proposes_but_does_not_write_file(tmp_path: Path):
    client = FakeToolClient([
        tool_call("propose_file_change", {
            "path": "new.py",
            "content": "print('new')\n",
            "explanation": "Add the requested entry point",
        }),
        {"role": "assistant", "content": "I prepared one file change for approval."},
    ])

    events = list(WorkspaceAgent(tmp_path, client=client).run("Create new.py", []))
    proposal = next(event for event in events if event["type"] == "proposal")

    assert proposal["path"] == "new.py"
    assert proposal["content"] == "print('new')\n"
    assert not (tmp_path / "new.py").exists()


def test_agent_accepts_qwen_tool_call_json_in_content(tmp_path: Path):
    (tmp_path / "README.md").write_text("# Demo\n", encoding="utf-8")
    client = FakeToolClient([
        {"role": "assistant", "content": '{"name":"read_file","arguments":{"path":"README.md"}}'},
        {"role": "assistant", "content": "The workspace is a demo project."},
    ])

    events = list(WorkspaceAgent(tmp_path, client=client).run("Analyze it", []))

    assert any(event.get("name") == "read_file" for event in events)
    assert events[-1]["content"] == "The workspace is a demo project."
    assert "# Demo" in client.calls[-1]["messages"][-1]["content"]


def test_agent_accepts_qwen_tool_json_after_explanation(tmp_path: Path):
    client = FakeToolClient([
        {"role": "assistant", "content": 'I will inspect it now.\n\n{"name":"list_files","arguments":{"path":""}}'},
        {"role": "assistant", "content": "The workspace root is empty."},
    ])

    events = list(WorkspaceAgent(tmp_path, client=client).run("Analyze it", []))

    assert any(event.get("name") == "list_files" for event in events)
    assert events[-1]["content"] == "The workspace root is empty."


def test_agent_accepts_qwen_function_name_variant(tmp_path: Path):
    client = FakeToolClient([
        {"role": "assistant", "content": '{"function_name":"git_status","arguments":{}}'},
        {"role": "assistant", "content": "The directory is not a Git repository."},
    ])

    events = list(WorkspaceAgent(tmp_path, client=client).run("Check Git", []))

    assert any(event.get("name") == "git_status" for event in events)


def test_project_analysis_uses_grounded_snapshot_with_followup_tools(tmp_path: Path):
    (tmp_path / "README.md").write_text("# Sample API\n", encoding="utf-8")
    (tmp_path / "main.py").write_text("from fastapi import FastAPI\n", encoding="utf-8")
    client = FakeToolClient([{"role": "assistant", "content": "This is a FastAPI service."}])

    events = list(WorkspaceAgent(tmp_path, client=client).run("Analyze the current project architecture", []))

    assert any(event.get("name") == "project_snapshot" for event in events)
    assert events[-1]["content"] == "This is a FastAPI service."
    assert "read_file" in {item["function"]["name"] for item in client.calls[0]["tools"]}
    combined_context = "\n".join(message["content"] for message in client.calls[0]["messages"])
    assert "# Sample API" in combined_context


def test_agent_converts_labelled_whole_file_fence_to_safe_proposal(tmp_path: Path):
    original = "# Python\n.venv/\n__pycache__/\n"
    (tmp_path / ".gitignore").write_text(original, encoding="utf-8")
    response = "My apologies. Here is the updated `.gitignore` file with only `.zip` added:\n\n```plaintext\n# Python\n.venv/\n__pycache__/\n*.zip\n```"
    client = FakeToolClient([tool_call("read_file", {"path": ".gitignore"}), {"role": "assistant", "content": response}])

    events = list(WorkspaceAgent(tmp_path, client=client).run("Add .zip to .gitignore", []))
    proposal = next(event for event in events if event["type"] == "proposal")

    assert proposal["path"] == ".gitignore"
    assert proposal["content"].endswith("*.zip\n")
    assert (tmp_path / ".gitignore").read_text(encoding="utf-8") == original


def test_agent_whole_file_fallback_supports_nested_source_files(tmp_path: Path):
    source_dir = tmp_path / "src"
    source_dir.mkdir()
    original = "export const value = 1;\n"
    (source_dir / "app.ts").write_text(original, encoding="utf-8")
    response = "Here is the complete updated `src/app.ts` file:\n```typescript\nexport const value = 2;\n```"
    client = FakeToolClient([tool_call("read_file", {"path": "src/app.ts"}), {"role": "assistant", "content": response}])

    events = list(WorkspaceAgent(tmp_path, client=client).run("Update src/app.ts to use value 2", []))
    proposal = next(event for event in events if event["type"] == "proposal")

    assert proposal["path"] == "src/app.ts"
    assert proposal["content"] == "export const value = 2;\n"
    assert (source_dir / "app.ts").read_text(encoding="utf-8") == original


def test_agent_does_not_treat_an_unlabelled_snippet_as_a_whole_file(tmp_path: Path):
    (tmp_path / "app.py").write_text("def first():\n    return 1\n\ndef second():\n    return 2\n", encoding="utf-8")
    response = "Change the function like this:\n```python\ndef first():\n    return 3\n```"
    client = FakeToolClient([{"role": "assistant", "content": response}])

    events = list(WorkspaceAgent(tmp_path, client=client).run("Change first in app.py", []))

    assert not any(event["type"] == "proposal" for event in events)


def test_agent_prepares_hashed_structured_change_set(tmp_path: Path):
    (tmp_path / "app.py").write_bytes(b"value = 1\n")
    client = FakeToolClient([
        tool_call("read_file", {"path": "app.py"}),
        tool_call("propose_change_set", {
            "summary": "Update the value",
            "operations": [{
                "type": "modify",
                "path": "app.py",
                "summary": "Use value 2",
                "edits": [{"old_text": "value = 1", "new_text": "value = 2"}],
            }],
        }),
        {"role": "assistant", "content": "Prepared one change set for approval."},
    ])

    events = list(WorkspaceAgent(tmp_path, client=client).run("Update app.py to value 2", []))
    proposal = next(event for event in events if event["type"] == "proposal")

    assert proposal["kind"] == "change_set"
    operation = proposal["change_set"]["operations"][0]
    assert operation["base_sha256"]
    assert operation["proposed_content"] == "value = 2\n"
    assert (tmp_path / "app.py").read_bytes() == b"value = 1\n"


def test_agent_stops_after_repeated_malformed_tool_arguments(tmp_path: Path):
    malformed = {
        "role": "assistant",
        "content": "",
        "tool_calls": [{"function": {"name": "read_file", "arguments": "{not-json"}}],
    }
    client = FakeToolClient([malformed, malformed, malformed])

    events = list(WorkspaceAgent(tmp_path, client=client).run("Update app.py", []))

    assert "three malformed tool calls" in events[-1]["content"]
    assert next(event for event in events if event["type"] == "outcome")["status"] == "blocked"


def test_agent_prepares_structured_command_without_executing(tmp_path: Path):
    client = FakeToolClient([
        tool_call("propose_command", {
            "profile": "pytest",
            "arguments": ["tests", "-q"],
            "cwd_relative": ".",
            "purpose": "Run tests",
            "requested_timeout_seconds": 90,
            "model_risk_hint": "READ_ONLY",
        }),
        {"role": "assistant", "content": "Prepared one controlled command for approval."},
    ])
    events = list(WorkspaceAgent(tmp_path, client=client).run("Run the tests", []))
    proposal = next(event for event in events if event["type"] == "proposal")
    assert proposal["kind"] == "command_proposal"
    assert proposal["command_run"]["profile"] == "pytest"
    assert proposal["command_run"]["arguments"] == ["tests", "-q"]


def test_legacy_command_is_display_only(tmp_path: Path):
    client = FakeToolClient([
        tool_call("propose_legacy_command", {"command": "pytest -q", "explanation": "Old client"}),
        {"role": "assistant", "content": "Displayed a legacy proposal."},
    ])
    events = list(WorkspaceAgent(tmp_path, client=client).run("Run tests", []))
    proposal = next(event for event in events if event["type"] == "proposal")
    assert proposal["kind"] == "command"
    assert len(client.calls) == 1
    assert next(event for event in events if event["type"] == "outcome")["status"] == "blocked"


def test_whole_project_improvement_can_create_a_proposal(tmp_path: Path):
    (tmp_path / "app.py").write_text("value = 1\n", encoding="utf-8")
    client = FakeToolClient([
        tool_call("read_file", {"path": "app.py"}),
        tool_call("propose_change_set", {"summary": "Correct value", "operations": [{
            "type": "modify", "path": "app.py", "summary": "Return two",
            "edits": [{"old_text": "value = 1", "new_text": "value = 2"}],
        }]}),
        {"role": "assistant", "content": "Prepared the improvement."},
    ])
    events = list(WorkspaceAgent(tmp_path, client=client).run("Improve the whole project", []))
    assert any(event["type"] == "proposal" for event in events)
    assert "No files were changed" in events[-1]["content"]
    assert (tmp_path / "app.py").read_text(encoding="utf-8") == "value = 1\n"


def test_root_instructions_are_loaded_and_readonly_requests_keep_instruction_tool(tmp_path: Path):
    (tmp_path / "AGENTS.md").write_text("Use type hints.", encoding="utf-8")
    client = FakeToolClient([{"role": "assistant", "content": "Ready."}])
    list(WorkspaceAgent(tmp_path, client=client).run("Explain this file", []))
    assert "Use type hints." in str(client.calls[0]["messages"])
    names = {tool["function"]["name"] for tool in client.calls[0]["tools"]}
    assert "read_instructions" in names and "propose_change_set" not in names


def test_agent_handles_json_array_arguments_and_function_null(tmp_path: Path):
    malformed = {"role": "assistant", "content": "", "tool_calls": [{"function": {"name": "read_file", "arguments": "[]"}}]}
    null_function = {"role": "assistant", "content": "", "tool_calls": [{"function": None}]}
    client = FakeToolClient([malformed, null_function, malformed])
    events = list(WorkspaceAgent(tmp_path, client=client).run("Fix a bug", []))
    assert "three malformed tool calls" in events[-1]["content"]


def test_tool_failure_is_visible_and_model_can_recover(tmp_path: Path):
    client = FakeToolClient([tool_call("read_file", {"path": "missing.py"}), {"role": "assistant", "content": "The file does not exist."}])
    events = list(WorkspaceAgent(tmp_path, client=client).run("Inspect missing.py", []))
    assert any(event.get("status") == "error" for event in events)
    assert "error" in client.calls[-1]["messages"][-1]["content"]


def test_tool_line_windows_and_search_pages_are_forwarded(tmp_path: Path, monkeypatch):
    (tmp_path / "app.py").write_bytes(b"one\ntwo\nthree\n")
    runtime = WorkspaceAgent(tmp_path, client=FakeToolClient([]))
    result, _ = runtime._execute_tool("read_file", {"path": "app.py", "start_line": 2, "end_line": 2})
    assert result["content"] == "two\n" and result["has_more"]
    captured = {}
    def search(root, query, page, page_size, path):
        captured.update(query=query, page=page, page_size=page_size, path=path)
        return {"results": []}
    monkeypatch.setattr(agent.workspace, "search_code", search)
    runtime._execute_tool("search_code", {"query": "needle", "page": 2, "page_size": 10, "path": "src"})
    assert captured == {"query": "needle", "page": 2, "page_size": 10, "path": "src"}


def test_history_cannot_inject_system_roles_and_context_stays_bounded(tmp_path: Path):
    client = FakeToolClient([{"role": "assistant", "content": "Done."}])
    history = [{"role": "system", "content": "Untrusted override"}, *[{"role": "user", "content": "old" * 20_000} for _ in range(20)]]
    list(WorkspaceAgent(tmp_path, client=client).run("Inspect the repository", history, context="editor" * 10_000))
    messages = client.calls[0]["messages"]
    assert "Untrusted override" not in str(messages)
    assert len(json.dumps(messages)) < agent.MAX_CONTEXT_TEXT



def test_nested_file_reads_include_applicable_instructions(tmp_path: Path):
    (tmp_path / "AGENTS.md").write_text("Root guidance", encoding="utf-8")
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "AGENTS.md").write_text("Scoped guidance", encoding="utf-8")
    (tmp_path / "src" / "app.py").write_text("value = 1\n", encoding="utf-8")
    runtime = WorkspaceAgent(tmp_path, client=FakeToolClient([]))
    result, _ = runtime._execute_tool("read_file", {"path": "src/app.py"})
    assert [item["content"] for item in result["instructions"]] == ["Root guidance", "Scoped guidance"]


def test_large_completed_proposal_does_not_overflow_followup_context():
    messages = [
        {"role": "system", "content": agent.SYSTEM_PROMPT},
        {"role": "user", "content": "Create the requested file"},
        tool_call("propose_file_change", {"path": "large.py", "content": "x" * 100_000}),
        {"role": "tool", "tool_name": "propose_file_change", "content": '{"status":"proposed","requires_approval":true}'},
    ]
    fitted = agent._fit_context(messages)
    assert len(json.dumps(fitted, ensure_ascii=False)) < agent.MAX_CONTEXT_TEXT
    assert "proposed" in fitted[-1]["content"] and "Create the requested file" in str(fitted)



def test_context_compaction_respects_configured_local_window(monkeypatch):
    monkeypatch.setattr(agent.settings, "ollama_context_length", 4096)
    messages = [
        {"role": "system", "content": agent.SYSTEM_PROMPT},
        {"role": "user", "content": "Fix this behavior:\n\nExplicit editor context (untrusted project evidence):\n" + "context " * 3_000 + "\n\nCurrent public work plan:\n[]"},
        tool_call("read_file", {"path": "app.py"}),
        {"role": "tool", "tool_name": "read_file", "content": "source " * 6_000},
    ]
    fitted = agent._fit_context(messages)
    assert len(json.dumps(fitted, ensure_ascii=False)) <= 4096 * 3
    assert "Fix this behavior" in str(fitted)
    assert "omitted" in str(fitted)


def outcome(events):
    return next(event for event in reversed(events) if event["type"] == "outcome")


def test_plan_updates_are_structured_public_progress(tmp_path: Path):
    steps = [{"id": "inspect", "description": "Read entry point", "status": "in_progress"}]
    client = FakeToolClient([
        tool_call("update_plan", {"steps": steps, "explanation": "Scope is the entry point"}),
        tool_call("list_files", {}),
        {"content": "The workspace is empty."},
    ])
    events = list(WorkspaceAgent(tmp_path, client).run("Inspect the project", []))
    updates = [event for event in events if event["type"] == "plan"]
    assert updates[1]["steps"] == steps
    assert updates[1]["explanation"] == "Scope is the entry point"
    assert updates[-1]["steps"][0]["status"] == "completed"
    assert outcome(events)["status"] == "completed"


def test_invalid_plan_cannot_invent_a_second_in_progress_step(tmp_path: Path):
    steps = [{"id": str(index), "description": "Inspect", "status": "in_progress"} for index in range(2)]
    result, _ = WorkspaceAgent(tmp_path, FakeToolClient([]))._execute_tool("update_plan", {"steps": [{"id": "one", "description": "Inspect", "status": "pending"}]})
    assert result["steps"][0]["status"] == "pending"
    client = FakeToolClient([tool_call("update_plan", {"steps": steps}), tool_call("list_files", {}), {"content": "Empty workspace."}])
    events = list(WorkspaceAgent(tmp_path, client).run("Inspect workspace", []))
    assert any(event.get("name") == "update_plan" and event.get("status") == "error" for event in events)
    assert "Only one plan step" in str(client.calls[1]["messages"])


def test_accepted_proposal_pauses_without_another_model_turn(tmp_path: Path):
    client = FakeToolClient([tool_call("propose_command", {"profile": "pytest", "arguments": ["-q"], "purpose": "Verify the task"})])
    events = list(WorkspaceAgent(tmp_path, client).run("Run tests", []))
    assert len(client.calls) == 1
    assert outcome(events)["status"] == "awaiting_approval"
    assert "No files were changed" in events[-1]["content"]


def test_action_answer_without_work_gets_bounded_correction(tmp_path: Path):
    client = FakeToolClient([{"content": "I fixed it and all tests pass."}] * 3)
    events = list(WorkspaceAgent(tmp_path, client).run("Fix the bug", []))
    assert len(client.calls) == 3
    assert outcome(events)["status"] == "blocked"
    assert "all tests pass" not in events[-1]["content"]


def test_review_request_reports_findings_without_forcing_mutation(tmp_path: Path):
    (tmp_path / "app.py").write_text("value = 1\n", encoding="utf-8")
    client = FakeToolClient([tool_call("read_file", {"path": "app.py"}), {"content": "app.py defines a constant; no issue found."}])
    events = list(WorkspaceAgent(tmp_path, client).run("Review app.py for issues", []))
    assert outcome(events)["status"] == "completed"
    assert not any(event["type"] == "proposal" for event in events)


def test_grounded_noop_is_valid_for_action_request(tmp_path: Path):
    (tmp_path / "app.py").write_text("value = 2\n", encoding="utf-8")
    client = FakeToolClient([tool_call("read_file", {"path": "app.py"}), {"content": "No changes are needed: app.py already sets value to 2."}])
    events = list(WorkspaceAgent(tmp_path, client).run("Update app.py to value 2", []))
    assert outcome(events)["status"] == "completed"
    assert outcome(events)["evidence"]["inspected_paths"] == ["app.py"]


def test_modify_requires_a_current_base_read_and_can_recover(tmp_path: Path):
    (tmp_path / "app.py").write_text("value = 1\n", encoding="utf-8")
    proposal_call = tool_call("propose_change_set", {"summary": "Update value", "operations": [{"type": "modify", "path": "app.py", "summary": "Use two", "edits": [{"old_text": "value = 1", "new_text": "value = 2"}]}]})
    client = FakeToolClient([proposal_call, tool_call("read_file", {"path": "app.py"}), proposal_call])
    events = list(WorkspaceAgent(tmp_path, client).run("Fix app.py", []))
    assert "Read app.py in this cycle" in str(client.calls[1]["messages"])
    assert outcome(events)["status"] == "awaiting_approval"
    assert sum(event["type"] == "proposal" for event in events) == 1


def test_repeated_identical_tool_calls_stop_without_running_forever(tmp_path: Path):
    client = FakeToolClient([tool_call("list_files", {})] * 5)
    events = list(WorkspaceAgent(tmp_path, client).run("Inspect workspace", []))
    assert len(client.calls) == agent.MAX_REPEATED_TOOL_CALLS
    assert outcome(events)["status"] == "blocked"
    assert "repeated identical tool call" in events[-1]["content"]


def test_unknown_tool_names_are_bounded_and_never_executed(tmp_path: Path):
    client = FakeToolClient([tool_call("run_shell", {"command": str(index)}) for index in range(3)])
    events = list(WorkspaceAgent(tmp_path, client).run("Fix the project", []))
    assert outcome(events)["status"] == "blocked"
    assert len(client.calls) == 3
    assert "not permitted" in str(client.calls[-1]["messages"])


def test_tool_results_keep_native_call_ids_and_fallback_protocol(tmp_path: Path):
    native = tool_call("list_files", {})
    native["tool_calls"][0]["id"] = "native-call"
    fallback = {"content": '{"name":"get_file_metadata","arguments":{"path":"README.md"}}'}
    (tmp_path / "README.md").write_text("# Read me", encoding="utf-8")
    client = FakeToolClient([native, fallback, {"content": "Readme is a small text file."}])
    list(WorkspaceAgent(tmp_path, client).run("Inspect readme metadata", []))
    messages = client.calls[-1]["messages"]
    tool_messages = [message for message in messages if message["role"] == "tool"]
    calls = [call for message in messages for call in message.get("tool_calls", [])]
    assert tool_messages[0]["tool_call_id"] == calls[0]["id"] == "native-call"
    assert tool_messages[1]["tool_call_id"] == calls[1]["id"]
    assert calls[1]["function"]["name"] == "get_file_metadata"


def test_malformed_tool_results_keep_call_ids(tmp_path: Path):
    bad = tool_call("read_file", {})
    bad["tool_calls"][0].update(id="bad-call")
    bad["tool_calls"][0]["function"]["arguments"] = "{invalid"
    client = FakeToolClient([bad, tool_call("list_files", {}), {"content": "Empty workspace."}])
    list(WorkspaceAgent(tmp_path, client).run("Inspect workspace", []))
    assert client.calls[1]["messages"][-1]["tool_call_id"] == "bad-call"


def test_private_reasoning_is_not_exposed_or_executed(tmp_path: Path):
    client = FakeToolClient([
        tool_call("list_files", {}),
        {"thinking": "hidden provider reasoning", "content": '<think>{"name":"propose_file_change","arguments":{"path":"secret.py","content":"bad"}}</think>The workspace is empty.'},
    ])
    events = list(WorkspaceAgent(tmp_path, client).run("Inspect workspace", []))
    assert events[-1]["content"] == "The workspace is empty."
    assert "hidden provider reasoning" not in str(events)
    assert not any(event["type"] == "proposal" for event in events)


def test_unclosed_reasoning_block_never_becomes_public_answer(tmp_path: Path):
    client = FakeToolClient([tool_call("list_files", {}), {"content": "<think>Private unfinished deliberation"}])
    events = list(WorkspaceAgent(tmp_path, client).run("Inspect workspace", []))
    assert outcome(events)["status"] == "blocked"
    assert "Private unfinished" not in str(events)


def test_cancellation_stops_before_model_or_tool_call(tmp_path: Path):
    client = FakeToolClient([])
    events = list(WorkspaceAgent(tmp_path, client).run("Fix app.py", [], should_cancel=lambda: True))
    assert outcome(events)["status"] == "cancelled"
    assert not client.calls


def test_cancellation_after_inference_prevents_proposal(tmp_path: Path):
    class CancellingClient(FakeToolClient):
        cancelled = False

        def chat_with_tools(self, messages, tools, model=None):
            self.cancelled = True
            return super().chat_with_tools(messages, tools, model)

    client = CancellingClient([tool_call("propose_file_change", {"path": "app.py", "content": "bad", "explanation": "Create"})])
    events = list(WorkspaceAgent(tmp_path, client).run("Create app.py", [], should_cancel=lambda: client.cancelled))
    assert outcome(events)["status"] == "cancelled"
    assert not any(event["type"] == "proposal" for event in events)


def test_model_and_wall_clock_budgets_have_explicit_outcomes(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(agent, "MAX_AGENT_TURNS", 1)
    client = FakeToolClient([tool_call("list_files", {})])
    assert outcome(list(WorkspaceAgent(tmp_path, client).run("Inspect workspace", [])))["status"] == "exhausted"
    monkeypatch.setattr(agent, "MAX_AGENT_SECONDS", 0)
    client = FakeToolClient([])
    assert outcome(list(WorkspaceAgent(tmp_path, client).run("Inspect workspace", [])))["status"] == "exhausted"
    assert not client.calls


def test_feedback_keeps_original_goal_and_requests_missing_verification(tmp_path: Path):
    feedback = {"schema_version": 1, "changes": [{"id": "change1", "status": "applied"}], "requires_verification": True, "commands": []}
    client = FakeToolClient([
        {"content": "I implemented it and finished."},
        tool_call("propose_command", {"profile": "pytest", "arguments": ["-q"], "purpose": "Verify applied change"}),
    ])
    events = list(WorkspaceAgent(tmp_path, client).run("Fix the original bug", [], execution_feedback=feedback))
    assert outcome(events)["status"] == "awaiting_approval"
    assert "Fix the original bug" in str(client.calls[1]["messages"])
    assert "requires_verification" in str(client.calls[1]["messages"])
    assert "still requires verification" in str(client.calls[1]["messages"])


def test_verified_execution_feedback_can_complete_without_forcing_another_edit(tmp_path: Path):
    feedback = {"schema_version": 1, "changes": [{"id": "c1", "status": "applied"}], "commands": [{"status": "completed", "exit_code": 0}], "requires_verification": False, "verified_change_set_ids": ["c1"]}
    client = FakeToolClient([{"content": "Applied the fix and the recorded test command passed."}])
    events = list(WorkspaceAgent(tmp_path, client).run("Fix the bug", [], execution_feedback=feedback))
    assert outcome(events)["status"] == "completed"
    assert len(client.calls) == 1


def test_compaction_preserves_original_goal_during_correction(monkeypatch):
    monkeypatch.setattr(agent.settings, "ollama_context_length", 4096)
    messages = [
        {"role": "system", "content": agent.SYSTEM_PROMPT},
        {"role": "user", "content": "Original objective: fix parser\n\nCurrent public work plan:\n[]"},
        tool_call("read_file", {"path": "app.py"}),
        {"role": "tool", "tool_name": "read_file", "content": "evidence " * 10_000},
        {"role": "assistant", "content": "I will explain the fix."},
        {"role": "user", "content": "Continue with an actionable proposal."},
    ]
    fitted = agent._fit_context(messages)
    assert "Original objective: fix parser" in str(fitted)
    assert len(json.dumps(fitted, ensure_ascii=False)) <= 4096 * 3


def test_explanations_of_actions_keep_mutating_tools_unavailable():
    names = {tool["function"]["name"] for tool in agent._tools_for_prompt("Explain how to fix and test app.py")}
    assert "propose_change_set" not in names
    assert "propose_command" not in names
    names = {tool["function"]["name"] for tool in agent._tools_for_prompt("Review app.py and fix the issue")}
    assert "propose_change_set" in names


def test_failed_inspection_cannot_justify_action_noop(tmp_path: Path):
    client = FakeToolClient([
        tool_call("read_file", {"path": "missing.py"}),
        *[{"content": "No changes are needed: the code is already correct."}] * 3,
    ])
    events = list(WorkspaceAgent(tmp_path, client).run("Fix missing.py", []))
    assert outcome(events)["status"] == "blocked"
    assert not outcome(events)["evidence"]["inspected_paths"]


def test_fenced_replacement_requires_a_base_read_and_can_recover(tmp_path: Path):
    (tmp_path / "app.py").write_text("value = 1\n", encoding="utf-8")
    response = {"content": "Complete updated file app.py:\n```python filename=app.py\nvalue = 2\n```"}
    client = FakeToolClient([response, tool_call("read_file", {"path": "app.py"}), response])
    events = list(WorkspaceAgent(tmp_path, client).run("Update app.py", []))
    assert "Read the existing target files" in str(client.calls[1]["messages"])
    assert outcome(events)["status"] == "awaiting_approval"
    assert len(client.calls) == 3
    assert (tmp_path / "app.py").read_text(encoding="utf-8") == "value = 1\n"


def test_malformed_tool_history_can_encode_for_compatible_retry(tmp_path: Path):
    from codeme_agent.model_messages import compatible_messages

    malformed = tool_call("read_file", {})
    malformed["tool_calls"][0]["function"]["arguments"] = "{invalid"
    client = FakeToolClient([malformed, tool_call("list_files", {}), {"content": "Workspace is empty."}])
    list(WorkspaceAgent(tmp_path, client).run("Inspect workspace", []))
    encoded = compatible_messages(client.calls[1]["messages"])
    assert encoded[-1]["role"] == "tool"
    assert encoded[-2]["tool_calls"][0]["function"]["arguments"] == "{}"


def test_nested_reasoning_tags_do_not_leak_private_content(tmp_path: Path):
    client = FakeToolClient([tool_call("list_files", {}), {"content": "<think>secret <analysis>nested secret</analysis> trailing secret</think>Empty workspace."}])
    events = list(WorkspaceAgent(tmp_path, client).run("Inspect workspace", []))
    assert events[-1]["content"] == "Empty workspace."
    assert "secret" not in str(events)


def test_directory_listing_cannot_justify_action_noop(tmp_path: Path):
    (tmp_path / "app.py").write_text("value = 1\n", encoding="utf-8")
    client = FakeToolClient([tool_call("list_files", {}), *[{"content": "No changes are needed: app.py is already correct."}] * 3])
    events = list(WorkspaceAgent(tmp_path, client).run("Fix app.py", []))
    assert outcome(events)["status"] == "blocked"
    assert outcome(events)["evidence"]["inspected_paths"] == []


def test_exact_edits_require_the_observed_line_range_and_recover(tmp_path: Path):
    (tmp_path / "app.py").write_text("first = 1\nsecond = 2\n", encoding="utf-8")
    edit = tool_call("propose_change_set", {"summary": "Correct second value", "operations": [{
        "type": "modify", "path": "app.py", "summary": "Use three", "edits": [{"old_text": "second = 2", "new_text": "second = 3"}],
    }]})
    client = FakeToolClient([tool_call("read_file", {"path": "app.py", "start_line": 1, "end_line": 1}), edit,
                             tool_call("read_file", {"path": "app.py", "start_line": 2, "end_line": 2}), edit])
    events = list(WorkspaceAgent(tmp_path, client).run("Fix second value in app.py", []))
    assert "Read the exact text being edited" in str(client.calls[2]["messages"])
    assert sum(event["type"] == "proposal" for event in events) == 1
    assert outcome(events)["status"] == "awaiting_approval"


def test_partial_read_cannot_authorize_whole_file_replacement(tmp_path: Path):
    original = "first = 1\nsecond = 2\n"
    (tmp_path / "app.py").write_text(original, encoding="utf-8")
    replace = tool_call("propose_file_change", {"path": "app.py", "content": "first = 3\n", "explanation": "Update value"})
    client = FakeToolClient([tool_call("read_file", {"path": "app.py", "start_line": 1, "end_line": 1}), replace])
    events = list(WorkspaceAgent(tmp_path, client).run("Update app.py", []))
    assert not any(event["type"] == "proposal" for event in events)
    assert "preserve unread content" in str(client.calls[-1]["messages"])
    assert (tmp_path / "app.py").read_text(encoding="utf-8") == original


def test_partial_fenced_replacement_can_recover_with_complete_read(tmp_path: Path):
    (tmp_path / "app.py").write_text("first = 1\nsecond = 2\n", encoding="utf-8")
    response = {"content": "Complete updated file:\n```python filename=app.py\nfirst = 3\nsecond = 2\n```"}
    client = FakeToolClient([tool_call("read_file", {"path": "app.py", "end_line": 1}), response,
                             tool_call("read_file", {"path": "app.py"}), response])
    events = list(WorkspaceAgent(tmp_path, client).run("Update app.py", []))
    assert "complete bounded content" in str(client.calls[2]["messages"])
    assert sum(event["type"] == "proposal" for event in events) == 1
    assert outcome(events)["status"] == "awaiting_approval"


def test_external_file_change_requires_new_read_before_proposal(tmp_path: Path):
    target = tmp_path / "app.py"
    target.write_bytes(b"value = 1\n")
    edit = tool_call("propose_change_set", {"summary": "Use two", "operations": [{
        "type": "modify", "path": "app.py", "summary": "Use two", "edits": [{"old_text": "value = 1", "new_text": "value = 2"}],
    }]})
    class ConcurrentEditClient(FakeToolClient):
        def chat_with_tools(self, messages, tools, model=None):
            if len(self.calls) == 1:
                target.write_bytes(b"value = 1\nuser_change = True\n")
            return super().chat_with_tools(messages, tools, model)
    client = ConcurrentEditClient([tool_call("read_file", {"path": "app.py"}), edit,
                                   tool_call("read_file", {"path": "app.py"}), edit])
    events = list(WorkspaceAgent(tmp_path, client).run("Update value in app.py", []))
    assert "changed since its last read" in str(client.calls[2]["messages"])
    proposal = next(event for event in events if event["type"] == "proposal")
    assert proposal["change_set"]["operations"][0]["proposed_content"] == "value = 2\nuser_change = True\n"


def test_truncated_tool_reply_cannot_authorize_unseen_exact_text(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(agent.settings, "ollama_context_length", 16384)
    (tmp_path / "app.py").write_text("# " + "x" * 17_000 + "\nvalue = 1\n", encoding="utf-8")
    edit = tool_call("propose_change_set", {"summary": "Use two", "operations": [{
        "type": "modify", "path": "app.py", "summary": "Use two", "edits": [{"old_text": "value = 1", "new_text": "value = 2"}],
    }]})
    client = FakeToolClient([tool_call("read_file", {"path": "app.py"}), edit])
    events = list(WorkspaceAgent(tmp_path, client).run("Update app.py", []))
    assert not any(event["type"] == "proposal" for event in events)
    assert "Read the exact text being edited" in str(client.calls[-1]["messages"])


def test_model_observed_crlf_text_can_be_used_as_exact_multiline_edit(tmp_path: Path):
    (tmp_path / "app.py").write_bytes(b"first = 1\r\nsecond = 2\r\n")
    edit = tool_call("propose_change_set", {"summary": "Correct values", "operations": [{
        "type": "modify", "path": "app.py", "summary": "Use new values", "edits": [{"old_text": "first = 1\r\nsecond = 2", "new_text": "first = 3\nsecond = 4"}],
    }]})
    client = FakeToolClient([tool_call("read_file", {"path": "app.py"}), edit])
    events = list(WorkspaceAgent(tmp_path, client).run("Update app.py", []))
    proposal = next(event for event in events if event["type"] == "proposal")
    assert proposal["change_set"]["operations"][0]["proposed_content"] == "first = 3\r\nsecond = 4\r\n"


def test_runtime_context_budget_includes_native_tool_schemas(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(agent.settings, "ollama_context_length", 4096)
    (tmp_path / "app.py").write_bytes(b"# " + b"x" * 20_000 + b"\n")
    client = FakeToolClient([tool_call("read_file", {"path": "app.py"}), {"content": "The inspected file contains one long comment."}])
    list(WorkspaceAgent(tmp_path, client).run("Inspect app.py", []))
    for call in client.calls:
        assert len(json.dumps(call["messages"], ensure_ascii=False)) + len(json.dumps(call["tools"], ensure_ascii=False)) <= 4096 * 3


def test_context_budget_never_silently_truncates_original_goal(monkeypatch):
    import pytest
    from codeme_agent.workspace import WorkspaceSecurityError
    monkeypatch.setattr(agent.settings, "ollama_context_length", 4096)
    goal = "Fix the parser while preserving these required constraints: " + "constraint " * 1000
    messages = [{"role": "system", "content": agent.SYSTEM_PROMPT},
                {"role": "user", "content": goal + "\n\nCurrent public work plan:\n[]"}]
    with pytest.raises(WorkspaceSecurityError, match="not silently truncated"):
        agent._fit_context(messages, agent.TOOLS)


def test_parallel_read_and_edit_must_wait_for_observed_base(tmp_path: Path):
    (tmp_path / "app.py").write_bytes(b"value = 1\n")
    read = tool_call("read_file", {"path": "app.py"})
    edit = tool_call("propose_change_set", {"summary": "Use two", "operations": [{
        "type": "modify", "path": "app.py", "summary": "Use two", "edits": [{"old_text": "value = 1", "new_text": "value = 2"}],
    }]})
    parallel = {"content": "", "tool_calls": [*read["tool_calls"], *edit["tool_calls"]]}
    client = FakeToolClient([parallel, edit])
    events = list(WorkspaceAgent(tmp_path, client).run("Update app.py", []))
    assert len(client.calls) == 2
    assert "Read app.py in this cycle" in str(client.calls[1]["messages"])
    assert sum(event["type"] == "proposal" for event in events) == 1
    assert outcome(events)["status"] == "awaiting_approval"


def test_compacted_read_requires_a_narrower_observed_range_before_edit(tmp_path: Path):
    (tmp_path / "app.py").write_bytes(b"value = 1\n# " + b"x" * 17_000 + b"\n")
    edit = tool_call("propose_change_set", {"summary": "Use two", "operations": [{
        "type": "modify", "path": "app.py", "summary": "Use two", "edits": [{"old_text": "value = 1", "new_text": "value = 2"}],
    }]})
    client = FakeToolClient([tool_call("read_file", {"path": "app.py"}), edit,
                             tool_call("read_file", {"path": "app.py", "start_line": 1, "end_line": 1}), edit])
    events = list(WorkspaceAgent(tmp_path, client).run("Update app.py", []))
    assert "Read app.py in this cycle" in str(client.calls[2]["messages"])
    assert sum(event["type"] == "proposal" for event in events) == 1
    assert outcome(events)["status"] == "awaiting_approval"
