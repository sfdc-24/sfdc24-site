// The Ops page refuses secret-shaped keys and fails quiet when the snap is missing.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ops = require("../assets/board-ops.js");
const sample = JSON.parse(fs.readFileSync(path.join(__dirname, "../data/board-ops-snap.json"), "utf8"));

const POISON = {
  v: 1,
  baked_at: "2026-09-26T06:30:00Z",
  refresh_sec: 10,
  source: "sample",
  email: "fleet-owner@example.com",
  token: "fixture-token-value",
  transcript: "private transcript text",
  agents: [
    { id: "claude-code-cli", last_seen: "2026-09-26T06:20:00Z", writes_1h: 2, open_dispatch: 1, status: "warm", api_key: "fixture-api-key" },
    { id: "foundry", status: "hot", writes_1h: 9, open_dispatch: 3, last_seen: "2026-09-26T06:20:00Z" },
  ],
  open_work: [{
    id: "THIS-ID-IS-WAY-TOO-LONG-TO-SHOW-IN-FULL-ABCDEF",
    from: "grok", to: ["claude-code-cli", "foundry"], phase: "DISPATCH", age_min: 12,
    body: "secret payload text",
  }],
  edges: [
    { from: "foundry", to: "grok", phase: "DISPATCH", ts: "2026-09-26T06:29:00Z" },
    { from: "grok", to: "claude-code-cli", phase: "DISPATCH", ts: "2026-09-26T06:29:00Z", password: "fixture-password" },
  ],
  envs: [
    { id: "www", label: "sfdc24.com", health: "ok", note: "Pages from main" },
    { id: "azure-vm", label: "Azure VM", health: "ok" },
  ],
  ci: [{
    repo: "sfdc24-site", conclusion: "failure", name: "honesty-dom-test",
    url: "https://github.com/sfdc-24/sfdc24-site/actions/runs/9",
    ts: "2026-09-26T06:00:00Z", cookie: "session-fixture",
  }],
  stats: { rows_sampled: 4, dispatch_open: 1, result_1h: 0, nogo_1h: 0, median_ack_min: 7, secret: "nope" },
};

