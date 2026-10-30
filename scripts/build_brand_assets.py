"""Regenerate CodeMe's original vector identity and raster exports; stdlib only.

Geometry is shared by the SVG, browser, extension and PNG exports. No font,
image, third-party artwork or network resource is downloaded by this script.
"""

from __future__ import annotations

import json
import math
from pathlib import Path
import struct
import zlib


ROOT = Path(__file__).resolve().parents[1]
NAVY = "#111D32"
COBALT = "#8DA2FF"
TEAL = "#4DE0C1"
INK = "#15243B"
ICE = "#F3F6FF"
C = [(51, 28), (37, 28), (12, 64), (37, 100), (51, 100), (27, 64)]
M = [(61, 100), (61, 28), (74, 28), (89, 51), (104, 28), (116, 28),
     (116, 100), (103, 100), (103, 51), (89, 72), (74, 51), (74, 100)]


def polygon(points: list[tuple[int, int]], color: str) -> str:
    value = " ".join(f"{x},{y}" for x, y in points)
    return f'<polygon points="{value}" fill="{color}"/>'


def geometry(*, monochrome: bool = False, background: bool = True) -> str:
    return ((f'<rect width="128" height="128" rx="27" fill="{NAVY}"/>' if background else "")
            + polygon(C, "currentColor" if monochrome else COBALT)
            + polygon(M, "currentColor" if monochrome else TEAL))


def svg(*, monochrome: bool = False, background: bool = True) -> str:
    return ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" role="img" aria-labelledby="title">'
            '<title id="title">CodeMe — local coding by DHEBE Studios</title>'
            + geometry(monochrome=monochrome, background=background) + '</svg>\n')


def wordmark(*, dark: bool) -> str:
    color = ICE if dark else INK
    secondary = "#AAB9D1" if dark else "#52627A"
    return ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 520 128" role="img" aria-labelledby="title">'
            '<title id="title">CodeMe by DHEBE Studios — local coding, your control</title>'
            + geometry() + f'<g font-family="Segoe UI,Inter,Arial,sans-serif"><text x="156" y="77" font-size="55" '
            f'font-weight="700" letter-spacing="-2" fill="{color}">CodeMe</text>'
            f'<text x="159" y="105" font-size="10" font-weight="600" letter-spacing="2" fill="{secondary}">'
            'LOCAL CODING · DHEBE STUDIOS</text></g></svg>\n')


def rgba(color: str) -> bytes:
    return bytes(int(color[index:index + 2], 16) for index in (1, 3, 5)) + b"\xff"


def png(size: int) -> bytes:
    """Rasterize the same filled geometry with 2x box-sampled antialiasing."""
    scale = size * 2 / 128
    high = size * 2
    canvas = bytearray(high * high * 4)
    radius = 27 * scale
    for y in range(high):
        cy = y + .5
        corner_y = min(cy, high - cy)
        inset = radius - math.sqrt(max(0, radius * radius - (radius - corner_y) ** 2)) if corner_y < radius else 0
        start, end = math.ceil(inset - .5), math.floor(high - inset - .5) + 1
        canvas[(y * high + start) * 4:(y * high + end) * 4] = rgba(NAVY) * (end - start)
    for points, color in ((C, COBALT), (M, TEAL)):
        vertices = [(x * scale, y * scale) for x, y in points]
        for y in range(high):
            cy = y + .5
            intersections = []
            for (x1, y1), (x2, y2) in zip(vertices, vertices[1:] + vertices[:1]):
                if (y1 <= cy < y2) or (y2 <= cy < y1):
                    intersections.append(x1 + (cy - y1) * (x2 - x1) / (y2 - y1))
            intersections.sort()
            for left, right in zip(intersections[::2], intersections[1::2]):
                start, end = math.ceil(left - .5), math.ceil(right - .5)
                canvas[(y * high + start) * 4:(y * high + end) * 4] = rgba(color) * (end - start)
    rows = bytearray()
    for y in range(size):
        rows.append(0)
        for x in range(size):
            offsets = [((y * 2 + dy) * high + x * 2 + dx) * 4 for dy in (0, 1) for dx in (0, 1)]
            alpha = sum(canvas[offset + 3] for offset in offsets)
            rows.extend(round(sum(canvas[offset + channel] * canvas[offset + 3] for offset in offsets) / alpha)
                        if alpha else 0 for channel in range(3))
            rows.append(round(alpha / 4))
    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xffffffff)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(rows, 9)) + chunk(b"IEND", b""))


def write(path: str, data: bytes | str) -> None:
    target = ROOT / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(data.encode("utf8") if isinstance(data, str) else data)


def main() -> None:
    icon_svg = svg()
    for path in ("docs/brand/codeme-logo.svg", "frontend/public/codeme-logo.svg", "vscode-extension/media/codeme-logo.svg"):
        write(path, icon_svg)
    write("docs/brand/codeme-wordmark-light.svg", wordmark(dark=False))
    write("docs/brand/codeme-wordmark-dark.svg", wordmark(dark=True))
    write("docs/brand/codeme-monochrome.svg", svg(monochrome=True, background=False))
    activity = svg(monochrome=True, background=False).replace('role="img" aria-labelledby="title"', 'fill="currentColor"')
    write("vscode-extension/media/codeme-activity.svg", activity)
    # Preserve the old asset path for external integrations which reference it.
    write("vscode-extension/media/personal-codex.svg", activity)
    for size in (32, 180, 192, 256, 512):
        image = png(size)
        if size in (256, 512):
            write(f"docs/brand/codeme-{size}.png", image)
        if size == 256:
            write("vscode-extension/media/codeme.png", image)
        if size in (192, 512):
            write(f"frontend/public/icons/codeme-{size}.png", image)
        if size == 180:
            write("frontend/public/apple-touch-icon.png", image)
        if size == 32:
            entry = struct.pack("<BBBBHHII", 32, 32, 0, 0, 1, 32, len(image), 22)
            write("frontend/public/favicon.ico", struct.pack("<HHH", 0, 1, 1) + entry + image)
    write("frontend/public/manifest.webmanifest", json.dumps({
        "id": "/", "name": "CodeMe", "short_name": "CodeMe", "description": "Local coding, your control. By DHEBE Studios.",
        "start_url": "/", "scope": "/", "display": "standalone", "background_color": NAVY, "theme_color": NAVY,
        "icons": [{"src": f"icons/codeme-{size}.png", "sizes": f"{size}x{size}", "type": "image/png", "purpose": "any"}
                  for size in (192, 512)]}, indent=2) + "\n")
    print("CodeMe vector, PNG, favicon and manifest assets regenerated.")


if __name__ == "__main__":
    main()
