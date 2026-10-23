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

test('services replace the conference teaser under the hero', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('http://site.test/', { waitUntil: 'load' });
  await expect(page.locator('#host-tease')).toHaveCount(0);
  const services = page.locator('#services');
  await expect(services).toBeVisible();
  await expect(services).toContainText('Salesforce implementations');
  await expect(services).toContainText('Supply chain on Salesforce');
  const quote = await page.locator('#quote').boundingBox();
  const block = await services.boundingBox();
  expect(block.y).toBeGreaterThan(quote.y);
  expect(block.y + block.height).toBeLessThan(1600);
});
