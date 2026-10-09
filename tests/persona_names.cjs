// Public pages show persona names. Routing keys may stay codex/claude.
// Run: node --test tests/persona_names.cjs
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const VENDOR = /\b(codex|cursor|gemini|grok|copilot|openai|anthropic|livekit|deepgram)\b/i;

function loadPersona() {
  const window = {
    document: {
      readyState: "complete",
      documentElement: { getAttribute() { return "cobalt"; }, setAttribute() {} },
      addEventListener() {},
      querySelector() { return null; },
      querySelectorAll() { return []; },
      body: null,
      createElement() { return { setAttribute() {}, style: {} }; }
    },
    location: { pathname: "/", assign() {} },
    NodeFilter: { SHOW_TEXT: 4 },
    setInterval() { return 0; },
    clearTimeout() {},
    MutationObserver: function MutationObserver() { this.observe = function () {}; }
  };
  window.window = window;
  vm.runInNewContext(fs.readFileSync(path.join(root, "assets/chrome.js"), "utf8"), window);
  return window.__SFDC24_PERSONA_COPY;
}

function visibleText(html) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ");
}

test("lowercase vendor names become personas", () => {
  const copy = loadPersona();
  assert.equal(typeof copy, "function");
  assert.equal(copy("codex is thinking…"), "Aya is thinking…");
  assert.equal(copy("CODEX got four"), "Aya got four");
  assert.equal(copy("cursor checked it"), "Cody checked it");
  assert.equal(copy("gemini and grok"), "Jenny and Greg");
  assert.equal(copy("Copilot Agents"), "Paired review");
  assert.equal(copy("Claude stays"), "Claude stays");
  assert.equal(copy("Mr. Salam"), "Mr. Salam");
});

test("homepage game copy and the board label do not print the vendor name", () => {
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  assert.match(html, /label:"Aya"/);
  assert.doesNotMatch(html, /codex wants another/);
  assert.doesNotMatch(html, /codex is thinking/);
  assert.doesNotMatch(html, /codex got four/);
  assert.doesNotMatch(html, /shell\("[^"]+", "codex"/);
});

test("public pages that name the crew use personas in the text", () => {
  const files = [
    "looks/index.html",
    "review/index.html",
    "ops/index.html",
    "p/080b1560-646c-4990-9aa2-1229f5416f9b/index.html"
  ];
  for (const rel of files) {
    const text = visibleText(fs.readFileSync(path.join(root, rel), "utf8"));
    assert.doesNotMatch(text, VENDOR, rel + " " + (text.match(VENDOR) || []).join(","));
  }
});

test("a revealed homepage board shows Aya, not codex", async () => {
  const { chromium } = require("playwright");
  const types = {
    ".html": "text/html", ".js": "application/javascript", ".css": "text/css",
    ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon"
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith("/")) rel += "index.html";
    const file = path.resolve(root, "." + rel);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) {
      res.writeHead(404).end("missing");
      return;
    }
    res.writeHead(200, { "content-type": types[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch({ channel: "chrome", args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  try {
    const page = await browser.newPage();
    await page.goto("http://127.0.0.1:" + server.address().port + "/", { waitUntil: "networkidle" });
    await page.evaluate(() => {
      const fleet = document.getElementById("fleet");
      if (fleet) fleet.hidden = false;
    });
    const names = await page.locator("#crew .nm").allTextContents();
    assert.deepEqual(names, ["Claude", "Aya"]);
    const board = await page.locator("#fleet").innerText();
    assert.doesNotMatch(board, VENDOR);
  } finally {
    await browser.close();
    server.close();
  }
});
