// Homepage entry into /conferences/: one card, one link, one still frame
// when motion is reduced. The preview is painted locally. It does not ask
// the network for anything.
const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.__net = [];
    const note = (kind, value) => window.__net.push(kind + ' ' + String(value || ''));
    const origFetch = window.fetch;
    window.fetch = function (input) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      note('fetch', url);
      return origFetch.apply(this, arguments);
    };
    const open = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
      note('xhr', url);
      return open.apply(this, arguments);
    };
    const Beacon = navigator.sendBeacon ? navigator.sendBeacon.bind(navigator) : null;
    navigator.sendBeacon = function (url) {
      note('beacon', url);
      return Beacon ? Beacon(url) : false;
    };
    window.WebSocket = function (url) {
      note('ws', url);
      throw new Error('no socket');
    };
    window.EventSource = function (url) {
      note('es', url);
    };
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

test('the conference entry card renders, links, and stays quiet on a 320 phone', async ({ page }) => {
  const requested = [];
  page.on('request', (req) => requested.push(req.url()));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 320, height: 700 });
  await page.goto('http://site.test/', { waitUntil: 'load' });

  const card = page.locator('#host-tease');
  const link = page.locator('#host-tease-go');
  await expect(card).toBeVisible();
  await expect(card).toHaveAccessibleName('Live conference room');
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute('href', '/conferences/');
  await expect(link).toHaveAccessibleName('Live conference room');
  expect(await link.getAttribute('target')).toBeNull();
  await expect(card.locator('.who')).toHaveCount(3);
  await expect(card.locator('.aim-draw')).toBeVisible();

  const still = await card.evaluate((el) => {
    const read = (node) => {
      const style = getComputedStyle(node);
      return { name: style.animationName, opacity: style.opacity, transform: style.transform };
    };
    return { draw: read(el.querySelector('.aim-draw')), who: read(el.querySelector('.who')) };
  });
  expect(still.draw.name).toBe('none');
  expect(still.who.name).toBe('none');
  expect(still.draw.opacity).toBe('1');
  expect(still.who.opacity).toBe('1');
  expect(['none', 'matrix(1, 0, 0, 1, 0, 0)']).toContain(still.draw.transform);
  expect(['none', 'matrix(1, 0, 0, 1, 0, 0)']).toContain(still.who.transform);

  const markup = await card.evaluate((el) => el.outerHTML + (el.nextElementSibling ? el.nextElementSibling.textContent : ''));
  expect(markup).not.toMatch(/https?:\/\//);
  expect(markup).not.toMatch(/\b(?:fetch|XMLHttpRequest|WebSocket|sendBeacon|EventSource)\b/);

  if (!requested.some((url) => url.includes('/data/desk.json'))) {
    await page.waitForRequest((req) => req.url().includes('/data/desk.json'));
  }
  const beforeQuiet = requested.length;
  await page.waitForTimeout(600);
  expect(requested.slice(beforeQuiet)).toEqual([]);
  const calls = await page.evaluate(() => window.__net);
  // The homepage already polls these. The card must not add another call.
  const homepageCalls = [
    /^fetch \/data\/desk\.json/,
    /^fetch \/data\/site-manifest\.json$/,
    /^fetch \/data\/next-release\.json$/,
    /^fetch \/data\/visitor-stats\.json$/,
    /^fetch https:\/\/sfdc24-studio-controller-96522051727\.us-central1\.run\.app\/health$/,
  ];
  expect(calls.filter((item) => !homepageCalls.some((rule) => rule.test(item)))).toEqual([]);
  expect(requested.some((url) => /\/conferences\/|aim-draw|host-tease/.test(url))).toBe(false);
  const knownHosts = new Set([
    'site.test',
    'fonts.googleapis.com',
    'fonts.gstatic.com',
    'script.google.com',
    'sfdc24-studio-controller-96522051727.us-central1.run.app',
  ]);
  const hosts = [...new Set(requested.map((url) => { try { return new URL(url).host; } catch (err) { return url; } }))];
  expect(hosts.filter((host) => !knownHosts.has(host))).toEqual([]);

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  const fit = await card.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    return { left: rect.left, right: rect.right, width: document.documentElement.clientWidth };
  });
  expect(fit.left).toBeGreaterThanOrEqual(0);
  expect(fit.right).toBeLessThanOrEqual(fit.width + 1);
});
