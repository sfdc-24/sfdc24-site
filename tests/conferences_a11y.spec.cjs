// Keyboard, names, contrast, and reduced motion for /conferences/.
// The room stays on Converspan. This page still has no microphone.
const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const ROOM = 'https://converspan.com/room';

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
    };
    return route.fulfill({
      body: fs.readFileSync(file),
      contentType: types[path.extname(file)] || 'text/plain',
    });
  });
});

function contrastOf(locator) {
  return locator.evaluate((el) => {
    const rgb = (s) => (String(s).match(/[\d.]+/g) || []).map(Number);
    const lum = ([r, g, b]) => {
      const c = [r, g, b].map((v) => {
        v /= 255;
        return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
      });
      return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    };
    const cs = getComputedStyle(el);
    const fg = rgb(cs.color).slice(0, 3);
    let node = el;
    let bg = null;
    while (node && !bg) {
      const c = rgb(getComputedStyle(node).backgroundColor);
      if (c.length >= 3 && (c.length < 4 || c[3] > 0.95)) bg = c.slice(0, 3);
      node = node.parentElement;
    }
    bg = bg || [243, 242, 239];
    const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x);
    return (a + 0.05) / (b + 0.05);
  });
}

function ringContrast(locator) {
  return locator.evaluate((el) => {
    const rgb = (s) => (String(s).match(/[\d.]+/g) || []).map(Number);
    const lum = ([r, g, b]) => {
      const c = [r, g, b].map((v) => {
        v /= 255;
        return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
      });
      return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    };
    const cs = getComputedStyle(el);
    const oc = rgb(cs.outlineColor).slice(0, 3);
    let node = el;
    let bg = null;
    while (node && !bg) {
      const c = rgb(getComputedStyle(node).backgroundColor);
      if (c.length >= 3 && (c.length < 4 || c[3] > 0.95)) bg = c.slice(0, 3);
      node = node.parentElement;
    }
    bg = bg || [25, 25, 25];
    const [a, b] = [lum(oc), lum(bg)].sort((x, y) => y - x);
    return {
      outline: `${cs.outlineWidth} ${cs.outlineStyle} ${cs.outlineColor}`,
      ratio: (a + 0.05) / (b + 0.05),
    };
  });
}

async function scrollPastHero(page) {
  await page.evaluate(() => {
    const lede = document.querySelector('main .lede');
    const past = lede.getBoundingClientRect().bottom + window.scrollY + 20;
    const actions = document.getElementById('conference-actions');
    const actionsTop = actions.getBoundingClientRect().top + window.scrollY;
    const beforeJoin = actionsTop - window.innerHeight * 0.45 - 24;
    window.scrollTo(0, Math.max(0, Math.min(past, beforeJoin)));
  });
}

test('dark header controls show a light focus ring at 360 and on desktop', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto('http://site.test/conferences/');
  await page.locator('a.skip').focus();
  await page.keyboard.press('Tab');
  const mark = page.locator('a.chrome-mark');
  await expect(mark).toBeFocused();
  const markRing = await ringContrast(mark);
  expect(markRing.outline).toBe('2px solid rgb(143, 199, 255)');
  expect(markRing.ratio).toBeGreaterThanOrEqual(3);

  await page.keyboard.press('Tab');
  const summary = page.locator('#chrome-menu summary');
  await expect(summary).toBeFocused();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  const method = page.locator('#chrome-menu nav a').first();
  await expect(method).toBeFocused();
  await expect(method).toHaveText('Method');
  const linkRing = await ringContrast(method);
  expect(linkRing.outline).toBe('2px solid rgb(143, 199, 255)');
  expect(linkRing.ratio).toBeGreaterThanOrEqual(3);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.keyboard.press('Escape');
  await page.locator('a.skip').focus();
  await page.keyboard.press('Tab');
  await expect(mark).toBeFocused();
  const deskRing = await ringContrast(mark);
  expect(deskRing.outline).toBe('2px solid rgb(143, 199, 255)');
  expect(deskRing.ratio).toBeGreaterThanOrEqual(3);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
});

test('Start stays white, and readable, when the pointer is over it', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const size of [{ width: 360, height: 740 }, { width: 1280, height: 800 }]) {
    await page.setViewportSize(size);
    await page.goto('http://site.test/conferences/');
    const start = page.locator('#conference-start');
    await start.hover();
    await expect(start).toHaveCSS('color', 'rgb(255, 255, 255)');
    expect(await contrastOf(start)).toBeGreaterThanOrEqual(4.5);
    const join = page.locator('#conference-join');
    await join.hover();
    expect(await contrastOf(join)).toBeGreaterThanOrEqual(4.5);
  }
});

