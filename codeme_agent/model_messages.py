"""Common, bounded message handling for local model protocols.

Model reasoning fields are intentionally not part of the application protocol.
Only assistant text and tool requests may cross this boundary.
"""

import json
import re
from uuid import uuid4


class VisibleText:
    """Remove explicit private-reasoning blocks even across streaming chunks."""

    _tags = ("<think>", "</think>", "<analysis>", "</analysis>")

    def __init__(self):
        self.pending = ""
        self.hidden: list[str] = []

    def feed(self, text: str, final: bool = False) -> str:
        self.pending += text
        visible = []
        while self.pending:
            match = re.search(r"</?(?:think|analysis)>", self.pending, re.IGNORECASE)
            if not match:
                keep = 0
                if not final:
                    # Hold only a trailing prefix of a private-reasoning tag.
                    for length in range(1, min(len(self.pending), 11) + 1):
                        if any(tag.startswith(self.pending[-length:].lower()) for tag in self._tags):
                            keep = length
                length = len(self.pending) - keep
                if not self.hidden:
                    visible.append(self.pending[:length])
                self.pending = self.pending[length:]
                break
            if not self.hidden:
                visible.append(self.pending[:match.start()])
            tag = match.group().lower()
            name = tag.strip("</>")
            if tag.startswith("</"):
                if name in self.hidden:
                    self.hidden = self.hidden[:self.hidden.index(name)]
            else:
                self.hidden.append(name)
            self.pending = self.pending[match.end():]
        return "".join(visible)


def visible_text(value: object, *, content_parts: bool = False) -> str:
    if value is None:
        return ""
    if content_parts and isinstance(value, list):
        pieces = []
        for part in value:
            if not isinstance(part, dict):
                raise ValueError("Invalid assistant content part")
            if part.get("type") in {"text", "output_text"}:
                if not isinstance(part.get("text"), str):
                    raise ValueError("Invalid assistant text content")
                pieces.append(part["text"])
            elif part.get("type") not in {"reasoning", "thinking", "analysis"}:
                raise ValueError("Unsupported assistant content part")
        value = "".join(pieces)
    if not isinstance(value, str):
        raise ValueError("Invalid assistant content")
    return VisibleText().feed(value, final=True)


def normalize_assistant(message: object, *, content_parts: bool = False) -> dict:
    if not isinstance(message, dict) or message.get("role", "assistant") != "assistant":
        raise ValueError("Response has no assistant message")
    result = {"role": "assistant", "content": visible_text(message.get("content", ""), content_parts=content_parts)}
    calls = message.get("tool_calls", [])
    if calls is None:
        calls = []
    if not isinstance(calls, list) or len(calls) > 64:
        raise ValueError("Invalid assistant tool calls")
    normalized = []
    identifiers: set[str] = set()
    for call in calls:
        if not isinstance(call, dict) or not isinstance(call.get("function"), dict):
            raise ValueError("Invalid assistant tool call")
        function = call["function"]
        name = function.get("name")
        if not isinstance(name, str) or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_-]{0,127}", name):
            raise ValueError("Invalid assistant tool name")
        arguments = function.get("arguments", {})
        if isinstance(arguments, str):
            if len(arguments) > 1_000_000:
                raise ValueError("Assistant tool arguments exceed limit")
            arguments = json.loads(arguments)
        if not isinstance(arguments, dict):
            raise ValueError("Assistant tool arguments must be an object")
        identifier = call.get("id") or "call_local_" + uuid4().hex
        if (not isinstance(identifier, str) or len(identifier) > 250
                or any(char.isspace() or ord(char) < 32 for char in identifier)
                or identifier in identifiers):
            raise ValueError("Invalid or duplicate assistant tool call ID")
        identifiers.add(identifier)
        normalized.append({"id": identifier, "type": "function", "function": {"name": name, "arguments": arguments}})
    if normalized:
        result["tool_calls"] = normalized
    return result


def compatible_messages(messages: list[dict]) -> list[dict]:
    """Encode native argument dictionaries and preserve tool call/result pairing."""
    result = []
    for message in messages:
        role = message.get("role")
        if role not in {"system", "user", "assistant", "tool"}:
            raise ValueError("Invalid message role")
        encoded = {"role": role, "content": message.get("content") or ""}
        if role == "assistant":
            encoded["content"] = visible_text(encoded["content"], content_parts=True)
        elif not isinstance(encoded["content"], str):
            raise ValueError("Local agent history must use text content")
        if role == "assistant" and message.get("tool_calls"):
            normalized = normalize_assistant(message, content_parts=True)
            encoded["content"] = normalized["content"]
            encoded["tool_calls"] = [
                {**call, "function": {**call["function"], "arguments": json.dumps(call["function"]["arguments"], ensure_ascii=False)}}
                for call in normalized["tool_calls"]
            ]
        if role == "tool":
            identifier = message.get("tool_call_id")
            if not isinstance(identifier, str) or not identifier:
                raise ValueError("A tool result is missing its tool_call_id")
            encoded["tool_call_id"] = identifier
            if message.get("tool_name"):
                encoded["name"] = message["tool_name"]
        result.append(encoded)
    return result


def explicit_remote_model(item: object) -> bool:
    """Reject affirmative remote/cloud metadata without inferring from publisher."""
    if isinstance(item, list):
        return any(explicit_remote_model(value) for value in item)
    if not isinstance(item, dict):
        return False
    for key, value in item.items():
        key = key.lower()
        if key in {"remote_host", "remote_model", "remote_url", "cloud", "is_cloud", "is_remote"} and value:
            return True
        if key in {"provider", "inference_provider", "backend", "location"} and isinstance(value, str):
            if value.lower() in {"cloud", "remote", "openai", "anthropic", "azure", "ollama-cloud"}:
                return True
        if isinstance(value, (dict, list)) and explicit_remote_model(value):
            return True
    return False


def cloud_model_name(name: str) -> bool:
    tag = name.lower().rsplit("/", 1)[-1].rsplit(":", 1)[-1]
    return tag == "cloud" or tag.endswith("-cloud")
