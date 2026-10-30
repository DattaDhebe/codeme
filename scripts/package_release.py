"""Build an explicit, reproducible customer ZIP. Never uploads or installs anything."""

from __future__ import annotations

import argparse
import ast
import hashlib
import json
import os
import posixpath
from pathlib import Path
import re
import stat
import subprocess
import tempfile
import zipfile
from pathlib import PurePosixPath


ROOT = Path(__file__).resolve().parents[1]
ROOT_FILES = ("README.md", "LICENSE", "NOTICE", "install.py", "start.py", "codeme_cli.py", "main.py", "requirements.txt", ".env.example", "alembic.ini")
COMMUNITY_FILES = ("CHANGELOG.md", "CODE_OF_CONDUCT.md", "CONTRIBUTING.md", "SECURITY.md", "SUPPORT.md")
FRONTEND_FILES = ("package.json", "package-lock.json", "angular.json", "tsconfig.json", "tsconfig.app.json")
PRIVATE_NAMES = {
    ".git", ".venv", "venv", "node_modules", ".runtime", "__pycache__", ".pytest_cache", ".angular", ".cache",
    ".aws", ".ssh", ".azure", ".gnupg", ".kube", ".docker", ".config", ".gcloud", ".npmrc", ".netrc", "_netrc",
    ".pypirc", ".git-credentials", ".gitconfig", "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", "identity",
    "known_hosts", "authorized_keys", "token.json", "tokens.json", "auth.json", "service-account.json", "service_account.json",
}
PRIVATE_SUFFIXES = {".db", ".sqlite", ".sqlite3", ".pyc", ".pyo", ".pem", ".key", ".pfx", ".p12", ".crt", ".der", ".asc", ".enc", ".secret", ".token", ".keystore", ".jks", ".log", ".gguf", ".safetensors", ".bin", ".pt", ".pth", ".onnx"}
WEB_SUFFIXES = {".js", ".mjs", ".cjs", ".ts", ".html", ".css", ".scss", ".json", ".webmanifest", ".svg", ".ico", ".png", ".jpg", ".jpeg", ".webp", ".woff", ".woff2", ".ttf", ".txt"}
MAX_FILE_BYTES = 32 * 1024 * 1024
MAX_PAYLOAD_BYTES = 128 * 1024 * 1024
MAX_FILES = 5000
DOC_FILES = ("architecture.md", "configuration.md", "development.md", "getting-started.md", "installation-testing.md",
             "model-evaluations.md", "repository-context.md", "review-2026-10-30.md", "troubleshooting.md", "coding-models.md",
             "index.md", "release-checklist.md", "privacy.md")
BRAND_FILES = ("README.md", "codeme-logo.svg", "codeme-wordmark-light.svg", "codeme-wordmark-dark.svg",
               "codeme-monochrome.svg", "codeme-512.png", "codeme-256.png")
EXTENSION_BRAND_FILES = ("codeme-logo.svg", "codeme-activity.svg", "codeme.png", "personal-codex.svg")


def private_name(name: str) -> bool:
    lower = name.lower()
    return (lower in PRIVATE_NAMES or lower.startswith((".env", "id_rsa.", "id_dsa.", "id_ecdsa.", "id_ed25519."))
            or Path(lower).suffix in PRIVATE_SUFFIXES
            or any(word in lower for word in ("credential", "secret", "private-key", "private_key"))
            or lower.endswith((".db-wal", ".db-shm", ".sqlite-wal", ".sqlite-shm")))


def checked(source: Path, relative: str) -> Path:
    path = source / relative
    if Path(relative).is_absolute() or ".." in Path(relative).parts:
        raise ValueError("Release paths must stay inside the application source")
    current = source
    for part in Path(relative).parts:
        current = current / part
        if current.is_symlink() or not current.resolve().is_relative_to(source):
            raise ValueError(f"Release refuses a symlink or external path: {relative}")
    return path


def product_version(source: Path) -> str:
    tree = ast.parse(checked(source, "codeme_agent/config.py").read_text(encoding="utf8"))
    for node in tree.body:
        if isinstance(node, ast.ClassDef) and node.name == "Settings":
            for value in node.body:
                if (isinstance(value, ast.AnnAssign) and isinstance(value.target, ast.Name) and value.target.id == "version"
                        and isinstance(value.value, ast.Constant) and isinstance(value.value.value, str)):
                    version = value.value.value
                    if re.fullmatch(r"\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?", version):
                        return version
    raise ValueError("Cannot determine a safe product version from Settings.version")


