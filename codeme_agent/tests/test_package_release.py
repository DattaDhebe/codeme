"""Release privacy/integrity tests create only small synthetic source trees."""

import hashlib
import io
import json
from pathlib import Path
import zipfile

import pytest

from scripts import package_release as release


def write(root, relative, data=b"fixture\n"):
    target = root / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(data if isinstance(data, bytes) else data.encode("utf8"))
    return target


def make_vsix(version="0.7.0", extra=None):
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w") as archive:
        archive.writestr("extension/package.json", json.dumps({"name": "personal-codeme", "version": version}))
        archive.writestr("extension/LICENSE.txt", "MIT fixture notice\n")
        for name, data in (extra or {}).items(): archive.writestr(name, data)
    return stream.getvalue()


@pytest.fixture()
def source(tmp_path, monkeypatch):
    source = tmp_path / "source"; source.mkdir()
    for name in release.ROOT_FILES: write(source, name)
    write(source, "LICENSE", "CodeMe Proprietary License\nLicense identifier: LicenseRef-CodeMe-Proprietary\n")
    write(source, "NOTICE", "Main application restricted; existing extension MIT permissions preserved.\n")
    write(source, "README.md", "# CodeMe\n[setup](docs/getting-started.md)\n[old](CURRENT_IMPLEMENTATION_REPORT.md)\n")
    write(source, "codeme_agent/config.py", "class Settings:\n    version: str = '0.7.0'\n")
    write(source, "codeme_agent/agent.py", "print('source fixture')\n")
    write(source, "alembic/env.py", "# migration environment\n")
    write(source, "alembic/versions/001.py", "# migration\n")
    for name in release.FRONTEND_FILES: write(source, "frontend/" + name, "{}")
    write(source, "frontend/src/main.ts", "export const value = 1;\n")
    write(source, "frontend/public/favicon.ico", b"icon")
    write(source, "frontend/dist/frontend/browser/index.html", "<main>CodeMe</main>")
    write(source, "frontend/dist/frontend/browser/main.js", "console.log('built');")
    write(source, "frontend/dist/frontend/3rdpartylicenses.txt", "existing browser notice\n")
    write(source, "docs/getting-started.md", "# Installation\n")
    write(source, "vscode-extension/LICENSE", "MIT fixture notice\n")
    write(source, "vscode-extension/personal-codeme-0.7.0.vsix", make_vsix())
    monkeypatch.setattr(release, "source_revision", lambda source: "a" * 40)
    return source


def test_payload_excludes_user_state_secrets_models_and_unrelated_files(source):
    private = (".env", "codeme.db", "CURRENT_IMPLEMENTATION_REPORT.md", "unknown.txt", ".runtime/model-choice.json",
               "codeme_agent/private.pem", "codeme_agent/session.token", "codeme_agent/id_rsa", "codeme_agent/id_rsa.backup",
               "codeme_agent/.azure/profile.json", "codeme_agent/.aws/credentials", "codeme_agent/tests/local.py",
               "frontend/public/.env.local", "frontend/public/model.gguf", "frontend/public/weights.safetensors",
               "frontend/src/.npmrc", "frontend/src/node_modules/leak.ts", "frontend/src/.cache/personal.json",
               "frontend/node_modules/data.json", "frontend/.angular/cache/data.json", "docs/private-secret.md")
    for name in private: write(source, name, "SENTINEL_PRIVATE_DATA")
    _, payload, _ = release.collect_payload(source)
    assert ".env.example" in payload
    assert "frontend/dist/frontend/browser/index.html" in payload
    assert "alembic/versions/001.py" in payload
    assert "vscode-extension/LICENSE" in payload
    assert all(b"SENTINEL_PRIVATE_DATA" not in value for value in payload.values())
    assert not set(private).intersection(payload)
    assert b"CURRENT_IMPLEMENTATION_REPORT.md" not in payload["README.md"]


