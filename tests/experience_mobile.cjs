// At 390 the Experience footer wraps, and the goal chips and agent list stay available.
// Run: node --test tests/experience_mobile.cjs
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const page = fs.readFileSync(path.join(__dirname, "..", "experience/index.html"), "utf8");
const phone = page.split("@media (max-width:899px)")[1].split("}")[0];

test("a phone still shows the team, the goal chips, and the stage agents", () => {
  assert.match(page, /class="xp-team"/);
  assert.doesNotMatch(phone, /\.xp-team/);
  assert.doesNotMatch(phone, /\.vc-deliver/);
  assert.doesNotMatch(phone, /\.pc-agents/);
});

test("the Experience footer wraps instead of clipping Converspan", () => {
  assert.match(page, /footer\.chrome-foot nav\{flex-wrap:wrap/);
  assert.doesNotMatch(page, /footer\.chrome-foot nav\{flex-wrap:nowrap/);
});
