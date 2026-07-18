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
