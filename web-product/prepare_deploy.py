"""Prepare a scoped Hostinger overlay; never include merchant secrets or runtime data."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import zipfile


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "web-product"
OUTPUT = ROOT / ".runtime" / "deployment"
ARCHIVE = "codeme-0.7.0-local-c015749a7d93.zip"
ARCHIVE_SHA = "6f640c61bb3b83b578b0740525ebe65b5f677f80422edb47abd8a3af221d8639"
ARCHIVE_BYTES = 638432


def main() -> None:
    public_files = [
        "index.html", "styles.css", "checkout.mjs",
        "assets/codeme-logo.svg", "assets/codeme-wordmark-light.svg",
        "assets/codeme-512.png", "api/_bootstrap.php", "api/payments.php", "api/download.php",
    ]
    private_files = ["bootstrap.php", "config.php", "lib/Commerce.php", "check-install.php"]
    entries = [(SOURCE / "public" / name, "public_html/products/codeme/" + name) for name in public_files]
    entries += [(SOURCE / "private" / name, "codeme-payments-private/" + name) for name in private_files]
    entries.append((ROOT / ".runtime/releases" / ARCHIVE, "codeme-payments-private/releases/" + ARCHIVE))
    blobs = []
    manifest = []
    for source, target in entries:
        if source.is_symlink() or not source.is_file() or not source.resolve().is_relative_to(ROOT):
            raise SystemExit(f"Missing or unsafe deployment source: {source}")
        data = source.read_bytes()
        digest = hashlib.sha256(data).hexdigest()
        if source.name == ARCHIVE and (len(data) != ARCHIVE_BYTES or digest != ARCHIVE_SHA):
            raise SystemExit("Customer release does not match the server-pinned size and checksum")
        blobs.append((target, data))
        manifest.append({"path": target, "bytes": len(data), "sha256": digest})
    OUTPUT.mkdir(parents=True, exist_ok=True)
    destination = OUTPUT / "codeme-product-overlay.zip"
    with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name, data in blobs:
            info = zipfile.ZipInfo(name, date_time=(2026, 10, 31, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = (0o100644 if name.startswith("public_html/") else 0o100600) << 16
            archive.writestr(info, data)
    report = {
        "extract_at": "/home/u942725982/domains/dhebe.com/",
        "public_product": "https://www.dhebe.com/products/codeme/",
        "warning": "Extract only at the domain directory above public_html. Never upload the ZIP under public_html.",
        "archive_sha256": hashlib.sha256(destination.read_bytes()).hexdigest(),
        "files": manifest,
    }
    (OUTPUT / "codeme-product-overlay.manifest.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"overlay": str(destination), "files": len(blobs), "sha256": report["archive_sha256"]}))


if __name__ == "__main__":
    main()
