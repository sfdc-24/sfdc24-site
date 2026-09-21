// The estimator must be able to size every problem the page offers to size.
//
// WHY THIS FILE EXISTS
//   The page shows four chips. Tapping one composes a sentence and sends it,
//   and the estimator answers with a range. So each chip is a promise: we are
//   inviting this question. If a chip's sentence falls through the matcher, the
//   visitor taps a suggestion the page made and is told it is not scopeable --
//   the page contradicting its own prompt, which is worse than having no chip.
//
//   That shipped once. The `reports` matcher contained the word "spreadsheet",
//   so "a spreadsheet holding the process together" was answered with a scope
//   about tracing one number end to end. The matcher returned a shape, nothing
//   threw, and every other suite stayed green: only a fixture comparing intent
//   against outcome can see a wrong-but-present match.
//
// WHAT IT REFUSES TO MIRROR
//   It executes index.html's OWN `SHAPES` and `estimate()`, reads the chips
//   from the page's OWN markup, and rebuilds the sentence from the page's OWN
//   template. A test that retypes any of those three passes while the page is
//   broken -- which is exactly how tests/honesty.spec.cjs kept its own stale
//   copy of the denial list and went green against a page that had moved on.
//
// Run: node tests/estimator_shapes.cjs
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SRC = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");

let failures = 0;
const fail = (msg) => { console.log(`  FAIL  ${msg}`); failures++; };
const pass = (msg) => console.log(`  ok    ${msg}`);

/* ---- 1. lift the real matcher out of the page ------------------------------ */
// Anchored on text that must exist for the feature to exist at all; if an
// anchor stops matching the suite fails loudly rather than testing nothing.
// estimate() defers to isMakeAsk() as of 2026-09-21 - MAKE_SHAPES only answer
// a request to MAKE something, because their bare nouns (app, game, play,
// argument) otherwise outrank every real SHAPES match. Lift that gate too, or
// this suite dies with "isMakeAsk is not defined" instead of testing anything.
const GATE_END = String.fromCharCode(10) + "  }";
const gateStart = SRC.indexOf("  var MAKE_INTENT =");
const gateEnd = SRC.indexOf(GATE_END, gateStart);
if (gateStart < 0 || gateEnd < 0) {
  console.log("\nFATAL: isMakeAsk()/MAKE_INTENT not found in index.html.\n");
  process.exit(1);
}
const gate = SRC.slice(gateStart, gateEnd + GATE_END.length);

const start = SRC.indexOf("var SHAPES = [");
const nullReturn = SRC.indexOf("return null;", start);
const end = SRC.indexOf("}", nullReturn);
if (start < 0 || nullReturn < 0 || end < 0) {
  console.log("\nFATAL: could not locate SHAPES/estimate() in index.html.");
  console.log("The estimator was removed or renamed - fix this suite's anchors before trusting it.\n");
  process.exit(1);
}
const source = gate + "\n" + SRC.slice(start, end + 1);

const sandbox = {};
vm.createContext(sandbox);
try {
  new vm.Script(source + "\n;({SHAPES:SHAPES, estimate:estimate})").runInContext(sandbox);
} catch (e) {
  console.log(`\nFATAL: the page's estimator source does not execute: ${e.message}\n`);
  process.exit(1);
}
const { SHAPES, estimate } = new vm.Script(
  "({SHAPES:SHAPES, estimate:estimate})").runInContext(sandbox);

