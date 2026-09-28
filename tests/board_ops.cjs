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
    repo: "sfdc24-site", conclusion: "failure", name: "homepage-browser-tests",
    url: "https://github.com/sfdc-24/sfdc24-site/actions/runs/9",
    ts: "2026-09-26T06:00:00Z", cookie: "session-fixture",
  }],
  stats: { rows_sampled: 4, dispatch_open: 1, result_1h: 0, nogo_1h: 0, median_ack_min: 7, secret: "nope" },
};

test("sample snap paints the bus, the promote lane, and not a retired node", () => {
  const clean = ops.sanitize(sample);
  assert.equal(clean.source, "sample");
  const view = ops.paint(clean, Date.parse("2026-09-26T06:34:00Z"));
  const blob = view.engine + view.pipeline + view.strip + view.lists + view.side + view.backlog + view.cooking;
  assert.match(view.engine, /Communication &amp; Control BUS/);
  assert.match(view.engine, /Grok/);
  assert.match(view.engine, /Delivery and strategy lead/);
  assert.match(view.pipeline, /DEV/);
  assert.match(view.pipeline, /STAGING/);
  assert.match(view.pipeline, /PROD/);
  assert.match(view.pipeline, /Conference showcase readiness/);
  assert.doesNotMatch(view.pipeline, /Conference Line/);
  assert.match(view.pipeline, /www\.sfdc24\.com/);
  assert.match(view.pipeline, /is-moving/);
  assert.doesNotMatch(view.engine, /BLACKBOARD|motherboard/i);
  assert.doesNotMatch(blob, /homepage-browser|site-positioning|example-check/);
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
  assert.match(view.engine, /is-quiet/);
  assert.match(view.pipeline, /is-live/);
  assert.match(view.pipeline, /is-ok/);
  assert.match(view.lists, /branch-runner/);
  assert.match(view.cooking, /Conference showcase readiness, staging pending, not accepted\./);
  assert.doesNotMatch(view.cooking, /Conference Line LiveKit/);
  assert.doesNotMatch(view.cooking, /not measured/);
  assert.match(view.cooking, /SA Wed Applicant Portal/);
  assert.match(view.cooking, /Org AI inventory/);
  assert.match(view.pipeline, /branch \/ PR/);
  assert.doesNotMatch(view.pipeline, /PR #224/);
  assert.doesNotMatch(view.pipeline, /—|branch\/PR/);
  assert.match(view.backlog, /Ops page with architecture of CI\/CD, agents and bus, backlog queue and release view\. Managed by Python post-release\./);
  assert.match(view.backlog, /Homepage visitor talk becomes a queued prototype for a later release\./);
  assert.match(view.backlog, /Voice fix for the heard question, parked/);
  assert.match(view.engine, /Claude/);
  const roleView = ops.paint({...clean, agents: []}, Date.parse("2026-09-26T06:34:00Z"));
  assert.match(roleView.engine, /Data and security engineer/);
  assert.match(view.engine, /Codex/);
  assert.match(view.engine, /Cursor/);
  assert.match(view.engine, /Gemini/);
  assert.match(view.engine, /Copilot Agents/);
  assert.match(view.engine, /GitHub DevOps and repo reviewer/);
  assert.match(roleView.engine, /Quality and test lead/);
  assert.match(roleView.engine, /Delivery and strategy lead/);
  assert.match(roleView.engine, /Admin and analyst/);
  assert.match(roleView.engine, /Heavy PM and Build and PR execution/);
  assert.match(view.follow, /Copilot/);
  assert.match(view.sprint, /sprint-card/);
  assert.match(view.sprint, /DISPATCH|ACK|REVIEW|COMMIT/);
  assert.match(view.sprint, /Conference showcase readiness/);
  assert.doesNotMatch(view.sprint, /Conference Line LiveKit/);
  assert.doesNotMatch(view.backlog, /Conference Line LiveKit/);
  assert.match(view.engine, /LIVE \/ops\/ funnel/);
  assert.match(view.engine, /DISPATCH|COMMIT|REVIEW|ACK/);
  assert.doesNotMatch(view.follow, /then Claude, Codex, and Cursor, then review/);
  assert.match(view.backlog, /funnel-list/);
  assert.doesNotMatch(view.backlog, /queue-card|<article|<b>/);
  assert.match(view.follow, /is-now"><b>Agents<\/b><span>Now<\/span>/);
  assert.match(view.follow, /is-past"><b>Idea<\/b>/);
  assert.match(view.follow, /is-past"><b>Blackboard<\/b>/);
  assert.match(view.follow, /is-next"><b>Copilot<\/b><span>Next<\/span>/);
  assert.match(view.follow, /is-now"><b>Deploy<\/b><span>Now<\/span>/);
  assert.doesNotMatch(view.follow, /Conflict|is-blocked/);
  assert.doesNotMatch(view.backlog, /Blackboard/);
  assert.doesNotMatch(view.backlog, /GROK-OPS|CODEX-REV|claude|Blackboard|motherboard|DISPATCH|REVIEW/i);
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
    open_work: [{
      id: "GROK-OPS-0142", from: "grok", to: ["claude-code-cli"], phase: "DISPATCH", age_min: 4, pr: 482,
      title: "Queue item refreshed",
    }],
    agents: sample.agents.map((row) => Object.assign({}, row, { status: "quiet", task: undefined, phase: undefined })),
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
  assert.match(view.backlog, /Queue item refreshed/);
  assert.doesNotMatch(view.backlog, /Ops page with architecture|GROK-OPS|claude/i);
});

test("secret-looking keys are not rendered", () => {
  const clean = ops.sanitize(POISON);
  const view = ops.paint(clean, Date.parse(clean.baked_at));
  const blob = view.engine + view.strip + view.lists + view.backlog + (view.side || "") + JSON.stringify(clean);
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

test("a work row without a safe title is left off the queue", () => {
  const raw = JSON.parse(JSON.stringify(sample));
  raw.open_work = [
    { id: "GROK-OPS-0142", from: "grok", to: ["claude-code-cli"], phase: "DISPATCH", age_min: 12, title: "Blackboard dump" },
    { id: "CODEX-REV-0901", from: "claude-code-cli", to: ["codex"], phase: "REVIEW", age_min: 4, title: "motherboard note" },
    { id: "CURSOR-OK-0001", from: "cursor", to: ["grok"], phase: "ACK", age_min: 1 },
    { id: "GEMINI-OK-0002", from: "gemini", to: ["grok"], phase: "RESULT", age_min: 2, title: "Ship the preview" },
    { id: "GROK-LONG-0003", from: "grok", to: ["cursor"], phase: "ACK", age_min: 2, title: "A".repeat(161) },
  ];
  const clean = ops.sanitize(raw);
  assert.equal(clean.open_work[0].title, undefined);
  assert.equal(clean.open_work[1].title, undefined);
  assert.equal(clean.open_work[2].title, undefined);
  assert.equal(clean.open_work[3].title, "Ship the preview");
  assert.equal(clean.open_work[4].title, undefined);
  const view = ops.paint(clean, Date.parse(clean.baked_at));
  assert.match(view.backlog, /Ship the preview/);
  assert.equal((view.backlog.match(/<li\b/g) || []).length, 1);
  assert.doesNotMatch(view.backlog, /Blackboard|motherboard|GROK-OPS|CODEX-REV|CURSOR-OK|claude|gemini/i);
});

test("a failed site check or a blocked gate shows a conflict", () => {
  const gated = ops.sanitize(Object.assign({}, sample, {
    envs: sample.envs.map((row) => row.id === "pages" ? Object.assign({}, row, { health: "degraded" }) : row),
  }));
  const blocked = ops.paint(gated, Date.parse(gated.baked_at));
  assert.match(blocked.follow, /is-blocked"><b>Conflict<\/b><span>Blocked<\/span>/);
  assert.match(blocked.follow, /blocked on a conflict/);
  assert.match(blocked.follow, /is-past"><b>Branch<\/b>/);
  assert.match(blocked.follow, /is-next"><b>Merge<\/b><span>Next<\/span>/);
  const failed = ops.sanitize(Object.assign({}, sample, {
    ci: sample.ci.map((row) => row.repo === "sfdc24-site" ? Object.assign({}, row, { conclusion: "failure" }) : row),
  }));
  assert.match(ops.paint(failed, Date.parse(failed.baked_at)).follow, /Conflict/);
});

test("an empty bake still shows the next release sentences", () => {
  const release = {
    note: "Next: voice fix",
    cooking: ["Voice fix for the heard question, moving through DEV, Staging, and Production."],
    later: ["Homepage visitor talk becomes a queued prototype for a later release."],
  };
  const bare = ops.sanitize(Object.assign({}, sample, { open_work: [] }));
  const view = ops.paint(bare, Date.parse(bare.baked_at), release);
  assert.match(view.cooking, /Voice fix for the heard question/);
  assert.match(view.backlog, /queued prototype for a later release/);
  assert.match(view.pipeline, /Voice fix for the heard question/);
  assert.doesNotMatch(view.pipeline, /—|branch\/PR/);
  assert.doesNotMatch(view.cooking, /GROK-OPS|claude|Blackboard|motherboard/i);
});

test("a missing snap is the empty state and a later miss keeps the last picture", () => {
  const empty = ops.emptyPaint();
  assert.match(empty.engine, /SNAPSHOT UNAVAILABLE/);
  assert.equal(empty.backlog, "");
  assert.equal(empty.cooking, "");
  assert.match(empty.follow, /is-now"><b>Agents<\/b><span>Now<\/span>/);
  assert.match(empty.follow, /is-now"><b>PR<\/b><span>Now<\/span>/);
  assert.match(empty.follow, /is-next"><b>Merge<\/b><span>Next<\/span>/);
  assert.match(empty.pipeline, /Voice fix/);
  assert.doesNotMatch(empty.pipeline, /—/);
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

test("a title that names a person is dropped", () => {
  const raw = JSON.parse(JSON.stringify(sample));
  raw.open_work[0].title = "Conference maturing for Dr Yasmine showcase, staging pending and not accepted.";
  raw.open_work[1].title = "Hajar follow up";
  raw.open_work[2].title = "Meet Mrs Jones tomorrow";
  raw.agents[0].task = "Notes for yasmine";
  const clean = ops.sanitize(raw);
  const blob = JSON.stringify(clean);
  assert.equal(/yasmine|hajar/i.test(blob), false);
  assert.equal(clean.open_work[0].title, undefined);
  assert.equal(clean.open_work[1].title, undefined);
  assert.equal(clean.open_work[2].title, undefined);
  assert.equal(clean.agents[0].task, undefined);
  const kept = ops.sanitize(sample);
  assert.equal(kept.open_work[0].title, "Conference showcase readiness, staging pending, not accepted.");
  const view = ops.paint(kept, Date.parse(kept.baked_at));
  const painted = view.pipeline + view.cooking + view.sprint + view.engine;
  assert.equal(/yasmine|hajar/i.test(painted), false);
  assert.match(painted, /Conference showcase readiness/);
});

test("the page only names the two static snap URLs", () => {
  assert.deepEqual(ops.urls(), [
    "/data/board-ops-snap.json",
    "https://raw.githubusercontent.com/sfdc-24/sfdc24-site/board-ops-snap/data/board-ops-snap.json",
  ]);
});