def test_zip_is_reproducible_and_every_payload_file_has_verified_manifest_hash(source):
    first = release.build_release(source)
    first_bytes = Path(first["path"]).read_bytes()
    second = release.build_release(source)
    assert first == second and first_bytes == Path(second["path"]).read_bytes()
    assert hashlib.sha256(first_bytes).hexdigest() == first["sha256"]
    with zipfile.ZipFile(io.BytesIO(first_bytes)) as archive:
        root = "CodeMe-0.7.0/"
        manifest = json.loads(archive.read(root + "RELEASE-MANIFEST.json"))
        names = {info.filename for info in archive.infolist()}
        assert names == {root + item["path"] for item in manifest["files"]} | {root + "RELEASE-MANIFEST.json"}
        for item in manifest["files"]:
            data = archive.read(root + item["path"])
            assert len(data) == item["bytes"] and hashlib.sha256(data).hexdigest() == item["sha256"]
        assert all(info.date_time == (1980, 1, 1, 0, 0, 0) for info in archive.infolist())
        assert manifest["source_revision"] == "a" * 40 and manifest["extension_included"] is True
        assert manifest["contains_model_weights"] is False and manifest["contains_runtimes"] is False
        assert archive.read(root + "LICENSE") == (source / "LICENSE").read_bytes()
        assert archive.read(root + "NOTICE") == (source / "NOTICE").read_bytes()
        assert manifest["application_license"] == "LICENSE" and manifest["extension_license"] == "vscode-extension/LICENSE"
        assert manifest["source_files"]["README.md"]["source_sha256"] == hashlib.sha256((source / "README.md").read_bytes()).hexdigest()
        quickstart = archive.read(root + "START-HERE-WINDOWS.txt").decode("utf8")
        assert "not a standalone .exe" in quickstart and "Node.js 24 LTS" in quickstart
        assert "python install.py" in quickstart and "No model weights are included" in quickstart
    assert Path(first["path"]).with_suffix(".sha256").read_text().startswith(first["sha256"])
    assert not list(Path(first["path"]).parent.glob("*.tmp"))


def test_branded_customer_docs_and_webmanifest_are_included_by_allowlist(source):
    write(source, "README.md", '<picture><img src="docs/brand/codeme-wordmark-light.svg" alt="CodeMe"></picture>\n')
    write(source, "docs/brand/codeme-wordmark-light.svg", '<svg xmlns="http://www.w3.org/2000/svg"/>')
    write(source, "docs/brand/codeme-logo.svg", '<svg xmlns="http://www.w3.org/2000/svg"/>')
    write(source, "docs/brand/codeme-512.png", b"PNG-FIXTURE")
    write(source, "docs/brand/private-secret.svg", "SENTINEL_PRIVATE_DATA")
    write(source, "docs/index.md", "# Documentation\n[license](../LICENSE)\n[the archive](archive/README.md)\n")
    write(source, "docs/release-checklist.md", "# Release checks\n")
    write(source, "frontend/public/manifest.webmanifest", '{"name":"CodeMe"}')
    write(source, "frontend/dist/frontend/browser/manifest.webmanifest", '{"name":"CodeMe"}')
    write(source, "vscode-extension/README.md", '<img src="media/codeme-logo.svg" alt="CodeMe">')
    write(source, "vscode-extension/NOTICE", "Existing code MIT; new brand assets follow root license.\n")
    write(source, "vscode-extension/CHANGELOG.md", "# Extension changes\n")
    write(source, "vscode-extension/media/codeme-logo.svg", '<svg xmlns="http://www.w3.org/2000/svg"/>')
    write(source, "SUPPORT.md", "# Support\n")
    write(source, ".github/copilot-instructions.md", "# Repository guidance\n")
    write(source, "scripts/build_brand_assets.py", "# standard library generator\n")
    write(source, ".github/workflows/ci.yml", "name: CodeMe checks\n")
    write(source, ".github/dependabot.yml", "version: 2\n")
    write(source, ".github/repository-metadata.json", '{"name":"CodeMe"}')
    write(source, "vscode-extension/personal-codeme-0.7.0.vsix", make_vsix(extra={"extension/NOTICE": (source / "vscode-extension/NOTICE").read_bytes()}))
    _, payload, _ = release.collect_payload(source)
    for name in ("docs/index.md", "docs/release-checklist.md", "docs/brand/codeme-logo.svg", "docs/brand/codeme-512.png",
                 "vscode-extension/media/codeme-logo.svg", "vscode-extension/NOTICE", "vscode-extension/CHANGELOG.md", "frontend/public/manifest.webmanifest", "frontend/dist/frontend/browser/manifest.webmanifest", "SUPPORT.md", ".github/copilot-instructions.md", ".github/workflows/ci.yml", ".github/dependabot.yml", ".github/repository-metadata.json", "scripts/build_brand_assets.py"):
        assert name in payload
    assert b"archive/" not in payload["docs/index.md"]
    assert b"main-application" in payload["THIRD-PARTY-NOTICES.md"]
    assert b"MIT" in payload["THIRD-PARTY-NOTICES.md"]
    assert b"ready-to-install extension" in payload["vscode-extension/README.md"]
    assert all(b"SENTINEL_PRIVATE_DATA" not in data for data in payload.values())


