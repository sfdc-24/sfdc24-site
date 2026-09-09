// Prove the browser gate can fail, before trusting it to pass.
//
// A Playwright suite that runs ZERO tests exits 0 and looks identical to one
// that ran and passed. So does a suite whose spec cannot be loaded at all —
// which is exactly the state tests/honesty.spec.cjs shipped in: no manifest, no
// lockfile, MODULE_NOT_FOUND from a clean tree, and three green checks that
// never touched it.
//
// This runs the real spec against a DELIBERATELY BROKEN copy of the homepage and
// requires it to fail, then confirms the original is restored byte for byte. If
// it passes on a page with the honest boundary ripped out, the gate is
// decoration and CI stops here rather than later.
//
// Run: node tests/honesty_negative_control.cjs
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const HOME = path.join(ROOT, "index.html");

const original = fs.readFileSync(HOME); // Buffer: restore is byte-exact.

function restore() {
  try {
    if (!fs.readFileSync(HOME).equals(original)) fs.writeFileSync(HOME, original);
  } catch { /* nothing further to do */ }
}
process.on("exit", restore);
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]) {
  process.on(sig, () => { restore(); process.exit(130); });
}

function runSpec() {
  const r = spawnSync("npx",
    ["playwright", "test", "tests/honesty.spec.cjs", "--reporter=line"],
    { cwd: ROOT, encoding: "utf8", shell: process.platform === "win32", timeout: 180_000 });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

const CASES = [
  {
    name: "the honest boundary is hidden from the reader",
    mutate: (s) => s.replace(/<p id="honest-boundary"/, '<p style="visibility:hidden" id="honest-boundary"'),
  },
  {
    name: "the honest boundary is removed entirely",
    mutate: (s) => s.replace(/ id="honest-boundary"/, ' id="gone"'),
  },
  {
    // The exact sentence chatgpt-codex-desktop-01a08613 walked past every guard
    // with. Without this case the CLAIMS entry that now catches it could be
    // deleted and every check would stay green — which is how it got in.
    name: "the reviewer's present-tense claim is put back on the page",
    mutate: (s) => s.replace(
      '<p id="honest-boundary"',
      '<p>SFDC24 evaluates live customer Salesforce environments today and returns a grade.</p>\n        <p id="honest-boundary"',
    ),
  },
];

let failures = 0;
console.log(`\nbrowser gate negative control — ${CASES.length} cases\n`);

// It must pass on the real page, or "it failed on the mutant" means nothing.
const baseline = runSpec();
if (!baseline.ok) {
  console.log("  BASELINE FAILED — the spec does not pass on the unmodified page.");
  console.log(baseline.out.split("\n").slice(-12).join("\n"));
  process.exit(1);
}
console.log("  baseline     the spec passes on the real page");

for (const c of CASES) {
  const before = fs.readFileSync(HOME, "utf8");
  const after = c.mutate(before);
  if (after === before) {
    console.log(`  NO-OP        ${c.name} — the mutation did not apply, so it proves nothing`);
    failures++;
    continue;
  }
  fs.writeFileSync(HOME, after);
  try {
    const { ok } = runSpec();
    if (ok) {
      console.log(`  NOT CAUGHT   ${c.name} — the gate passed on a broken page`);
      failures++;
    } else {
      console.log(`  caught       ${c.name}`);
    }
  } finally {
    fs.writeFileSync(HOME, original);
  }
}

const intact = fs.readFileSync(HOME).equals(original);
console.log(`\n  index.html restored byte-for-byte: ${intact}`);
if (!intact) failures++;

console.log(`\n${CASES.length - failures}/${CASES.length} controls satisfied\n`);
process.exit(failures === 0 ? 0 : 1);
