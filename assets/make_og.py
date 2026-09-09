#!/usr/bin/env python3
"""Regenerate assets/og.png.

WHY THIS SCRIPT EXISTS RATHER THAN A HAND-MADE PNG
--------------------------------------------------
The previous og.png read "Salesforce operations for orgs nobody wants to touch"
and "Independent consulting - Toronto". It was the ONLY surface still carrying
both the superseded proposition and the person-centric framing after the body
copy, the title, the share metadata and the manifest had all been corrected -
and it is the surface a visitor sees FIRST, because a link shared on LinkedIn or
WhatsApp is the image, not the page.

It survived because nothing could read it. Every guard in tests/ reads text; a
PNG is opaque to all of them. So the card is generated from the text below,
which a test CAN read, and the test asserts the source text carries the
proposition and none of the retired phrases. The image is then a build artifact
of a checked string rather than a binary nobody can audit.

Run:  python assets/make_og.py
"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent

# ---- the copy, which is what the test reads ------------------------------
BRAND = "sfdc24"
HEADLINE = [
    "Salesforce assessment,",
    "automation and",
    "AI enablement",
]
SUBLINE = "For enterprises  \u00b7  Research stage"
URL = "www.sfdc24.com"

# ---- palette, matching the site's dark theme -----------------------------
BG = (11, 13, 16)
CARD_EDGE = (38, 43, 51)
INK = (233, 237, 243)
MUTED = (138, 148, 163)
ACCENT = (0, 224, 143)

W, H = 1200, 630


def font(name: str, size: int) -> ImageFont.FreeTypeFont:
    for path in (rf"C:\Windows\Fonts\{name}", f"/usr/share/fonts/truetype/dejavu/{name}"):
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            continue
    raise SystemExit(f"font not found: {name} - install it or edit this list")


def main() -> None:
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)

    d.rounded_rectangle([30, 30, W - 30, H - 30], radius=18, outline=CARD_EDGE, width=2)

    d.text((78, 82), BRAND, font=font("consolab.ttf", 30), fill=ACCENT)

    y = 196
    head = font("arialbd.ttf", 66)
    for line in HEADLINE:
        d.text((78, y), line, font=head, fill=INK)
        y += 80

    d.text((78, 452), SUBLINE, font=font("arial.ttf", 30), fill=MUTED)
    d.line([(78, 516), (178, 516)], fill=ACCENT, width=5)
    d.text((78, 542), URL, font=font("consola.ttf", 24), fill=MUTED)

    out = HERE / "og.png"
    img.save(out, "PNG", optimize=True)
    print(f"wrote {out} ({out.stat().st_size} bytes, {W}x{H})")


if __name__ == "__main__":
    main()