def quickstart(version: str, extension: str | None) -> str:
    return f"""CodeMe {version} — Windows quick start

This ZIP contains Python source, a prebuilt browser, and an optional VS Code
extension. It is not a standalone .exe or a bundled Python/Node/Ollama runtime.

Before starting
1. Extract the whole CodeMe-{version} folder to a permanent local folder.
2. Install Python 3.10+ (3.12 recommended) and add it to PATH.
3. Install Node.js 24 LTS including npm. Supported alternatives are Node 20.19+
   within 20.x, or 22.12+ within 22.x. The installer rebuilds the included browser.
4. Internet access is needed for initial dependency and model downloads. Git and
   ripgrep are recommended for full repository tools. VS Code 1.90+ is needed for
   reviewed edits and approved commands; browser exploration is read-only.

Install and run
Open a terminal in this extracted folder, then run:
    python install.py
The installer creates .venv, installs dependencies, builds the browser, prepares
Ollama when needed, and launches CodeMe. An OS installer may ask for permission.
You can also double-click INSTALL-WINDOWS.cmd after prerequisites are installed.
The browser opens at http://127.0.0.1:4200. Keep the terminal open while using it.
For later launches run python start.py or double-click START-WINDOWS.cmd.
Press Ctrl+C in that terminal to stop the launcher's services.

Local models
No model weights are included. Setup reuses a suitable installed model or can
download the configured default through Ollama with progress. Optional coding
models can be selected in the app's model catalog; larger choices need much more
RAM and disk space. Model quality and speed depend on your hardware and choice.
Model licenses remain separate from this software distribution. No hosted model
account or API key is required. Initial setup needs internet; installed local
models can be used without a hosted inference service.

VS Code Agent
{('In VS Code, use Extensions > ... > Install from VSIX and select ' + extension + '. Then open a project folder, open CodeMe, connect to the local backend, and review workspace registration. Choose Agent for reviewed edits and approved checks.') if extension else 'This package does not include a VSIX. Browser chat and read-only exploration are available; install the separately supplied CodeMe extension for Agent edits/commands.'}
The model cannot approve its own edits or commands. Back up important projects.

Details and troubleshooting: README.md and docs/getting-started.md.
Integrity: RELEASE-MANIFEST.json lists SHA-256 for every other packaged file.
The download is a source-and-prebuilt-assets distribution, not an unattended or
guaranteed-correct coding service. Review LICENSE and NOTICE for the main
application's purchase permissions and separately licensed components. The
existing extension MIT license remains in vscode-extension/LICENSE and the VSIX.
"""


def command_file(script: str) -> bytes:
    return ("@echo off\r\ncd /d \"%~dp0\"\r\npython " + script + "\r\n"
            "set \"CODEME_EXIT=%ERRORLEVEL%\"\r\nif not \"%CODEME_EXIT%\"==\"0\" pause\r\nexit /b %CODEME_EXIT%\r\n").encode("utf8")


def validate_vsix(data: bytes, version: str, *, expected_license: bytes | None = None, expected_notice: bytes | None = None,
                  expected_third_party_notices: bytes | None = None) -> None:
    import io
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        if len(archive.infolist()) > 2000 or sum(info.file_size for info in archive.infolist()) > MAX_PAYLOAD_BYTES:
            raise ValueError("VSIX contents exceed release bounds")
        for info in archive.infolist():
            path = PurePosixPath(info.filename.replace("\\", "/"))
            if path.is_absolute() or ".." in path.parts or any(":" in part or private_name(part) for part in path.parts):
                raise ValueError("VSIX contains a private or unsafe path")
            if info.file_size > MAX_FILE_BYTES:
                raise ValueError("VSIX file exceeds release bounds")
            if stat.S_ISLNK(info.external_attr >> 16):
                raise ValueError("VSIX contains a symlink")
        if archive.getinfo("extension/package.json").file_size > 128 * 1024:
            raise ValueError("VSIX metadata exceeds release bounds")
        metadata = json.loads(archive.read("extension/package.json"))
        if metadata.get("name") != "personal-codeme" or metadata.get("version") != version:
            raise ValueError("VSIX name/version does not match this CodeMe release")
        licenses = {"extension/LICENSE", "extension/LICENSE.txt"}.intersection(archive.namelist())
        if not licenses:
            raise ValueError("VSIX must preserve its existing license")
        if expected_license is not None and not any(archive.read(name) == expected_license for name in licenses):
            raise ValueError("VSIX license differs from the current component license")
        if expected_notice is not None:
            notices = {"extension/NOTICE", "extension/NOTICE.txt"}.intersection(archive.namelist())
            if not any(archive.read(name) == expected_notice for name in notices):
                raise ValueError("VSIX must preserve the current component notice")
        if expected_third_party_notices is not None:
            name = "extension/THIRD_PARTY_NOTICES.txt"
            if name not in archive.namelist() or archive.read(name) != expected_third_party_notices:
                raise ValueError("VSIX must preserve the current third-party notices")


