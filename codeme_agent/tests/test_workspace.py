import shutil
import subprocess
import sys
from pathlib import Path, PurePosixPath, PureWindowsPath

import pytest

from codeme_agent import workspace
from codeme_agent.workspace import canonicalize_workspace_path, normalize_workspace_root, WorkspaceSecurityError


@pytest.mark.parametrize("native_path", [PurePosixPath, PureWindowsPath])
def test_action_path_guards_do_not_depend_on_native_host_path_syntax(monkeypatch, native_path):
    monkeypatch.setattr(workspace, "Path", native_path)
    for forbidden in ("C:outside.txt", "C:/outside.txt", "C:\\outside.txt", "\\outside.txt", "\\\\server\\share\\file.txt", "/outside.txt"):
        with pytest.raises(WorkspaceSecurityError):
            workspace.normalize_action_path(forbidden)
    assert workspace.normalize_action_path("src\\nested\\file.py") == "src/nested/file.py"
    assert workspace.normalize_action_path("./src/file.py") == "src/file.py"
    assert workspace.normalize_action_path(".", allow_root=True) == "."


def test_normalize_workspace_root_with_existing_directory(tmp_path: Path):
    workspace_dir = tmp_path / "repo"
    workspace_dir.mkdir()

    result = normalize_workspace_root(str(workspace_dir))

    assert result == workspace_dir.resolve()


def test_normalize_workspace_root_rejects_missing_directory(tmp_path: Path):
    missing_dir = tmp_path / "missing"

    with pytest.raises(WorkspaceSecurityError):
        normalize_workspace_root(str(missing_dir))


def test_canonicalize_workspace_path_rejects_outside_paths(tmp_path: Path):
    workspace_dir = tmp_path / "repo"
    workspace_dir.mkdir()
    file_path = workspace_dir / "file.txt"
    file_path.write_text("hello")

    with pytest.raises(WorkspaceSecurityError):
        canonicalize_workspace_path(workspace_dir, "../outside.txt")


def test_canonicalize_workspace_path_expands_relative_paths(tmp_path: Path):
    workspace_dir = tmp_path / "repo"
    workspace_dir.mkdir()
    file_path = workspace_dir / "file.txt"
    file_path.write_text("hello")

    target = canonicalize_workspace_path(workspace_dir, "file.txt")
    assert target == file_path.resolve()


def test_instructions_merge_root_to_leaf_and_support_new_files(tmp_path: Path):
    (tmp_path / "AGENTS.md").write_text("Use local tools.", encoding="utf-8")
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "AGENTS.md").write_text("Use typed functions.", encoding="utf-8")
    result = workspace.find_agent_instructions(tmp_path, "src/new.py")
    assert [item["path"] for item in result["instructions"]] == ["AGENTS.md", "src/AGENTS.md"]
    assert result["instructions"][0]["content"] == "Use local tools."


def test_instruction_symlink_cannot_read_outside_workspace(tmp_path: Path):
    root = tmp_path / "repo"
    root.mkdir()
    outside = tmp_path / "private.txt"
    outside.write_text("private", encoding="utf-8")
    try:
        (root / "AGENTS.md").symlink_to(outside)
    except OSError:
        pytest.skip("Symlink creation requires Windows developer mode or privileges")
    with pytest.raises(WorkspaceSecurityError):
        workspace.find_agent_instructions(root)
    entries, _ = workspace.list_directory(root)
    assert entries == []


def test_read_file_returns_requested_line_window(tmp_path: Path):
    (tmp_path / "app.py").write_bytes(b"one\ntwo\nthree\nfour\n")
    result = workspace.read_file(tmp_path, "app.py", 2, 3)
    assert result["content"] == "two\nthree\n"
    assert result["total_lines"] == 4 and result["has_more"]
    with pytest.raises(WorkspaceSecurityError):
        workspace.read_file(tmp_path, "app.py", 0, 3)


