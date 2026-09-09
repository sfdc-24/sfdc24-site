// Prove the browser gate can fail, before trusting it to pass.
//
// A Playwright suite that runs ZERO tests exits 0 and looks identical to one
// that ran and passed. So does a suite whose spec cannot be loaded at all —
// which is exactly the state tests/honesty.spec.cjs shipped in: no manifest, no
// lockfile, MODULE_NOT_FOUND from a clean tree, and three green checks that
// never touched it.
//
// MULTI-FILE since round two: the gate reads tests/capabilities.json as well as
// the page, and a control that can only mutate index.html cannot test the half
// of the mechanism that lives in a fixture.
//
// BASELINE-AWARE since round three, and for an honest reason. The suite now has
// one INTENTIONAL failure: four sentences on /xray/ are recorded as disputed
// live copy awaiting Mr. Salam, and `no live claim is disputed` fails while they
// stand. A control that demanded a green baseline would have to pretend that
// finding away. So the baseline failure set is captured first, and every case
// must add a NAMED new failure to it. "The suite went red" proves nothing when
// part of it is red on purpose.
//
// Run: node tests/honesty_negative_control.cjs
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const FILES = {
  home: path.join(ROOT, "index.html"),
  caps: path.join(ROOT, "tests", "capabilities.json"),
};

const ORIGINAL = Object.fromEntries(
  Object.entries(FILES).map(([k, p]) => [k, fs.readFileSync(p)]),
);

function restore() {
  for (const [k, p] of Object.entries(FILES)) {
    try {
      if (!fs.readFileSync(p).equals(ORIGINAL[k])) fs.writeFileSync(p, ORIGINAL[k]);
    } catch { /* nothing further to do */ }
  }
}
process.on("exit", restore);
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]) {
  process.on(sig, () => { restore(); process.exit(130); });
}

/** The set of test titles currently failing.
 *
 * JSON, not the line reporter. My first version scraped `› title` out of the
 * line output — which prints that for EVERY test, passing or not, so the
 * "failing" set was all ten and every control reported NOT CAUGHT on a healthy
 * gate. A control that cannot tell pass from fail is worse than none, because
 * it reads as a coverage collapse.
 */
function failingTests() {
  const r = spawnSync("npx",
    ["playwright", "test", "tests/honesty.spec.cjs", "--reporter=json"],
    { cwd: ROOT, encoding: "utf8", shell: process.platform === "win32",
      timeout: 600_000, maxBuffer: 64 * 1024 * 1024 });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const failing = new Set();
  let report;
  try {
    report = JSON.parse(out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1));
  } catch {
    throw new Error("could not parse the Playwright JSON report:\n" + out.slice(-800));
  }
  const visit = (suite) => {
    for (const spec of suite.specs ?? []) {
      const ok = (spec.tests ?? []).every((t) =>
        (t.results ?? []).every((res) => res.status === "passed" || res.status === "skipped"));
      if (!ok) failing.add(spec.title);
    }
    for (const child of suite.suites ?? []) visit(child);
  };
  for (const suite of report.suites ?? []) visit(suite);
  return { failing, out };
}

const REVIEWED = "every capability claim, on every surface of every page, has been reviewed";

const CASES = [
  { name: "the honest boundary is hidden from the reader", file: "home",
    expect: "the honest boundary is actually visible to a reader",
    mutate: (s) => s.replace(/<p id="honest-boundary"/, '<p style="visibility:hidden" id="honest-boundary"') },

  { name: "the honest boundary is removed entirely", file: "home",
    expect: "exactly one honest-boundary exists in the DOM",
    mutate: (s) => s.replace(/ id="honest-boundary"/, ' id="gone"') },

  { name: "round one's present-tense claim is put back on the page", file: "home",
    expect: REVIEWED,
    mutate: (s) => s.replace('<p id="honest-boundary"',
      '<p>SFDC24 evaluates live customer Salesforce environments today and returns a grade.</p>\n        <p id="honest-boundary"') },

  { name: "round two: a visible claim in phrasing no blocklist was taught", file: "home",
    expect: REVIEWED,
    mutate: (s) => s.replace('<p id="honest-boundary"',
      '<p>SFDC24 imports metadata from live customer Salesforce tenants today and publishes diagnostic scores.</p>\n        <p id="honest-boundary"') },

  { name: "round two: the meta description claims what the page denies", file: "home",
    expect: REVIEWED,
    mutate: (s) => s.replace('<meta name="description" content="Salesforce assessment',
      '<meta name="description" content="SFDC24 scores a live org today and returns a grade. Salesforce assessment') },

  // ── Round three: the collector hand-selected containers and meta keys ──
  { name: "round three: a standalone div, which no tag list contained", file: "home",
    expect: REVIEWED,
    mutate: (s) => s.replace('<p id="honest-boundary"',
      '<div>SFDC24 imports production Salesforce data today and publishes diagnostic scores.</div>\n        <p id="honest-boundary"') },

  { name: "round three: a meta carrying only itemprop", file: "home",
    expect: REVIEWED,
    mutate: (s) => s.replace('<meta property="og:type"',
      '<meta itemprop="description" content="SFDC24 scores a live customer org today.">\n<meta property="og:type"') },

  { name: "a claim in a title attribute", file: "home",
    expect: REVIEWED,
    mutate: (s) => s.replace('<p id="honest-boundary"',
      '<p title="SFDC24 grades your production Salesforce org today.">Hover me.</p>\n        <p id="honest-boundary"') },

  { name: "a claim in aria-description", file: "home",
    expect: REVIEWED,
    mutate: (s) => s.replace('<p id="honest-boundary"',
      '<p aria-description="SFDC24 scans your production org today.">x</p>\n        <p id="honest-boundary"') },

  { name: "an approved claim asserts a capability declared false", file: "caps",
    expect: "no reviewed claim asserts a capability we do not have",
    mutate: (s) => s.replace('"asserts": "none"', '"asserts": "automated_connector_reads_live_org"') },
];

let failures = 0;
console.log(`\nbrowser gate negative control — ${CASES.length} cases\n`);

const base = failingTests();
console.log(`  baseline     ${base.failing.size} test(s) failing before any mutation`
  + (base.failing.size ? `: ${[...base.failing].join("; ")}` : ""));

for (const c of CASES) {
  const target = FILES[c.file];
  const before = fs.readFileSync(target, "utf8");
  const after = c.mutate(before);
  if (after === before) {
    console.log(`  NO-OP        ${c.name} — the mutation did not apply, so it proves nothing`);
    failures++;
    continue;
  }
  fs.writeFileSync(target, after);
  try {
    const { failing } = failingTests();
    const added = [...failing].filter((t) => !base.failing.has(t));
    if (failing.has(c.expect) && !base.failing.has(c.expect)) {
      console.log(`  caught       ${c.name}`);
    } else if (added.length) {
      console.log(`  WRONG TEST   ${c.name}\n               newly failing: ${added.join("; ")}`
        + `\n               expected: ${c.expect}`);
      failures++;
    } else {
      console.log(`  NOT CAUGHT   ${c.name} — no test failed that was not already failing`);
      failures++;
    }
  } finally {
    restore();
  }
}

const intact = Object.entries(FILES)
  .every(([k, p]) => fs.readFileSync(p).equals(ORIGINAL[k]));
console.log(`\n  every input restored byte-for-byte: ${intact}`);
if (!intact) failures++;

console.log(`\n${CASES.length - failures}/${CASES.length} controls satisfied\n`);
process.exit(failures === 0 ? 0 : 1);
