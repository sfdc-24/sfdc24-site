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

// The Projects page is "a list of what is actually built and running, kept
// current": it lists the studio, and says plainly what a visitor can and
// cannot do in it today.
test('the Projects page lists the studio with its limits stated', async ({ page }) => {
  await page.goto('http://site.test/projects/');
  const entry = page.locator('article', { has: page.getByRole('heading', { name: /The studio/ }) });
  await expect(entry).toHaveCount(1);
  await expect(entry).toContainText('scripted walkthrough');
  await expect(entry).toContainText('invited email');
  await expect(entry).toContainText('voice is not on for visitors yet');
});

// One list. chrome-footer-polish.js rebuilds the nav on some pages after
// chrome.js has; with its own copy of the links, a link added to one file
// appeared on one pass and vanished on the next. It now reuses chrome.js's.
test('the footer list lives only in chrome.js', () => {
  const chrome = fs.readFileSync(path.join(root, 'assets', 'chrome.js'), 'utf8');
  const polish = fs.readFileSync(path.join(root, 'assets', 'chrome-footer-polish.js'), 'utf8');
  expect(chrome).toContain('window.__SFDC24_FOOTER_LINKS = footerLinks');
  expect(polish).toContain('window.__SFDC24_FOOTER_LINKS');
  for (const label of ['"Board"', '"Studio"', '"Method"', '"History"', '"Privacy"', '"Terms"', '"LinkedIn"']) {
    expect(polish, `chrome-footer-polish.js keeps its own ${label}`).not.toContain(label);
  }
});

test('the homepage footer is still right after the polish pass has run', async ({ page }) => {
  await page.goto('http://site.test/');
  await page.waitForTimeout(1500);   // polish runs after chrome.js, on a timer
  await expect(page.locator('footer.chrome-foot nav a')).toHaveText(EXPECTED);
});
