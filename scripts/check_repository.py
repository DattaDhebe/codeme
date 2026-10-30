"""Check shipped identity, versions, legal notices and maintained documentation offline."""

from __future__ import annotations

import ast
import json
from pathlib import Path
import re
import struct
from urllib.parse import unquote, urlsplit

from configure_repository import read_metadata


ROOT = Path(__file__).resolve().parents[1]


def check(root: Path = ROOT) -> list[str]:
    errors = []
    metadata = read_metadata(root / ".github/repository-metadata.json")
    extension = json.loads((root / "vscode-extension/package.json").read_text(encoding="utf8"))
    browser = json.loads((root / "frontend/package.json").read_text(encoding="utf8"))
    settings = ast.parse((root / "codeme_agent/config.py").read_text(encoding="utf8"))
    fields = {}
    for node in ast.walk(settings):
        if isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name) and isinstance(node.value, ast.Constant):
            fields[node.target.id] = node.value.value
    if fields.get("app_name") != "CodeMe" or extension.get("displayName") != "CodeMe":
        errors.append("Backend and extension display names must be CodeMe")
    if len({fields.get("version"), browser.get("version"), extension.get("version")}) != 1:
        errors.append("Backend, browser and extension versions must agree")
    if extension.get("publisher") != "personal-codex-local" or extension.get("name") != "personal-codeme":
        errors.append("Existing extension identity needs an explicit migration before changing")
    if extension.get("license") != "MIT" or browser.get("license") != "UNLICENSED":
        errors.append("Preserve the MIT extension and restricted private browser license declarations")
    repository_url = "https://github.com/" + metadata["repository"]
    for label, manifest in (("extension", extension), ("browser", browser)):
        repo = manifest.get("repository")
        url = repo.get("url", "") if isinstance(repo, dict) else repo or ""
        if url.removeprefix("git+").removesuffix(".git") != repository_url:
            errors.append(f"Incorrect {label} repository URL")
    required = ["LICENSE", "NOTICE", "CONTRIBUTING.md", "SECURITY.md", "SUPPORT.md", "CODE_OF_CONDUCT.md", "CHANGELOG.md",
                "docs/index.md", "docs/release-checklist.md", "docs/brand/README.md", "docs/brand/codeme-logo.svg",
                "docs/brand/codeme-wordmark-light.svg", "docs/brand/codeme-wordmark-dark.svg",
                "vscode-extension/NOTICE", "vscode-extension/LICENSE", "vscode-extension/CHANGELOG.md",
                "frontend/public/favicon.ico", "frontend/public/manifest.webmanifest", ".github/workflows/ci.yml"]
    errors.extend("Missing required file: " + name for name in required if not (root / name).is_file())
    if "CodeMe Proprietary License" not in (root / "LICENSE").read_text(encoding="utf8"):
        errors.append("Root license does not match the owner's restricted application choice")
    icon = root / "vscode-extension" / extension.get("icon", "missing-icon")
    if not icon.is_file():
        errors.append("Extension icon is missing")
    else:
        data = icon.read_bytes()
        if data[:8] != b"\x89PNG\r\n\x1a\n" or len(data) < 24 or min(struct.unpack(">II", data[16:24])) < 128:
            errors.append("Extension icon must be a valid PNG at least 128 pixels square")
    manifest_path = root / "frontend/public/manifest.webmanifest"
    if manifest_path.is_file():
        web = json.loads(manifest_path.read_text(encoding="utf8"))
        if web.get("name") != "CodeMe":
            errors.append("Browser manifest name must be CodeMe")
        for entry in web.get("icons", []):
            if not (manifest_path.parent / entry["src"]).is_file():
                errors.append("Missing browser manifest icon: " + entry["src"])
    # Historical audits and unrelated working notes are deliberately not rewritten
    # or treated as current documentation. Only maintained guides are checked.
    guides = [root / name for name in ("README.md", "PLAN.md", "CONTRIBUTING.md", "SECURITY.md", "SUPPORT.md", "CODE_OF_CONDUCT.md", "CHANGELOG.md")]
    guides += list((root / "docs").glob("*.md")) + [root / "docs/brand/README.md", root / "vscode-extension/README.md"]
    for guide in guides:
        if not guide.is_file():
            continue
        body = guide.read_text(encoding="utf8")
        body = re.sub(r"```.*?```", "", body, flags=re.DOTALL)
        links = re.findall(r"\]\(([^)]+)\)", body) + re.findall(r'(?:src|srcset)="([^"]+)"', body)
        for link in links:
            link = link.strip().strip("<>")
            if urlsplit(link).scheme or link.startswith(("#", "/")):
                continue
            path = unquote(link.split("#", 1)[0])
            if path and not (guide.parent / path).exists():
                errors.append(f"Broken local link in {guide.relative_to(root)}: {path}")
    return errors


if __name__ == "__main__":
    try:
        failures = check()
    except (OSError, ValueError, KeyError, TypeError, SyntaxError) as error:
        failures = [str(error)]
    if failures:
        print("Repository checks failed:\n" + "\n".join("- " + failure for failure in failures))
        raise SystemExit(1)
    print("CodeMe identity, versions, licenses, icons and maintained documentation are consistent.")