def collect_payload(source: Path, *, include_extension: bool = True) -> tuple[str, dict[str, bytes], dict[str, dict[str, str]]]:
    """Select source and build artifacts explicitly; never archive the whole repo."""
    source = source.resolve()
    version = product_version(source)
    payload: dict[str, bytes] = {}
    origins: dict[str, dict[str, str]] = {}
    total_bytes = 0
    def add(relative: str, target: str | None = None, *, required=True):
        nonlocal total_bytes
        path = checked(source, relative)
        if not path.is_file():
            if required: raise ValueError(f"Required release file is missing: {relative}")
            return
        if path.stat().st_size > MAX_FILE_BYTES:
            raise ValueError(f"Release file is too large: {relative}")
        with path.open("rb") as handle:
            data = handle.read(MAX_FILE_BYTES + 1)
        if len(data) > MAX_FILE_BYTES: raise ValueError(f"Release file is too large: {relative}")
        if total_bytes + len(data) > MAX_PAYLOAD_BYTES or len(payload) >= MAX_FILES:
            raise ValueError("Release payload exceeds its size/count bound")
        name = target or relative
        total_bytes += len(data) - len(payload.get(name, b""))
        payload[name] = data
        origins[name] = {"source_path": relative, "source_sha256": hashlib.sha256(data).hexdigest()}
    def tree(relative: str, suffixes: set[str], *, skip_tests=False):
        base = checked(source, relative)
        if not base.is_dir(): raise ValueError(f"Required release directory is missing: {relative}")
        for current, directories, files in os.walk(base, followlinks=False):
            kept = []
            for name in sorted(directories):
                if private_name(name) or skip_tests and name == "tests": continue
                directory = checked(source, (Path(current) / name).relative_to(source).as_posix())
                if directory.is_dir(): kept.append(name)
            directories[:] = kept
            for name in sorted(files):
                if private_name(name) or Path(name).suffix.lower() not in suffixes or name.endswith(".spec.ts"): continue
                add((Path(current) / name).relative_to(source).as_posix())
    for name in ROOT_FILES: add(name)
    add("PLAN.md", required=False)
    for name in COMMUNITY_FILES: add(name, required=False)
    tree("codeme_agent", {".py"}, skip_tests=True)
    tree("alembic", {".py", ".mako", ".md"})
    for name in FRONTEND_FILES: add("frontend/" + name)
    tree("frontend/src", WEB_SUFFIXES, skip_tests=True)
    tree("frontend/public", WEB_SUFFIXES)
    tree("frontend/dist/frontend/browser", WEB_SUFFIXES - {".ts", ".scss"})
    add("frontend/dist/frontend/browser/index.html")
    add("frontend/dist/frontend/3rdpartylicenses.txt")
    for name in DOC_FILES: add("docs/" + name, required=False)
    for name in BRAND_FILES: add("docs/brand/" + name, required=False)
    add(".github/workflows/install-smoke.yml", required=False)
    add(".github/workflows/ci.yml", required=False)
    add(".github/dependabot.yml", required=False)
    add(".github/repository-metadata.json", required=False)
    add(".github/copilot-instructions.md", required=False)
    for name in ("evaluate_models.py", "install_smoke.py", "package_release.py", "build_brand_assets.py"):
        add("scripts/" + name, required=False)
    add("vscode-extension/LICENSE")
    add("vscode-extension/README.md", required=False)
    add("vscode-extension/NOTICE", required=False)
    add("vscode-extension/THIRD_PARTY_NOTICES.txt", required=False)
    add("vscode-extension/CHANGELOG.md", required=False)
    for name in EXTENSION_BRAND_FILES: add("vscode-extension/media/" + name, required=False)
    extension = None
    if include_extension:
        extension = f"vscode-extension/personal-codeme-{version}.vsix"
        add(extension)
        validate_vsix(payload[extension], version, expected_license=payload["vscode-extension/LICENSE"],
                      expected_notice=payload.get("vscode-extension/NOTICE"),
                      expected_third_party_notices=payload.get("vscode-extension/THIRD_PARTY_NOTICES.txt"))
    if "vscode-extension/README.md" in payload:
        hint = (f"Customer package: the ready-to-install extension is `{extension}`. Use VS Code > Extensions > ... > Install from VSIX; building the extension is unnecessary for this download.\n\n"
                if extension else "Customer package: no extension VSIX was included. The developer build commands below require the full repository checkout.\n\n")
        payload["vscode-extension/README.md"] = (hint + payload["vscode-extension/README.md"].decode("utf8")).encode("utf8")
    notices = ("# Included notices\n\nOriginal main-application code, documentation and branding are covered by the root `LICENSE`; `NOTICE` describes component scope. Consult those files for the purchaser's permissions and restrictions.\n"
               "The existing VS Code extension MIT license is preserved in `vscode-extension/LICENSE` and its VSIX; those separate permissions are unchanged.\n"
               "Bundled extension dependency notices are preserved in `vscode-extension/THIRD_PARTY_NOTICES.txt` when supplied and inside the VSIX.\n"
               "Browser dependency notices are preserved in `frontend/dist/frontend/3rdpartylicenses.txt`.\n"
               "Python/npm dependencies and optional model weights retain their own licenses; weights and runtimes are not bundled.\n")
    # Keep customer navigation useful without distributing a user's dirty audit.
    readme = payload["README.md"].decode("utf8")
    readme = "\n".join(line for line in readme.splitlines() if "CURRENT_IMPLEMENTATION_REPORT.md" not in line and "docs/archive/" not in line)
    payload["README.md"] = ("Customer distribution: begin with START-HERE-WINDOWS.txt. Application source, prebuilt browser assets, and the packaged extension are included; contributor test suites and historical audits are not bundled.\n\n" + readme + "\n").encode("utf8")
    if "docs/index.md" in payload:
        index = payload["docs/index.md"].decode("utf8")
        payload["docs/index.md"] = ("\n".join(line for line in index.splitlines() if "(archive/" not in line) + "\n").encode("utf8")
    # Image references may only use already approved packaged assets. Never
    # follow an arbitrary README path to fill a missing customer artifact.
    for document in ("README.md", "docs/brand/README.md", "vscode-extension/README.md"):
        if document not in payload: continue
        text = payload[document].decode("utf8")
        references = re.findall(r'(?:src|srcset)=[\"\']([^\"\']+)', text)
        references += re.findall(r"!\[[^\]]*\]\(([^)]+)\)", text)
        for reference in references:
            if "://" in reference or reference.startswith("data:"): continue
            target = posixpath.normpath((Path(document).parent / reference).as_posix())
            # These known project brand references are simple relative paths.
            if "brand/" in target or "/media/" in target:
                if target not in payload:
                    raise ValueError(f"Referenced brand image is absent from the release allowlist: {target}")
    payload["THIRD-PARTY-NOTICES.md"] = notices.encode("utf8")
    payload["START-HERE-WINDOWS.txt"] = quickstart(version, extension).encode("utf8")
    payload["INSTALL-WINDOWS.cmd"] = command_file("install.py")
    payload["START-WINDOWS.cmd"] = command_file("start.py")
    if sum(map(len, payload.values())) > MAX_PAYLOAD_BYTES: raise ValueError("Release payload exceeds its size bound")
    return version, payload, origins


