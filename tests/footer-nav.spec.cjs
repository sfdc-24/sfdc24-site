// The footer is rebuilt at runtime by assets/chrome.js on every page that
// loads it, so the footer a visitor sees is only proven by rendering it: a
// link added to static HTML alone is erased when chrome.js boots.
const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');

test.beforeEach(async ({ page }) => {
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://site.test') return route.abort();
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.resolve(root, '.' + rel);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
    const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json' };
    return route.fulfill({ body: fs.readFileSync(file), contentType: types[path.extname(file)] || 'text/plain' });
  });
});

const EXPECTED = ['Board', 'Studio', 'Method', 'History', 'Privacy', 'Terms', 'LinkedIn'];

for (const page_ of ['/', '/intake/', '/method/', '/history/', '/privacy/', '/terms/', '/projects/',
  '/org/', '/agents/', '/listen/', '/looks/', '/governor/', '/404.html']) {
  test(`the rendered footer on ${page_} links the studio`, async ({ page }) => {
    await page.goto('http://site.test' + page_);
    const nav = page.locator('footer.chrome-foot nav');
    await expect(nav.locator('a')).toHaveText(EXPECTED);
    await expect(nav.getByRole('link', { name: 'Studio' })).toHaveAttribute('href', '/studio/');
  });
}
