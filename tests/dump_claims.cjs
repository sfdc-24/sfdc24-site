// Print every candidate capability claim on every surface, per page.
//
// This is the tool that makes the allowlist reviewable rather than pasted: run
// it, read what it prints, and decide sentence by sentence whether the site is
// entitled to say it. Run: node tests/dump_claims.cjs
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
      if (fs.existsSync(nested)) found.push(path.join(entry.name, 'index.html'));
    }
  }
  return found.sort();
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const technical = [...TECHNICAL_META];
  let total = 0;
  for (const rel of pages()) {
    await page.goto(url.pathToFileURL(path.join(ROOT, rel)).href);
    await page.waitForLoadState('networkidle');
    const surfaces = await page.evaluate(COLLECT_SURFACES, technical);
    const lines = [];
    for (const s of surfaces) {
      for (const claim of candidateClaims(s.text)) lines.push(`  [${s.surface}] ${claim}`);
    }
    if (lines.length) {
      console.log(`\n=== ${rel}  (${lines.length}) ===`);
      for (const l of lines) console.log(l);
      total += lines.length;
    }
  }
  console.log(`\ntotal candidate claims: ${total}`);
  await browser.close();
})();
