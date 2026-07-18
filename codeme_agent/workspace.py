import json
import shutil
import subprocess
from pathlib import Path, PureWindowsPath
from typing import Iterable

from codeme_agent.config import settings

EXCLUDED_DIR_NAMES = {
    ".git",
    "node_modules",
    "dist",
    "build",
    "coverage",
    "bin",
    "obj",
    ".venv",
    "venv",
    "__pycache__",
}

SECRET_FILE_NAMES = {
    ".env",
    ".env.local",
    ".env.development",
    ".env.test",
    ".git-credentials",
    "id_rsa",
    "id_dsa",
    "id_ecdsa",
    "id_ed25519",
}

SECRET_SUFFIXES = {
    ".key",
    ".pem",
    ".p12",
    ".pfx",
    ".crt",
    ".der",
    ".asc",
    ".enc",
    ".secret",
    ".token",
}

DEFAULT_FILE_READ_LIMIT = 1_500_000
DEFAULT_SEARCH_PAGE_SIZE = 50
DEFAULT_SEARCH_TIMEOUT = 5


class WorkspaceError(Exception):
    pass


class WorkspaceNotFoundError(WorkspaceError):
    pass


class WorkspaceSecurityError(WorkspaceError):
    pass


def is_unc_path(path: Path) -> bool:
    if path.drive.startswith("\\\\"):
        return True
    if isinstance(path, PureWindowsPath):
        return path.anchor.startswith("\\\\")
    return False


def _resolve_path(path: Path, strict: bool = True) -> Path:
    try:
        return path.resolve(strict=strict)
    except FileNotFoundError as exc:
        raise WorkspaceSecurityError(f"Path does not exist: {path}") from exc


def normalize_workspace_root(path: str | None = None) -> Path:
    root = Path(path) if path else Path(settings.default_workspace_root)
    if not root.is_absolute():
        root = Path.cwd() / root

    if is_unc_path(root) and not settings.allow_unc_paths:
        raise WorkspaceSecurityError("UNC paths are disabled for workspace registration")

    canonical_root = _resolve_path(root, strict=True)
    if not canonical_root.exists() or not canonical_root.is_dir():
        raise WorkspaceSecurityError("Workspace root must be an existing directory")

    return canonical_root


def assert_within_workspace(root: Path, candidate: Path) -> None:
    try:
        candidate.relative_to(root)
    except ValueError as exc:
        raise WorkspaceSecurityError("Path is outside the registered workspace") from exc


def canonicalize_workspace_path(root: Path, path: str | None = None) -> Path:
    if path is None or path == "":
        return root

    candidate = Path(path)
    if not candidate.is_absolute():
        candidate = root.joinpath(candidate)

    if is_unc_path(candidate) and not settings.allow_unc_paths:
        raise WorkspaceSecurityError("UNC paths are disabled")

    resolved = _resolve_path(candidate, strict=True)
    assert_within_workspace(root, resolved)
    return resolved


def is_excluded_path(path: Path, root: Path) -> bool:
    try:
        relative = path.relative_to(root)
    except ValueError:
        return True

    for part in relative.parts:
        if part in EXCLUDED_DIR_NAMES:
            return True
        if part.startswith(".") and part.lower().startswith(".env"):
            return True
        if part.lower() in SECRET_FILE_NAMES:
            return True

    name = path.name.lower()
    if name in SECRET_FILE_NAMES or name.startswith(".env"):
        return True
    if any(name.endswith(suffix) for suffix in SECRET_SUFFIXES):
        return True

    return False


def is_binary_file(path: Path) -> bool:
    if path.is_dir():
        return False
    try:
        with path.open("rb") as handle:
            chunk = handle.read(4096)
    except OSError:
        return False

    if b"\x00" in chunk:
        return True

    text_chars = bytearray({7, 8, 9, 10, 12, 13, 27} | set(range(0x20, 0x100)) - {0x7f})
    return bool(chunk and any(byte not in text_chars for byte in chunk))


def list_directory(root: Path, path: str | None = None, page: int = 1, page_size: int = 100) -> tuple[list[dict], bool]:
    if page < 1 or page_size < 1 or page_size > 250:
        raise WorkspaceSecurityError("Pagination parameters are invalid")

    directory = canonicalize_workspace_path(root, path)
    if not directory.is_dir():
        raise WorkspaceSecurityError("Requested path is not a directory")
    if is_excluded_path(directory, root):
        raise WorkspaceSecurityError("Requested directory is excluded")

    entries = []
    for entry in sorted(directory.iterdir(), key=lambda item: (not item.is_dir(), item.name.lower())):
        if is_excluded_path(entry, root):
            continue
        stat = entry.stat()
        entries.append(
            {
                "path": str(entry.relative_to(root).as_posix()),
                "name": entry.name,
                "is_dir": entry.is_dir(),
                "size": None if entry.is_dir() else stat.st_size,
                "modified_at": stat.st_mtime and datetime_from_timestamp(stat.st_mtime),
            }
        )

    start = (page - 1) * page_size
    end = start + page_size
    page_entries = entries[start:end]
    has_more = len(entries) > end
    return page_entries, has_more


def datetime_from_timestamp(ts: float):
    from datetime import datetime

    return datetime.fromtimestamp(ts)


def get_file_metadata(root: Path, path: str | None = None) -> dict:
    target = canonicalize_workspace_path(root, path)
    if is_excluded_path(target, root):
        raise WorkspaceSecurityError("Requested file is excluded")

    stat = target.stat()
    return {
        "path": str(target.relative_to(root).as_posix()),
        "is_dir": target.is_dir(),
        "size": stat.st_size,
        "modified_at": datetime_from_timestamp(stat.st_mtime),
    }


