// Static contracts for the Method choice-design probe.
// Playwright (choice_design_probe.spec.cjs) owns the click path.
const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const REPO = path.join(__dirname, "..");

function read(rel) {
  return fs.readFileSync(path.join(REPO, rel), "utf8");
}

test("Method mounts a cobalt-locked choice-design probe", () => {
  const method = read("method/index.html");
  assert.match(method, /id="choice-design"/);
  assert.match(method, /id="choice-design-probe"/);
  assert.match(method, /data-palette="cobalt"/);
  assert.match(method, /#0A66C2/);
  assert.match(method, /choice-design-probe\.js/);
  assert.match(method, /What are you working on\?/);
  assert.match(method, /Trust Navy/);
  assert.match(method, /Countdown plus last release/);
  assert.doesNotMatch(method, /AI FITNESS/i);
  const visible = method
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ");
  assert.doesNotMatch(visible, /SFDC\s*24/);
});

test("probe script stays on-page and does not switch the site", () => {
  const src = read("assets/choice-design-probe.js");
  assert.match(src, /#0A66C2/);
  assert.doesNotMatch(src, /document\.cookie/);
  assert.doesNotMatch(src, /localStorage/);
  assert.doesNotMatch(src, /data-palette/);
  assert.doesNotMatch(src, /next-deploy/);
  assert.doesNotMatch(src, /Math\.random/);
  assert.match(src, /stays on this page/);
});

test("bundled sets match the catalog and differ on two attributes", () => {
  const catalog = JSON.parse(read("data/choice-design-pilot.json"));
  assert.equal(catalog.status, "pilot-not-deployed");
  assert.equal(catalog.visitor_surface.path, "/method/#choice-design");
  assert.equal(catalog.visitor_surface.applies_to_site, false);
  assert.equal(catalog.privacy.cookies, false);

  const src = read("assets/choice-design-probe.js");
  const sandbox = { window: {}, document: { readyState: "complete", getElementById: () => null } };
  vm.runInNewContext(src, sandbox);
  const api = sandbox.window.__choiceDesignProbe;
  assert.ok(api, "probe did not export __choiceDesignProbe");
  assert.equal(api.accent, "#0A66C2");
  assert.equal(Array.isArray(api.errors) ? api.errors.length : -1, 0);
  assert.equal(api.sets.length, catalog.choice_sets_per_survey);
  const names = catalog.attributes.map((a) => a.name);
  const allowed = Object.fromEntries(catalog.attributes.map((a) => [a.name, new Set(a.levels)]));
  api.sets.forEach((pair) => {
    assert.equal(pair.length, 2);
    const a = pair[0], b = pair[1];
    let diff = 0;
    names.forEach((name) => {
      assert.ok(allowed[name].has(a[name]), `${name} level ${a[name]} is not in the catalog`);
      assert.ok(allowed[name].has(b[name]), `${name} level ${b[name]} is not in the catalog`);
      if (a[name] !== b[name]) diff += 1;
    });
    assert.ok(diff >= 2, "a bundled set differs on fewer than two attributes");
  });
});

test("bundled sets are the exact seed-24 catalog artifact", () => {
  const out = execFileSync("python3", [
    path.join(REPO, "tools", "choice_design.py"),
    "--seed", "24",
  ], { encoding: "utf8" });
  const rows = out.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const expected = [];
  for (let i = 0; i < rows.length; i += 2) {
    expected.push([rows[i].attributes, rows[i + 1].attributes]);
  }
  const src = read("assets/choice-design-probe.js");
  const sandbox = { window: {}, document: { readyState: "complete", getElementById: () => null } };
  vm.runInNewContext(src, sandbox);
  const actual = JSON.parse(JSON.stringify(sandbox.window.__choiceDesignProbe.sets));
  assert.deepEqual(actual, expected);
  assert.match(read("method/index.html"), /data-catalog="\/data\/choice-design-pilot\.json"/);
  assert.match(read("assets/choice-design-probe.js"), /data-catalog/);
  assert.match(read("assets/choice-design-probe.js"), /restoreFocus/);
});
