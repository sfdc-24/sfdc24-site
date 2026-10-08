// Dashboard charts and the placeholder governance file. Run:
// node --test tests/dashboard_milestones.cjs
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");

const root = path.join(__dirname, "..");
const BANNED = ["Grok", "Codex", "Gemini", "Cursor", "Copilot", "OpenAI", "Anthropic", "xAI", "LiveKit", "Deepgram", "Redis", "Docker", "Claudia"];

function hits(text) {
  const found = {};
  for (const word of BANNED) {
    const re = new RegExp("\\b" + word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "g");
    const n = (text.match(re) || []).length;
    if (n) found[word] = n;
  }
  return found;
}

function jsonFiles(dir) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) out.push(...jsonFiles(full));
    else if (name.endsWith(".json")) out.push(full);
  }
  return out;
}

test("committed chart text and the placeholder file use persona names only", () => {
  const files = [
    "dashboard/index.html",
    "assets/milestones/2026-10-08.mmd",
    "assets/milestones/2026-10-08-progress.mmd",
    "assets/milestones/pokayoke.json",
    "assets/milestones.js"
  ];
  for (const rel of files) {
    const text = fs.readFileSync(path.join(root, rel), "utf8");
    assert.deepEqual(hits(text), {}, rel);
  }
  const page = fs.readFileSync(path.join(root, "dashboard/index.html"), "utf8");
  assert.match(page, /as of Oct 8, 2026 1:50 PM ET/);
  assert.match(page, /Early access/);
  assert.match(page, /Mistake-proofing \(poka-yoke\) learnings/);
  assert.match(page, /15 pass, 8 fail, 2 not testable of 25/);
  assert.match(page, /as of Oct 8, 2026 2:11 PM ET/);
  assert.match(page, /proj:pokayoke:v1/);
  assert.match(page, /proj:governance:v1/);
  assert.match(page, /id="milestone-live" disabled/);
  const data = JSON.parse(fs.readFileSync(path.join(root, "assets/milestones/pokayoke.json"), "utf8"));
  assert.equal(data.placeholder, "Governance check in progress, results pending");
  assert.equal(data.governance_score, "15 pass, 8 fail, 2 not testable of 25");
  assert.equal(data.governance_as_of, "Oct 8, 2026 2:11 PM ET");
  assert.equal(data.learnings.length, 18);
  assert.equal(data.governance.length, 17);
  assert.deepEqual(data.learnings.map((row) => row.id), Array.from({ length: 18 }, (_, i) => "PY-" + String(i + 1).padStart(2, "0")));
  const counts = {};
  for (const row of data.governance) {
    counts[row.verdict] = (counts[row.verdict] || 0) + 1;
    assert.equal(row.as_of, "Oct 8, 2026 2:11 PM ET");
  }
  assert.deepEqual(counts, { PASS: 8, FAIL: 8, "NOT TESTABLE": 1 });
  assert.match(JSON.stringify(data), /code-review request channel/);
  assert.match(JSON.stringify(data), /Shared-state worker/);
  const script = fs.readFileSync(path.join(root, "assets/milestones.js"), "utf8");
  assert.match(script, /LIVE_CHART = false/);
  assert.match(script, /proj:milestones:v1:mermaid/);
  assert.match(script, /proj:pokayoke:v1/);
  assert.match(script, /proj:governance:v1/);
  assert.doesNotMatch(script, /fetch\([^)]*proj:/);
});

test("served JSON under assets and data stays free of banned names, except recorded internal snapshots", () => {
  for (const file of jsonFiles(path.join(root, "assets"))) {
    assert.deepEqual(hits(fs.readFileSync(file, "utf8")), {}, path.relative(root, file));
  }
  // These snapshots are the recorded source. Public pages translate them at
  // render time. A new JSON file under data/ is not on this list and is scanned.
  const recorded = new Set([
    "data/org.json",
    "data/next-release.json",
    "data/ops-agent-metrics.json",
    "data/board-ops-snap.json",
    "data/ops-delivery.json",
    "data/history-timeline.json"
  ]);
  for (const file of jsonFiles(path.join(root, "data"))) {
    const rel = path.relative(root, file);
    if (recorded.has(rel)) continue;
    assert.deepEqual(hits(fs.readFileSync(file, "utf8")), {}, rel);
  }
});

function chromeBin() {
  for (const bin of ["/usr/bin/google-chrome-stable", "/usr/bin/google-chrome", "/usr/local/bin/google-chrome"]) {
    if (fs.existsSync(bin)) return bin;
  }
  return null;
}