def read_file(root: Path, path: str) -> dict:
    target = canonicalize_workspace_path(root, path)
    if target.is_dir():
        raise WorkspaceSecurityError("Requested path is a directory")
    if is_excluded_path(target, root):
        raise WorkspaceSecurityError("Requested file is excluded")
    if is_binary_file(target):
        raise WorkspaceSecurityError("Binary files cannot be read")
    if target.stat().st_size > settings.max_file_size:
        raise WorkspaceSecurityError("File size exceeds the configured limit")

    with target.open("r", encoding="utf-8", errors="replace") as handle:
        content = handle.read(settings.max_file_size + 1)

    metadata = get_file_metadata(root, path)
    return {"path": metadata["path"], "content": content, "metadata": metadata}


def _git_command(root: Path, args: list[str], timeout: int = 5) -> subprocess.CompletedProcess:
    if shutil.which("git") is None:
        raise WorkspaceError("Git is not installed")

    return subprocess.run(
        ["git", *args],
        cwd=root,
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
    )


def get_git_status(root: Path) -> dict:
    try:
        result = _git_command(root, ["rev-parse", "--is-inside-work-tree"])
    except WorkspaceError:
        return {"is_git": False, "status": []}
    if result.returncode != 0 or result.stdout.strip() != "true":
        return {"is_git": False, "status": []}

    status_result = _git_command(root, ["status", "--porcelain"])
    if status_result.returncode != 0:
        return {"is_git": True, "status": []}

    status_entries = []
    for line in status_result.stdout.splitlines():
        if not line.strip():
            continue
        status_text = line[:2].strip()
        path_text = line[3:].strip() if len(line) > 3 else line[2:].strip()
        status_entries.append({"path": path_text, "status": status_text})

    return {"is_git": True, "status": status_entries}


def get_git_diff(root: Path, path: str | None = None) -> dict:
    status = get_git_status(root)
    if not status["is_git"]:
        return {"path": path, "diff": ""}

    if path is None:
        working = _git_command(root, ["diff", "--no-ext-diff", "--relative"])
        staged = _git_command(root, ["diff", "--cached", "--no-ext-diff", "--relative"])
        if working.returncode not in (0, 1) or staged.returncode not in (0, 1):
            raise WorkspaceError("Git diff failed")
        sections = []
        if working.stdout:
            sections.append("# Working tree\n" + working.stdout)
        if staged.stdout:
            sections.append("# Staged changes\n" + staged.stdout)
        return {"path": None, "diff": "\n".join(sections)}

    target = canonicalize_workspace_path(root, path)
    if is_excluded_path(target, root):
        raise WorkspaceSecurityError("Requested file is excluded")

    rel_path = str(target.relative_to(root))
    diff_result = _git_command(root, ["diff", "--no-ext-diff", "--relative", "--", rel_path])
    if diff_result.returncode not in (0, 1):
        raise WorkspaceError("Git diff failed")
    return {"path": rel_path, "diff": diff_result.stdout}


def search_code(root: Path, query: str, page: int = 1, page_size: int = DEFAULT_SEARCH_PAGE_SIZE) -> dict:
    if not query.strip():
        return {"results": [], "page": page, "page_size": page_size, "has_more": False}
    if page < 1 or page_size < 1 or page_size > 200:
        raise WorkspaceSecurityError("Invalid search pagination")
    if shutil.which("rg") is None:
        raise WorkspaceError("ripgrep (rg) is required for search")

    max_matches = page * page_size + 1
    cmd = [
        "rg",
        "--json",
        "--no-config",
        "--no-ignore",
        "--hidden",
        "--max-filesize",
        "4M",
        "--max-count",
        str(max_matches),
        query,
        str(root),
    ]

    for excluded in EXCLUDED_DIR_NAMES:
        cmd.extend(["--glob", f"!{excluded}/**"])
    for env_name in [".env", ".env.*"]:
        cmd.extend(["--glob", f"!{env_name}"])

    result = subprocess.run(cmd, cwd=root, capture_output=True, text=True, timeout=DEFAULT_SEARCH_TIMEOUT)
    if result.returncode not in (0, 1):
        raise WorkspaceError("ripgrep search failed")

    results = []
    for raw in result.stdout.splitlines():
        if not raw.strip():
            continue
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if payload.get("type") != "match":
            continue
        data = payload.get("data", {})
        path_text = data.get("path", {}).get("text")
        if not path_text:
            continue
        candidate = root.joinpath(path_text)
        if is_excluded_path(candidate, root):
            continue
        line_number = data.get("line_number", 0)
        submatches = data.get("submatches", [])
        text = submatches[0].get("match", {}).get("text", "") if submatches else ""
        column = submatches[0].get("start", 0) + 1 if submatches else 0
        results.append(
            {
                "path": str(Path(path_text).as_posix()),
                "line": line_number,
                "column": column,
                "text": text,
            }
        )

    has_more = len(results) > page_size
    return {
        "results": results[(page - 1) * page_size : page * page_size],
        "page": page,
        "page_size": page_size,
        "has_more": has_more,
    }


def find_agent_instructions(root: Path, path: str | None = None) -> dict:
    current = canonicalize_workspace_path(root, path)
    if current.is_file():
        current = current.parent

    while True:
        agent_file = current / "AGENTS.md"
        if agent_file.exists() and agent_file.is_file() and not is_excluded_path(agent_file, root):
            if is_binary_file(agent_file):
                break
            with agent_file.open("r", encoding="utf-8", errors="replace") as handle:
                return {
                    "instructions": [
                        {
                            "path": str(agent_file.relative_to(root).as_posix()),
                            "content": handle.read(),
                        }
                    ]
                }
        if current == root:
            break
        current = current.parent

    return {"instructions": []}
