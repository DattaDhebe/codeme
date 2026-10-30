import re
from pathlib import Path

ANSI_PATTERN = re.compile(r"(?:\x1B\[[0-?]*[ -/]*[@-~]|\x1B\][^\x07]*(?:\x07|\x1B\\)|\x9B[0-?]*[ -/]*[@-~])")
CONTROL_PATTERN = re.compile(r"[^\x09\x0A\x0D\x20-\x7E\u0080-\uFFFF]")
SECRET_PATTERN = re.compile(
    r"(?i)\b(token|secret|password|api[_-]?key|private[_-]?key|connection[_-]?string|credential|auth|cookie)\b\s*[:=]\s*([^\s]+)"
)


def sanitize_output(value: str | None, limit: int = 32_768) -> str:
    if not value or limit <= 0:
        return ""
    clean = ANSI_PATTERN.sub("", value)
    clean = CONTROL_PATTERN.sub("", clean)
    clean = SECRET_PATTERN.sub(lambda match: f"{match.group(1)}=[REDACTED]", clean)
    return clean[-limit:]


def safe_log_path(raw_path: str, root: Path) -> str | None:
    value = raw_path.strip().strip('"\'').replace("\\", "/")
    if not value or "\x00" in value:
        return None
    candidate = Path(value)
    root_resolved = root.resolve(strict=True)
    if candidate.is_absolute() or re.match(r"^[A-Za-z]:", value) or value.startswith("//"):
        try:
            resolved = candidate.resolve(strict=False)
            relative = resolved.relative_to(root_resolved)
        except (OSError, ValueError):
            return None
        return relative.as_posix()
    if any(part in {"", ".", ".."} for part in candidate.parts):
        return None
    resolved = (root_resolved / candidate).resolve(strict=False)
    try:
        return resolved.relative_to(root_resolved).as_posix()
    except ValueError:
        return None


PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("python_traceback", re.compile(r'File "(?P<file>[^"]+)", line (?P<line>\d+)(?:, in (?P<test>[^\r\n]+))?')),
    ("typescript", re.compile(r"(?P<file>[^\s:(]+\.(?:ts|tsx))\((?P<line>\d+),(?P<column>\d+)\):\s*(?P<severity>error|warning)\s*(?P<code>TS\d+)?\s*:?\s*(?P<message>[^\r\n]+)", re.I)),
    ("angular", re.compile(r"(?P<file>[^\s:]+\.(?:ts|html|scss)):(?P<line>\d+):(?P<column>\d+)\s*[-:]\s*(?P<severity>error|warning)\s*(?P<code>NG\d+|TS\d+)?\s*:?\s*(?P<message>[^\r\n]+)", re.I)),
    ("dotnet", re.compile(r"(?P<file>[^\r\n(]+\.(?:cs|fs|vb))\((?P<line>\d+),(?P<column>\d+)\):\s*(?P<severity>error|warning)\s*(?P<code>[A-Z]{2}\d+)\s*:\s*(?P<message>[^\r\n]+)", re.I)),
    ("maven", re.compile(r"\[ERROR\]\s+(?P<file>[^\s:\[]+\.java):\[(?P<line>\d+),(?P<column>\d+)\]\s*(?P<message>[^\r\n]+)")),
    ("gradle", re.compile(r"(?P<file>[^\r\n:]+\.(?:java|kt|groovy)):(?P<line>\d+):\s*(?P<severity>error|warning):\s*(?P<message>[^\r\n]+)", re.I)),
    ("pytest", re.compile(r"(?P<file>[^\s:]+\.py):(?P<line>\d+):\s*(?:(?P<test>test_[^\s]+)\s+-\s+)?(?P<message>[^\r\n]+)")),
    ("eslint", re.compile(r"(?P<line>\d+):(?P<column>\d+)\s+(?P<severity>error|warning)\s+(?P<message>.+?)\s+(?P<code>[\w@/-]+)$", re.I | re.M)),
]

DIAGNOSTIC_MARKERS = {
    "python_traceback": ('file "',), "typescript": (".ts(", ".tsx("),
    "angular": (".ts:", ".html:", ".scss:"), "dotnet": (".cs(", ".fs(", ".vb("),
    "maven": (".java:",), "gradle": (".java:", ".kt:", ".groovy:"),
    "pytest": (".py:",),
}


def parse_diagnostics(output: str | None, root: Path, limit: int = 50) -> list[dict]:
    if limit <= 0:
        return []
    clean = sanitize_output(output, 128_000)
    diagnostics: list[dict] = []
    seen: set[tuple] = set()
    current_eslint_file: str | None = None
    for raw_line in clean.splitlines():
        # Compiler patterns may backtrack across a whole line at every offset.
        # A single huge/minified line must not stall verification and repair.
        # The bounded raw output remains available as separate failure evidence.
        line = raw_line[:4096]
        lower_line = line.lower()
        if line.strip().endswith((".js", ".jsx", ".ts", ".tsx")):
            current_eslint_file = safe_log_path(line.strip(), root)
        for kind, pattern in PATTERNS:
            if kind in DIAGNOSTIC_MARKERS and not any(marker in lower_line for marker in DIAGNOSTIC_MARKERS[kind]):
                continue
            if kind == "eslint" and (not current_eslint_file or ":" not in line):
                continue
            for match in pattern.finditer(line):
                groups = match.groupdict()
                raw_path = groups.get("file") or (current_eslint_file if kind == "eslint" else None)
                relative_path = safe_log_path(raw_path, root) if raw_path else None
                if raw_path and relative_path is None:
                    continue
                item = {
                    "kind": kind,
                    "relative_path": relative_path,
                    "line": int(groups["line"]) if groups.get("line") else None,
                    "column": int(groups["column"]) if groups.get("column") else None,
                    "severity": (groups.get("severity") or "error").lower(),
                    "message": sanitize_output(groups.get("message") or line.strip(), 1000),
                    "test_name": sanitize_output(groups.get("test"), 500) if groups.get("test") else None,
                    "error_code": groups.get("code"),
                }
                fingerprint = tuple(item.values())
                if fingerprint not in seen:
                    seen.add(fingerprint)
                    diagnostics.append(item)
                if len(diagnostics) >= limit:
                    return diagnostics
    return diagnostics
