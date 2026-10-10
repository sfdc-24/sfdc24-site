// The conference page is client language. Redis is live. The sheet is backup only.
// Run: node --test tests/conference_plain.cjs
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const page = fs.readFileSync(path.join(__dirname, "..", "conference/index.html"), "utf8");

test("the conference page speaks plainly and does not call the sheet the system of record", () => {
  assert.match(page, /Redis is the live layer/);
  assert.match(page, /spreadsheet is only a backup/);
  assert.match(page, /never the live record/);
  assert.doesNotMatch(page, /system of record/i);
  assert.doesNotMatch(page, /VERIFY/);
  assert.doesNotMatch(page, /communication board/i);
  assert.doesNotMatch(page, /owner records/i);
  assert.doesNotMatch(page, /href="\/ops\//);
  assert.doesNotMatch(page, /href="\/dashboard\//);
  assert.doesNotMatch(page, /href="\/process\//);
  assert.match(page, /name="robots" content="noindex"/);
});