test("mermaid draws the dashboard without console errors or banned names", async (t) => {
  const bin = chromeBin();
  if (!bin) {
    t.skip("chrome is not installed");
    return;
  }
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith("/")) rel += "index.html";
    const file = path.resolve(root, "." + rel);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) {
      res.writeHead(404).end("missing");
      return;
    }
    const types = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".json": "application/json", ".mmd": "text/plain", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".png": "image/png" };
    res.writeHead(200, { "content-type": types[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const origin = "http://127.0.0.1:" + port;
  const debug = 9333 + (port % 1000);
  const chrome = spawn(bin, [
    "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
    "--disable-extensions", "--no-first-run",
    "--user-data-dir=/tmp/dash-chrome-" + process.pid,
    "--remote-debugging-port=" + debug,
    "about:blank"
  ], { stdio: "ignore" });
  try {
    let version;
    for (let i = 0; i < 40; i++) {
      try {
        version = await new Promise((resolve, reject) => {
          http.get("http://127.0.0.1:" + debug + "/json/version", (res) => {
            let body = "";
            res.on("data", (chunk) => { body += chunk; });
            res.on("end", () => resolve(JSON.parse(body)));
          }).on("error", reject);
        });
        break;
      } catch (err) {
        await new Promise((r) => setTimeout(r, 150));
      }
    }
    assert.ok(version, "chrome did not start");
    const ws = new WebSocket(version.webSocketDebuggerUrl);
    let next = 1;
    const pending = new Map();
    const events = [];
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve);
      ws.addEventListener("error", reject);
    });
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      } else if (msg.method) events.push(msg);
    });
    const send = (method, params, sessionId) => new Promise((resolve, reject) => {
      const id = next++;
      const packet = { id, method, params: params || {} };
      if (sessionId) packet.sessionId = sessionId;
      pending.set(id, (msg) => msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result));
      ws.send(JSON.stringify(packet));
    });
    const { targetId } = await send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
    const page = (method, params) => send(method, params, sessionId);
    await page("Page.enable");
    await page("Runtime.enable");
    await page("Log.enable");
    async function openAt(width, height) {
      await page("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 500 });
      await page("Page.navigate", { url: origin + "/dashboard/" });
      await new Promise((r) => setTimeout(r, 5000));
    }
    await openAt(1280, 900);
    const evaled = await page("Runtime.evaluate", {
      expression: `JSON.stringify({
        text: document.body.innerText,
        svgs: document.querySelectorAll("#chart-progress svg, #chart-timeline svg").length,
        governance: (document.getElementById("governance-status") || {}).textContent || "",
        poke: (document.getElementById("pokayoke-status") || {}).textContent || "",
        disabled: document.getElementById("milestone-live").disabled,
        error: (document.getElementById("chart-error") || {}).hidden,
        links: [...document.querySelectorAll("a[href]")].map(a => a.getAttribute("href"))
      })`,
      returnByValue: true
    });
    const data = JSON.parse(evaled.result.value);
    assert.deepEqual(hits(data.text), {}, data.text.slice(0, 500));
    assert.equal(data.svgs, 2, "both charts should draw");
    assert.equal(data.governance, "15 pass, 8 fail, 2 not testable of 25");
    assert.match(data.text, /as of Oct 8, 2026 2:11 PM ET/);
    assert.match(data.text, /PY-01/);
    assert.match(data.text, /code-review request channel/);
    assert.equal(data.poke, "");
    assert.equal(data.disabled, true);
    assert.equal(data.error, true);
    const clipExpr = `(() => {
      const bad = [];
      const doc = document.documentElement;
      if (doc.scrollWidth > doc.clientWidth + 1) bad.push("page scroll " + doc.scrollWidth + ">" + doc.clientWidth);
      for (const id of ["chart-progress", "chart-timeline"]) {
        const svg = document.querySelector("#" + id + " svg");
        if (!svg) { bad.push(id + " missing"); continue; }
        const sb = svg.getBoundingClientRect();
        for (const t of svg.querySelectorAll("text")) {
          const r = t.getBoundingClientRect();
          if (r.width < 1) continue;
          if (r.left < sb.left - 2 || r.right > sb.right + 2 || r.top < sb.top - 2 || r.bottom > sb.bottom + 2) {
            bad.push(id + ": " + t.textContent.slice(0, 70));
          }
        }
      }
      return bad;
    })()`;
    const clip1280 = await page("Runtime.evaluate", { expression: clipExpr, returnByValue: true });
    assert.deepEqual(clip1280.result.value, [], "1280 label clip");
    await openAt(390, 844);
    const clip390 = await page("Runtime.evaluate", { expression: clipExpr, returnByValue: true });
    assert.deepEqual(clip390.result.value, [], "390 label clip");
    const phone = await page("Runtime.evaluate", {
      expression: `JSON.stringify({
        text: document.body.innerText,
        governance: (document.getElementById("governance-status") || {}).textContent || "",
        svgs: document.querySelectorAll("#chart-progress svg, #chart-timeline svg").length
      })`,
      returnByValue: true
    });
    const phoneData = JSON.parse(phone.result.value);
    assert.deepEqual(hits(phoneData.text), {}, phoneData.text.slice(0, 400));
    assert.equal(phoneData.governance, "15 pass, 8 fail, 2 not testable of 25");
    assert.equal(phoneData.svgs, 2);
    const consoleErrors = events.filter((msg) => {
      if (msg.method === "Runtime.exceptionThrown") return true;
      if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") return true;
      if (msg.method === "Log.entryAdded" && msg.params.entry && msg.params.entry.level === "error") return true;
      return false;
    }).map((msg) => JSON.stringify(msg.params).slice(0, 300));
    assert.deepEqual(consoleErrors, []);
    for (const href of data.links) {
      if (!href || href.startsWith("mailto:") || href.startsWith("http")) continue;
      const resolved = new URL(href, origin + "/dashboard/");
      if (resolved.origin !== origin) continue;
      const status = await new Promise((resolve) => {
        http.get(resolved, (res) => { res.resume(); resolve(res.statusCode); }).on("error", () => resolve(0));
      });
      assert.equal(status, 200, href);
    }
    ws.close();
  } finally {
    chrome.kill();
    await new Promise((resolve) => server.close(resolve));
  }
});
