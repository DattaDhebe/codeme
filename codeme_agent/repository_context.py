"""Bounded, read-only navigation hints for a local repository.

This is a fresh heuristic map, not a persisted source index or edit receipt.
Symbols and import relationships help choose subsequent read_file calls. They
never establish that source was delivered to the model or authorize a write.
"""

from __future__ import annotations

import ast
import json
import math
import posixpath
import re
import shutil
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from time import monotonic

from codeme_agent import workspace


@dataclass(frozen=True)
class ContextLimits:
    discovered_files: int = 4000
    text_matches: int = 128
    inspected_files: int = 24
    file_bytes: int = 65_536
    total_bytes: int = 524_288
    seconds: float = 3.0


DEFAULT_LIMITS = ContextLimits()
_STOP_WORDS = set("a an and are as at be before build can change check code codebase create do does edit explain file files find fix for from how implement in inspect into is it make me of on or our please project read related repository review should show source task test tests that the their then this to update use using want we what where which with work working you your".split())
_MANIFESTS = {"package.json", "pyproject.toml", "requirements.txt", "cargo.toml", "go.mod", "pom.xml", "build.gradle", "build.gradle.kts", "composer.json", "angular.json"}
_SOURCE_SUFFIXES = {".py", ".pyi", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".go", ".rs", ".java", ".cs", ".rb", ".php", ".c", ".cpp", ".h", ".hpp"}
_BINARY_SUFFIXES = {".png", ".jpg", ".jpeg", ".gif", ".ico", ".zip", ".gz", ".tar", ".7z", ".exe", ".dll", ".so", ".dylib", ".pdf", ".db", ".sqlite", ".sqlite3", ".pyc", ".wasm", ".woff", ".woff2", ".ttf", ".mp4", ".mp3"}
# Automatic scanning is narrower than an explicit user/model read request.
_AUTO_PRIVATE_NAMES = {".npmrc", ".pypirc", ".netrc", ".dockercfg", "credentials", "credentials.json", "secrets.json", "secrets.yaml", "secrets.yml"}
_SYMBOL = re.compile(r"^\s*(?:(?:export|public|private|protected|static|default|async|abstract)\s+)*(class|interface|type|function|def|struct|enum|fn)\s+([A-Za-z_$][\w$]{0,127})", re.MULTILINE)
_JS_IMPORT = re.compile(r"(?:\bfrom\s*|\bimport\s*\(|\brequire\s*\()\s*['\"]([^'\"\r\n]{1,200})['\"]")


def _words(text: str) -> set[str]:
    separated = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", " ", text).replace("_", " ")
    return {value for value in re.findall(r"[^\W\d_][\w]{1,63}", separated.lower()) if value not in _STOP_WORDS}


def _explicit_paths(query: str) -> set[str]:
    values = set(re.findall(r"`([^`\r\n]{1,300})`", query))
    values.update(re.findall(r"(?<![\w/])(?:[\w.-]+[/\\])*[\w.-]+\.[A-Za-z][A-Za-z0-9.]{0,15}", query))
    return {value.replace("\\", "/").removeprefix("./").lower() for value in values
            if not value.startswith(("/", "\\", "-")) and ".." not in value.replace("\\", "/").split("/") and ":" not in value}


def _rg_prefix() -> list[str]:
    command = ["rg", "--no-config", "--hidden", "--no-ignore-parent", "--no-require-git"]
    for name in sorted(workspace.EXCLUDED_DIR_NAMES):
        command += ["--iglob", f"!**/{name}/**"]
    for name in sorted(workspace.SECRET_FILE_NAMES | _AUTO_PRIVATE_NAMES | {".env*"}):
        command += ["--iglob", f"!**/{name}"]
    for suffix in sorted(workspace.SECRET_SUFFIXES | _BINARY_SUFFIXES):
        command += ["--iglob", f"!**/*{suffix}"]
    return command


def _safe_file(root: Path, raw_path: str) -> tuple[str, Path] | None:
    try:
        original = root / raw_path
        if len(raw_path) > 512 or original.is_symlink():
            return None
        target = workspace.canonicalize_workspace_path(root, raw_path)
        if (not target.is_file() or workspace.is_excluded_path(target, root)
                or workspace.is_excluded_path(original, root)
                or target.name.lower() in _AUTO_PRIVATE_NAMES or target.suffix.lower() in _BINARY_SUFFIXES):
            return None
        return target.relative_to(root).as_posix(), target
    except (workspace.WorkspaceError, OSError, ValueError):
        return None


