import json
import hashlib
import shutil
import subprocess
import threading
from pathlib import Path, PureWindowsPath

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
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
    ".angular",
    ".next",
    ".nuxt",
    ".cache",
    ".runtime",
    ".aws",
    ".ssh",
    ".azure",
    ".gnupg",
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
MAX_COMMAND_OUTPUT = 2_000_000
MAX_SEARCH_PAGES = 100
MAX_INSTRUCTION_TEXT = 12_000


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
    except (OSError, RuntimeError) as exc:
        raise WorkspaceSecurityError("Path cannot be resolved inside the workspace") from exc


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
        if part.lower() in EXCLUDED_DIR_NAMES:
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
        try:
            resolved = _resolve_path(entry)
            assert_within_workspace(root, resolved)
            if is_excluded_path(resolved, root):
                continue
            stat = entry.stat()
        except (WorkspaceError, OSError):
            continue
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


def read_file(root: Path, path: str, start_line: int | None = None, end_line: int | None = None) -> dict:
    if start_line is not None and (type(start_line) is not int or start_line < 1):
        raise WorkspaceSecurityError("start_line must be a positive integer")
    if end_line is not None and (type(end_line) is not int or end_line < (start_line or 1)):
        raise WorkspaceSecurityError("end_line must be at least start_line")
    target = canonicalize_workspace_path(root, path)
    if target.is_dir():
        raise WorkspaceSecurityError("Requested path is a directory")
    if is_excluded_path(target, root):
        raise WorkspaceSecurityError("Requested file is excluded")
    if is_binary_file(target):
        raise WorkspaceSecurityError("Binary files cannot be read")
    if target.stat().st_size > settings.max_file_size:
        raise WorkspaceSecurityError("File size exceeds the configured limit")

    # Search/replace proposals bind to exact UTF-8 bytes. Universal-newline
    # translation would make an observed CRLF excerpt fail against its base.
    with target.open("r", encoding="utf-8", errors="replace", newline="") as handle:
        content = handle.read(settings.max_file_size + 1)
    if len(content) > settings.max_file_size:
        raise WorkspaceSecurityError("File size exceeds the configured limit")
    metadata = get_file_metadata(root, path)
    result = {"path": metadata["path"], "content": content, "metadata": metadata,
              "content_sha256": hashlib.sha256(content.encode("utf-8")).hexdigest()}
    if start_line is not None or end_line is not None:
        lines = content.splitlines(keepends=True)
        first = start_line or 1
        last = min(end_line or len(lines), len(lines))
        result.update(content="".join(lines[first - 1:last]), start_line=first,
                      end_line=last, total_lines=len(lines), has_more=last < len(lines))
    return result


