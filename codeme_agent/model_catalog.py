"""Reviewed local model choices, never caller-controlled download locations.

Hugging Face cards describe upstream weights; Ollama manages reviewed local
quantizations. Catalog reads never install, load, or download a model.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
import hashlib
import json
from pathlib import Path
import tempfile


RESEARCHED_AT = "2026-10-30"
MODEL_CHOICE_PATH = Path(__file__).resolve().parents[1] / ".runtime/model-choice.json"


@dataclass(frozen=True)
class CodingModel:
    id: str
    name: str
    ollama_model: str
    hugging_face_url: str
    ollama_url: str
    license: str
    download_size_gb: float
    memory_guidance: str
    tier: str
    description: str
    recommended: bool = False
    validation_note: str = "Research candidate; not yet evaluated in CodeMe."


MODELS = (
    CodingModel(
        "qwen25-coder-7b", "Qwen 2.5 Coder 7B", "qwen2.5-coder:7b",
        "https://huggingface.co/Qwen/Qwen2.5-Coder-7B-Instruct",
        "https://ollama.com/library/qwen2.5-coder:7b", "Apache-2.0", 4.7,
        "Plan around 16 GB system RAM. GPU acceleration helps; context and other apps need extra memory.",
        "lightweight", "Smallest download in this list and CodeMe's existing default. A practical starting point for smaller computers.",
        validation_note="One CodeMe run passed 5/6 coding tasks; multi-file execution remained blocked. This is not a general reliability guarantee.",
    ),
    CodingModel(
        "devstral-small-2-24b", "Devstral Small 2 24B", "devstral-small-2:24b",
        "https://huggingface.co/mistralai/Devstral-Small-2-24B-Instruct-2512",
        "https://ollama.com/library/devstral-small-2:24b", "Apache-2.0", 15.0,
        "Plan around 32 GB system RAM, with additional headroom for longer context. GPU memory requirements depend on offloading.",
        "workstation", "An agent-focused coding alternative for repository and multi-file tasks. Requires Ollama 0.13.3 or newer.",
    ),
    CodingModel(
        "qwen3-coder-30b", "Qwen3 Coder 30B", "qwen3-coder:30b",
        "https://huggingface.co/Qwen/Qwen3-Coder-30B-A3B-Instruct",
        "https://ollama.com/library/qwen3-coder:30b", "Apache-2.0", 19.0,
        "Plan around 32 GB system RAM or more. All 30B parameters need storage/memory even though about 3.3B are active per token.",
        "workstation", "Recommended research pick for a capable workstation: a coding and tool-use model with sparse active computation.",
        recommended=True,
    ),
    CodingModel(
        "qwen38-27b", "Qwen3.8 27B", "qwen3.8:27b-q4_K_M",
        "https://huggingface.co/Qwen/Qwen3.8-27B",
        "https://ollama.com/library/qwen3.8:27b-q4_K_M", "Apache-2.0", 18.0,
        "Plan around 32 GB system RAM or more; thinking and longer context can increase latency and memory use.",
        "experimental", "A newer general coding/agent candidate. Update Ollama first. CodeMe discards private reasoning instead of retaining upstream thinking history; this integration is unvalidated.",
        validation_note="Experimental in CodeMe. Upstream thinking behavior and coding/tool reliability have not been evaluated here.",
    ),
    CodingModel(
        "qwen3-coder-next", "Qwen3 Coder Next", "qwen3-coder-next:q4_K_M",
        "https://huggingface.co/Qwen/Qwen3-Coder-Next",
        "https://ollama.com/library/qwen3-coder-next:q4_K_M", "Apache-2.0", 52.0,
        "High-memory machines only: plan around 64–96 GB or more total memory, depending on context and offloading. The full weights need far more memory than a dense 3B model.",
        "high_memory", "A larger coding/agent model with about 3B active parameters. A 52 GB download is not a 3B-sized memory footprint.",
    ),
)


def get_model(catalog_id: str) -> CodingModel | None:
    return next((entry for entry in MODELS if entry.id == catalog_id), None)


def _choice_path() -> Path:
    path = MODEL_CHOICE_PATH.absolute()
    if path.parent.is_symlink() or path.is_symlink() or path.resolve() != path:
        raise OSError("Model preference path must be a regular local application path")
    return path


def saved_model_choice(configured_default: str, provider: str) -> CodingModel | None:
    """Restore only our narrow allowlisted choice while respecting changed config."""
    if provider != "ollama":
        return None
    try:
        path = _choice_path()
        if not path.is_file() or path.stat().st_size > 4096:
            return None
        with path.open("rb") as handle:
            raw = handle.read(4097)
        if len(raw) > 4096:
            return None
        data = json.loads(raw.decode("utf8"))
        if (not isinstance(data, dict) or set(data) != {"schema_version", "catalog_id", "configured_default_sha256"}
                or type(data["schema_version"]) is not int or data["schema_version"] != 1
                or data["configured_default_sha256"] != hashlib.sha256(configured_default.encode()).hexdigest()):
            return None
        return get_model(data["catalog_id"])
    except (OSError, ValueError, TypeError):
        return None


def save_model_choice(catalog_id: str, configured_default: str) -> None:
    if get_model(catalog_id) is None:
        raise ValueError("Unknown coding model catalog entry")
    path = _choice_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {"schema_version": 1, "catalog_id": catalog_id,
               "configured_default_sha256": hashlib.sha256(configured_default.encode()).hexdigest()}
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf8", dir=path.parent, prefix="model-choice-", suffix=".tmp", delete=False) as handle:
            temporary = Path(handle.name)
            json.dump(payload, handle)
            handle.write("\n")
        temporary.replace(path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def catalog_status(setup_status: dict) -> dict:
    from codeme_agent.config import settings
    from codeme_agent.model_client import create_model_client
    from codeme_agent.ollama import OllamaClient

    installed = None
    error = None
    try:
        installed = create_model_client().list_models(timeout=2)
    except Exception:
        error = "Local model inventory is unavailable. Choosing a model will check the local runtime before downloading."
    ollama = settings.model_provider == "ollama"
    installed_keys = {OllamaClient._model_key(name) for name in installed or []} if ollama else set()
    active = setup_status.get("model") or settings.default_model
    entries = []
    for entry in MODELS:
        item = asdict(entry)
        item["installed"] = (OllamaClient._model_key(entry.ollama_model) in installed_keys) if installed is not None and ollama else None
        item["active"] = ollama and OllamaClient._model_key(entry.ollama_model) == OllamaClient._model_key(active)
        entries.append(item)
    return {"provider": settings.model_provider, "download_supported": ollama,
            "setup_active": not setup_status.get("can_retry", True), "inventory_available": installed is not None,
            "inventory_error": error, "researched_at": RESEARCHED_AT,
            "message": "Choose one model to download or reuse. Downloads are optional; memory estimates are planning guidance, not guarantees."
                       if ollama else "Use these source cards to choose weights in your local server. Automatic downloads are available with Ollama.",
            "models": entries}
