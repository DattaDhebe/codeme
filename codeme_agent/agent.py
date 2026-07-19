import json
import re
from pathlib import Path
from typing import Iterator

from codeme_agent import changesets, command_runs, workspace
from codeme_agent.ollama import OllamaClient

MAX_AGENT_TURNS = 12
MAX_TOOL_TEXT = 60_000
MAX_BOOTSTRAP_TEXT = 90_000

SYSTEM_PROMPT = """You are CODEME, a capable local coding agent operating inside a registered workspace.
You have tools to inspect the repository. Use them proactively before answering project-specific questions.
Never claim that you cannot access the workspace: inspect it with list_files, search_code, and read_file.
Read AGENTS.md instructions when present and obey them. Search narrowly, read relevant files, and inspect Git state when useful.
For project analysis or architecture questions, listing the root is not sufficient. Read the README, dependency manifests, entry points, and representative source files for each major component before answering.
Ground every project claim in files you actually inspected. Do not invent directories, technologies, or behavior from file names alone.
For requested changes, first read the exact base files, then call propose_change_set once with create operations or minimal exact search/replace edits. Do not request delete or rename operations. Do not pretend a change was applied.
The legacy propose_file_change tool exists only for compatibility. Prefer propose_change_set because it computes verified base hashes and one reviewable multi-file proposal.
For a command the user should run, call propose_command with one controlled profile and literal arguments. Never provide shell text, executable paths, environment variables, or policy overrides. Never claim a command ran merely because it was proposed.
Command output is not returned to you in this phase. Stop after one command proposal and a concise summary.
Read-only tools execute automatically. File changes and commands require explicit approval in VS Code.
Keep the final response concise: report what you found, proposals created, and verification still needed.
"""


TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "list_files",
            "description": "List files and directories at a path inside the active workspace.",
            "parameters": {
                "type": "object",
                "properties": {"path": {"type": "string", "description": "Relative directory path; empty means workspace root."}},
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "read_file",
            "description": "Read a UTF-8 text file inside the active workspace.",
            "parameters": {
                "type": "object",
                "properties": {"path": {"type": "string", "description": "Relative file path."}},
                "required": ["path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_file_metadata",
            "description": "Read bounded metadata for one workspace-relative file without reading its contents.",
            "parameters": {
                "type": "object",
                "properties": {"path": {"type": "string"}},
                "required": ["path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "search_code",
            "description": "Search workspace text with a regular expression and return matching file locations.",
            "parameters": {
                "type": "object",
                "properties": {"query": {"type": "string", "description": "ripgrep-compatible search expression."}},
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "git_status",
            "description": "Inspect the workspace Git working tree status.",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "git_diff",
            "description": "Read Git changes for the whole workspace or one relative file.",
            "parameters": {
                "type": "object",
                "properties": {"path": {"type": "string", "description": "Optional relative file path."}},
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "read_instructions",
            "description": "Read the nearest AGENTS.md instructions applying to a workspace path.",
            "parameters": {
                "type": "object",
                "properties": {"path": {"type": "string", "description": "Optional relative file or directory path."}},
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "propose_change_set",
            "description": "Propose one reviewable multi-file change set. Create operations use content. Modify operations use exact old_text/new_text edits from files you already read.",
            "parameters": {
                "type": "object",
                "properties": {
                    "summary": {"type": "string", "description": "Short summary of the complete change."},
                    "operations": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "type": {"type": "string", "enum": ["create", "modify"]},
                                "path": {"type": "string", "description": "Workspace-relative file path."},
                                "summary": {"type": "string"},
                                "content": {"type": "string", "description": "Required only for create."},
                                "edits": {
                                    "type": "array",
                                    "description": "Required only for modify. old_text must match the verified base exactly.",
                                    "items": {
                                        "type": "object",
                                        "properties": {
                                            "old_text": {"type": "string"},
                                            "new_text": {"type": "string"},
                                            "replace_all": {"type": "boolean"},
                                        },
                                        "required": ["old_text", "new_text"],
                                    },
                                },
                            },
                            "required": ["type", "path", "summary"],
                        },
                    },
                },
                "required": ["summary", "operations"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "propose_file_change",
            "description": "Deprecated compatibility tool for one complete-file proposal. Prefer propose_change_set.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Relative workspace file path."},
                    "content": {"type": "string", "description": "Complete final content of the file."},
                    "explanation": {"type": "string", "description": "Short reason for the change."},
                },
                "required": ["path", "content", "explanation"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "propose_command",
            "description": "Propose one controlled command profile for explicit one-time approval. This never executes on the backend.",
            "parameters": {
                "type": "object",
                "properties": {
                    "profile": {
                        "type": "string",
                        "enum": ["pytest", "python_module", "npm_test", "npm_build", "npm_lint", "dotnet_test", "dotnet_build", "maven_test", "maven_package", "gradle_test", "gradle_build", "git_status", "git_diff", "custom_executable"],
                    },
                    "arguments": {"type": "array", "items": {"type": "string"}, "description": "Literal arguments only; never shell text."},
                    "cwd_relative": {"type": "string", "description": "Workspace-relative directory, usually '.'."},
                    "purpose": {"type": "string"},
                    "requested_timeout_seconds": {"type": "integer", "minimum": 1, "maximum": 900},
                    "model_risk_hint": {"type": "string", "enum": ["READ_ONLY", "BUILD_OR_TEST", "WRITES_WORKSPACE", "NETWORK", "PACKAGE_INSTALL", "LONG_RUNNING", "SENSITIVE", "BLOCKED"]},
                },
                "required": ["profile", "arguments", "purpose"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "propose_legacy_command",
            "description": "Deprecated display-only compatibility proposal. Never use for new requests.",
            "parameters": {
                "type": "object",
                "properties": {
                    "command": {"type": "string"},
                    "explanation": {"type": "string"},
                },
                "required": ["command", "explanation"],
            },
        },
    },
]


def _truncate(value: object, limit: int = MAX_TOOL_TEXT) -> object:
    if isinstance(value, str) and len(value) > limit:
        return value[:limit] + f"\n... truncated {len(value) - limit} characters"
    if isinstance(value, dict):
        return {key: _truncate(item, limit) for key, item in value.items()}
    if isinstance(value, list):
        return [_truncate(item, limit) for item in value]
    return value


def _safe_proposal_path(root: Path, raw_path: str) -> str:
    if not raw_path or "\x00" in raw_path:
        raise workspace.WorkspaceSecurityError("A relative file path is required")
    candidate = Path(raw_path)
    if candidate.is_absolute() or workspace.is_unc_path(candidate):
        raise workspace.WorkspaceSecurityError("Proposed file path must be relative")
    resolved = (root / candidate).resolve(strict=False)
    workspace.assert_within_workspace(root, resolved)
    if workspace.is_excluded_path(resolved, root):
        raise workspace.WorkspaceSecurityError("Proposed file path is excluded")
    return resolved.relative_to(root).as_posix()


def _content_tool_calls(assistant: dict, available_tools: list[dict] | None = None) -> list[dict]:
    """Accept tool JSON emitted as text by smaller Ollama coding models."""
    content = assistant.get("content")
    if not isinstance(content, str) or not content.strip():
        return []
    candidate = content.strip()
    if candidate.startswith("```json") and candidate.endswith("```"):
        candidate = candidate[7:-3].strip()
    elif candidate.startswith("```") and candidate.endswith("```"):
        candidate = candidate[3:-3].strip()
    known_tools = {item["function"]["name"] for item in (available_tools or TOOLS)}
    decoder = json.JSONDecoder()
    start_indexes = [0]
    start_indexes.extend(index for index, char in enumerate(candidate) if char == "{" and index > 0)
    for index in start_indexes:
        try:
            decoded, _end = decoder.raw_decode(candidate, index)
        except json.JSONDecodeError:
            continue
        if not isinstance(decoded, dict):
            continue
        name = decoded.get("name") or decoded.get("tool") or decoded.get("function_name")
        arguments = decoded.get("arguments", decoded.get("parameters", {}))
        if name in known_tools and isinstance(arguments, (dict, str)):
            return [{"function": {"name": name, "arguments": arguments}}]
    return []


def _needs_project_bootstrap(prompt: str) -> bool:
    normalized = prompt.lower()
    signals = ("current project", "whole project", "entire project", "project architecture", "analyze the project", "analyse the project", "codebase")
    return any(signal in normalized for signal in signals)


def _tools_for_prompt(prompt: str) -> list[dict]:
    normalized = prompt.lower()
    mutation_signals = ("add ", "create ", "edit ", "fix ", "implement ", "refactor ", "remove ", "rename ", "update ", "write ", "change ", "run ", "test ", "build ", "lint ")
    if any(signal in normalized for signal in mutation_signals):
        return TOOLS
    return TOOLS[:6]


def _path_score(raw_value: str) -> int:
    value = raw_value.strip().strip("\"':;,").replace("\\", "/").removeprefix("./")
    if not value or len(value) > 260 or re.search(r"\s|[*?<>|]", value):
        return 0
    if value.startswith(("/", "\\")) or re.match(r"^[a-zA-Z]:", value) or ".." in value.split("/"):
        return 0
    basename = value.rsplit("/", 1)[-1].lower()
    known = {".gitignore", ".gitattributes", ".editorconfig", ".npmrc", ".dockerignore", "package.json", "requirements.txt", "pyproject.toml", "dockerfile", "makefile"}
    if basename in known:
        return 100
    if re.fullmatch(r"\.[a-z0-9]+", basename):
        return 0
    if re.fullmatch(r"[^./][^/]*\.[a-z0-9][a-z0-9._-]*", basename, re.IGNORECASE):
        return 90 if "/" in value else 70
    return 0


def _best_path_candidate(text: str) -> str | None:
    candidates = []
    for match in re.finditer(r"`([^`\n]+)`", text):
        value = match.group(1).strip().strip("\"':;,").replace("\\", "/").removeprefix("./")
        score = _path_score(value)
        if score:
            candidates.append((score, match.start(), value))
    candidates.sort(reverse=True)
    return candidates[0][2] if candidates else None


def _fallback_file_proposals(root: Path, prompt: str, response: str) -> list[dict]:
    """Turn a small model's clearly labelled whole-file fence into an approval-gated proposal."""
    proposals = []
    previous_end = 0
    fence_pattern = re.compile(r"```([^\n`]*)\r?\n([\s\S]*?)```", re.MULTILINE)
    for match in fence_pattern.finditer(response):
        info, content = match.group(1).strip(), match.group(2)
        explicit_match = re.search(r"(?:path|filename|file)\s*=\s*[\"']?([^\s\"']+)", info, re.IGNORECASE)
        explicit_path = explicit_match.group(1) if explicit_match else None
        nearby = response[max(previous_end, match.start() - 1_200) : match.start()]
        raw_path = explicit_path if explicit_path and _path_score(explicit_path) else _best_path_candidate(f"{prompt}\n{nearby}")
        previous_end = match.end()
        if not raw_path or not content:
            continue
        confidence_text = f"{prompt}\n{nearby}".lower()
        labelled_whole_file = bool(re.search(r"\b(updated|complete|full|entire|replace|create|new)\b[\s\S]{0,80}\bfile\b|\bfile\b[\s\S]{0,80}\b(updated|complete|full|entire|replace|create|new)\b", confidence_text))
        try:
            relative_path = _safe_proposal_path(root, raw_path)
            existing = workspace.read_file(root, relative_path)["content"]
        except workspace.WorkspaceError:
            existing = ""
            try:
                relative_path = _safe_proposal_path(root, raw_path)
            except workspace.WorkspaceError:
                continue
        existing_lines = {line.strip() for line in existing.splitlines() if line.strip()}
        proposed_lines = {line.strip() for line in content.splitlines() if line.strip()}
        overlap = len(existing_lines & proposed_lines) / max(1, len(existing_lines))
        if not explicit_path and not labelled_whole_file and overlap < 0.6:
            continue
        proposals.append({
            "kind": "file_change",
            "path": relative_path,
            "content": content,
            "explanation": f"Replace {relative_path} with the complete generated file (approval required).",
        })
    return proposals


def _project_snapshot(root: Path) -> str:
    """Give smaller models enough grounded context to plan a whole-project answer."""
    root_entries, root_more = workspace.list_directory(root, None, 1, 100)
    structure = [f"- {item['path']}{'/' if item['is_dir'] else ''}" for item in root_entries]
    if root_more:
        structure.append("- ... more root entries")

    discovered_files = [item["path"] for item in root_entries if not item["is_dir"]]
    top_directories = [item["path"] for item in root_entries if item["is_dir"] and not item["name"].startswith(".")][:20]
    for directory in top_directories:
        try:
            entries, has_more = workspace.list_directory(root, directory, 1, 100)
        except workspace.WorkspaceError:
            continue
        structure.append(f"\n[{directory}/]")
        structure.extend(f"- {item['path']}{'/' if item['is_dir'] else ''}" for item in entries)
        if has_more:
            structure.append("- ... more entries")
        discovered_files.extend(item["path"] for item in entries if not item["is_dir"])
        source_dirs = [item["path"] for item in entries if item["is_dir"] and item["name"] in {"src", "app", "lib"}]
        for source_dir in source_dirs:
            try:
                source_entries, _ = workspace.list_directory(root, source_dir, 1, 100)
            except workspace.WorkspaceError:
                continue
            structure.append(f"\n[{source_dir}/]")
            structure.extend(f"- {item['path']}{'/' if item['is_dir'] else ''}" for item in source_entries)
            discovered_files.extend(item["path"] for item in source_entries if not item["is_dir"])

    priority_names = {
        "readme.md": 0,
        "package.json": 1,
        "requirements.txt": 1,
        "pyproject.toml": 1,
        "cargo.toml": 1,
        "go.mod": 1,
        "angular.json": 2,
        "main.py": 2,
        "app.py": 2,
        "extension.ts": 2,
        "main.ts": 2,
        "routers.py": 3,
    }
    candidates = sorted(
        {item for item in discovered_files if Path(item).name.lower() in priority_names},
        key=lambda item: (priority_names[Path(item).name.lower()], len(Path(item).parts), item),
    )[:18]

    sections = ["Project structure inspected automatically:\n" + "\n".join(structure)]
    remaining = MAX_BOOTSTRAP_TEXT - len(sections[0])
    for file_path in candidates:
        if remaining <= 0:
            break
        try:
            content = workspace.read_file(root, file_path)["content"]
        except workspace.WorkspaceError:
            continue
        excerpt = content[: min(remaining, 16_000)]
        sections.append(f"\n--- {file_path} ---\n{excerpt}")
        remaining -= len(excerpt)
    return "\n".join(sections)


class WorkspaceAgent:
    def __init__(self, root: Path, client: OllamaClient | None = None):
        self.root = workspace.normalize_workspace_root(str(root))
        self.client = client or OllamaClient()

    def _execute_tool(self, name: str, arguments: dict) -> tuple[dict, dict | None]:
        if name == "list_files":
            entries, has_more = workspace.list_directory(self.root, arguments.get("path") or None, 1, 100)
            return {"entries": entries, "has_more": has_more}, None
        if name == "read_file":
            result = workspace.read_file(self.root, str(arguments.get("path", "")))
            return _truncate(result), None
        if name == "get_file_metadata":
            return workspace.get_file_metadata(self.root, str(arguments.get("path", ""))), None
        if name == "search_code":
            return workspace.search_code(self.root, str(arguments.get("query", "")), 1, 40), None
        if name == "git_status":
            return workspace.get_git_status(self.root), None
        if name == "git_diff":
            return _truncate(workspace.get_git_diff(self.root, arguments.get("path") or None)), None
        if name == "read_instructions":
            return _truncate(workspace.find_agent_instructions(self.root, arguments.get("path") or None)), None
        if name == "propose_change_set":
            raw_operations = arguments.get("operations")
            if not isinstance(raw_operations, list):
                raise workspace.WorkspaceSecurityError("Change-set operations must be a list")
            normalized_operations = []
            for raw_operation in raw_operations:
                if not isinstance(raw_operation, dict):
                    raise workspace.WorkspaceSecurityError("Every change-set operation must be an object")
                normalized_operations.append({
                    "type": raw_operation.get("type"),
                    "relative_path": raw_operation.get("path"),
                    "summary": raw_operation.get("summary"),
                    "content": raw_operation.get("content"),
                    "edits": raw_operation.get("edits", []),
                })
            prepared = changesets.prepare_change_set(
                self.root,
                str(arguments.get("summary", "")),
                normalized_operations,
            )
            proposal = {"kind": "change_set", "change_set": prepared}
            return {
                "status": "proposed",
                "change_set_id": prepared["id"],
                "files": [item["relative_path"] for item in prepared["operations"]],
                "requires_approval": True,
            }, proposal
        if name == "propose_file_change":
            relative_path = _safe_proposal_path(self.root, str(arguments.get("path", "")))
            content = arguments.get("content")
            if not isinstance(content, str):
                raise workspace.WorkspaceSecurityError("Proposed file content must be text")
            proposal = {
                "kind": "file_change",
                "path": relative_path,
                "content": content,
                "explanation": str(arguments.get("explanation", "Proposed by the coding agent")),
            }
            return {"status": "proposed", "path": relative_path, "requires_approval": True}, proposal
        if name == "propose_command":
            prepared = command_runs.prepare_command_run(self.root, arguments)
            proposal = {"kind": "command_proposal", "command_run": prepared}
            return {
                "status": "proposed",
                "command_run_id": prepared["id"],
                "profile": prepared["profile"],
                "requires_approval": True,
            }, proposal
        if name == "propose_legacy_command":
            command = str(arguments.get("command", "")).strip()
            if not command or "\n" in command or "\r" in command or len(command) > 2_000:
                raise workspace.WorkspaceSecurityError("A bounded display-only command is required")
            proposal = {
                "kind": "command",
                "command": command,
                "explanation": str(arguments.get("explanation", "Legacy display-only command proposal")),
            }
            return {"status": "display_only", "requires_approval": False, "deprecated": True}, proposal
        raise workspace.WorkspaceError(f"Unknown tool: {name}")

    def run(self, prompt: str, history: list[dict], model: str | None = None, context: str | None = None) -> Iterator[dict]:
        messages: list[dict] = [{"role": "system", "content": SYSTEM_PROMPT}]
        messages.extend(history[-20:])
        user_content = prompt if not context else f"{prompt}\n\nExplicit editor context:\n{context}"
        messages.append({"role": "user", "content": user_content})

        yield {"type": "status", "label": "Inspecting workspace", "detail": self.root.name}
        project_bootstrap = _needs_project_bootstrap(prompt)
        if project_bootstrap:
            yield {"type": "tool", "name": "project_snapshot", "summary": "README, manifests, entry points, and component structure", "status": "running"}
            snapshot = _project_snapshot(self.root)
            messages.insert(1, {"role": "system", "content": snapshot})
            messages.insert(2, {"role": "system", "content": "The project inspection above is complete. Answer from that evidence now. Do not call or describe any tools, commands, or proposals."})
            yield {"type": "tool", "name": "project_snapshot", "summary": "README, manifests, entry points, and component structure", "status": "complete"}
            assistant = self.client.chat_with_tools(messages, [], model=model)
            content = str(assistant.get("content") or "I inspected the project but could not produce a summary.")
            yield {"type": "message", "content": content}
            return
        available_tools = _tools_for_prompt(prompt)
        available_tool_names = {item["function"]["name"] for item in available_tools}
        proposal_count = 0
        malformed_tool_calls = 0
        for _turn in range(MAX_AGENT_TURNS):
            assistant = self.client.chat_with_tools(messages, available_tools, model=model)
            tool_calls = assistant.get("tool_calls") or _content_tool_calls(assistant, available_tools)
            if not tool_calls:
                content = str(assistant.get("content") or "I finished inspecting the workspace.")
                if "propose_file_change" in available_tool_names and proposal_count == 0:
                    for proposal in _fallback_file_proposals(self.root, prompt, content):
                        proposal_count += 1
                        yield {"type": "proposal", **proposal}
                yield {"type": "message", "content": content}
                return

            messages.append(assistant)
            for call in tool_calls:
                function = call.get("function", {}) if isinstance(call, dict) else {}
                name = str(function.get("name", ""))
                raw_arguments = function.get("arguments", {})
                if isinstance(raw_arguments, str):
                    try:
                        arguments = json.loads(raw_arguments)
                    except json.JSONDecodeError:
                        arguments = None
                else:
                    arguments = raw_arguments if isinstance(raw_arguments, dict) else None
                if arguments is None or not name:
                    malformed_tool_calls += 1
                    messages.append({"role": "tool", "content": json.dumps({"error": "Malformed tool call arguments"}), "tool_name": name or "unknown"})
                    if malformed_tool_calls >= 3:
                        yield {"type": "message", "content": "I stopped after three malformed tool calls. No changes were applied."}
                        return
                    continue
                malformed_tool_calls = 0
                summary = arguments.get("path") or arguments.get("query") or arguments.get("profile") or arguments.get("command") or "workspace"
                yield {"type": "tool", "name": name, "summary": str(summary)[:200], "status": "running"}
                try:
                    if name not in available_tool_names:
                        raise workspace.WorkspaceSecurityError(f"Tool {name} is not permitted for this read-only request")
                    if name.startswith("propose_") and proposal_count:
                        raise workspace.WorkspaceSecurityError("Only one proposal is allowed per agent request")
                    result, proposal = self._execute_tool(name, arguments)
                except workspace.WorkspaceError as exc:
                    result, proposal = {"error": str(exc)}, None
                if proposal:
                    proposal_count += 1
                    yield {"type": "proposal", **proposal}
                messages.append({"role": "tool", "content": json.dumps(result, default=str), "tool_name": name})
                yield {"type": "tool", "name": name, "summary": str(summary)[:200], "status": "complete"}

        yield {
            "type": "message",
            "content": "I reached the tool-call limit while inspecting the project. Please narrow the request or ask me to continue.",
        }
