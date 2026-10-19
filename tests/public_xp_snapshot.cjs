const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("the public fleet snapshot contains no raw operational keys", () => {
  const file = path.join(__dirname, "..", "data", "xp-live.json");
  const snapshot = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(snapshot, { public_status: "withheld", keys: {} });
});
