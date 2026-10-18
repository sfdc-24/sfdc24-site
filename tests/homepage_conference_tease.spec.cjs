// Homepage teaser for /conferences/: a silent room preview under the hero.
// The loop runs only on screen with the tab visible. Reduced motion, including
// a change while the page is open, leaves one still frame. Nothing is sent.
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
    };
    return route.fulfill({
      body: fs.readFileSync(file),
      contentType: types[path.extname(file)] || 'text/plain',
    });
  });
});

async function contrast(locator) {
  return locator.evaluate((el) => {
    const rgb = (s) => (s.match(/[\d.]+/g) || []).map(Number);
    const lum = ([r, g, b]) => {
      const c = [r, g, b].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
      return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    };
    const fg = rgb(getComputedStyle(el).color);
    let node = el, bg = null;
    while (node && !bg) {
      const c = rgb(getComputedStyle(node).backgroundColor);
      if (c.length >= 3 && (c.length === 3 || c[3] > 0.95)) bg = c;
      node = node.parentElement;
    }
    bg = bg || [255, 255, 255];
    const [a, b] = [lum(fg.slice(0, 3)), lum(bg.slice(0, 3))].sort((x, y) => y - x);
    return (a + 0.05) / (b + 0.05);
  });
}

function still(locator) {
  return locator.evaluate((el) => {
    const read = (node) => {
      const s = getComputedStyle(node);
      return { name: s.animationName, opacity: s.opacity, transform: s.transform };
    };
    return {
      draw: read(el.querySelector('.aim-draw')),
      who: read(el.querySelector('.who')),
    };
  });
}

