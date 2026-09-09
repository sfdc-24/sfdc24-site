// Mutation control for tests/site_positioning.cjs.
//
// This guard has been green three times while the site was still wrong: once
// with the regexes corrupted into backspace bytes, once with `me` and `mine`
// missing from the word list, and once checking three pages out of nine with
// every <script> stripped before it looked. Green is not evidence. Each case
// below reverts one fix and requires the suite to FAIL on the named test.
//
// Every mutation VERIFIES ITSELF FIRST. A replacement whose anchor no longer
// matches changes nothing, the suite passes, and this reports a dead guard as
// healthy. That has happened here, and it cost a cycle.
//
// Originals are stashed up front and restored on every exit path including
// signals — an earlier version of this harness was interrupted and left
// deliberately broken source behind.
//
// Run: node tests/mutate_positioning.cjs

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO = path.join(__dirname, '..');

const MUTATIONS = [
  {
    name: 'the first-person list loses "me" again',
    file: 'tests/site_positioning.cjs',
    from: "  new RegExp('\\\\bme\\\\b', 'i'),\n",
    to: '',
    expect: /catches every line it has ever missed/,
  },
  {
    name: 'the guard stops reading copy that scripts write into the page',
    file: 'tests/site_positioning.cjs',
    // This case was NOT CAUGHT on the first run, and that was the point of
    // running it: the test asserting script extraction called scriptProse()
    // directly, so it proved the extractor worked while the guard had stopped
    // using it. Both now go through readablePage().
    from: '  const text = withoutExemptions(readablePage(html));',
    to: '  const text = withoutExemptions(visible(html));',
    expect: /guard catches first-person copy that exists ONLY inside a script/,
  },
  {
    name: 'page discovery stops descending into subdirectories',
    file: 'tests/site_positioning.cjs',
    from: '    if (entry.isDirectory()) found.push(...discoverPages(path.join(dir, entry.name), rel));',
    to: '    if (entry.isDirectory()) { /* skipped */ }',
    expect: /every required page still exists/,
  },
  {
    name: 'the conversational exemption becomes a hole anything fits through',
    file: 'tests/site_positioning.cjs',
    from: "  for (const allowed of CONVERSATIONAL_VOICE) out = out.split(allowed).join(' ');",
    to: "  for (const rx of [/\\bI\\b/g, /\\bmy\\b/gi]) out = out.replace(rx, ' ');",
    expect: /exemption list is exact strings/,
  },
  {
    name: 'the browser tab goes back to the operations proposition',
    file: 'index.html',
    from: '<title>SFDC24 — Salesforce assessment and automation</title>',
    to: '<title>SFDC24 — Salesforce operations, Toronto</title>',
    expect: /browser tab, the search snippet and the share card/,
  },
  {
    name: 'variant A goes back to selling the superseded proposition',
    file: 'index.html',
    from: '<h1>Security gaps, waste, redundancy — measured, not guessed.</h1>',
    to: '<h1>Salesforce operations for orgs nobody wants to touch.</h1>',
    expect: /BOTH A\/B variants lead with the same proposition/,
  },
  {
    name: 'the page claims a live org is scored again',
    file: 'index.html',
    from: 'The scoring model is real: four pillars',
    to: 'The assessment model is real and scores a live org. Four pillars',
    expect: /no page claims a live org is being scored/,
  },
  {
    name: 'a person is put back on a page nobody used to check',
    file: 'terms/index.html',
    from: 'A Salesforce assessment, business process automation and AI enablement service',
    to: 'The website of an independent Salesforce operations consultant, a service',
    expect: /terms\/index\.html sells a capability/,
  },
  {
    // og.png was the last surface still selling the old thing, and it survived
    // every text guard because a PNG is opaque to all of them.
    name: 'the share image goes back to the retired proposition',
    file: 'assets/make_og.py',
    from: 'SUBLINE = "For enterprises  \\u00b7  Research stage"',
    to: 'SUBLINE = "Independent consulting  \\u00b7  Toronto"',
    expect: /share image itself is on-proposition/,
  },
  {
    name: 'a public page stops saying what the business does',
    file: 'projects/index.html',
    from: 'What is being built toward Salesforce assessment, business process automation and AI enablement for enterprises. Research stage, in the open.',
    to: 'What is being built.',
    expect: /every public page says what this business does/,
  },
  {
    name: 'a hero variant drops the research-stage caveat',
    file: 'index.html',
    from: 'This is research stage and we would rather say so than pretend otherwise.',
    to: 'This is proven and in production.',
    expect: /BOTH A\/B variants lead with the same proposition/,
  },
  {
    name: 'the positive contract goes back to one loose term',
    file: 'tests/site_positioning.cjs',
    from: "const PROPOSITION_CORE = /assessment|business process automation|\\bautomation\\b|AI enablement/i;",
    to: 'const PROPOSITION_CORE = /security|operability|waste|redundancy/i;',
    expect: /every public page says what this business does|share image itself is on-proposition/,
  },
  {
    // The OG guard used to assert existence and mtime>0, which is true of every
    // file that ever existed. Bound to the generated bytes now.
    name: 'the shipped share image drifts from the copy it is generated from',
    file: 'assets/og.png',
    from: null,
    binaryFlip: true,
    expect: /share image itself is on-proposition/,
  },
  {
    name: 'the extractor goes back to a regex and quote pairing drifts again',
    file: 'tests/site_positioning.cjs',
    from: "      if (c === '\"' || c === \"'\" || c === '`') {",
    to: "      if (false) {",
    expect: /SHORT literal cannot desynchronise|guard catches first-person copy/,
  },
  {
    name: 'the homepage stops explaining the method',
    file: 'index.html',
    from: 'Every change is reviewed at an exact commit by an agent that did not',
    to: 'Changes are reviewed by an agent that did not',
    expect: /still explains how the site is built/,
  },

  // ── The honesty property ────────────────────────────────────────────────
  // The first of these PASSED against the shipped guard. With /xray/ left
  // alone, the homepage could claim it assesses your production org and both
  // the JS suite (42/42) and the Python xray suite (OK) stayed green, because
  // the old check was a single regex for the exact phrase "scores a live org".
  {
    name: 'the site claims it reads your production org, in different words',
    file: 'index.html',
    from: 'The scoring model is real: four pillars',
    to: 'We assess your production Salesforce org against four pillars today: four pillars',
    expect: /no page claims a live org is being scored/,
  },
  {
    name: 'a pinned honesty denial is deleted',
    file: 'index.html',
    from: 'Nothing here has scored',
    to: 'This has scored',
    expect: /still denies, in so many words/,
  },
  {
    name: "/xray/ stops calling its own data synthetic",
    file: 'xray/index.html',
    from: 'synthetic sample data',
    to: 'sample data',
    expect: /still declares its data synthetic/,
  },
  {
    // The old guard read `if (!/synthetic/i.test(xray)) return;` — the thing
    // being guarded could switch the guard off. Same shape codex found in the
    // MCP plan the same day. Flipping the constant must not silently disarm
    // everything either: it is a deliberate act tied to a real collector.
    name: 'the honesty guard is disarmed by flipping its constant',
    file: 'tests/site_positioning.cjs',
    from: 'const COLLECTOR_READS_REAL_ORGS = false;',
    to: 'const COLLECTOR_READS_REAL_ORGS = true;',
    expect: /collector flag is off until a collector exists/,
  },
];