def source_revision(source: Path) -> str | None:
    try:
        output = subprocess.check_output(["git", "-C", str(source), "-c", "core.fsmonitor=false", "rev-parse", "HEAD"],
                                         text=True, stderr=subprocess.DEVNULL, timeout=5).strip()
        return output if re.fullmatch(r"[0-9a-f]{40,64}", output) else None
    except (OSError, subprocess.SubprocessError): return None


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def install_immutable_file(temporary: Path, target: Path) -> None:
    """Reuse identical artifacts; never overwrite a different existing identity."""
    expected = file_sha256(temporary)
    if target.exists():
        if target.is_symlink() or not target.is_file() or file_sha256(target) != expected:
            raise ValueError(f"Refusing to overwrite a different release artifact: {target.name}")
        return
    try:
        temporary.replace(target)
    except PermissionError:
        # Concurrent identical builds or an existing Windows download handle
        # need not rewrite an already complete immutable artifact.
        if target.is_symlink() or not target.is_file() or file_sha256(target) != expected:
            raise


def write_metadata(target: Path, data: bytes) -> None:
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=target.parent, prefix="release-meta-", suffix=".tmp", delete=False) as handle:
            temporary = Path(handle.name)
            handle.write(data)
        install_immutable_file(temporary, target)
    finally:
        if temporary is not None: temporary.unlink(missing_ok=True)


