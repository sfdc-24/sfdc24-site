// Dashboard, Ops, and Process stay one drill-down. Run:
// node --test tests/hierarchy_drill.cjs
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");

function read(rel) {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

function ids(html) {
  return new Set(Array.from(html.matchAll(/\sid="([^"]+)"/g), (m) => m[1]));
}

test("the three pages name their place in the hierarchy", () => {
  const dashboard = read("dashboard/index.html");
  const ops = read("ops/index.html");
  const process = read("process/index.html");
  assert.match(dashboard, /<title>Dashboard — strategy and status<\/title>/);
  assert.match(ops, /<title>Ops — project breakdown<\/title>/);
  assert.match(process, /<title>Process — what is working<\/title>/);
  assert.match(dashboard, /href="#main"/);
  assert.match(ops, /href="#main"/);
  assert.match(process, /href="#main"/);
  assert.match(ops, /Communication & Control BUS/);
  assert.match(ops, /not a live bus/);
  assert.match(process, /not a trusted live read/);
  assert.match(process, /What is working, and how it runs/);
  assert.match(dashboard, /content="noindex"/);
  assert.match(ops, /content="noindex"/);
  assert.match(process, /content="noindex"/);
});

test("breadcrumbs drill Dashboard, then Ops, then Process", () => {
  for (const rel of ["dashboard/index.html", "ops/index.html", "process/index.html"]) {
    const html = read(rel);
    const crumb = html.split('aria-label="Drill down"')[1].split("</nav>")[0];
    const hrefs = Array.from(crumb.matchAll(/href="([^"]+)"/g), (m) => m[1]);
    assert.deepEqual(hrefs, ["/dashboard/", "/ops/", "/process/"], rel);
  }
  assert.match(read("ops/index.html"), /aria-current="page">Ops<\/a>[\s\S]*href="\/process\/"/);
});

test("dashboard workstreams open real Ops anchors, and Ops opens Process", () => {
  const dashboard = read("dashboard/index.html");
  const ops = read("ops/index.html");
  const process = read("process/index.html");
  const opsIds = ids(ops);
  const processIds = ids(process);
  const targets = Array.from(dashboard.matchAll(/href="\/ops\/#([^"]+)"/g), (m) => m[1]);
  assert.ok(targets.length >= 7);
  for (const id of targets) assert.ok(opsIds.has(id), "ops missing #" + id);
  for (const id of Array.from(ops.matchAll(/href="\/process\/#([^"]+)"/g), (m) => m[1])) {
    assert.ok(processIds.has(id), "process missing #" + id);
  }
  assert.match(process, /href="\/ops\/#live-execution"/);
  assert.match(process, /href="\/dashboard\/"/);
  assert.match(ops, /href="\/process\/#how-we-work"/);
  assert.doesNotMatch(dashboard + ops + process, /CONF_REDIS\s*=\s*1/);
  assert.doesNotMatch(ops, /guest invitation/i);
});
