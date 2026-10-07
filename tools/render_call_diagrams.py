#!/usr/bin/env python3
"""Render the call diagrams to SVG and PNG.

Reads floor/diagrams/call-*.mmd. Writes SVG and PNG beside them, and refreshes
docs/conference-call.html so the file opens locally with the pictures inline.

Needs Google Chrome and the Mermaid bundle at /tmp/mermaid.min.js, or set
MERMAID_JS to a local mermaid.min.js. No network during the render.
"""
from __future__ import annotations

import html
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DIAG = ROOT / "floor" / "diagrams"
DOCS = ROOT / "docs"
NAMES = (
    ("call-access", "1. Conference access and security"),
    ("call-agents", "2. Lay of the land for agents"),
    ("call-future", "3. Future-state processes"),
    ("call-architecture", "4. Redis to the webpage"),
)
MERMAID = Path(os.environ.get("MERMAID_JS", "/tmp/mermaid.min.js"))
CHROME = os.environ.get("CHROME", "google-chrome")


CHROME_FLAGS = (
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-extensions",
    "--disable-background-networking",
    "--no-first-run",
)


def chrome(*args: str, timeout: int = 25) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(
            [CHROME, *CHROME_FLAGS, *args],
            check=False,
            text=True,
            timeout=timeout,
            capture_output=True,
        )
    except subprocess.TimeoutExpired as exc:
        out = exc.stdout or ""
        err = exc.stderr or ""
        if isinstance(out, bytes):
            out = out.decode("utf-8", "replace")
        if isinstance(err, bytes):
            err = err.decode("utf-8", "replace")
        return subprocess.CompletedProcess(exc.cmd, 124, out, err)


def render_one(name: str, source: str, work: Path) -> tuple[str, Path]:
    page = work / f"{name}.html"
    shot = work / f"{name}.png"
    mermaid_copy = work / "mermaid.min.js"
    if not mermaid_copy.exists():
        shutil.copyfile(MERMAID, mermaid_copy)
    page.write_text(
        f"""<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
  body {{ margin: 0; background: #F3F2EF; }}
  .wrap {{ padding: 24px; }}
  .mermaid svg {{ max-width: 1280px; height: auto; }}
</style></head>
<body><div class="wrap"><pre class="mermaid">{html.escape(source)}</pre></div>
<script src="mermaid.min.js"></script>
<script>
  mermaid.initialize({{
    startOnLoad: true,
    securityLevel: "strict",
    theme: "base",
    themeVariables: {{
      primaryColor: "#F3F2EF",
      primaryTextColor: "#191919",
      primaryBorderColor: "#0A66C2",
      lineColor: "#191919",
      secondaryColor: "#FFFFFF",
      tertiaryColor: "#F3F2EF",
      fontFamily: "Segoe UI, sans-serif"
    }}
  }});
</script></body></html>
""",
        encoding="utf-8",
    )
    user = work / f"profile-{name}"
    shot_run = chrome(
        f"--user-data-dir={user}",
        "--window-size=1400,1600",
        "--virtual-time-budget=6000",
        f"--screenshot={shot}",
        page.as_uri(),
    )
    if not shot.is_file() or shot.stat().st_size < 1000:
        raise SystemExit(f"{name}: screenshot failed\n{shot_run.stderr[-500:]}")
    dom_path = work / f"{name}.dom.html"
    dom_run = chrome(
        f"--user-data-dir={user}-dom",
        "--virtual-time-budget=6000",
        "--dump-dom",
        page.as_uri(),
        timeout=20,
    )
    dom = dom_run.stdout or ""
    dom_path.write_text(dom, encoding="utf-8")
    start = dom.find("<svg")
    end = dom.rfind("</svg>")
    if start < 0 or end < 0:
        raise SystemExit(f"{name}: Mermaid produced no SVG")
    svg = dom[start:end + len("</svg>")]
    return svg, shot


def standalone(blocks: list[tuple[str, str, str]]) -> str:
    parts = ["""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Conference diagrams for the call</title>
<style>
  :root { --ink:#191919; --paper:#fff; --mute:#666; --accent:#0A66C2; --soft:#F3F2EF; }
  body { margin:0; background:var(--soft); color:var(--ink); font:16px/1.5 "Segoe UI", sans-serif; }
  main { max-width:1100px; margin:0 auto; padding:24px 16px 64px; }
  h1 { font-weight:500; font-size:1.8rem; }
  h2 { font-weight:500; font-size:1.25rem; margin:2rem 0 .4rem; }
  .banner { background:var(--paper); border-left:3px solid var(--accent); padding:12px 14px; }
  figure { margin:0 0 12px; background:var(--paper); border:1px solid #ddd; overflow:auto; }
  figure svg, figure img { max-width:100%; height:auto; display:block; }
  textarea { width:100%; min-height:12rem; font:13px/1.4 ui-monospace, Menlo, monospace; }
  button { min-height:44px; padding:8px 14px; background:var(--ink); color:var(--paper); border:0; font-weight:600; }
  .note { color:var(--mute); }
</style>
</head>
<body>
<main>
  <h1>Conference diagrams</h1>
  <p class="banner">Sample discussion set. Not a live Redis read. Solid nodes are current. Dashed nodes are future. Edit a diagram below and press Redraw. The repo copies live in floor/diagrams. Captions for the call are in docs/conference-diagrams-brief.md.</p>
"""]
    for name, title, source in blocks:
        parts.append(f"""
  <section id="{name}">
    <h2>{html.escape(title)}</h2>
    <figure id="{name}-pic"><img alt="{html.escape(title)}" src="../floor/diagrams/{name}.svg"></figure>
    <p class="note">Diagram text. Edit here for the call, then copy the result back to floor/diagrams/{name}.mmd.</p>
    <textarea id="{name}-src">{html.escape(source)}</textarea>
    <p><button type="button" data-redraw="{name}">Redraw</button></p>
  </section>
""")
    parts.append("""
</main>
<script src="https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.min.js"></script>
<script>
  function draw(name) {
    var src = document.getElementById(name + "-src").value;
    var pic = document.getElementById(name + "-pic");
    if (!window.mermaid) return;
    mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "base" });
    mermaid.render("live" + name, src).then(function (out) {
      pic.innerHTML = out.svg;
    });
  }
  document.addEventListener("click", function (event) {
    var name = event.target.getAttribute && event.target.getAttribute("data-redraw");
    if (name) draw(name);
  });
</script>
</body>
</html>
""")
    return "".join(parts)


def main() -> None:
    if not MERMAID.is_file():
        raise SystemExit(f"Mermaid bundle missing: {MERMAID}")
    blocks = []
    with tempfile.TemporaryDirectory(prefix="call-diagrams-") as tmp:
        work = Path(tmp)
        for name, title in NAMES:
            source = (DIAG / f"{name}.mmd").read_text(encoding="utf-8")
            svg, shot = render_one(name, source, work)
            (DIAG / f"{name}.svg").write_text(svg, encoding="utf-8")
            shutil.copyfile(shot, DIAG / f"{name}.png")
            blocks.append((name, title, source))
            print(f"rendered {name}")
    DOCS.mkdir(exist_ok=True)
    (DOCS / "conference-call.html").write_text(standalone(blocks), encoding="utf-8")
    print("wrote docs/conference-call.html")


if __name__ == "__main__":
    main()
