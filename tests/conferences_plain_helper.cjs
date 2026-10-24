// Shared open for the plain /conferences/ page.
const { expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

async function install({ page }) {
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
      '.webmanifest': 'application/manifest+json',
    };
    return route.fulfill({
      body: fs.readFileSync(file),
      contentType: types[path.extname(file)] || 'text/plain',
    });
  });
}

async function open(page, viewport) {
  await page.setViewportSize(viewport || { width: 1280, height: 900 });
  await page.goto('http://site.test/conferences/', { waitUntil: 'load' });
}

async function expectPlain(page) {
  await expect(page.locator('h1')).toHaveText('Conferences');
  const main = page.locator('#conference');
  await expect(main).toContainText('AI-assisted working session');
  await expect(main).toContainText('Abdus and his agent team, Claude, Cursor, Grok, Gemini, and Codex');
  await expect(page.locator('#conference-status')).toHaveText('The live conference room is still being built and is not open yet.');
  await expect(page.locator('#conference-how li')).toHaveText([
    'Name the Salesforce work.',
    'Plan it with the agent team.',
    'Prototype the change on Salesforce.',
    'A person reviews it before anything ships.',
  ]);
  await expect(page.locator('main a')).toHaveCount(1);
  await expect(page.locator('#conference-contact')).toHaveAttribute('href', 'mailto:abdus@sfdc24.com');
  await expect(page.locator('#conference-start, #conference-join, #host-tease, #conference-invite, a[href="https://sfdc24.com/conferences/room/"]')).toHaveCount(0);
  await expect(page.locator('footer a[href="/ops/"]')).toHaveText('Ops');
  await expect(page.locator('footer a[href="/conference/?room=workshop"]')).toHaveText('Conferences');
  await expect(page.locator('#chrome-menu a[href="/conference/?room=workshop"]')).toHaveText('Conferences');
  await expect(page.locator('#chrome-menu a[href="/ops/"]')).toHaveText('Ops');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}

module.exports = { install, open, expectPlain };