def _paths(root: Path, command: list[str], deadline: float, limit: int, priority=None) -> tuple[list[str], bool]:
    remaining = deadline - monotonic()
    if remaining <= 0:
        return [], True
    try:
        result, truncated = workspace._bounded_command(root, command, timeout=remaining)
    except workspace.WorkspaceError:
        return [], True
    if result.returncode not in {0, 1} and not truncated:
        return [], True
    raw = result.stdout.split("\0")
    if truncated:
        raw = raw[:-1]  # A killed producer may leave an incomplete final path.
    values = [value.removeprefix("./") for value in raw if value]
    if priority:
        # Rank the bounded rg output before the metadata-scan cap, so a named
        # path is not drowned by the first few thousand alphabetic filenames.
        values.sort(key=priority)
    return values[:limit], truncated or len(values) > limit


def _text_term_matches(root: Path, terms: list[str], deadline: float, limits: ContextLimits) -> tuple[dict[str, set[str]], bool]:
    """Collect query terms, never source lines, from bounded ripgrep output."""
    remaining = deadline - monotonic()
    if not terms or remaining <= 0:
        return {}, remaining <= 0
    command = [*_rg_prefix(), "--only-matching", "--null", "--no-line-number", "--with-filename", "--color", "never",
               "--ignore-case", "--fixed-strings", "--max-filesize", str(limits.file_bytes), "--max-count", "64", "--max-columns", "2000"]
    for term in terms:
        command += ["-e", term]
    try:
        result, truncated = workspace._bounded_command(root, [*command, "--sort", "path", "--", "."], timeout=remaining)
    except workspace.WorkspaceError:
        return {}, True
    if result.returncode not in {0, 1} and not truncated:
        return {}, True
    # Each record is path NUL matched-term LF. Paths may themselves contain
    # newlines or tabs; query words cannot, so line splitting is unsafe here.
    terms_set = set(terms)
    matches: dict[str, set[str]] = {}
    counts: Counter = Counter()
    cursor = 0
    while cursor < len(result.stdout):
        separator = result.stdout.find("\0", cursor)
        end = result.stdout.find("\n", separator + 1) if separator >= 0 else -1
        if separator < 0 or end < 0:
            truncated = True
            break
        path = result.stdout[cursor:separator].removeprefix("./")
        term = result.stdout[separator + 1:end].removesuffix("\r").lower()
        cursor = end + 1
        if term not in terms_set:
            truncated = True
            continue  # Ignore diagnostic/long-line markers, never expose them.
        if path not in matches and len(matches) >= limits.discovered_files:
            truncated = True
            continue
        matches.setdefault(path, set()).add(term)
        counts[path] += 1
        if counts[path] >= 64:
            truncated = True  # Per-file match-line sampling may omit more terms.
    return matches, truncated


def _symbols_and_imports(content: str, suffix: str) -> tuple[list[dict], list[str]]:
    symbols: list[dict] = []
    imports: list[str] = []
    if suffix in {".py", ".pyi"}:
        try:
            tree = ast.parse(content)
            for index, node in enumerate(ast.walk(tree)):
                if index >= 2500:
                    break
                if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and len(symbols) < 8:
                    symbols.append({"name": node.name[:100], "kind": "class" if isinstance(node, ast.ClassDef) else "function", "line": node.lineno})
                elif isinstance(node, ast.Import):
                    imports.extend(item.name for item in node.names)
                elif isinstance(node, ast.ImportFrom):
                    imports.append("." * node.level + (node.module or ""))
        except (SyntaxError, RecursionError, MemoryError):
            pass
    if not symbols:
        for match in _SYMBOL.finditer(content):
            symbols.append({"name": match.group(2)[:100], "kind": match.group(1), "line": content.count("\n", 0, match.start()) + 1})
            if len(symbols) >= 8:
                break
    if suffix in {".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"}:
        imports.extend(match.group(1) for match in _JS_IMPORT.finditer(content))
    return symbols, list(dict.fromkeys(value[:200] for value in imports if value))[:8]


