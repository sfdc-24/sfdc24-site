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


PAGE = """<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
  html, body {{ margin: 0; background: #F3F2EF; }}
  .wrap {{ margin: 0; }}
</style></head>
<body><div class="wrap"><pre class="mermaid">{source}</pre></div>
<script src="mermaid.min.js"></script>
<script>
  mermaid.initialize({{
    startOnLoad: true,
    securityLevel: "strict",
    theme: "base",
    flowchart: {{ htmlLabels: true, wrappingWidth: 220, padding: 16, nodeSpacing: 36, rankSpacing: 44 }},
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
"""

TIGHTEN = r"""
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const work = process.argv[2];
const port = 9335;
const chrome = spawn("google-chrome", [
  "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
  "--disable-extensions", "--disable-background-networking", "--no-first-run",
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${join(work, "cdp-profile")}`,
  "about:blank",
], { stdio: "ignore" });

async function ready() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return await res.json();
    } catch {}
    await delay(250);
  }
  throw new Error("chrome did not open a debug port");
}

const version = await ready();
const browser = new WebSocket(version.webSocketDebuggerUrl);
let seq = 0;
const pending = new Map();
browser.addEventListener("message", (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
});
await new Promise((resolve) => browser.addEventListener("open", resolve));

function send(method, params = {}, sessionId) {
  const id = ++seq;
  const payload = { id, method, params };
  if (sessionId) payload.sessionId = sessionId;
  browser.send(JSON.stringify(payload));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout ${method}`)), 25000);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    });
  });
}

const measure = `(() => {
  const svg = document.querySelector("svg");
  if (!svg) return { error: "no svg" };
  if (/syntax error/i.test(svg.textContent || "")) return { error: "syntax", text: svg.textContent.slice(0, 240) };
  const bb = svg.getBBox();
  const pad = 16;
  const x = bb.x - pad;
  const y = bb.y - pad;
  const w = bb.width + pad * 2;
  const h = bb.height + pad * 2;
  svg.setAttribute("viewBox", x + " " + y + " " + w + " " + h);
  svg.setAttribute("width", String(Math.ceil(w)));
  svg.setAttribute("height", String(Math.ceil(h)));
  svg.style.maxWidth = "none";
  svg.style.width = Math.ceil(w) + "px";
  svg.style.height = Math.ceil(h) + "px";
  const clips = [];
  document.querySelectorAll(".cluster-label div, .node .label div").forEach((el) => {
    const text = (el.textContent || "").replace(/\s+/g, " ").trim();
    if (!text) return;
    if (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1) {
      clips.push(text);
    }
  });
  document.querySelectorAll(".cluster").forEach((cluster) => {
    const label = cluster.querySelector(".cluster-label");
    if (!label) return;
    const lr = label.getBoundingClientRect();
    cluster.querySelectorAll(".node").forEach((node) => {
      const nr = node.getBoundingClientRect();
      const overlap = Math.min(lr.bottom, nr.bottom) - Math.max(lr.top, nr.top);
      if (overlap > 1) clips.push("overlap: " + (label.textContent || "").trim());
    });
  });
  const rect = svg.getBoundingClientRect();
  return {
    svg: svg.outerHTML,
    clips,
    width: Math.ceil(rect.width),
    height: Math.ceil(rect.height),
    x: rect.x,
    y: rect.y
  };
})()`;

try {
  const pages = readdirSync(work).filter((name) => name.endsWith(".html")).sort();
  for (const file of pages) {
    const name = file.replace(/\.html$/, "");
    const { targetId } = await send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
    await send("Page.enable", {}, sessionId);
    await send("Runtime.enable", {}, sessionId);
    await send("Emulation.setDeviceMetricsOverride", {
      width: 3600, height: 2200, deviceScaleFactor: 1, mobile: false,
    }, sessionId);
    await send("Page.navigate", { url: "file://" + join(work, file) }, sessionId);
    let measured = null;
    for (let i = 0; i < 40; i++) {
      await delay(250);
      const result = await send("Runtime.evaluate", { expression: measure, returnByValue: true }, sessionId);
      const value = result.result && result.result.value;
      if (value && value.svg) { measured = value; break; }
      if (value && value.error && value.error !== "no svg") throw new Error(name + ": " + JSON.stringify(value));
    }
    if (!measured) throw new Error(name + ": Mermaid produced no SVG");
    if (measured.clips.length) {
      console.error(name + " clipped text: " + measured.clips.join(" | "));
      process.exitCode = 2;
    }
    await send("Emulation.setDeviceMetricsOverride", {
      width: Math.max(measured.width + 8, 1),
      height: Math.max(measured.height + 8, 1),
      deviceScaleFactor: 1,
      mobile: false,
    }, sessionId);
    await delay(150);
    const again = await send("Runtime.evaluate", {
      expression: `(() => { const r = document.querySelector("svg").getBoundingClientRect(); return {x:r.x,y:r.y,width:Math.ceil(r.width),height:Math.ceil(r.height), svg: document.querySelector("svg").outerHTML}; })()`,
      returnByValue: true,
    }, sessionId);
    const box = again.result.value;
    const shot = await send("Page.captureScreenshot", {
      format: "png",
      clip: { x: box.x, y: box.y, width: box.width, height: box.height, scale: 2 },
      captureBeyondViewport: true,
    }, sessionId);
    writeFileSync(join(work, name + ".svg"), box.svg);
    writeFileSync(join(work, name + ".png"), Buffer.from(shot.data, "base64"));
    console.log("tight " + name + " " + box.width + "x" + box.height);
    await send("Target.closeTarget", { targetId });
  }
} finally {
  chrome.kill("SIGKILL");
  try { browser.close(); } catch {}
}
"""