def test_read_file_preserves_crlf_and_binds_ranges_to_complete_file_hash(tmp_path: Path):
    from codeme_agent.changesets import sha256_text
    content = "one\r\ntwo\r\nthree\r\n"
    (tmp_path / "windows.txt").write_bytes(content.encode("utf-8"))
    result = workspace.read_file(tmp_path, "windows.txt", 2, 2)
    assert result["content"] == "two\r\n"
    assert result["content_sha256"] == sha256_text(content)


@pytest.mark.skipif(shutil.which("rg") is None, reason="ripgrep is required")
def test_search_returns_relative_context_and_accurate_pages(tmp_path: Path):
    (tmp_path / "app.py").write_text("first needle\nsecond needle\nthird needle\n", encoding="utf-8")
    result = workspace.search_code(tmp_path, "needle", page=2, page_size=2)
    assert result["results"] == [{"path": "app.py", "line": 3, "column": 7, "text": "third needle"}]
    assert not result["has_more"]


@pytest.mark.skipif(shutil.which("rg") is None, reason="ripgrep is required")
def test_search_honors_ignores_and_handles_dash_patterns(tmp_path: Path):
    (tmp_path / ".git").mkdir()
    (tmp_path / ".gitignore").write_text("ignored.txt\n", encoding="utf-8")
    (tmp_path / "ignored.txt").write_text("--help", encoding="utf-8")
    (tmp_path / "app.py").write_text("print('--help')\n", encoding="utf-8")
    (tmp_path / ".env").write_text("SECRET=--help", encoding="utf-8")
    result = workspace.search_code(tmp_path, "--help")
    assert [item["path"] for item in result["results"]] == ["app.py"]
    assert result["results"][0]["text"] == "print('--help')"


def test_repository_tool_output_is_bounded(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(workspace, "MAX_COMMAND_OUTPUT", 2_000)
    result, truncated = workspace._bounded_command(tmp_path, [sys.executable, "-c", "print('x' * 20000)"])
    assert truncated and len(result.stdout) == 2_000


def test_repository_tool_timeout_is_a_recoverable_error(tmp_path: Path):
    with pytest.raises(workspace.WorkspaceError, match="timed out"):
        workspace._bounded_command(tmp_path, [sys.executable, "-c", "import time; time.sleep(5)"], timeout=0.05)


@pytest.mark.skipif(shutil.which("git") is None, reason="Git is required")
def test_git_diff_includes_staged_deleted_files_without_secrets(tmp_path: Path):
    def git(*args):
        subprocess.run(["git", *args], cwd=tmp_path, check=True, capture_output=True)
    git("init")
    for name, text in (("app.py", "old\n"), ("deleted.py", "removed\n"), (".env", "SECRET=before\n")):
        (tmp_path / name).write_text(text, encoding="utf-8")
    git("add", "--all")
    git("-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-m", "base")
    (tmp_path / "app.py").write_text("new\n", encoding="utf-8")
    git("add", "app.py")
    (tmp_path / "deleted.py").unlink()
    (tmp_path / ".env").write_text("SECRET=after\n", encoding="utf-8")
    diff = workspace.get_git_diff(tmp_path)["diff"]
    assert "+new" in diff and "Staged changes" in diff and "deleted.py" in diff
    assert "SECRET=" not in diff and ".env" not in diff
    assert "deleted.py" in workspace.get_git_diff(tmp_path, "deleted.py")["diff"]


@pytest.mark.skipif(shutil.which("git") is None, reason="Git is required")
def test_git_status_is_relative_to_registered_subdirectory(tmp_path: Path):
    subprocess.run(["git", "init"], cwd=tmp_path, check=True, capture_output=True)
    root = tmp_path / "src"
    root.mkdir()
    (root / "app.py").write_text("value = 1\n", encoding="utf-8")
    subprocess.run(["git", "add", "src/app.py"], cwd=tmp_path, check=True, capture_output=True)
    assert workspace.get_git_status(root)["status"] == [{"path": "app.py", "status": "A"}]