test('the teaser links to /conferences/ and the hero stays on a 390 phone', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('http://site.test/');
  const card = page.locator('#host-tease');
  const link = page.locator('#host-tease-go');
  await expect(card).toBeVisible();
  await expect(card).toHaveAccessibleName('Live conference room');
  await expect(page.locator('#host-tease-line')).toHaveText('Live conference room');
  await expect(link).toHaveText('Start');
  await expect(link).toHaveAccessibleName('Live conference room');
  await expect(link).toHaveAttribute('href', '/conferences/');
  expect(await link.getAttribute('target')).toBeNull();
  await expect(card.locator('.who')).toHaveCount(3);
  await expect(card.locator('.aim-draw')).toHaveCount(1);
  await expect(card.locator('audio, video, img, iframe')).toHaveCount(0);
  await expect(card).toHaveClass(/is-live/);
  const motion = await card.locator('.who').first().evaluate((el) => {
    const anim = el.getAnimations().find((item) => item.animationName === 'host-pulse');
    const timing = anim && anim.effect ? anim.effect.getTiming() : null;
    return { state: anim ? anim.playState : '', iterations: timing ? timing.iterations : 0 };
  });
  expect(motion.state).toBe('running');
  expect(motion.iterations).toBe(Infinity);
  const quote = await page.locator('#quote').boundingBox();
  const pathfig = await page.locator('.pathfig').boundingBox();
  const cardBox = await card.boundingBox();
  const linkBox = await link.boundingBox();
  expect(quote.y).toBeGreaterThanOrEqual(0);
  expect(quote.y + quote.height).toBeLessThan(844);
  expect(pathfig.y + pathfig.height).toBeLessThan(844);
  expect(cardBox.y).toBeGreaterThanOrEqual(pathfig.y + pathfig.height - 1);
  expect(cardBox.y + cardBox.height).toBeLessThan(844);
  expect(linkBox.height).toBeGreaterThanOrEqual(48);
  expect(linkBox.width).toBeGreaterThanOrEqual(48);
  expect(await contrast(page.locator('#host-tease-line'))).toBeGreaterThanOrEqual(4.5);
  expect(await contrast(link)).toBeGreaterThanOrEqual(4.5);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test('reduced motion shows one still frame', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('http://site.test/');
  const card = page.locator('#host-tease');
  await expect(card).toBeVisible();
  await expect(card).not.toHaveClass(/is-live/);
  const frame = await still(card);
  for (const part of Object.values(frame)) expect(part.name).toBe('none');
  expect(frame.who.opacity).toBe('1');
  expect(frame.draw.opacity).toBe('1');
  expect(['none', 'matrix(1, 0, 0, 1, 0, 0)']).toContain(frame.who.transform);
  expect(['none', 'matrix(1, 0, 0, 1, 0, 0)']).toContain(frame.draw.transform);
  await expect(page.locator('#host-tease-go')).toHaveAttribute('href', '/conferences/');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test('reduced motion switches to a still frame while the page is open', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('http://site.test/');
  const card = page.locator('#host-tease');
  await expect(card).toHaveClass(/is-live/);
  expect(await card.locator('.aim-draw').evaluate((el) => getComputedStyle(el).animationName)).not.toBe('none');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(card).not.toHaveClass(/is-live/);
  const frozen = await still(card);
  for (const part of Object.values(frozen)) expect(part.name).toBe('none');
  expect(frozen.who.opacity).toBe('1');
  expect(frozen.draw.opacity).toBe('1');
  expect(['none', 'matrix(1, 0, 0, 1, 0, 0)']).toContain(frozen.who.transform);
  expect(['none', 'matrix(1, 0, 0, 1, 0, 0)']).toContain(frozen.draw.transform);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect(card).toHaveClass(/is-live/);
  expect(await card.locator('.who').first().evaluate((el) => getComputedStyle(el).animationPlayState)).toBe('running');
  await expect(page.locator('#host-tease-go')).toHaveAttribute('href', '/conferences/');
});

test('the loop pauses off screen and while the tab is hidden', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('http://site.test/');
  const card = page.locator('#host-tease');
  await expect(card).toHaveClass(/is-live/);
  await card.evaluate((el) => {
    const top = el.getBoundingClientRect().top + window.scrollY;
    window.scrollTo(0, top + el.offsetHeight + 80);
  });
  await expect(card).not.toHaveClass(/is-live/);
  expect(await card.locator('.who').first().evaluate((el) => getComputedStyle(el).animationPlayState)).toBe('paused');
  await card.scrollIntoViewIfNeeded();
  await expect(card).toHaveClass(/is-live/);
  expect(await card.locator('.aim-draw').evaluate((el) => getComputedStyle(el).animationPlayState)).toBe('running');
  await page.evaluate(() => {
    const desc = Object.getOwnPropertyDescriptor(Document.prototype, 'hidden');
    if (!desc || desc.configurable === false) throw new Error('document.hidden is not configurable');
    let hidden = true;
    Object.defineProperty(Document.prototype, 'hidden', { configurable: true, get: () => hidden });
    window.__setTabHidden = (value) => {
      hidden = value;
      document.dispatchEvent(new Event('visibilitychange'));
    };
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(card).not.toHaveClass(/is-live/);
  expect(await card.locator('.aim-draw').evaluate((el) => getComputedStyle(el).animationPlayState)).toBe('paused');
  await page.evaluate(() => window.__setTabHidden(false));
  await expect(card).toHaveClass(/is-live/);
  expect(await card.locator('.who').first().evaluate((el) => getComputedStyle(el).animationPlayState)).toBe('running');
  await expect(page.locator('#host-tease-go')).toHaveAttribute('href', '/conferences/');
});

for (const width of [320, 375, 390]) {
  test(`the teaser does not overflow a ${width}px phone`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ width, height: width === 320 ? 700 : 844 });
    await page.goto('http://site.test/');
    const card = page.locator('#host-tease');
    await expect(card).toBeVisible();
    await expect(page.locator('#host-tease-go')).toHaveAttribute('href', '/conferences/');
    const linkBox = await page.locator('#host-tease-go').boundingBox();
    expect(linkBox.height).toBeGreaterThanOrEqual(48);
    expect(linkBox.width).toBeGreaterThanOrEqual(48);
    const fit = await card.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const cut = [...el.querySelectorAll('.host-line, .host-go')].filter((node) => node.scrollWidth > node.clientWidth + 1);
      return {
        left: r.left,
        right: r.right,
        page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        cut: cut.map((node) => node.className),
      };
    });
    expect(fit.left).toBeGreaterThanOrEqual(0);
    expect(fit.right).toBeLessThanOrEqual(width + 1);
    expect(fit.page).toBeLessThanOrEqual(0);
    expect(fit.cut).toEqual([]);
  });
}