def render_all(work: Path) -> None:
    script = work / "tighten.mjs"
    script.write_text(TIGHTEN, encoding="utf-8")
    run = subprocess.run(
        ["node", str(script), str(work)],
        check=False,
        text=True,
        timeout=180,
        capture_output=True,
    )
    print(run.stdout)
    if run.stderr:
        print(run.stderr)
    if run.returncode not in (0, 2):
        raise SystemExit(f"tight render failed ({run.returncode})")
    return run.returncode


def write_page(name: str, source: str, work: Path) -> None:
    mermaid_copy = work / "mermaid.min.js"
    if not mermaid_copy.exists():
        shutil.copyfile(MERMAID, mermaid_copy)
    (work / f"{name}.html").write_text(
        PAGE.format(source=html.escape(source)),
        encoding="utf-8",
    )


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
  main { max-width:1200px; margin:0 auto; padding:24px 16px 64px; }
  h1 { font-weight:500; font-size:1.8rem; }
  h2 { font-weight:500; font-size:1.25rem; margin:1.4rem 0 .4rem; }
  h3 { font-weight:500; font-size:1rem; margin:12px 0 6px; }
  .banner { background:var(--paper); border-left:3px solid var(--accent); padding:12px 14px; }
  .call-split { display:grid; grid-template-columns:minmax(0,1fr) minmax(220px,300px); gap:12px; align-items:start; }
  .call-panel { background:var(--paper); border:1px solid #ddd; padding:12px; min-width:0; }
  .call-figure { margin:0; background:var(--paper); border:1px solid #ddd; overflow:auto; min-width:0; }
  .call-figure svg, .call-figure img { width:100%; height:auto; display:block; }
  textarea, select { width:100%; box-sizing:border-box; margin:0 0 8px; color:var(--ink); background:var(--paper); border:1px solid #ccc; }
  .call-src { min-height:12rem; font:13px/1.4 ui-monospace, Menlo, monospace; }
  .call-note, .call-spoken { min-height:4.5rem; font:15px/1.4 "Segoe UI", sans-serif; }
  .call-btn { min-height:44px; margin:0 8px 8px 0; padding:8px 14px; background:var(--ink); color:var(--paper); border:0; font-weight:600; cursor:pointer; }
  .call-btn-quiet { background:var(--paper); color:var(--ink); border:1px solid var(--ink); }
  .call-hint, .call-meta, .call-pin-status { color:var(--mute); font-size:.9rem; }
  .call-tools { margin:16px 0; }
  .call-edit { margin:8px 0 16px; }
  .call-list { margin:0 0 8px; padding-left:1.2rem; }
  .call-marks { position:absolute; left:0; top:0; right:0; bottom:0; pointer-events:none; }
  .call-pin { position:absolute; width:22px; height:22px; border-radius:50%; background:#0A66C2; color:#fff; font:700 12px/22px "Segoe UI", sans-serif; text-align:center; pointer-events:auto; }
  .call-lock { background:var(--soft); border-left:3px solid var(--accent); padding:8px 10px; margin:0 0 8px; }
  .call-diff { max-height:10rem; overflow:auto; margin:0 0 8px; padding:8px; background:var(--soft); font:12px/1.4 ui-monospace, Menlo, monospace; white-space:pre-wrap; }
  .call-btn:disabled { opacity:.45; cursor:not-allowed; }
  @media (max-width:800px) { .call-split { grid-template-columns:1fr; } }
</style>
</head>
<body>
<main>
  <h1>Conference diagrams</h1>
  <p class="banner">Sample discussion set. Not a live Redis read. Solid nodes are current. Dashed nodes are future. Comments and history stay in this browser. Export notes writes call-notes-2026-10-07.md, the JSON beside it, manifest.json, and approved/&lt;diagram&gt;-v&lt;n&gt;.mmd. After the call, commit the notes under docs/call-notes/ and the approved files under floor/diagrams/approved/. An approved file is never edited again. Captions are in docs/conference-diagrams-brief.md.</p>
"""]
    for name, title, source in blocks:
        svg_path = DIAG / f"{name}.svg"
        svg = svg_path.read_text(encoding="utf-8") if svg_path.is_file() else ""
        if "</textarea" in svg or "</section" in svg:
            raise SystemExit(f"{name}: svg is not safe to embed")
        parts.append(f"""
  <section id="{name}" data-call-diagram="{name}">
    <h2>{html.escape(title)}</h2>
    <figure class="call-figure" id="{name}-pic">{svg}</figure>
    <div class="call-edit" hidden>
      <textarea id="{name}-src" class="call-src">{html.escape(source)}</textarea>
    </div>
  </section>
""")
    parts.append("""
</main>
<script src="https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.min.js"></script>
<script src="../assets/call-markup.js"></script>
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
            write_page(name, source, work)
            blocks.append((name, title, source))
        clipped = render_all(work)
        for name, _title in NAMES:
            svg = (work / f"{name}.svg").read_text(encoding="utf-8")
            if "<svg" not in svg or "Syntax error" in svg:
                raise SystemExit(f"{name}: bad svg")
            (DIAG / f"{name}.svg").write_text(svg, encoding="utf-8")
            shutil.copyfile(work / f"{name}.png", DIAG / f"{name}.png")
            print(f"rendered {name}")
        if clipped:
            raise SystemExit("clipped text remains in a diagram")
    DOCS.mkdir(exist_ok=True)
    (DOCS / "conference-call.html").write_text(standalone(blocks), encoding="utf-8")
    print("wrote docs/conference-call.html")


if __name__ == "__main__":
    main()
