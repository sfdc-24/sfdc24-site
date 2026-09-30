const {test} = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const ops = require("../assets/board-ops.js");
const html = fs.readFileSync(path.join(root, "ops/index.html"), "utf8");
const css = fs.readFileSync(path.join(root, "assets/ops-agent-roster.css"), "utf8");
const sample = ops.sanitize(JSON.parse(fs.readFileSync(path.join(root, "data/board-ops-snap.json"), "utf8")));

function between(text, start, end) {
  const i = text.indexOf(start);
  assert.ok(i >= 0, start);
  const j = text.indexOf(end, i + start.length);
  assert.ok(j > i, end);
  return text.slice(i + start.length, j).trim();
}

test("states matrix is nine cells and never a task sentence", () => {
  const fleet = ops.fleetStates(sample);
  assert.equal(fleet.length, 9);
  assert.deepEqual(fleet.map((row) => row.name), ["Human", "Grok", "Claude", "Codex", "Cursor", "Gemini", "Copilot", "", ""]);
  assert.equal(fleet[0].state, "Idle");
  assert.equal(fleet.find((row) => row.id === "grok").state, "Active");
  assert.equal(fleet.find((row) => row.id === "grok").doing, "");
  assert.equal(fleet.find((row) => row.id === "gemini").state, "Standby");
  assert.equal(fleet.find((row) => row.id === "copilot").state, "Idle");
  assert.ok(fleet.every((row) => row.doing === ""));
  const quiet = ops.fleetStates({agents: []});
  assert.equal(quiet[0].state, "Idle");
  assert.ok(quiet.slice(1, 7).every((row) => row.state === "Idle" && row.doing === ""));
  const held = ops.fleetStates({
    agents: [{id: "cursor", status: "warm", writes_1h: 0, open_dispatch: 1}],
  });
  assert.equal(held.find((row) => row.id === "cursor").state, "Assigned");
  assert.equal(held.find((row) => row.id === "cursor").metric, 1);
  const blocked = ops.fleetStates({agents: [{id: "cursor", status: "hot", phase: "NOGO", task: "LIVE /ops/ funnel and per-agent strip", writes_1h: 2}]});
  assert.equal(blocked.find((row) => row.id === "cursor").state, "Active");
  assert.equal(blocked.find((row) => row.id === "cursor").glyph, "N");
  assert.equal(blocked.find((row) => row.id === "cursor").doing, "");
  assert.ok(html.includes(">States</h2>"));
  assert.ok(html.includes("status-grid"));
  assert.ok(html.includes("status-legend"));
  assert.ok(!html.includes("Active shows the snapshot task"));
  assert.ok(html.indexOf('id="fleet-states"') < html.indexOf('id="productivity"'));
  assert.ok(html.indexOf('id="productivity"') < html.indexOf('id="activity-log"'));
  assert.ok(html.indexOf('id="activity-log"') < html.indexOf('id="delivery-gantt"'));
});

test("hour day and week buckets are the snapshot rows, not invented counts", () => {
  const events = ops.activityEvents(sample);
  assert.equal(events.length, sample.edges.length + sample.open_work.length);
  assert.ok(events.some((row) => row.phase === "DISPATCH" && row.source === "bus" && row.what === "to Cursor" && row.ts === "2026-09-27T01:39:00Z"));
  assert.ok(events.some((row) => row.phase === "RESULT" && row.source === "bus" && row.actor === "Codex" && row.ts === "2026-09-27T01:04:00Z"));
  assert.ok(events.some((row) => row.source === "work" && row.ts === "2026-09-27T01:33:00Z" && row.what.startsWith("Conference showcase readiness")));
  assert.ok(events.some((row) => row.source === "work" && row.ts === "2026-09-26T22:41:00Z" && row.phase === "RESULT"));
  const report = ops.productivityReport(sample);
  for (const span of ["hour", "day", "week"]) {
    const listed = report[span].reduce((sum, bucket) => sum + bucket.people.reduce((n, person) => n + person.actions.length, 0), 0);
    assert.equal(listed, events.length, span);
  }
  assert.deepEqual(report.hour.map((bucket) => bucket.label), ["2026-09-27 01:00 UTC", "2026-09-27 00:00 UTC", "2026-09-26 22:00 UTC"]);
  assert.deepEqual(report.day.map((bucket) => bucket.label), ["2026-09-27 UTC", "2026-09-26 UTC"]);
  assert.deepEqual(report.week.map((bucket) => bucket.label), ["Week of 2026-09-21 UTC"]);
  const names = new Set(report.week[0].people.map((person) => person.actor));
  assert.equal(names.has("Gemini"), false);
  assert.equal(names.has("Copilot"), false);
  const monday = ops.productivityReport({
    baked_at: "2026-09-28T00:00:00Z",
    edges: [{from: "grok", to: "cursor", phase: "RESULT", ts: "2026-09-28T00:05:00Z"}],
    open_work: [],
  });
  assert.equal(monday.week[0].label, "Week of 2026-09-28 UTC");
  assert.equal(monday.hour[0].people[0].actions.length, 1);
});

