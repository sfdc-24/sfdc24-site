// Seed tests/capabilities.json from the site as it stands today.
//
// Run ONCE, then maintain by hand. Its output is only as good as the reading
// that went into it: I ran tests/dump_claims.cjs and read all 39 candidates
// before running this. The allowlist's value is PROSPECTIVE — new copy in the
// risk class fails until a person reviews it — not retrospective, and pretending
// otherwise would make it a rubber stamp with a JSON extension.
//
// Run: node tests/gen_capabilities.cjs > tests/capabilities.json
'use strict';
const { chromium } = require('@playwright/test');
const path = require('node:path');
const url = require('node:url');
const fs = require('node:fs');
const { COLLECT_SURFACES, TECHNICAL_META, candidateClaims } = require('./claim_surfaces.cjs');

const ROOT = path.join(__dirname, '..');

function pages() {
  const found = [];
  for (const entry of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.html')) found.push(entry.name);
    else if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
      const nested = path.join(ROOT, entry.name, 'index.html');
      if (fs.existsSync(nested)) found.push(`${entry.name}/index.html`);
    }
  }
  return found.sort();
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const seen = new Map();
  for (const rel of pages()) {
    await page.goto(url.pathToFileURL(path.join(ROOT, rel)).href);
    await page.waitForLoadState('networkidle');
    const surfaces = await page.evaluate(COLLECT_SURFACES, [...TECHNICAL_META]);
    for (const s of surfaces) {
      for (const claim of candidateClaims(s.text)) {
        if (!seen.has(claim)) seen.set(claim, { text: claim, asserts: 'none', seen_on: [] });
        const rec = seen.get(claim);
        const where = `${rel} ${s.surface}`;
        if (!rec.seen_on.includes(where)) rec.seen_on.push(where);
      }
    }
  }
  await browser.close();
  console.log(JSON.stringify(
    { approved_claims: [...seen.values()].sort((a, b) => a.text.localeCompare(b.text)) },
    null, 2));
})();
