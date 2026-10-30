"""Small, deterministic guards for the local agent's public work loop.

Plans describe intended work. Only reviewed execution records establish that a
change was applied or verified; model prose and plan checkboxes never do.
"""

import re


def public_text(value: object) -> str:
    """Remove private reasoning blocks, including a truncated open block."""
    text = value if isinstance(value, str) else ""
    visible, depth, cursor = [], 0, 0
    for match in re.finditer(r"</?(?:think|thinking|analysis|reasoning)\b[^>]*>", text, re.IGNORECASE):
        if depth == 0:
            visible.append(text[cursor:match.start()])
        depth = max(0, depth - 1) if match.group().startswith("</") else depth + 1
        cursor = match.end()
    if depth == 0:
        visible.append(text[cursor:])
    return "".join(visible).strip()


def request_kind(prompt: str) -> str:
    """Conservatively distinguish an inspection from requested execution."""
    text = prompt.strip().lower()
    # Requests for instructions and explanations often mention action verbs.
    # A later explicit instruction to act still makes this an execution task.
    instructional = re.match(r"(?:please\s+)?(?:explain|describe|show me how|how (?:do|can|should|would)|what (?:is|are|does)|why\b)", text)
    explicit_action = re.search(r"\b(?:and|then|also|please)\s+(?:actually\s+)?(?:fix|implement|create|edit|update|change|improve|run|build|test|refactor|repair)\b", text)
    how_to = re.match(r"(?:please\s+)?(?:(?:explain|describe|show me)\s+how\b|how\b)", text)
    if how_to and not re.search(r"\b(?:then|also|and actually)\s+(?:fix|implement|create|edit|update|change|improve|run|build|test|refactor|repair)\b", text):
        return "inspect"
    if instructional and not explicit_action:
        return "inspect"
    if re.search(r"\b(?:add|create|edit|fix|implement|refactor|remove|rename|update|write|change|run|test|build|lint|improve|debug|repair|correct|optimize|optimise|enable|disable|install|make)\b", text):
        return "execute"
    return "inspect"


def normalize_plan(steps: object) -> list[dict]:
    if not isinstance(steps, list) or not 1 <= len(steps) <= 20:
        raise ValueError("Plan must contain between 1 and 20 steps")
    normalized, seen = [], set()
    active = 0
    for step in steps:
        if not isinstance(step, dict):
            raise ValueError("Every plan step must be an object")
        identifier, description, status = step.get("id"), step.get("description"), step.get("status")
        if not isinstance(identifier, str) or not re.fullmatch(r"[A-Za-z0-9_.-]{1,80}", identifier) or identifier in seen:
            raise ValueError("Plan steps require unique, short IDs")
        if not isinstance(description, str) or not description.strip() or len(description) > 500:
            raise ValueError("Plan step descriptions must contain between 1 and 500 characters")
        if status not in {"pending", "in_progress", "completed"}:
            raise ValueError("Plan status must be pending, in_progress, or completed")
        active += status == "in_progress"
        seen.add(identifier)
        normalized.append({"id": identifier, "description": public_text(description), "status": status})
        if not normalized[-1]["description"]:
            raise ValueError("Plan descriptions must contain a public work summary")
    if active > 1:
        raise ValueError("Only one plan step may be in progress")
    return normalized


def initial_plan(kind: str) -> list[dict]:
    descriptions = [("inspect", "Inspect relevant files and project instructions")]
    if kind == "execute":
        descriptions.extend([("implement", "Prepare and apply the requested work through approval"), ("verify", "Check the result with relevant verification")])
    else:
        descriptions.append(("report", "Report findings grounded in inspected evidence"))
    return [{"id": identifier, "description": description, "status": "in_progress" if index == 0 else "pending"}
            for index, (identifier, description) in enumerate(descriptions)]


def observed_execution(feedback: object) -> bool:
    """Whether canonical feedback contains execution, without interpreting logs."""
    if not isinstance(feedback, dict):
        return False
    return any(isinstance(record, dict) and record.get("status") in {"applied", "completed", "succeeded", "failed", "cancelled"}
               for key in ("changes", "commands")
               for record in (feedback.get(key) if isinstance(feedback.get(key), list) else []))