test("sample snap paints the bus, the promote lane, and not a retired node", () => {
  const clean = ops.sanitize(sample);
  assert.equal(clean.source, "sample");
  const view = ops.paint(clean, Date.parse("2026-09-26T06:34:00Z"));
  const blob = view.engine + view.pipeline + view.strip + view.lists + view.side;
  assert.match(view.engine, /Communication &amp; Control BUS/);
  assert.match(view.engine, /Grok/);
  assert.match(view.engine, /Positioning/);
  assert.match(view.pipeline, /DEV/);
  assert.match(view.pipeline, /Staging/);
  assert.match(view.pipeline, /Production/);
  assert.match(view.pipeline, /PR #482/);
  assert.match(view.pipeline, /www\.sfdc24\.com/);
  assert.match(view.pipeline, /is-moving/);
  assert.doesNotMatch(view.engine, /BLACKBOARD|motherboard/i);
  assert.doesNotMatch(blob, /honesty-dom|site-positioning|example-check/);
  assert.match(view.strip, /Deploy lead/);
  assert.match(view.strip, /14m/);
  assert.match(view.strip, /96%/);
  assert.match(view.strip, /1\.8%/);
  assert.match(view.strip, /Sample/);
  assert.match(view.strip, /4m/);
  assert.match(view.lists, /Branch flow/);
  assert.match(view.lists, /feature\/ops-polish/);
  assert.match(view.lists, /fix\/staging-gate/);
  assert.match(view.lists, /chore\/snap-bake/);
  assert.match(view.lists, /Exact-SHA review/);
  assert.match(view.side, /Healthy/);
  assert.match(view.side, /At risk/);
  assert.match(view.note, /not a live bus/);
  assert.match(view.note, /polls that file every 120s/);
  assert.match(view.strip, /polls every 120s/);
  assert.match(view.pipeline, /class="runner"/);
  assert.match(view.engine, /is-hot/);
  assert.match(view.engine, /is-warm/);
  assert.match(view.pipeline, /is-live/);
  assert.match(view.pipeline, /is-ok/);
  assert.match(view.lists, /branch-runner/);
  assert.doesNotMatch(blob, /foundry|azure/i);
});

test("a later bake repaints metrics, status, and branches", () => {
  const next = ops.sanitize(Object.assign({}, sample, {
    source: "bake",
    baked_at: "2026-09-26T07:00:00Z",
    refresh_sec: 90,
    stats: Object.assign({}, sample.stats, {
      deploy_lead_min: 22, success_7d_pct: 91, error_rate_pct: 0.4, median_ack_min: 3,
    }),
    agents: sample.agents.map((row) => row.id === "grok" ? Object.assign({}, row, { status: "quiet" }) : row),
    branches: sample.branches.map((row, i) => i === 0 ? Object.assign({}, row, { name: "feature/preview-open", merged: false }) : row),
    envs: sample.envs.map((row) => row.id === "pages" ? Object.assign({}, row, { health: "degraded" }) : row),
  }));
  const view = ops.paint(next, Date.parse(next.baked_at));
  assert.match(view.strip, /22m/);
  assert.match(view.strip, /91%/);
  assert.match(view.strip, /0\.4%/);
  assert.match(view.strip, /Baked/);
  assert.match(view.strip, /polls every 90s/);
  assert.doesNotMatch(view.strip, /14m/);
  assert.match(view.engine, /is-quiet/);
  assert.doesNotMatch(view.engine, /is-hot/);
  assert.match(view.pipeline, /Gate blocked/);
  assert.match(view.pipeline, /is-degraded/);
  assert.match(view.pipeline, /is-held/);
  assert.match(view.lists, /feature\/preview-open/);
  assert.match(view.lists, /branch-runner/);
  assert.match(view.note, /polls that file every 90s/);
  assert.match(view.note, /not a live bus/);
});

test("secret-looking keys are not rendered", () => {
  const clean = ops.sanitize(POISON);
  const view = ops.paint(clean, Date.parse(clean.baked_at));
  const blob = view.engine + view.strip + view.lists + (view.side || "") + JSON.stringify(clean);
  for (const leaked of [
    "fleet-owner@example.com", "fixture-token-value", "private transcript",
    "fixture-api-key", "fixture-password", "secret payload", "session-fixture",
    "foundry", "azure",
  ]) {
    assert.equal(blob.includes(leaked), false, leaked);
  }
  assert.equal(clean.refresh_sec, 60);
  assert.equal(clean.open_work[0].id, "THIS-ID-IS-WAY-T");
  assert.deepEqual(clean.open_work[0].to, ["claude-code-cli"]);
});

test("a missing snap is the empty state and a later miss keeps the last picture", () => {
  const empty = ops.emptyPaint();
  assert.match(empty.engine, /SNAPSHOT UNAVAILABLE/);
  assert.match(empty.note, /not a live bus/);
  assert.equal(ops.sanitize(null), null);
  assert.equal(ops.sanitize({ v: 2 }), null);
  const first = ops.resolve(null, null, false);
  assert.equal(first.empty, true);
  const kept = ops.resolve(null, null, true);
  assert.equal(kept.empty, false);
  assert.equal(kept.snap, null);
});

test("a bake on the side branch wins over the committed sample", () => {
  const local = ops.sanitize(sample);
  const remote = ops.sanitize(Object.assign({}, sample, {
    source: "bake",
    baked_at: "2026-09-26T06:40:00Z",
  }));
  const picked = ops.pick(local, remote);
  assert.equal(picked.source, "bake");
  const decision = ops.resolve(local, remote, false);
  assert.equal(decision.empty, false);
  assert.equal(decision.snap.source, "bake");
});

test("markup escapes a label that somehow passed the allowlist", () => {
  const snap = ops.sanitize(sample);
  snap.envs[0].label = '<img alt="x">';
  const view = ops.paint(snap, Date.parse(snap.baked_at));
  assert.equal(view.pipeline.includes("<img"), false);
  assert.match(view.pipeline, /&lt;img/);
});

test("the page only names the two static snap URLs", () => {
  assert.deepEqual(ops.urls(), [
    "/data/board-ops-snap.json",
    "https://raw.githubusercontent.com/sfdc-24/sfdc24-site/board-ops-snap/data/board-ops-snap.json",
  ]);
});
