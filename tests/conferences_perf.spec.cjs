// /conferences/ stays put while the webfont swaps, and the phone card
// does not paint (or fetch its QR) on a narrow screen.
const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.__cls = 0;
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (!entry.hadRecentInput) window.__cls += entry.value;
        }
      }).observe({ type: 'layout-shift', buffered: true });
    } catch (err) {}
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
      '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon',
    };
    return route.fulfill({
      body: fs.readFileSync(file),
      contentType: types[path.extname(file)] || 'text/plain',
    });
  });
});

test('the lede keeps its measure when the font changes at 390x844', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const images = [];
  page.on('request', (req) => {
    if (req.resourceType() === 'image') images.push(req.url());
  });
  await page.goto('http://site.test/conferences/');
  const lede = page.locator('main .lede');
  const before = await lede.evaluate((el) => ({
    max: getComputedStyle(el).maxWidth,
    h: el.getBoundingClientRect().height,
  }));
  expect(before.max).toBe('352px');
  expect(before.h).toBeLessThan(30);
  await lede.evaluate((el) => {
    el.style.fontFamily = '"Courier New", monospace';
  });
  const after = await lede.evaluate((el) => getComputedStyle(el).maxWidth);
  expect(after).toBe(before.max);
  await expect(page.locator('#conference-phone')).toBeHidden();
  expect(images.some((url) => url.includes('phone.svg'))).toBe(false);
  const cls = await page.evaluate(() => window.__cls || 0);
  expect(cls).toBeLessThan(0.05);
  for (const id of ['conference-stage', 'conference-recap', 'conference-lobby', 'conference-goals', 'conference-invite', 'conference-ready', 'conference-faq']) {
    await expect(page.locator('#' + id)).toHaveCount(1);
  }
});
