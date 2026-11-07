const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { classify, ROSTER, FEED_PATH, SSE_PATH, RECHECK_MS } = require("../assets/fleet-board.js");

const root = path.join(__dirname, "..");
const NOW = Date.parse("2026-11-07T01:00:00Z");
const READ = "2026-11-07T01:00:00Z";
const FRESH_PULSE = "2026-11-07T00:59:10Z";

function live(agents, extra) {
  return Object.assign({
    schema: "sfdc24.fleet-public.v1",
    public_status: "live",
    transport: "poll",
    poll_seconds: 15,
    read_at: READ,
    fresh_within_sec: 300,
    agents: agents
  }, extra || {});
}

test("the committed projection is an unpublished blocker with no agent rows", () => {
  const raw = fs.readFileSync(path.join(root, "data", "fleet-public.json"), "utf8");
  const doc = JSON.parse(raw);
  assert.equal(doc.schema, "sfdc24.fleet-public.v1");
  assert.equal(doc.public_status, "unpublished");
  assert.equal(doc.transport, "none");
  assert.equal(doc.read_at, null);
  assert.deepEqual(doc.agents, []);
  assert.doesNotMatch(raw, /"status"\s*:/);
  assert.doesNotMatch(raw, /pulse_at"\s*:\s*"/);
});

test("the board script does not fetch the withheld keyspace or another host", () => {
  const src = fs.readFileSync(path.join(root, "assets", "fleet-board.js"), "utf8");
  assert.equal(FEED_PATH, "/data/fleet-public.json");
  assert.equal(SSE_PATH, "/data/fleet-public.sse");
  assert.doesNotMatch(src, /innerHTML|https?:\/\/|fetch\(\s*["'`][^"'`]*xp-live/);
  assert.match(src, /new EventSource\(SSE_PATH\)/);
  assert.match(src, /cache:\s*"no-store"/);
  const home = fs.readFileSync(path.join(root, "index.html"), "utf8");
  assert.match(home, /id="fleet-board"/);
  assert.match(home, /assets\/fleet-board\.js/);
  assert.doesNotMatch(home, /fleet-board[\s\S]{0,400}xp-live/);
});

test("an unpublished file shows six unknown agents and is not called live", () => {
  const view = classify(JSON.parse(fs.readFileSync(path.join(root, "data", "fleet-public.json"), "utf8")), NOW);
  assert.equal(view.feed.state, "unpublished");
  assert.equal(view.feed.live, false);
  assert.equal(view.feed.scheduleMs, RECHECK_MS);
  assert.match(view.feed.note, /not a live feed/i);
  assert.deepEqual(view.agents.map((a) => a.id), ROSTER.map((a) => a.id));
  for (const agent of view.agents) {
    assert.equal(agent.status, "unknown");
    assert.equal(agent.blocked, false);
    assert.equal(agent.pulseLabel, "No pulse");
    assert.notEqual(agent.status, "idle");
    assert.notEqual(agent.status, "active");
  }
});

test("roster names and active-without-a-pulse are not rendered active", () => {
  const namesOnly = live(ROSTER.map((row) => ({ id: row.id, status: "active" })));
  const view = classify(namesOnly, NOW);
  assert.equal(view.feed.state, "live");
  assert.equal(view.feed.live, true);
  for (const agent of view.agents) {
    assert.equal(agent.status, "unknown", agent.id);
    assert.equal(agent.pulseLabel, "No pulse");
    assert.equal(agent.blocked, false);
  }
});

test("one fresh explicit active agent does not make the other five active", () => {
  const view = classify(live([
    { id: "grok", status: "active", pulse_at: FRESH_PULSE, task: "Coordinate review", owner: "Grok", gap: null }
  ]), NOW);
  const grok = view.agents.find((a) => a.id === "grok");
  assert.equal(grok.status, "active");
  assert.match(grok.pulseLabel, /Nov/);
  assert.equal(grok.taskLabel, "Coordinate review");
  assert.equal(grok.ownerLabel, "Grok");
  for (const agent of view.agents.filter((a) => a.id !== "grok")) {
    assert.equal(agent.status, "unknown");
    assert.equal(agent.pulseLabel, "No pulse");
  }
});

test("a blocked task stays blocked when the feed itself is stale", () => {
  const old = live([
    { id: "claude", status: "blocked", pulse_at: "2026-11-07T00:40:00Z", task: "Release gate", owner: "Claude", gap: "Review waiting" }
  ], { read_at: "2026-11-07T00:40:00Z" });
  const view = classify(old, NOW);
  assert.equal(view.feed.state, "stale");
  assert.equal(view.feed.live, false);
  assert.match(view.feed.note, /blocked task stays blocked/i);
  const claude = view.agents.find((a) => a.id === "claude");
  assert.equal(claude.status, "blocked");
  assert.equal(claude.blocked, true);
  assert.doesNotMatch(claude.pulseLabel, /idle/i);
  assert.equal(claude.gapLabel, "Review waiting");
});

test("a pulse older than the snapshot is stale without clearing a block", () => {
  const view = classify(live([
    { id: "claude", status: "blocked", pulse_at: "2026-11-07T00:40:00Z", task: "Release gate", owner: "Claude", gap: "Review waiting" }
  ]), NOW);
  assert.equal(view.feed.state, "live");
  const claude = view.agents.find((a) => a.id === "claude");
  assert.equal(claude.status, "blocked");
  assert.match(claude.pulseLabel, /pulse stale/);
});

test("explicit idle is idle, and a missing pulse is not rewritten into idle", () => {
  const view = classify(live([
    { id: "aya", status: "idle", pulse_at: FRESH_PULSE },
    { id: "cursor" }
  ]), NOW);
  assert.equal(view.agents.find((a) => a.id === "aya").status, "idle");
  assert.equal(view.agents.find((a) => a.id === "cursor").status, "unknown");
  assert.equal(view.agents.find((a) => a.id === "cursor").pulseLabel, "No pulse");
});

test("markup, mail, secrets and private key names are not shown", () => {
  const view = classify(live([{
    id: "gemini",
    status: "blocked",
    pulse_at: FRESH_PULSE,
    task: "<img src=x onerror=alert(1)>",
    owner: "Abdus Salam",
    gap: "fleet:inbox:gemini token ghp_example"
  }]), NOW);
  const gemini = view.agents.find((a) => a.id === "gemini");
  assert.equal(gemini.taskLabel, "Not shown");
  assert.equal(gemini.ownerLabel, "Not shown");
  assert.equal(gemini.gapLabel, "Not shown");
  assert.equal(gemini.status, "blocked");
});

test("a foreign sse path is not a channel this page will open", () => {
  const view = classify(live([], { transport: "sse", sse_path: "https://example.test/private" }), NOW);
  assert.equal(view.feed.sse, false);
  assert.equal(view.feed.live, false);
  assert.equal(view.agents.every((a) => a.status === "unknown"), true);
});

test("poll cadence is the file's own seconds, bounded", () => {
  assert.equal(classify(live([], { poll_seconds: 15 }), NOW).feed.scheduleMs, 15000);
  assert.equal(classify(live([], { poll_seconds: 1 }), NOW).feed.scheduleMs, 5000);
  assert.equal(classify(live([], { poll_seconds: 120 }), NOW).feed.scheduleMs, 30000);
});