def build_release(source: Path = ROOT, *, include_extension: bool = True) -> dict:
    source = source.resolve()
    version, payload, origins = collect_payload(source, include_extension=include_extension)
    files = [{"path": name, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()} for name, data in sorted(payload.items())]
    content_hash = hashlib.sha256(json.dumps(files, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    manifest = {"schema_version": 1, "product": "CodeMe", "version": version, "format": "source-and-prebuilt-assets",
                "archive_root": f"CodeMe-{version}", "source_revision": source_revision(source),
                "source_revision_note": "Git revision identifies the checkout base; packaged file hashes identify exact reviewed working-tree bytes, including uncommitted changes.",
                "content_sha256": content_hash, "contains_model_weights": False, "contains_runtimes": False,
                "extension_included": include_extension, "fixed_zip_timestamp": "1980-01-01T00:00:00",
                "reproducibility": "Identical payload and provenance produce identical ZIP bytes with the same Python/zlib implementation.",
                "source_files": origins, "adapted_customer_documentation": [name for name in ("README.md", "docs/index.md", "vscode-extension/README.md") if name in payload],
                "application_license": "LICENSE", "component_license_notice": "NOTICE",
                "extension_license": "vscode-extension/LICENSE",
                "files": files}
    manifest_bytes = (json.dumps(manifest, indent=2, sort_keys=True) + "\n").encode("utf8")
    payload["RELEASE-MANIFEST.json"] = manifest_bytes
    directory = checked(source, ".runtime/releases")
    directory.mkdir(parents=True, exist_ok=True)
    # Content-addressed filenames keep paid-download artifacts immutable by identity.
    filename = f"codeme-{version}-local-{hashlib.sha256(manifest_bytes).hexdigest()[:12]}.zip"
    target = directory / filename
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=directory, prefix="release-", suffix=".tmp", delete=False) as handle:
            temporary = Path(handle.name)
        with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
            for name, data in sorted(payload.items()):
                info = zipfile.ZipInfo(f"CodeMe-{version}/{name}", date_time=(1980, 1, 1, 0, 0, 0))
                info.create_system = 3
                info.external_attr = (stat.S_IFREG | 0o644) << 16
                info.compress_type = zipfile.ZIP_DEFLATED
                archive.writestr(info, data, compresslevel=9)
        install_immutable_file(temporary, target)
    finally:
        if temporary is not None: temporary.unlink(missing_ok=True)
    digest = file_sha256(target)
    manifest_path = checked(source, target.with_suffix(".manifest.json").relative_to(source).as_posix())
    checksum_path = checked(source, target.with_suffix(".sha256").relative_to(source).as_posix())
    write_metadata(manifest_path, manifest_bytes)
    write_metadata(checksum_path, f"{digest}  {filename}\n".encode("utf8"))
    return {"status": "built", "path": str(target), "bytes": target.stat().st_size, "sha256": digest,
            "version": version, "files": len(payload), "manifest": str(target.with_suffix(".manifest.json")),
            "source_revision": manifest["source_revision"], "content_sha256": content_hash}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--without-extension", action="store_true", help="Explicitly create a browser-only package without a VSIX.")
    args = parser.parse_args(argv)
    try:
        result = build_release(include_extension=not args.without_extension)
    except (OSError, ValueError, SyntaxError, zipfile.BadZipFile, KeyError) as exc:
        print(json.dumps({"status": "failed", "error": str(exc)}))
        return 1
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
