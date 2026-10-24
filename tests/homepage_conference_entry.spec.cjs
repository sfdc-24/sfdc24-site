// The homepage no longer offers a conference entry card. /ops/ is in the menu.
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
      '.ico': 'image/x-icon',
      '.svg': 'image/svg+xml',
      '.webmanifest': 'application/manifest+json',
    };
    return route.fulfill({
      body: fs.readFileSync(file),
      contentType: types[path.extname(file)] || 'text/plain',
    });
  });
});

test('the homepage has no conference entry card on a 320 phone', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await page.goto('http://site.test/', { waitUntil: 'load' });
  await expect(page.locator('#host-tease')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Live conference room' })).toHaveCount(0);
  await expect(page.locator('main a[href="/conferences/"]')).toHaveCount(0);
  await expect(page.locator('footer a[href="/conferences/"]')).toHaveText('Conferences');
  await expect(page.locator('#chrome-menu a[href="/conferences/"]')).toHaveText('Conferences');
  await expect(page.locator('footer a[href="/ops/"]')).toHaveText('Ops');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
