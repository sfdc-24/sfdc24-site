// Visitor-facing cleanup checks. Does not invent figures.
// Run: node --test tests/data_cleanup.cjs
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");

function read(rel) {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

test("Fardeen and Banglar Rannaghor do not appear in published pages or data", () => {
  const banned = /Fardeen|Banglar|Rannaghor/i;
  function walk(dir) {
    for (const name of fs.readdirSync(dir)) {
      if (name === "node_modules" || name === ".git") continue;
      const full = path.join(dir, name);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) walk(full);
      else if (/\.(html|js|json|md|mmd|css|py|cjs)$/.test(name) && !full.endsWith(path.join("tests", "data_cleanup.cjs"))) {
        const text = fs.readFileSync(full, "utf8");
        assert.doesNotMatch(text, banned, path.relative(root, full));
      }
    }
  }
  walk(root);
});

test("the homepage board shows persona names, not the codex handle", () => {
  const home = read("index.html");
  assert.match(home, /label:"Aya"/);
  assert.match(home, /label:"Claude"/);
  assert.match(home, /crewLabel\(p\)/);
  assert.doesNotMatch(home, /nm\.textContent = p\.who/);
});

test("Ops does not show vendor branch names or a merged pull request as current agents QA", () => {
  const ops = read("ops/index.html");
  const funnel = ops.split('id="milestone-funnel"')[1].split("</section>")[0];
  assert.match(funnel, /#253<\/a> is still open/);
  assert.match(funnel, /#255<\/a> merged 29 Sep 2026/);
  assert.match(funnel, /no agents QA pull request is recorded on this strip/);
  assert.doesNotMatch(funnel, /pull\/70/);
  assert.doesNotMatch(funnel, /Agents #70/);
  assert.doesNotMatch(ops, /<code>codex\/<\/code>/);
  assert.doesNotMatch(ops, /<code>grok\/<\/code>/);
  assert.doesNotMatch(ops, /<code>gemini\/<\/code>/);
  assert.match(ops, /Attribution follows each persona's branch/);
  assert.match(ops, /9 Oct 2026, 13:59Z/);
  assert.match(ops, /Expense Line Item/);
  assert.doesNotMatch(ops, /30 Sep 2026/);
  assert.doesNotMatch(ops, /Toronto today/);
  assert.match(ops, /LIVE_CHART|next-deploy\.js/);
  const milestones = read("assets/milestones.js");
  assert.match(milestones, /LIVE_CHART = false/);
});

test("the governance headline matches the recorded rows", () => {
  const data = JSON.parse(read("assets/milestones/pokayoke.json"));
  const counts = {};
  for (const row of data.governance) counts[row.verdict] = (counts[row.verdict] || 0) + 1;
  const tally = Object.entries(counts)
    .map(([verdict, n]) => n + " " + verdict.toLowerCase())
    .join(", ") + " of " + data.governance.length;
  assert.equal(counts.PASS, 8);
  assert.equal(counts.FAIL, 8);
  assert.equal(counts["NOT TESTABLE"], 1);
  assert.equal(data.governance.length, 17);
  assert.equal(data.governance_score, "8 pass, 8 fail, 1 not testable of 17");
  assert.equal(
    data.governance_score,
    "8 pass, 8 fail, 1 not testable of 17"
  );
  assert.equal(tally.includes("8 pass") && tally.includes("of 17"), true);
  const page = read("dashboard/index.html");
  assert.match(page, /8 pass, 8 fail, 1 not testable of 17/);
  assert.doesNotMatch(page, /15 pass, 8 fail, 2 not testable of 25/);
});

test("the process blocker register is labeled as a seed", () => {
  const page = read("process/index.html");
  const block = page.split('id="blocker-register"')[1].split('id="wait-charts"')[0];
  assert.match(block, /not a live open list/);
  assert.doesNotMatch(block, /Open Blocker Register/);
  assert.match(block, /seed, about 5h/);
  assert.doesNotMatch(block, /silent ~5h/);
  assert.doesNotMatch(block, /dropping the ball/i);
  assert.doesNotMatch(block, /SLA breach/i);
});
