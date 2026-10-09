// Public pages do not offer Dashboard, Ops, or Process.
// Those three stay reachable by URL, stay noindex, and keep their own breadcrumb.
// Run: node --test tests/public_nav.cjs
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const INTERNAL = ["/dashboard/", "/ops/", "/process/"];

function hrefs(html) {
  return [...html.matchAll(/<a\s+[^>]*href="([^"]+)"/g)].map((m) => m[1]);
}

test("the shared footer offers Experience and Conference, not the internal pages", () => {
  const chrome = read("assets/chrome.js");
  const list = chrome.split("function footerLinks")[1].split("return links")[0];
  assert.match(list, /\/experience\/", "Experience"/);
  assert.match(list, /\/conference\/", "Conference"/);
  for (const href of INTERNAL) assert.doesNotMatch(list, new RegExp(href.replaceAll("/", "\\/")));
  for (const rel of ["index.html", "experience/index.html", "conference/index.html"]) {
    const page = read(rel);
    for (const href of INTERNAL) {
      assert.equal(hrefs(page).includes(href), false, rel + " links " + href);
    }
  }
});

test("the release chip is not a link to Ops", () => {
  const js = read("assets/next-deploy.js");
  assert.doesNotMatch(js, /href\s*=\s*["']\/ops\//);
  assert.doesNotMatch(js, /setAttribute\("href", "\/ops\/"\)/);
});

test("Dashboard, Ops, and Process stay noindex and keep the drill-down", () => {
  for (const rel of ["dashboard/index.html", "ops/index.html", "process/index.html"]) {
    const page = read(rel);
    assert.match(page, /name="robots" content="noindex"/, rel);
    const crumb = page.split('aria-label="Drill down"')[1].split("</nav>")[0];
    assert.deepEqual(hrefs(crumb), INTERNAL, rel);
  }
});

test("Process does not blame the chair", () => {
  const page = read("process/index.html");
  assert.doesNotMatch(page, /dropping the ball/i);
  assert.doesNotMatch(page, /SLA breach/i);
  assert.doesNotMatch(page, /silent ~5h/);
});