test("missing timestamps stay out of the buckets and say so", () => {
  const undated = ops.activityEvents({
    baked_at: "2026-09-27T01:41:00Z",
    edges: [{from: "grok", to: "cursor", phase: "DISPATCH"}],
    open_work: [{from: "grok", to: ["cursor"], phase: "RESULT", title: "No clock on this row."}],
  });
  assert.deepEqual(undated, []);
  const report = ops.productivityReport({baked_at: "2026-09-27T01:41:00Z", edges: [], open_work: []});
  assert.deepEqual(report.hour, []);
  assert.deepEqual(report.day, []);
  assert.deepEqual(report.week, []);
  const view = ops.paint({baked_at: "2026-09-27T01:41:00Z", edges: [], open_work: [], agents: [], source: "sample", refresh_sec: 120}, Date.parse("2026-09-27T01:41:00Z"));
  assert.equal((view.productivity.match(/No timestamped actions in this snapshot\./g) || []).length, 3);
  assert.match(view.activity, /No timestamped actions in this snapshot\./);
  assert.match(ops.paint(null).productivity, /Snapshot unavailable\./);
  assert.match(ops.paint(null).activity, /Snapshot unavailable\./);
  const poisoned = ops.paint({
    baked_at: "2026-09-27T01:41:00Z",
    refresh_sec: 120,
    source: "sample",
    agents: [],
    edges: [{from: "grok", to: "cursor", phase: "DISPATCH", ts: "2026-09-27T01:39:00Z", password: "fixture-password"}],
    open_work: [{from: "grok", to: ["cursor"], phase: "ACK", age_min: 8, title: "A <script> title", next: true}],
  });
  assert.doesNotMatch(poisoned.productivity + poisoned.activity, /fixture-password|<script>/);
  assert.match(poisoned.activity, /&lt;script&gt;/);
});

test("the page fallback is the same report the poll paints from the sample", () => {
  const view = ops.paint(sample, Date.parse(sample.baked_at));
  assert.equal(between(html, '<div id="productivity-mount">', "</div><!-- /productivity-mount -->"), view.productivity);
  assert.equal(between(html, '<div id="activity-log-mount" class="activity-log" tabindex="0">', "</div><!-- /activity-log-mount -->"), view.activity);
  assert.match(view.activity, /DISPATCH/);
  assert.match(view.activity, /RESULT/);
  assert.doesNotMatch(between(html, 'id="productivity"', 'id="activity-log"'), /\d+(?:\.\d+)?%/);
  assert.ok(css.includes("#activity-log-mount{max-height:240px;overflow-x:hidden;overflow-y:auto"));
  assert.ok(css.includes("#fleet-states .status-grid{"));
  assert.ok(css.includes(".is-active"));
  assert.ok(css.includes(".is-assigned"));
  assert.ok(css.includes(".is-standby"));
  assert.ok(css.includes(".is-idle"));
  assert.ok(css.includes("flex-wrap:wrap"));
});
