// Prove the browser gate can fail, before trusting it to pass.
//
// A Playwright suite that runs ZERO tests exits 0 and looks identical to one
// that ran and passed. So does a suite whose spec cannot be loaded at all —
// which is exactly the state tests/honesty.spec.cjs shipped in: no manifest, no
// lockfile, MODULE_NOT_FOUND from a clean tree, and three green checks that
// never touched it.
//
// This runs the real spec against DELIBERATELY BROKEN inputs and requires it to
// fail on each, then confirms every file is restored byte for byte. If it passes
// on a page with the honest boundary ripped out, or on a page whose metadata
// claims what the page denies, the gate is decoration and CI stops here.
//
// MULTI-FILE since round two: the gate now reads tests/capabilities.json as well
// as the page, and a control that can only mutate index.html cannot test the
// half of the mechanism that lives in the fixture.
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

// Buffers: restore is byte-exact, and never depends on line-ending guessing.
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

function runSpec() {
  const r = spawnSync("npx",
    ["playwright", "test", "tests/honesty.spec.cjs", "--reporter=line"],
    { cwd: ROOT, encoding: "utf8", shell: process.platform === "win32", timeout: 300_000 });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

const CASES = [
  {
    name: "the honest boundary is hidden from the reader",
    file: "home",
    mutate: (s) => s.replace(/<p id="honest-boundary"/, '<p style="visibility:hidden" id="honest-boundary"'),
  },
  {
    name: "the honest boundary is removed entirely",
    file: "home",
    mutate: (s) => s.replace(/ id="honest-boundary"/, ' id="gone"'),
  },
  {
    // Round one's escape phrase.
    name: "the first reviewer's present-tense claim is put back on the page",
    file: "home",
    mutate: (s) => s.replace(
      '<p id="honest-boundary"',
      '<p>SFDC24 evaluates live customer Salesforce environments today and returns a grade.</p>\n        <p id="honest-boundary"',
    ),
  },
  {
    // Round two, false green 1: a VISIBLE claim in verbs no blocklist had.
    // Caught now by the allowlist rather than by a pattern, which is the point.
    name: "a visible claim in phrasing no blocklist was ever taught",
    file: "home",
    mutate: (s) => s.replace(
      '<p id="honest-boundary"',
      '<p>SFDC24 imports metadata from live customer Salesforce tenants today and publishes diagnostic scores.</p>\n        <p id="honest-boundary"',
    ),
  },
  {
    // Round two, false green 2: the surface nothing looked at.
    name: "the meta description claims what the page denies",
    file: "home",
    mutate: (s) => s.replace(
      '<meta name="description" content="Salesforce assessment',
      '<meta name="description" content="SFDC24 scores a live org today and returns a grade. Salesforce assessment',
    ),
  },
  {
    // The surface inventory must fail CLOSED: an unknown meta name is prose.
    name: "a brand new meta tag smuggles a claim onto an unlisted surface",
    file: "home",
    mutate: (s) => s.replace(
      '<meta property="og:type"',
      '<meta name="abstract" content="SFDC24 reads your production Salesforce org and grades it today.">\n<meta property="og:type"',
    ),
  },
  {
    // capabilities.json must be load-bearing, not decoration: an approved claim
    // may not assert a capability declared false.
    name: "an approved claim asserts a capability declared false",
    file: "caps",
    mutate: (s) => s.replace(
      '"automated_connector_reads_live_org": false',
      '"automated_connector_reads_live_org": false, "_bogus": false',
    ).replace(
      '"asserts": "none"',
      '"asserts": "automated_connector_reads_live_org"',
    ),
  },
];

let failures = 0;
console.log(`\nbrowser gate negative control — ${CASES.length} cases\n`);

// It must pass on the real inputs, or "it failed on the mutant" means nothing.
const baseline = runSpec();
if (!baseline.ok) {
  console.log("  BASELINE FAILED — the spec does not pass on the unmodified site.");
  console.log(baseline.out.split("\n").slice(-15).join("\n"));
  process.exit(1);
}
console.log("  baseline     the spec passes on the real site");

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
    const { ok } = runSpec();
    if (ok) {
      console.log(`  NOT CAUGHT   ${c.name} — the gate passed on a broken input`);
      failures++;
    } else {
      console.log(`  caught       ${c.name}`);
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
