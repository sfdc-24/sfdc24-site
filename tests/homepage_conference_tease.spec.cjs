// The homepage conference teaser is retired. Since 2026-11-04 the studio hero leads the page.
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

test('owner 2026-11-04: the studio hero replaces the CI/CD line; still no teaser or Work section', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('http://site.test/', { waitUntil: 'load' });
  await expect(page.locator('#host-tease')).toHaveCount(0);
  await expect(page.locator('#services')).toHaveCount(0);
  await expect(page.locator('h2', { hasText: /^Work$/ })).toHaveCount(0);
  await expect(page.locator('#quote')).toHaveText('Salesforce Design and Training Studio');
  await expect(page.locator('.sh-hero .hero-sub')).toContainText('multi-agent framework');
  await expect(page.locator('.sh-hero .caveat')).toContainText('Automation and AI enablement');
  await expect(page.locator('body')).not.toContainText('CI/CD pipeline run by AI agents');
  // The hero band spans the page; its text column and picture sit inside it.
  const band = await page.locator('.sh-hero').boundingBox();
  expect(band.x).toBe(0);
  expect(Math.round(band.width)).toBe(1440);
  await expect(page.locator('a.skip')).toHaveAttribute('href', '#quote');
});
