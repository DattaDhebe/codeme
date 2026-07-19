from pathlib import Path

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


def test_project_analysis_uses_grounded_snapshot_without_exposing_tools(tmp_path: Path):
    (tmp_path / "README.md").write_text("# Sample API\n", encoding="utf-8")
    (tmp_path / "main.py").write_text("from fastapi import FastAPI\n", encoding="utf-8")
    client = FakeToolClient([{"role": "assistant", "content": "This is a FastAPI service."}])

    events = list(WorkspaceAgent(tmp_path, client=client).run("Analyze the current project architecture", []))

    assert any(event.get("name") == "project_snapshot" for event in events)
    assert events[-1]["content"] == "This is a FastAPI service."
    assert client.calls[0]["tools"] == []
    combined_context = "\n".join(message["content"] for message in client.calls[0]["messages"])
    assert "# Sample API" in combined_context


def test_agent_converts_labelled_whole_file_fence_to_safe_proposal(tmp_path: Path):
    original = "# Python\n.venv/\n__pycache__/\n"
    (tmp_path / ".gitignore").write_text(original, encoding="utf-8")
    response = "My apologies. Here is the updated `.gitignore` file with only `.zip` added:\n\n```plaintext\n# Python\n.venv/\n__pycache__/\n*.zip\n```"
    client = FakeToolClient([{"role": "assistant", "content": response}])

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
    client = FakeToolClient([{"role": "assistant", "content": response}])

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

    assert events[-1]["content"] == "I stopped after three malformed tool calls. No changes were applied."


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
    tool_result = client.calls[-1]["messages"][-1]["content"]
    assert '"requires_approval": false' in tool_result