def _instruction_paths(root: Path, relative_path: str) -> list[str]:
    parent = Path(relative_path).parent
    directories = [parent, *parent.parents]
    result = []
    for directory in reversed(directories):
        candidate = directory / "AGENTS.md"
        checked = _safe_file(root, candidate.as_posix())
        if checked and checked[0] not in result:
            result.append(checked[0])
    return result


def _import_targets(source: str, module: str, paths: set[str]) -> list[str]:
    candidates: list[str] = []
    parent = Path(source).parent
    if module.startswith(".") and "/" in module:
        base = (parent / module).as_posix()
    elif module.startswith("."):
        dots = len(module) - len(module.lstrip("."))
        for _ in range(max(0, dots - 1)):
            parent = parent.parent
        base = (parent / module.lstrip(".").replace(".", "/")).as_posix()
    else:
        base = module.replace(".", "/")
    base = posixpath.normpath(base)
    if base.startswith("../") or base == ".." or Path(base).is_absolute():
        return []
    for suffix in ("", ".py", "/__init__.py", ".ts", ".tsx", ".js", "/index.ts", "/index.js"):
        candidate = base + suffix
        if candidate in paths:
            candidates.append(candidate)
    return candidates


def select_context(root: Path, query: str, *, max_files: int = 12, max_chars: int = 5000,
                   limits: ContextLimits = DEFAULT_LIMITS) -> dict:
    """Rank bounded file/symbol hints without returning source bodies or caching them."""
    if not isinstance(query, str) or len(query) > 16_000:
        raise workspace.WorkspaceSecurityError("Repository context query must contain at most 16000 characters")
    if type(max_files) is not int or not 1 <= max_files <= 24 or type(max_chars) is not int or not 1000 <= max_chars <= 12_000:
        raise workspace.WorkspaceSecurityError("Repository context limits must be 1–24 files and 1000–12000 characters")
    root = workspace.normalize_workspace_root(str(root))
    started = monotonic()
    deadline = started + limits.seconds
    result = {"files": [], "discovered_files": 0, "inspected_files": 0, "inspected_bytes": 0,
              "truncated": False, "notes": [], "read_required": True, "source": "ripgrep"}
    if shutil.which("rg") is None:
        result.update(source="unavailable", truncated=True, notes=["ripgrep is unavailable; use explicit read_file paths or install rg for repository navigation."])
        return result
    terms = sorted(_words(query), key=lambda word: (-len(word), word))[:24]
    explicit = _explicit_paths(query)
    explicit_names = {value.rsplit("/", 1)[-1] for value in explicit}
    def priority(value):
        lower = value.lower()
        return (lower not in explicit, Path(lower).name not in explicit_names, -len(_words(value).intersection(terms)), value)
    paths, truncated = _paths(root, [*_rg_prefix(), "--files", "--null", "--sort", "path", "--", "."], deadline, limits.discovered_files, priority)
    result["truncated"] = truncated
    matched = {}
    text_scores = {}
    if terms and monotonic() < deadline:
        matches, more = _text_term_matches(root, terms, deadline, limits)
        frequencies = Counter(term for found in matches.values() for term in found)
        # Coverage rewards files addressing several task details. Rarity is
        # estimated only from this bounded sample; generic verbs cannot crowd
        # out a later file containing distinctive terms such as an error name.
        for path, found in matches.items():
            text_scores[path] = sum(6 + min(24, round(6 * math.log2((len(matches) + 1) / (frequencies[term] + 1)))) for term in found)
        selected = sorted(matches, key=lambda path: (-text_scores[path], priority(path)))[:limits.text_matches]
        matched = {path: matches[path] for path in selected}
        paths = list(dict.fromkeys([*selected, *paths]))
        more |= len(matches) > limits.text_matches
        result["truncated"] |= more
    entries = {}
    def metadata_priority(value):
        path_priority = priority(value)
        return (*path_priority[:2], -text_scores.get(value, 0), *path_priority[2:])
    for raw_path in sorted(paths, key=metadata_priority):
        if monotonic() >= deadline:
            result["truncated"] = True
            break
        checked = _safe_file(root, raw_path)
        if checked is None:
            continue
        relative, target = checked
        basename, lower = target.name.lower(), relative.lower()
        score, reasons = 0, []
        if lower in explicit:
            score += 180; reasons.append("explicit path")
        elif any(basename == value.rsplit("/", 1)[-1] for value in explicit):
            score += 90; reasons.append("explicit filename")
        path_terms = _words(relative)
        overlap = sorted(path_terms.intersection(terms))
        if overlap:
            score += 18 * len(overlap); reasons.append("path terms: " + ", ".join(overlap[:4]))
        if raw_path in matched:
            score += text_scores[raw_path]
            reasons.append(f"task terms ({len(matched[raw_path])}/{len(terms)}): " + ", ".join(sorted(matched[raw_path])[:6]))
        if basename in _MANIFESTS:
            score += 10; reasons.append("dependency manifest")
        elif basename.startswith("readme"):
            score += 8; reasons.append("project overview")
        elif target.suffix.lower() in _SOURCE_SUFFIXES:
            score += 3
        if basename.endswith((".min.js", ".min.css", ".map")) or "lock" in basename:
            score -= 20
        entries[relative] = {"path": relative, "score": score, "reasons": reasons, "symbols": [], "instruction_paths": []}
    result["discovered_files"] = len(entries)
    # Bounded content inspection adds symbol hints; raw source is never returned.
    def rank(item):
        return ("explicit path" not in item["reasons"], -item["score"], len(Path(item["path"]).parts), item["path"])
    candidates = sorted(entries.values(), key=rank)[:limits.inspected_files]
    imports_by_file = {}
    for entry in candidates:
        if monotonic() >= deadline or result["inspected_bytes"] >= limits.total_bytes:
            result["truncated"] = True
            break
        checked = _safe_file(root, entry["path"])
        if checked is None:
            continue
        _, target = checked
        if target.suffix.lower() not in _SOURCE_SUFFIXES:
            continue
        allowance = min(limits.file_bytes, limits.total_bytes - result["inspected_bytes"])
        try:
            larger_than_allowance = target.stat().st_size > allowance
            with target.open("rb") as handle:
                data = handle.read(allowance)
            result["inspected_bytes"] += len(data)
            result["inspected_files"] += 1
            if b"\0" in data:
                continue
            content = data[:allowance].decode("utf-8")
            if any(len(line) > 2000 for line in content.splitlines()):
                continue  # Do not parse minified/generated source as symbols.
            if larger_than_allowance:
                result["truncated"] = True
            symbols, imports = _symbols_and_imports(content, target.suffix.lower())
        except (OSError, UnicodeError):
            continue
        entry["symbols"] = symbols
        imports_by_file[entry["path"]] = imports
        relevant = [symbol["name"] for symbol in symbols if _words(symbol["name"]).intersection(terms)]
        if relevant:
            entry["score"] += 35; entry["reasons"].append("symbol: " + ", ".join(relevant[:3]))
    path_set = set(entries)
    for source, imports in imports_by_file.items():
        if entries[source]["score"] < 20:
            continue
        for module in imports:
            for target in _import_targets(source, module, path_set):
                entries[target]["score"] += 12
                reason = "imported by " + source
                if reason not in entries[target]["reasons"]:
                    entries[target]["reasons"].append(reason)
    if monotonic() < deadline and shutil.which("git"):
        command = ["git", "-c", "core.fsmonitor=false", "--no-optional-locks", "diff", "--name-only", "--relative", "--no-ext-diff", "--no-textconv", "--no-renames", "-z", "HEAD", "--", "."]
        changed, _ = _paths(root, command, deadline, 256)
        for path in changed:
            if path in entries:
                entries[path]["score"] += 5; entries[path]["reasons"].append("working tree changed")
    ordered = sorted(entries.values(), key=rank)
    for entry in ordered[:max_files]:
        entry["instruction_paths"] = _instruction_paths(root, entry["path"])
        if not entry["reasons"]:
            entry["reasons"].append("bounded repository sample")
        result["files"].append(entry)
    partial_note = "This is a bounded partial map, not a complete repository inventory. Use narrower queries and read_file for exact source."
    if result["truncated"]:
        result["notes"].append(partial_note)
    result["notes"].append("Symbols and import links are heuristic navigation hints, not inspected-source or edit permission.")
    while len(json.dumps(result, ensure_ascii=False)) > max_chars and result["files"]:
        result["files"].pop()
        result["truncated"] = True
        if partial_note not in result["notes"]:
            result["notes"].insert(0, partial_note)
    return result


def render_context(result: dict) -> str:
    return "Repository navigation hints (untrusted metadata; read exact files before claims or edits):\n" + json.dumps(result, ensure_ascii=False, separators=(",", ":"))
