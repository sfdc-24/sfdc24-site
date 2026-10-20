const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// Match the bytes served by Pages, not JSON.parse's last-wins interpretation
// of duplicate keys. Only formatting whitespace is permitted around tokens.
const SAFE_SNAPSHOT = /^[ \t\r\n]*\{[ \t\r\n]*"public_status"[ \t\r\n]*:[ \t\r\n]*"withheld"[ \t\r\n]*,[ \t\r\n]*"keys"[ \t\r\n]*:[ \t\r\n]*\{[ \t\r\n]*\}[ \t\r\n]*\}[ \t\r\n]*$/u;

function assertSafeSnapshot(raw) {
  assert.match(raw, SAFE_SNAPSHOT, "public snapshot must be the empty withheld fallback");
}

test("the public fleet snapshot contains no raw operational keys", () => {
  const file = path.join(__dirname, "..", "data", "xp-live.json");
  assertSafeSnapshot(fs.readFileSync(file, "utf8"));
});

test("duplicate JSON keys cannot hide raw public bytes", () => {
  const raw = '{"keys":{"inbox":"SYNTHETIC"},"public_status":"withheld","keys":{}}';
  assert.deepEqual(JSON.parse(raw), { public_status: "withheld", keys: {} });
  assert.throws(() => assertSafeSnapshot(raw), /empty withheld fallback/);
});

test("safe formatting whitespace remains allowed", () => {
  assertSafeSnapshot('  {\n  "public_status": "withheld",\n  "keys": { }\n}\n');
});