def test_missing_root_license_and_unapproved_brand_image_fail_closed(source):
    write(source, "README.md", '<img src="docs/brand/unreviewed.svg">')
    write(source, "docs/brand/unreviewed.svg", "not allowlisted")
    with pytest.raises(ValueError, match="absent from the release allowlist"):
        release.collect_payload(source)
    (source / "LICENSE").unlink()
    with pytest.raises(ValueError, match="LICENSE"):
        release.collect_payload(source)


def test_current_version_and_required_prebuilt_assets_are_enforced(source):
    (source / "frontend/dist/frontend/browser/index.html").unlink()
    with pytest.raises(ValueError, match="missing"):
        release.build_release(source)
    assert not (source / ".runtime/releases").exists()


def test_existing_different_artifact_is_never_silently_replaced(source):
    result = release.build_release(source)
    target = Path(result["path"])
    target.write_bytes(b"different artifact under this identity")
    with pytest.raises(ValueError, match="Refusing to overwrite"):
        release.build_release(source)
    assert target.read_bytes() == b"different artifact under this identity"


def test_stale_vsix_version_is_rejected(source):
    write(source, "vscode-extension/personal-codeme-0.7.0.vsix", make_vsix("0.6.0"))
    with pytest.raises(ValueError, match="name/version"):
        release.build_release(source)


def test_stale_vsix_license_or_brand_notice_is_rejected(source):
    write(source, "vscode-extension/NOTICE", "Current brand terms\n")
    with pytest.raises(ValueError, match="current component notice"):
        release.collect_payload(source)
    write(source, "vscode-extension/personal-codeme-0.7.0.vsix", make_vsix(extra={"extension/NOTICE": "Current brand terms\n"}))
    write(source, "vscode-extension/LICENSE", "Changed component license\n")
    with pytest.raises(ValueError, match="license differs"):
        release.collect_payload(source)
    write(source, "vscode-extension/LICENSE", "MIT fixture notice\n")
    write(source, "vscode-extension/THIRD_PARTY_NOTICES.txt", "Current dependency notices\n")
    with pytest.raises(ValueError, match="third-party notices"):
        release.collect_payload(source)


@pytest.mark.parametrize("name", ["extension/.env", "extension/id_ed25519", "../outside.txt", "C:/user.txt"])
def test_vsix_cannot_smuggle_private_or_escaping_files(source, name):
    write(source, "vscode-extension/personal-codeme-0.7.0.vsix", make_vsix(extra={name: "PRIVATE"}))
    with pytest.raises(ValueError, match="private or unsafe"):
        release.build_release(source)


def test_source_symlinks_are_refused_without_reading_external_data(source, tmp_path):
    outside = write(tmp_path, "outside.py", "SENTINEL_PRIVATE_DATA")
    link = source / "codeme_agent/linked.py"
    try: link.symlink_to(outside)
    except OSError: pytest.skip("Host does not permit test symlinks")
    with pytest.raises(ValueError, match="symlink or external"):
        release.build_release(source)


def test_file_size_limit_prevents_large_payload_collection(source, monkeypatch):
    monkeypatch.setattr(release, "MAX_FILE_BYTES", 5)
    with pytest.raises(ValueError, match="too large"):
        release.collect_payload(source)


def test_explicit_browser_only_package_does_not_pretend_to_include_agent_extension(source):
    (source / "vscode-extension/personal-codeme-0.7.0.vsix").unlink()
    _, payload, _ = release.collect_payload(source, include_extension=False)
    assert not any(path.endswith(".vsix") for path in payload)
    assert b"does not include a VSIX" in payload["START-HERE-WINDOWS.txt"]