/* ---- 2. lift the chips and the sentence template --------------------------- */
const picks = [...SRC.matchAll(/data-pick="([^"]+)"/g)].map((m) => m[1]);
const tpl = SRC.match(/box\.value\s*=\s*"([^"]*)"\s*\+\s*pick\s*\+\s*"([^"]*)"/);
/* This used to fail here. It is the wrong assertion for this suite to own.
   "Every chip the page offers must be scopeable" is a promise about the
   estimator. "The page must offer chips" is a product decision, and as of
   2026-09-21 index.html ships `<div class="chips" id="chips" hidden>` with no
   children at all - the CSS, the click handler and this suite all still name a
   feature that was stripped from the markup. Stating it loudly beats failing
   on it: a permanently red suite is a suite nobody wires into CI, which is
   exactly how this one went unread. The per-chip assertions below still run
   the moment a chip comes back. */
if (!picks.length) {
  console.log("  note  index.html offers no data-pick chips; the per-chip "
    + "assertions below have nothing to run against");
}
if (!tpl) {
  console.log("\nFATAL: could not find the chip sentence template in index.html.\n");
  process.exit(1);
}
const compose = (pick) => `${tpl[1]}${pick}${tpl[2]}`;

/* ---- 3. every chip must be scopeable -------------------------------------- */
// Keyed by the chip's own text, so a NEW chip cannot quietly go untested:
// an unknown pick fails and names itself.
const CHIP_INTENT = {
  "approvals that sit for days": "approvals",
  "reports nobody trusts": "reports",
  "the same data typed in twice": "duplicate",
  "a spreadsheet holding the process together": "spreadsheet",
};

console.log(`\nestimator shapes - ${picks.length} chips, ${SHAPES.length} shapes\n`);

for (const pick of picks) {
  const sentence = compose(pick);
  const got = estimate(sentence);
  const want = CHIP_INTENT[pick];
  if (!want) {
    fail(`chip "${pick}" has no recorded intent - add it to CHIP_INTENT and assert what it should size`);
    continue;
  }
  if (!got) {
    fail(`chip "${pick}" is not scopeable: the page offers the question then refuses it\n        sent: ${sentence}`);
  } else if (got.id !== want) {
    fail(`chip "${pick}" sized as "${got.id}", intended "${want}"\n        scope returned: ${got.scope}`);
  } else {
    pass(`chip "${pick}" -> ${got.id}`);
  }
}

/* ---- 4. order matters, so pin it ------------------------------------------ */
// estimate() is first-match-wins. `spreadsheet` only beats `reports` because it
// is listed first; reordering them silently restores the original defect, and
// no other assertion here would notice.
const ids = SHAPES.map((s) => s.id);
const iSheet = ids.indexOf("spreadsheet");
const iRep = ids.indexOf("reports");
if (iSheet < 0 || iRep < 0) {
  fail(`expected both "spreadsheet" and "reports" shapes; got ${ids.join(", ")}`);
} else if (iSheet > iRep) {
  fail('"spreadsheet" is listed after "reports"; first-match-wins sends the spreadsheet chip to the reports scope');
} else {
  pass('"spreadsheet" precedes "reports" (first match wins)');
}

/* ---- 5. typed sentences, for shapes no chip reaches ----------------------- */
const TYPED = [
  ["Our handover between sales and delivery keeps dropping things.", "handover"],
  ["Onboarding a new hire takes us two weeks of manual setup.", "onboarding"],
  ["We track the whole pipeline in Excel and it is falling apart.", "spreadsheet"],
  ["The numbers in our dashboard do not match the source.", "reports"],
  // approvals and duplicate were reachable only through the four suggestion
  // chips. Those chips are no longer in the markup (see the chips FAIL above),
  // so until they come back these two shapes had nothing exercising them -
  // dead config that still reads as capability. Typed fixtures now do it.
  ["Every discount sits waiting on sign-off for days.", "approvals"],
  ["The same data gets typed in twice, once here and once in the finance system.", "duplicate"],
  // Must NOT match: proves the fall-through is real and estimate() is not
  // simply answering everything, which would make every assertion above hollow.
  ["What do you think about the weather this week?", null],
  ["much better, whats next?", null],
  ["", null],
];

for (const [text, want] of TYPED) {
  const got = estimate(text);
  const gotId = got ? got.id : null;
  const label = text ? `"${text.slice(0, 52)}${text.length > 52 ? "..." : ""}"` : "(empty string)";
  if (gotId === want) pass(`${label} -> ${gotId ?? "not scopeable"}`);
  else fail(`${label} sized as ${gotId ?? "not scopeable"}, expected ${want ?? "not scopeable"}`);
}

/* ---- 6. no shape may be unreachable -------------------------------------- */
// A shape nothing can hit is dead config that reads as capability.
const reached = new Set();
for (const pick of picks) { const s = estimate(compose(pick)); if (s) reached.add(s.id); }
for (const [text] of TYPED) { const s = estimate(text); if (s) reached.add(s.id); }
const orphans = ids.filter((id) => !reached.has(id));
if (orphans.length) fail(`shapes no fixture reaches, so nothing proves they work: ${orphans.join(", ")}`);
else pass(`all ${ids.length} shapes reached by at least one fixture`);

/* ---- 7. every shape must carry its assumption ----------------------------- */
// A range without its assumption is a promise, per the comment above SHAPES.
for (const s of SHAPES) {
  const missing = ["id", "scope", "band", "effort", "assume"].filter((k) => !s[k] || !String(s[k]).trim());
  if (missing.length) fail(`shape "${s.id}" is missing: ${missing.join(", ")}`);
}
if (SHAPES.every((s) => s.assume && s.band)) pass("every shape names a range and the assumption under it");

console.log(`\n${failures === 0 ? "PASS" : "FAIL"} - ${failures} problem(s)\n`);
process.exit(failures === 0 ? 0 : 1);