// Stashed as BUFFERS, not strings. One of the cases mutates a PNG, and reading
// a PNG as utf8 and writing it back corrupts it — the harness would then be the
// thing that broke the repository it was checking.
const originals = new Map();
for (const m of MUTATIONS) {
  const file = path.join(REPO, m.file);
  if (!originals.has(file)) originals.set(file, fs.readFileSync(file));
}
function restoreAll() {
  for (const [file, buf] of originals) {
    try { if (!fs.readFileSync(file).equals(buf)) fs.writeFileSync(file, buf); } catch { /* nothing to do */ }
  }
}
process.on('exit', restoreAll);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
  process.on(sig, () => { restoreAll(); process.exit(130); });
}

/**
 * Apply one anchor, tolerating line endings.
 *
 * A multi-line anchor written with LF does not match a file git checked out
 * with CRLF. On a canonical Windows checkout every multi-line case reported
 * ANCHOR LOST on source that was perfectly fine, this exited 1, and CI went red
 * for a reason that had nothing to do with the site — a gate that cries wolf on
 * one platform is a gate people turn off. Found by
 * chatgpt-codex-desktop-01a0839e running it on Windows, which is exactly where
 * it had never been run.
 *
 * @returns {string|null} the mutated text, or null if the anchor is truly absent
 */
