// /conferences/ after the stacked passes: one phone bar, one room path,
// no sideways scroll. The samples may loop, but only the one in front.
const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const ROOM = 'https://sfdc24.com/conferences/room/';
const WIDTHS = [
  { width: 320, height: 568 },
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
  { width: 1280, height: 800 },
];

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
      '.ico': 'image/x-icon',
    };
    return route.fulfill({
      body: fs.readFileSync(file),
      contentType: types[path.extname(file)] || 'text/plain',
    });
  });
});

function bottomBars() {
  const vh = window.innerHeight;
  const found = [];
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el);
    if (cs.position !== 'fixed' || cs.visibility === 'hidden' || cs.display === 'none') continue;
    if (cs.pointerEvents === 'none') continue;
    const rect = el.getBoundingClientRect();
    if (rect.height < 20 || rect.width < window.innerWidth * 0.7) continue;
    if (rect.top <= vh * 0.5 || rect.bottom < vh * 0.7) continue;
    found.push(el.id || String(el.className).slice(0, 40));
  }
  return found;
}

function sideways() {
  return document.documentElement.scrollWidth - document.documentElement.clientWidth;
}

function roomPath() {
  return [...document.querySelectorAll('a[href="https://sfdc24.com/conferences/room/"]')].map((el) => el.id);
}

test('the page does not scroll sideways and keeps one room path', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const size of WIDTHS) {
    await page.setViewportSize(size);
    await page.goto('http://site.test/conferences/', { waitUntil: 'load' });
    const stops = await page.evaluate(() => {
      const max = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
      return [0, Math.round(max / 2), max];
    });
    for (const y of stops) {
      await page.evaluate((top) => window.scrollTo(0, top), y);
      expect(await page.evaluate(sideways), `${size.width} at ${y}`).toBeLessThanOrEqual(0);
      if (size.width === 390) {
        const bars = await page.evaluate(bottomBars);
        expect(bars.length, `${size.width} bars at ${y}: ${bars.join(',')}`).toBeLessThanOrEqual(1);
      }
    }
    expect(await page.evaluate(roomPath)).toEqual(['conference-start', 'conference-join']);
    await expect(page.locator('#conference-start')).toHaveAttribute('href', ROOM);
    await expect(page.locator('#conference-join')).toHaveAttribute('href', ROOM);
    await expect(page.locator('#conference-dock')).toHaveCount(0);
    await expect(page.locator('.chrome-disclaimer')).toContainText('not affiliated with, endorsed by, or sponsored by Salesforce');
  }
});

test('a 390 phone shows at most one bottom bar and one looping scene', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('http://site.test/conferences/', { waitUntil: 'load' });
  await expect(page.locator('#conference-dock')).toHaveCount(0);

  const stops = await page.evaluate(() => {
    const max = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    const actions = document.getElementById('conference-actions');
    const past = actions.getBoundingClientRect().bottom + window.scrollY + 8;
    return [0, Math.round(past), Math.round(max / 2), max];
  });
  for (const y of stops) {
    await page.evaluate((top) => window.scrollTo(0, top), y);
    await page.waitForTimeout(80);
    const bars = await page.evaluate(bottomBars);
    expect(bars.length, `bars at ${y}: ${bars.join(',')}`).toBeLessThanOrEqual(1);
    expect(await page.evaluate(sideways), `sideways at ${y}`).toBeLessThanOrEqual(0);
    const loops = await page.evaluate(() => {
      const vh = window.innerHeight;
      const hosts = new Set();
      for (const el of document.querySelectorAll('body *')) {
        if (!el.getAnimations) continue;
        const rect = el.getBoundingClientRect();
        if (rect.bottom <= 0 || rect.top >= vh || rect.width < 1 || rect.height < 1) continue;
        for (const anim of el.getAnimations()) {
          if (anim.playState !== 'running') continue;
          const timing = anim.effect && anim.effect.getTiming ? anim.effect.getTiming() : {};
          if (timing.iterations !== Infinity) continue;
          let node = el;
          let host = '';
          while (node) {
            if (node.id && node.id.indexOf('conference-') === 0) {
              host = node.id;
              break;
            }
            node = node.parentElement;
          }
          hosts.add(host || 'page');
        }
      }
      return [...hosts];
    });
    expect(loops.length, `loops at ${y}: ${loops.join(',')}`).toBeLessThanOrEqual(1);
  }

  expect(await page.evaluate(roomPath)).toEqual(['conference-start', 'conference-join']);
  await expect(page.locator('.flowbar-go')).toHaveAttribute('href', '#conference-actions');
  await expect(page.locator('.chrome-disclaimer')).toContainText('not affiliated with, endorsed by, or sponsored by Salesforce');
});
