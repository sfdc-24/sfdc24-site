// Lightweight checks for the page-weight and legibility pass.
// Run: node --test tests/page_weight.cjs
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

test("dashboard charts stay held, and mermaid does not block first paint", () => {
  const page = read("dashboard/index.html");
  const script = read("assets/milestones.js");
  assert.match(page, /<script defer src="https:\/\/cdn\.jsdelivr\.net\/npm\/mermaid@11\.4\.1\/dist\/mermaid\.min\.js"/);
  assert.doesNotMatch(page, /<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/mermaid/);
  assert.match(page, /id="chart-progress" role="region"/);
  assert.match(page, /id="chart-timeline" role="region"/);
  assert.match(page, /content="noindex"/);
  assert.match(script, /LIVE_CHART = false/);
  assert.doesNotMatch(script, /fetch\([^)]*proj:/);
  assert.match(page, /id="milestone-live" disabled/);
});

test("the homepage has one main landmark and does not block on the font stylesheet", () => {
  const page = read("index.html");
  assert.equal((page.match(/<main\b/g) || []).length, 1);
  assert.equal((page.match(/<\/main>/g) || []).length, 1);
  assert.match(page, /<main class="wrap" id="main">/);
  assert.match(page, /rel="preload" as="style"/);
  const head = page.split("</head>")[0].replace(/<noscript>[\s\S]*?<\/noscript>/g, "");
  assert.doesNotMatch(head, /<link rel="stylesheet" href="https:\/\/fonts\.googleapis\.com/);
  const deploy = read("assets/next-deploy.js");
  assert.doesNotMatch(deploy, /Release\. Open Ops/);
});

test("the talk page has a heading, and Ops text is at least 12px", () => {
  const voice = read("voice/index.html");
  assert.equal((voice.match(/<h1\b/g) || []).length, 1);
  assert.equal((voice.match(/<main\b/g) || []).length, 1);
  const css = [
    "assets/ops-gantt.css",
    "assets/ops-board.css",
    "assets/ops-board-a.css",
    "assets/ops-board-b.css",
    "assets/ops-board-c.css",
    "assets/ops-agent-metrics.css"
  ].map(read).join("\n");
  assert.doesNotMatch(css, /font-size:\s*(?:9|10|11)px/);
  assert.doesNotMatch(css, /font:[^;{}]*\b(?:9|10|11)px/);
});
