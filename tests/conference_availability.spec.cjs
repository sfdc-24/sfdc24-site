// The five public surfaces agree on conference availability, and the copy
// still fits a desktop window and a phone without sideways scroll.
const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

async function install(page) {
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

async function overflow(page) {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

for (const width of [1280, 390]) {
  test(`homepage names the owner and does not add a join at ${width}px`, async ({ page }) => {
    await install(page);
    await page.setViewportSize({ width, height: 900 });
    await page.goto('http://site.test/', { waitUntil: 'load' });
    await expect(page.locator('.sh-hero .hero-sub')).toContainText('The line is owner only');
    await expect(page.locator('#capabilities')).toContainText('guest access is not open');
    await expect(page.locator('.sh-actions a')).toHaveText(['See what the studio does', 'Write to the studio']);
    await expect(page.getByRole('link', { name: 'Join the room' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Join the conference' })).toHaveCount(0);
    expect(await overflow(page)).toBeLessThanOrEqual(1);
  });

  test(`conferences keeps one contact and the owner-only status at ${width}px`, async ({ page }) => {
    await install(page);
    await page.setViewportSize({ width, height: 900 });
    await page.goto('http://site.test/conferences/', { waitUntil: 'load' });
    const status = page.locator('#conference-status');
    await expect(status).toBeVisible();
    await expect(status).toContainText('open to the owner only');
    await expect(status).toContainText('guest access is not open');
    await expect(status).not.toContainText('not open yet');
    await expect(page.locator('main a')).toHaveCount(1);
    await expect(page.locator('#conference-contact')).toHaveAttribute('href', 'mailto:abdus@sfdc24.com');
    await expect(page.locator('#conference-contact')).toBeVisible();
    expect(await overflow(page)).toBeLessThanOrEqual(1);
  });

  test(`conference keeps the owner sign-in and no public mailto at ${width}px`, async ({ page }) => {
    await install(page);
    await page.setViewportSize({ width, height: 900 });
    await page.goto('http://site.test/conference/', { waitUntil: 'load' });
    await expect(page.locator('.lede')).toContainText('Google sign-in, owner only');
    await expect(page.locator('.lede')).toContainText('guest access is not open');
    await expect(page.locator('#conf-room-toggle')).toHaveText('Join the room');
    await expect(page.locator('main a[href^="mailto:"]')).toHaveCount(0);
    const buttons = page.locator('.conf-actions button:visible');
    await expect(buttons).toHaveCount(2);
    expect(await overflow(page)).toBeLessThanOrEqual(1);
  });

  test(`projects labels conferences owner only at ${width}px`, async ({ page }) => {
    await install(page);
    await page.setViewportSize({ width, height: 900 });
    await page.goto('http://site.test/projects/', { waitUntil: 'load' });
    const article = page.locator('article', { has: page.getByRole('heading', { name: 'Conferences: planning and prototyping with the agent team' }) });
    await expect(article.locator('.tag')).toHaveText('Owner only');
    await expect(article).toContainText('guest access is not open');
    await expect(article).not.toContainText('Running');
    await expect(page.locator('main a[href^="mailto:"]')).toHaveCount(1);
    expect(await overflow(page)).toBeLessThanOrEqual(1);
  });

  test(`experience keeps one owner sign-in and no page scroll at ${width}px`, async ({ page }) => {
    await install(page);
    await page.setViewportSize({ width, height: width === 390 ? 844 : 800 });
    await page.goto('http://site.test/experience/', { waitUntil: 'load' });
    const room = page.locator('#experience-voice-room');
    await expect(room).toHaveText('Join the voice room (owner sign-in)');
    await expect(room).toHaveCount(1);
    await expect(page.locator('main')).toContainText('guest access is not open');
    await expect(page.locator('.xp-empty')).toContainText('as the owner talks');
    const spill = await page.evaluate(() => document.scrollingElement.scrollHeight - window.innerHeight);
    expect(spill).toBeLessThanOrEqual(2);
    expect(await overflow(page)).toBeLessThanOrEqual(1);
  });
}
