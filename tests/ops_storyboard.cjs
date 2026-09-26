// The Ops storyboard groups by the file's grain and drops secret-shaped copy.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const story = require("../assets/ops-storyboard.js");
const sample = JSON.parse(fs.readFileSync(path.join(__dirname, "../data/ops-storyboard.json"), "utf8"));

test("sample frames group by week and can group by month", () => {
  const clean = story.sanitize(sample);
  assert.equal(clean.grain, "week");
  const view = story.paint(clean);
  assert.match(view, /Grouped by week/);
  assert.match(view, /Week of 24 Aug/);
  assert.match(view, /Week of 31 Aug/);
  assert.match(view, /The clock starts/);
  assert.match(view, /Ops, in the open/);
  assert.doesNotMatch(view, /foundry|azure|script\.google/i);
  const months = story.groupEntries(clean.entries, "month");
  assert.deepEqual(months.map((row) => row.label), ["August 2026", "September 2026"]);
  assert.equal(months[1].entries.length, 5);
  const monthView = story.paint(Object.assign({}, clean, { grain: "month" }));
  assert.match(monthView, /Grouped by month/);
  assert.match(monthView, /September 2026/);
  assert.doesNotMatch(monthView, /Week of/);
});

test("a secret caption is not rendered and a missing file stays quiet", () => {
  const poisoned = story.sanitize({
    v: 1,
    grain: "week",
    baked_at: "2026-09-26T06:30:00Z",
    source: "sample",
    entries: [
      {
        date: "2026-09-20",
        title: "Leaked",
        caption: "Write fleet-owner@example.com into the frame",
        token: "fixture-token-value",
      },
      sample.entries[0],
    ],
  });
  const view = story.paint(poisoned);
  assert.equal(view.includes("fleet-owner@example.com"), false);
  assert.equal(view.includes("fixture-token-value"), false);
  assert.match(view, /The clock starts/);
  assert.match(story.emptyPaint(), /Storyboard unavailable/);
  assert.equal(story.sanitize(null), null);
  assert.equal(story.sanitize({ v: 2, baked_at: "2026-09-26T06:30:00Z" }), null);
});

test("markup in a title is escaped", () => {
  const snap = story.sanitize(sample);
  snap.entries[0].title = '<img alt="x">';
  const view = story.paint(snap);
  assert.equal(view.includes("<img"), false);
  assert.match(view, /&lt;img/);
});
