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
    expect: /no page claims a live org has been scored/,
  },
  {
    name: 'a person is put back on a page nobody used to check',
    file: 'terms/index.html',
    from: 'A Salesforce assessment, business process automation and AI enablement service',
    to: 'The website of an independent Salesforce operations consultant, a service',
    expect: /terms\/index\.html sells a capability/,
  },
];

const originals = new Map();
for (const m of MUTATIONS) {
  const file = path.join(REPO, m.file);
  if (!originals.has(file)) originals.set(file, fs.readFileSync(file, 'utf8'));
}
function restoreAll() {
  for (const [file, text] of originals) {
    try { if (fs.readFileSync(file, 'utf8') !== text) fs.writeFileSync(file, text); } catch { /* nothing to do */ }
  }
}
process.on('exit', restoreAll);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
  process.on(sig, () => { restoreAll(); process.exit(130); });
}

let failures = 0;
console.log(`\nmutation control — ${MUTATIONS.length} cases\n`);

for (const m of MUTATIONS) {
  const file = path.join(REPO, m.file);
  const before = fs.readFileSync(file, 'utf8');

  if (!before.includes(m.from)) {
    console.log(`  ANCHOR LOST  ${m.name}\n               ${m.file} no longer contains the text to mutate`);
    failures++;
    continue;
  }
  const after = before.replace(m.from, m.to);
  if (after === before) {
    console.log(`  NO-OP        ${m.name}  (replacement changed nothing)`);
    failures++;
    continue;
  }

  fs.writeFileSync(file, after);
  try {
    const run = spawnSync(process.execPath, ['--test', 'tests/site_positioning.cjs'],
      { cwd: REPO, encoding: 'utf8' });
    const out = `${run.stdout}${run.stderr}`;
    const suiteFailed = run.status !== 0;
    const rightTestFailed = out.split('\n')
      .filter((l) => l.startsWith('✖') || l.includes('not ok'))
      .some((l) => m.expect.test(l));

    if (suiteFailed && rightTestFailed) console.log(`  caught       ${m.name}`);
    else if (suiteFailed) { console.log(`  WRONG TEST   ${m.name}\n               failed, but not on ${m.expect}`); failures++; }
    else { console.log(`  NOT CAUGHT   ${m.name}\n               the suite stayed green with the fix reverted`); failures++; }
  } finally {
    fs.writeFileSync(file, before);
  }
}

console.log(`\n${MUTATIONS.length - failures}/${MUTATIONS.length} mutations caught\n`);
process.exit(failures === 0 ? 0 : 1);
