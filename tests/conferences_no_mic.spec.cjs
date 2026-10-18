// /conferences/ is a handoff. chrome.js must not attach the shared ask
// microphone there. A page that does not opt out still gets it.
const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.__srBuilt = 0;
    window.__srStarts = 0;
    class Rec {
      constructor() { window.__srBuilt += 1; }
      start() { window.__srStarts += 1; }
      stop() {}
      abort() {}
    }
    window.SpeechRecognition = Rec;
    window.webkitSpeechRecognition = Rec;
  });
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://site.test') return route.abort();
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.resolve(root, '.' + rel);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) {
      return route.fulfill({ status: 404, body: '' });
    }
    const types = {
      '.html': 'text/html',
      '.js': 'application/javascript',
      '.css': 'text/css',
      '.json': 'application/json',
      '.png': 'image/png',
      '.ico': 'image/x-icon',
    };
    return route.fulfill({
      body: fs.readFileSync(file),
      contentType: types[path.extname(file)] || 'text/plain',
    });
  });
});

test('the conferences handoff renders no microphone or speech recognition', async ({ page }) => {
  await page.goto('http://site.test/conferences/');
  await expect(page.locator('#conference-start')).toHaveAttribute('href', 'https://converspan.com/room');
  await expect(page.locator('.facts')).toContainText('PIPEDA and the CRTC require consent');
  await expect(page.locator('.facts')).toContainText('No microphone');
  await expect(page.locator('.facts')).toContainText('No transcript or recording');
  await expect(page.locator('#chrome-mic')).toHaveCount(0);
  await expect(page.locator('#chrome-ask, #chrome-ask-shell, #chrome-box')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /ask out loud|listening/i })).toHaveCount(0);
  expect(await page.evaluate(() => window.__srBuilt)).toBe(0);
  expect(await page.evaluate(() => window.__srStarts)).toBe(0);
  expect(await page.locator('body').innerHTML()).not.toMatch(/tel:/i);
});

test('a page that does not opt out still gets the ask microphone', async ({ page }) => {
  await page.goto('http://site.test/method/');
  const mic = page.locator('#chrome-mic');
  await expect(mic).toBeVisible();
  await expect(mic).toHaveAttribute('aria-label', 'Ask out loud');
  expect(await page.evaluate(() => document.body.getAttribute('data-chrome-ask'))).toBeNull();
  await mic.click();
  expect(await page.evaluate(() => window.__srBuilt)).toBe(1);
  expect(await page.evaluate(() => window.__srStarts)).toBe(1);
});
