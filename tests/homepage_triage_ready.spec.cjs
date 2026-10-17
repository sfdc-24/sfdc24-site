// Delays triage.js past the moment Enter is already live. An early send must
// not reach the model, and must pick up the local rule or the route stamp
// once the deferred script actually runs.
const { test, expect } = require('@playwright/test');
const { pathToFileURL } = require('node:url');
const fs = require('node:fs');
const path = require('node:path');

const HOME = pathToFileURL(path.join(__dirname, '..', 'index.html')).href;
const TRIAGE = fs.readFileSync(path.join(__dirname, '..', 'assets', 'triage.js'), 'utf8');

async function loadWhileTriageHangs(page) {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const remote = [];
  await page.route('**/triage.js', async (route) => {
    await gate;
    await route.fulfill({
      status: 200,
      contentType: 'text/javascript',
      body: TRIAGE,
    });
  });
  await page.route(/script\.google\.com/, (route) => {
    remote.push(decodeURIComponent(route.request().url()));
    return route.abort();
  });
  await page.goto(HOME, { waitUntil: 'commit' });
  await page.locator('#box').waitFor({ state: 'attached' });
  await expect(page.locator('#cliout')).toContainText('waiting for a question');
  await expect(page.locator('#cliout')).not.toContainText('python triage');
  expect(await page.evaluate(() => !!window.__TRIAGE)).toBe(false);
  await page.evaluate(() => { const seek = document.querySelector('.seek'); if (seek) seek.hidden = false; });
  return {
    remote,
    release() { release(); },
  };
}

test('a greeting sent before triage.js arrives is answered locally', async ({ page }) => {
  const held = await loadWhileTriageHangs(page);
  await page.locator('#box').fill('hello');
  await page.locator('#box').press('Enter');
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 80)));
  expect(held.remote).toEqual([]);
  expect(await page.evaluate(() => !!window.__TRIAGE)).toBe(false);
  await expect(page.locator('#tape')).toContainText('hello');
  held.release();
  await expect(page.locator('#tape')).toContainText('Hi. What can we help you with?');
  await expect(page.locator('#cliout')).toContainText('answered here, no model call');
  expect(held.remote).toEqual([]);
});

test('a routed question sent before triage.js arrives is stamped, not sent bare', async ({ page }) => {
  const held = await loadWhileTriageHangs(page);
  const question = 'please review this apex trigger';
  await page.locator('#box').fill(question);
  await page.locator('#box').press('Enter');
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 80)));
  expect(held.remote).toEqual([]);
  held.release();
  await expect.poll(() => held.remote.length).toBe(1);
  expect(held.remote[0]).toContain('Today is ');
  expect(held.remote[0]).toContain(question);
  expect(held.remote[0].indexOf('Today is ')).toBeLessThan(held.remote[0].indexOf(question));
});
