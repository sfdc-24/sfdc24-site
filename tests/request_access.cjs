// The home email box is labeled, and visitors without an invite can ask.
// Run: node --test tests/request_access.cjs
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

test("Start conversation labels the email box and offers Request access", () => {
  const js = read("assets/voice-conversation.js");
  assert.match(js, /placeholder: "Your invited email"/);
  assert.match(js, /"Your invited email"/);
  assert.match(js, /href: "mailto:abdus@sfdc24.com"/);
  assert.match(js, /"Request access"/);
  for (const rel of ["index.html", "experience/index.html"]) {
    const page = read(rel);
    assert.match(page, /\.vc-email-label\{/);
    assert.match(page, /\.vc-request\{/);
  }
});
