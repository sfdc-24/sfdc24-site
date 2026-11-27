#!/usr/bin/env python3
"""Build a one-file, offline preview of the guest seat (/guest/) for the owner to look at before anything ships.

The preview is the real page: guest/index.html's body, assets/chrome.css, assets/guest-room.css, guest-typing.js and
guest-room.js, inlined as they are. Only three things are swapped, and only in the preview file:

  - the media client (guest-media-client.js) is replaced by tools/guest_preview_stub.js, a stand-in room: Rigel joins,
    then a sample shared screen (drawn on a canvas) comes up. Nothing connects anywhere;
  - fetch() answers the page's two requests (the join config and the join) from the stub, as a demo pass would;
  - location.hash / location.search / location.pathname / history.replaceState in the page's scripts read a stand-in
    address (window.__guestPreviewLoc), so the preview behaves like /guest/?demo=1#CODE wherever it is opened.

A small "Preview" bar at the top picks the welcome line (a, b, c) and a scenario (normal, microphone denied, sound
blocked, pass used up), and restarts the page. No code, token, guest data or secret is in the file.

    python tools/guest_preview.py --out <file.html>

The output has no <html>/<head>/<body> of its own (a claude.ai Artifact page adds the skeleton); --standalone wraps it
in one, for opening the file directly in a browser.
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SITE = "https://www.sfdc24.com"
SWAPS = (
    ("history.replaceState(", "__guestPreviewLoc.replaceState("),
    ("location.hash", "__guestPreviewLoc.hash"),
    ("location.search", "__guestPreviewLoc.search"),
    ("location.pathname", "__guestPreviewLoc.pathname"),
)


def read(rel: str) -> str:
    return (ROOT / rel).read_text(encoding="utf-8")


def swap(text: str, name: str, need: tuple) -> str:
    """The stand-in address for the page's own reads of it. Every swap the page needs must happen, or the build fails."""
    for old, new in SWAPS:
        count = text.count(old)
        if old in need and count == 0:
            raise SystemExit("guest_preview: %s no longer reads %s; update the preview" % (name, old))
        text = text.replace(old, new)
    return text


def body_of(html: str) -> tuple:
    """(body attributes, body markup without its external scripts) from guest/index.html."""
    found = re.search(r"<body([^>]*)>(.*)</body>", html, re.S)
    if not found:
        raise SystemExit("guest_preview: guest/index.html has no body")
    attrs, inner = found.group(1), found.group(2)
    inner = re.sub(r'<script src="[^"]*"[^>]*></script>\s*', "", inner)
    inner = re.sub(r'href="/', 'href="%s/' % SITE, inner)          # the footer's links go to the live site
    inner = inner.replace('action="/guest/"', 'action="#"')
    return attrs, inner


def build(standalone: bool) -> str:
    html = read("guest/index.html")
    attrs, inner = body_of(html)
    inner = swap(inner, "guest/index.html", ("location.hash", "location.search"))
    classes = re.search(r'class="([^"]*)"', attrs)
    room = swap(read("assets/guest-room.js"), "guest-room.js",
                ("history.replaceState(", "location.hash", "location.search", "location.pathname"))
    parts = [
        '<title>Guest Demo Preview</title>',
        '<meta name="robots" content="noindex">',
        '<style>\n' + read("assets/chrome.css") + '\n' + read("assets/guest-room.css") + '\n' + PREVIEW_CSS + '</style>',
        PREVIEW_BAR,
        # Before the page's own inline script, which reads the stand-in address at once.
        '<script>\n' + (ROOT / "tools" / "guest_preview_stub.js").read_text(encoding="utf-8") + '\n</script>',
        inner.strip(),
        '<script>document.body.className = %r;</script>' % (classes.group(1) if classes else ""),
        '<script>\n' + read("assets/guest-typing.js") + '\n</script>',
        '<script>\n' + room + '\n</script>',
    ]
    page = "\n".join(parts) + "\n"
    if standalone:
        page = ('<!DOCTYPE html>\n<html lang="en" data-palette="cobalt">\n<head>\n<meta charset="utf-8">\n'
                '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n</head>\n'
                '<body>\n' + page + '</body>\n</html>\n')
    for secret in ("join_token\":", "serviceUrl\": \"https://conference-guest"):
        if secret in page:
            raise SystemExit("guest_preview: refusing to write a preview that holds %s" % secret)
    return page


PREVIEW_CSS = """
/* The preview bar: not part of the guest page. */
:root { --preview-bg: #1F2A37; --preview-fg: #F3F6FA; --preview-chip: #33445A; --preview-on: #0A66C2; }
body { background: var(--paper); color: var(--ink); }
.pv-bar { display: flex; flex-wrap: wrap; gap: 6px 10px; align-items: center; padding-block: 8px;
  padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px));
  background: var(--preview-bg); color: var(--preview-fg); font: 600 12px/1.3 var(--ui); }
.pv-bar strong { letter-spacing: 0.06em; text-transform: uppercase; }
.pv-group { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
.pv-bar button { min-height: 30px; padding: 4px 10px; border: 0; border-radius: 999px; background: var(--preview-chip);
  color: var(--preview-fg); font: 600 12px/1 var(--ui); cursor: pointer; }
.pv-bar button[aria-pressed="true"] { background: var(--preview-on); }
.pv-bar button:focus-visible { outline: 2px solid var(--preview-fg); outline-offset: 1px; }
.pv-note { color: color-mix(in srgb, var(--preview-fg) 70%, var(--preview-bg)); font-weight: 500; }
"""

PREVIEW_BAR = """<div class="pv-bar" id="pv-bar" role="region" aria-label="Preview controls">
  <strong>Preview</strong><span class="pv-note">Nothing connects. Sample screen.</span>
  <span class="pv-group" aria-label="Welcome line">Line
    <button type="button" id="pv-notice-a" data-pv-notice="a">A</button>
    <button type="button" id="pv-notice-b" data-pv-notice="b">B</button>
    <button type="button" id="pv-notice-c" data-pv-notice="c">C</button>
  </span>
  <span class="pv-group" aria-label="Scenario">
    <button type="button" id="pv-s-normal" data-pv-scenario="normal">Normal</button>
    <button type="button" id="pv-s-mic" data-pv-scenario="mic">Mic denied</button>
    <button type="button" id="pv-s-sound" data-pv-scenario="sound">Sound blocked</button>
    <button type="button" id="pv-s-used" data-pv-scenario="used">Pass used up</button>
  </span>
  <button type="button" id="pv-restart">Restart</button>
</div>"""


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--out", required=True, help="the preview file to write")
    parser.add_argument("--standalone", action="store_true", help="wrap it in its own html/head/body")
    args = parser.parse_args(argv)
    Path(args.out).write_bytes(build(args.standalone).encode("utf-8"))
    print("guest_preview: wrote %s" % args.out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
