import os
import tempfile
from pathlib import Path

import pytest

from codeme_agent.workspace import canonicalize_workspace_path, normalize_workspace_root, WorkspaceSecurityError


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
