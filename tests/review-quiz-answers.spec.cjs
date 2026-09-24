// /review/ gates its options behind three questions and tells the visitor
// where every answer is. On 2026-09-24 it said "the front page", but the
// homepage rebuild removed all three answers from it; /projects/ has them.
// This renders the page the quiz points to and finds each correct answer's
// fact there, so the quiz cannot silently become unanswerable again.
const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');

test.beforeEach(async ({ page }) => {
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://site.test') return route.abort();
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.resolve(root, '.' + rel);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
    const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json' };
    return route.fulfill({ body: fs.readFileSync(file), contentType: types[path.extname(file)] || 'application/octet-stream' });
  });
});

test('every quiz answer is on the page the quiz sends visitors to', async ({ page }) => {
  await page.goto('http://site.test/review/');
  const href = await page.locator('p.note a').first().getAttribute('href');
  expect(href).toBe('/projects/');
  const answers = await page.evaluate(() => {
    const src = [...document.scripts].map((s) => s.textContent).join('\n');
    return JSON.parse(src.match(/var ANSWERS = (\{[^}]*\})/)[1].replace(/(\w+):/g, '"$1":'));
  });
  expect(answers).toEqual({ q1: '5', q2: 'check', q3: 'built' });
  await page.goto('http://site.test' + href);
  const text = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
  // q1 "Five", q2 "A second agent checks it", q3 "The connector is designed and not built"
  expect(text).toMatch(/\bFive participants\b/);
  expect(text).toMatch(/second name against it once another participant has checked it/);
  expect(text).toMatch(/does not exist yet is the part that reads a live system/);
});
