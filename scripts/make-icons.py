"""Render the PWA icons (PNG) from public/icons/radar.svg with Playwright.

Usage (repo venv activated, from the repo root):
    python scripts/make-icons.py          # or: npm run icons:make

Environment:
    PW_CHANNEL  chromium channel, default "msedge" (same as scripts/screenshots.py)

Writes to public/icons/:
    icon-192.png          192x192, the mark (purpose "any")
    icon-512.png          512x512, the mark (purpose "any")
    maskable-512.png      512x512, the mark scaled to 66% on a full-bleed #0B0F17
                          square so it stays inside the 80% maskable safe zone
    apple-touch-icon.png  180x180, the mark

The page is a local file:// document (no server, no CSP) that embeds the SVG
with <img>; each PNG is a viewport-sized screenshot at device scale factor 1,
so the pixel size equals the requested size exactly. The PNGs are committed;
re-run only when the mark changes.
"""

import os
import struct
import sys
import tempfile
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
ICON_DIR = ROOT / "public" / "icons"
SVG = ICON_DIR / "radar.svg"
CHANNEL = os.environ.get("PW_CHANNEL", "msedge")
BG = "#0B0F17"

# (file name, canvas size, mark size)
TARGETS = [
    ("icon-192.png", 192, 192),
    ("icon-512.png", 512, 512),
    ("maskable-512.png", 512, int(round(512 * 0.66))),
    ("apple-touch-icon.png", 180, 180),
]

PAGE = """<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
html, body { margin: 0; padding: 0; width: %(size)dpx; height: %(size)dpx; overflow: hidden; }
body { background: %(bg)s; display: grid; place-items: center; }
img { display: block; width: %(mark)dpx; height: %(mark)dpx; }
</style></head><body><img src="%(svg)s" alt=""></body></html>
"""


def png_size(path):
    with open(path, "rb") as f:
        head = f.read(24)
    if len(head) < 24 or head[:8] != b"\x89PNG\r\n\x1a\n":
        return (0, 0)
    return struct.unpack(">II", head[16:24])


def main():
    if not SVG.exists():
        print("missing %s" % SVG)
        return 1
    svg_url = SVG.resolve().as_uri()
    failed = 0
    with tempfile.TemporaryDirectory() as tmp, sync_playwright() as p:
        browser = p.chromium.launch(headless=True, channel=CHANNEL)
        try:
            for name, size, mark in TARGETS:
                html = Path(tmp) / ("%s.html" % name)
                html.write_text(PAGE % {"size": size, "mark": mark, "bg": BG, "svg": svg_url}, encoding="utf-8")
                ctx = browser.new_context(viewport={"width": size, "height": size}, device_scale_factor=1)
                page = ctx.new_page()
                page.goto(html.resolve().as_uri(), wait_until="load")
                page.wait_for_function("document.images.length === 1 && document.images[0].complete && document.images[0].naturalWidth > 0")
                out = ICON_DIR / name
                page.screenshot(path=str(out), full_page=False, omit_background=False)
                ctx.close()
                dims = png_size(out)
                ok = dims == (size, size)
                print("%s  %s  %dx%d  %d bytes" % ("PASS" if ok else "FAIL", name, dims[0], dims[1], out.stat().st_size))
                if not ok:
                    failed += 1
        finally:
            browser.close()
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
