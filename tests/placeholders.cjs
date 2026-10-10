// Placeholder rows stay off Method and the /speed/ alias.
// Run: node --test tests/placeholders.cjs
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

test("Method and SPEED do not offer TODO or EXAMPLE rows", () => {
  const method = read("method/index.html");
  const frag = read("assets/speed-section.fragment.html");
  const js = read("assets/speed-charts.js");
  const speed = read("speed/index.html");
  assert.doesNotMatch(method, /EXAMPLE/);
  assert.doesNotMatch(method, />TODO</);
  assert.match(speed, /url=\/method\/#speed/);
  assert.doesNotMatch(frag, />EXAMPLE</);
  assert.doesNotMatch(frag, /TODO/);
  assert.match(frag, /id="speed-deploy"[^>]*hidden/);
  assert.match(js, /rows = rows\.filter\(function \(r\) \{ return !r\.example; \}\)/);
  assert.doesNotMatch(js, /textContent = "EXAMPLE"/);
  assert.doesNotMatch(js, /class="ex">EXAMPLE</);
});
