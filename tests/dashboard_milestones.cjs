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
  assert.match(page, /Governance check in progress, results pending/);
  assert.match(page, /proj:pokayoke:v1/);
  assert.match(page, /proj:governance:v1/);
  assert.match(page, /id="milestone-live" disabled/);
  const data = JSON.parse(fs.readFileSync(path.join(root, "assets/milestones/pokayoke.json"), "utf8"));
  assert.equal(data.placeholder, "Governance check in progress, results pending");
  assert.deepEqual(data.learnings, []);
  assert.deepEqual(data.governance, []);
  const script = fs.readFileSync(path.join(root, "assets/milestones.js"), "utf8");
  assert.match(script, /LIVE_CHART = false/);
  assert.match(script, /proj:milestones:v1:mermaid/);
  assert.match(script, /proj:pokayoke:v1/);
  assert.match(script, /proj:governance:v1/);
  assert.doesNotMatch(script, /fetch\([^)]*proj:/);
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
    await page("Page.navigate", { url: origin + "/dashboard/" });
    await new Promise((r) => setTimeout(r, 5000));
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
    assert.equal(data.governance, "Governance check in progress, results pending");
    assert.match(data.poke, /No mistake-proofing rows are recorded yet/);
    assert.equal(data.disabled, true);
    assert.equal(data.error, true);
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