function applyAnchor(text, from, to) {
  if (text.includes(from)) return text.replace(from, to);
  if (!from.includes('\n')) return null;
  const escaped = from.split('\n')
    .map((line) => line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('\\r?\\n');
  const pattern = new RegExp(escaped);
  if (!pattern.test(text)) return null;
  return text.replace(pattern, to.split('\n').join('\r\n'));
}

let failures = 0;
console.log(`\nmutation control — ${MUTATIONS.length} cases\n`);

for (const m of MUTATIONS) {
  const file = path.join(REPO, m.file);

  // A binary case: flip the shipped bytes so they no longer match what the
  // generator produces. Text anchors cannot express this, and reading a PNG as
  // utf8 to do it would corrupt the file.
  if (m.binaryFlip) {
    const buf = fs.readFileSync(file);
    const flipped = Buffer.concat([buf, Buffer.from([0])]);
    if (flipped.equals(buf)) {
      console.log(`  NO-OP        ${m.name}  (byte flip changed nothing)`);
      failures++;
      continue;
    }
    fs.writeFileSync(file, flipped);
  } else {
    const before = fs.readFileSync(file, 'utf8');
    const after = applyAnchor(before, m.from, m.to);
    if (after === null) {
      console.log(`  ANCHOR LOST  ${m.name}\n               ${m.file} no longer contains the text to mutate`);
      failures++;
      continue;
    }
    if (after === before) {
      console.log(`  NO-OP        ${m.name}  (replacement changed nothing)`);
      failures++;
      continue;
    }
    fs.writeFileSync(file, after);
  }
  try {
    // Bounded: a mutation can make a test hang rather than fail, and an
    // unbounded harness then hangs with it.
    const run = spawnSync(process.execPath, ['--test', 'tests/site_positioning.cjs'],
      { cwd: REPO, encoding: 'utf8', timeout: 90_000, killSignal: 'SIGKILL' });
    const out = `${run.stdout}${run.stderr}`;
    const suiteFailed = run.status !== 0;
    const rightTestFailed = out.split('\n')
      .filter((l) => l.startsWith('✖') || l.includes('not ok'))
      .some((l) => m.expect.test(l));

    if (suiteFailed && rightTestFailed) console.log(`  caught       ${m.name}`);
    else if (suiteFailed) { console.log(`  WRONG TEST   ${m.name}\n               failed, but not on ${m.expect}`); failures++; }
    else { console.log(`  NOT CAUGHT   ${m.name}\n               the suite stayed green with the fix reverted`); failures++; }
  } finally {
    // Restore from the Buffer stashed up front — `before` no longer exists in
    // this scope for the binary path, and a Buffer restores text and PNG alike.
    fs.writeFileSync(file, originals.get(file));
  }
}

console.log(`\n${MUTATIONS.length - failures}/${MUTATIONS.length} mutations caught\n`);
process.exit(failures === 0 ? 0 : 1);
