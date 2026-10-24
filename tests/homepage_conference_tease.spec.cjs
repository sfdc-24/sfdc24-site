// The homepage conference teaser is retired. Services lead the page instead.
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
    };
    return route.fulfill({
      body: fs.readFileSync(file),
      contentType: types[path.extname(file)] || 'text/plain',
    });
  });
});

test('owner 2026-10-24: the homepage is centered, one line under the title, no Work section', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('http://site.test/', { waitUntil: 'load' });
  await expect(page.locator('#host-tease')).toHaveCount(0);
  await expect(page.locator('#services')).toHaveCount(0);
  await expect(page.locator('h2', { hasText: /^Work$/ })).toHaveCount(0);
  await expect(page.locator('.launch .hero-sub')).toHaveText('CI/CD pipeline run by AI agents: Claude, Cursor, Grok, Gemini, and Codex.');
  await expect(page.locator('.launch .caveat')).toContainText('Automation and AI enablement');
  for (const sel of ['#quote', '.launch .hero-sub', '.launch .caveat']) {
    expect(await page.locator(sel).evaluate((n) => getComputedStyle(n).textAlign)).toBe('center');
    const box = await page.locator(sel).boundingBox();
    const mid = box.x + box.width / 2;
    expect(Math.abs(mid - 720)).toBeLessThan(40);           // the page's centre line
  }
  await expect(page.locator('a.skip')).toHaveAttribute('href', '#quote');
});