test('the guest link has a name and Select All stays inside it', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto('http://site.test/conferences/');
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, writable: true, value: undefined });
  });
  await page.locator('#conference-invite').click();
  const field = page.locator('#conference-invite-link');
  await expect(field).toBeVisible();
  await expect(field).toBeFocused();
  await expect(field).toHaveAccessibleName('Converspan room link');
  await expect(field).toHaveAttribute('aria-readonly', 'true');
  const selected = () => page.evaluate(() => (window.getSelection() ? window.getSelection().toString() : ''));
  expect(await selected()).toBe(ROOM);

  await page.evaluate(() => {
    const range = document.createRange();
    range.selectNodeContents(document.body);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  });
  await page.keyboard.press('Control+a');
  expect(await selected()).toBe(ROOM);

  await page.keyboard.press('Tab');
  await expect(field).not.toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(field).toBeFocused();
  expect(await selected()).toBe(ROOM);
  await expect(page.locator(`a[href="${ROOM}"]`)).toHaveCount(2);
  await expect(page.locator('.chrome-disclaimer')).toContainText('not affiliated with, endorsed by, or sponsored by Salesforce');
});

test('the mobile guide is reachable from the header while it is showing', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto('http://site.test/conferences/');
  const bar = page.locator('#conference-flow');
  await page.locator('a.skip').focus();
  await page.keyboard.press('Tab');
  await expect(page.locator('a.chrome-mark')).toBeFocused();
  await scrollPastHero(page);
  await expect(bar).toHaveClass(/\bis-on\b/);
  await expect(bar).not.toHaveAttribute('inert');
  await page.keyboard.press('Tab');
  await expect(page.locator('#chrome-menu summary')).toBeFocused();
  await page.keyboard.press('Tab');
  const go = page.locator('.flowbar-go');
  await expect(go).toBeFocused();
  await expect(go).toHaveAccessibleName('Go to Start');
  await expect(go).toHaveText('Start');
  await page.keyboard.press('Enter');
  const actions = page.locator('#conference-actions');
  await expect(actions).toBeFocused();
  await expect(actions).toHaveAccessibleName('Start or join');
  await expect(page.locator('#conference-start')).toBeInViewport();
  await expect(page.locator(`a[href="${ROOM}"]`)).toHaveCount(2);
});

test('reduced motion is still, and live regions stay polite', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto('http://site.test/conferences/');
  await page.locator('#conference-stage').scrollIntoViewIfNeeded();
  await page.locator('#conference-recap').scrollIntoViewIfNeeded();
  await page.locator('#conference-ready').scrollIntoViewIfNeeded();
  await expect(page.locator('#conference-ready')).toHaveClass(/is-in/);
  const running = await page.evaluate(() => {
    const names = [];
    document.querySelectorAll('body *').forEach((el) => {
      if (!el.getAnimations) return;
      el.getAnimations().forEach((anim) => {
        if (anim.playState === 'running') names.push(anim.animationName || 'transition');
      });
    });
    return names;
  });
  expect(running).toEqual([]);
  expect(await contrastOf(page.locator('.aim-label').first())).toBeGreaterThanOrEqual(4.5);
  await expect(page.locator('#conference-recap')).toHaveAttribute('role', 'img');
  await expect(page.locator('#conference-recap .recap-in')).toHaveAttribute('aria-hidden', 'true');
  await expect(page.locator('#conference-stage .web')).toHaveAttribute('aria-hidden', 'true');
  await expect(page.locator('#conference-stage .orb')).toHaveAttribute('aria-hidden', 'true');
  const live = await page.locator('main [aria-live], main [role="status"]').evaluateAll((els) => els.map((el) => ({
    id: el.id || el.className,
    live: el.getAttribute('aria-live') || (el.getAttribute('role') === 'status' ? 'polite' : ''),
  })));
  expect(live).toEqual([
    { id: 'conference-lobby-status', live: 'polite' },
    { id: 'conference-goals-live', live: 'polite' },
    { id: 'conference-invite-toast', live: 'polite' },
    { id: 'ready-list', live: 'polite' },
  ]);
  await expect(page.locator('#conference-lobby-status')).toHaveText('Waiting for your host');
  const clockLive = await page.locator('#conference-lobby .lobby-clock').evaluate((el) => {
    let node = el;
    while (node && node !== document.body) {
      if (node.getAttribute('aria-live') || node.getAttribute('role') === 'status') return true;
      node = node.parentElement;
    }
    return false;
  });
  expect(clockLive).toBe(false);
  await expect(page.locator('.chrome-disclaimer')).toContainText('not affiliated with, endorsed by, or sponsored by Salesforce');
});