def _bounded_command(root: Path, command: list[str], timeout: int = 5) -> tuple[subprocess.CompletedProcess, bool]:
    """Cap subprocess output while it is produced, including on large repositories."""
    chunks: list[bytes] = []
    truncated = False
    try:
        process = subprocess.Popen(command, cwd=root, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    except OSError as exc:
        raise WorkspaceError("Repository tool could not be started") from exc

    def consume() -> None:
        nonlocal truncated
        remaining = MAX_COMMAND_OUTPUT
        while process.stdout is not None:
            chunk = process.stdout.read(min(65_536, remaining + 1))
            if not chunk:
                break
            chunks.append(chunk[:remaining])
            remaining -= len(chunk)
            if remaining < 0:
                truncated = True
                try:
                    process.kill()
                except OSError:
                    pass
                break

    reader = threading.Thread(target=consume, daemon=True)
    reader.start()
    try:
        process.wait(timeout=timeout)
    except subprocess.TimeoutExpired as exc:
        process.kill()
        process.wait()
        reader.join(timeout=1)
        raise WorkspaceError("Repository tool timed out; narrow the request and retry") from exc
    finally:
        reader.join(timeout=1)
        if process.stdout is not None:
            process.stdout.close()
    output = b"".join(chunks).decode("utf-8", errors="replace")
    return subprocess.CompletedProcess(command, process.returncode, output, ""), truncated

def _git_command(root: Path, args: list[str], timeout: int = 5) -> subprocess.CompletedProcess:
    if shutil.which("git") is None:
        raise WorkspaceError("Git is not installed")
    result, truncated = _bounded_command(root, ["git", "-c", "core.fsmonitor=false", "--no-optional-locks", *args], timeout)
    if truncated:
        raise WorkspaceError("Git output exceeded the limit; request one relevant file")
    return result


def get_git_status(root: Path) -> dict:
    try:
        result = _git_command(root, ["rev-parse", "--is-inside-work-tree"])
    except WorkspaceError:
        return {"is_git": False, "status": []}
    if result.returncode != 0 or result.stdout.strip() != "true":
        return {"is_git": False, "status": []}
    status_result = _git_command(root, ["status", "--porcelain=v1", "-z", "--", "."])
    if status_result.returncode != 0:
        raise WorkspaceError("Git status failed")
    prefix_result = _git_command(root, ["rev-parse", "--show-prefix"])
    prefix = prefix_result.stdout.strip().replace("\\", "/") if prefix_result.returncode == 0 else ""
    entries = []
    records = iter(status_result.stdout.split("\0"))
    for record in records:
        if len(record) < 4:
            continue
        status_text, path_text = record[:2], record[3:]
        if "R" in status_text or "C" in status_text:
            next(records, None)  # Porcelain -z includes the original path after a rename.
        if prefix:
            if not path_text.startswith(prefix):
                continue
            path_text = path_text[len(prefix):]
        if not is_excluded_path(root / path_text, root):
            entries.append({"path": Path(path_text).as_posix(), "status": status_text.strip()})
    return {"is_git": True, "status": entries}


def _diff_pathspecs() -> list[str]:
    exclusions = [f":(glob,icase,exclude)**/{name}/**" for name in sorted(EXCLUDED_DIR_NAMES)]
    exclusions.extend(f":(glob,icase,exclude)**/{name}" for name in sorted(SECRET_FILE_NAMES))
    exclusions.append(":(glob,icase,exclude)**/.env*")
    exclusions.extend(f":(glob,icase,exclude)**/*{suffix}" for suffix in sorted(SECRET_SUFFIXES))
    return [".", *exclusions]


def get_git_diff(root: Path, path: str | None = None) -> dict:
    status = get_git_status(root)
    if not status["is_git"]:
        return {"path": path, "diff": ""}
    relative = None
    if path:
        # Deleted files still have a useful diff; resolve existing ancestors safely.
        target = (root / path).resolve(strict=False)
        assert_within_workspace(root, target)
        if is_excluded_path(target, root):
            raise WorkspaceSecurityError("Requested file is excluded")
        relative = target.relative_to(root).as_posix()
    pathspecs = [relative, *_diff_pathspecs()[1:]] if relative else _diff_pathspecs()
    sections = []
    for label, extra in (("Working tree", []), ("Staged changes", ["--cached"])):
        result = _git_command(root, ["diff", *extra, "--no-ext-diff", "--no-textconv", "--no-renames", "--relative", "--", *pathspecs])
        if result.returncode not in (0, 1):
            raise WorkspaceError("Git diff failed")
        if result.stdout:
            sections.append(f"# {label}\n" + result.stdout)
    return {"path": relative, "diff": "\n".join(sections)}

def search_code(root: Path, query: str, page: int = 1, page_size: int = DEFAULT_SEARCH_PAGE_SIZE, path: str | None = None) -> dict:
    if type(page) is not int or type(page_size) is not int or page < 1 or page > MAX_SEARCH_PAGES or page_size < 1 or page_size > 200:
        raise WorkspaceSecurityError("Invalid search pagination")
    if not isinstance(query, str) or len(query) > 2_000:
        raise WorkspaceSecurityError("Search expression must be bounded text")
    if not query.strip():
        return {"results": [], "page": page, "page_size": page_size, "has_more": False}
    if shutil.which("rg") is None:
        raise WorkspaceError("ripgrep (rg) is required for search")
    target = canonicalize_workspace_path(root, path)
    if is_excluded_path(target, root):
        raise WorkspaceSecurityError("Requested search path is excluded")
    cmd = ["rg", "--json", "--no-config", "--hidden", "--max-filesize", "4M", "--max-count", str(page * page_size + 1)]
    for excluded in sorted(EXCLUDED_DIR_NAMES):
        cmd.extend(["--glob", f"!**/{excluded}/**"])
    for name in sorted(SECRET_FILE_NAMES | {".env*"}):
        cmd.extend(["--glob", f"!**/{name}"])
    for suffix in sorted(SECRET_SUFFIXES):
        cmd.extend(["--glob", f"!**/*{suffix}"])
    # -e and -- keep an expression beginning with '-' from becoming an rg option.
    cmd.extend(["-e", query, "--", target.relative_to(root).as_posix() or "."])
    result, truncated = _bounded_command(root, cmd, DEFAULT_SEARCH_TIMEOUT)
    if not truncated and result.returncode not in (0, 1):
        raise WorkspaceError("ripgrep search failed; check the expression")
    results = []
    for raw in result.stdout.splitlines():
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if not isinstance(payload, dict) or payload.get("type") != "match":
            continue
        data = payload.get("data", {})
        path_text = data.get("path", {}).get("text")
        if not path_text:
            continue
        try:
            candidate = canonicalize_workspace_path(root, path_text)
        except WorkspaceError:
            continue
        if is_excluded_path(candidate, root):
            continue
        matches = data.get("submatches", [])
        text = data.get("lines", {}).get("text", "").rstrip("\r\n")
        results.append({"path": candidate.relative_to(root).as_posix(), "line": data.get("line_number", 0),
                        "column": matches[0].get("start", 0) + 1 if matches else 0, "text": text[:2_000]})
    end = page * page_size
    return {"results": results[(page - 1) * page_size:end], "page": page, "page_size": page_size,
            "has_more": len(results) > end or truncated, "truncated": truncated}


def find_agent_instructions(root: Path, path: str | None = None) -> dict:
    current = (root / path).resolve(strict=False) if path else root
    assert_within_workspace(root, current)
    if is_excluded_path(current, root):
        raise WorkspaceSecurityError("Requested instruction path is excluded")
    if current.is_file() or not current.exists():
        current = current.parent
    directories = [current, *current.parents]
    applicable = []
    for directory in directories:
        applicable.append(directory)
        if directory == root:
            break
    instructions = []
    remaining = MAX_INSTRUCTION_TEXT
    for directory in reversed(applicable):
        agent_file = directory / "AGENTS.md"
        if not agent_file.is_file():
            continue
        # Reuse normal file validation so symlinks, secrets and large files are guarded.
        item = read_file(root, agent_file.relative_to(root).as_posix())
        if len(item["content"]) > remaining:
            raise WorkspaceSecurityError("Applicable AGENTS.md instructions exceed the context limit")
        instructions.append({"path": agent_file.relative_to(root).as_posix(), "content": item["content"]})
        remaining -= len(item["content"])
    return {"instructions": instructions}
