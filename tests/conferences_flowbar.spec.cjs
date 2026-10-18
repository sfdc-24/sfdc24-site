// /conferences/ mobile guide. A bottom bar appears after the hero and
// leaves when Start and Join is on screen. Dots follow the sections.
// In-page anchor only. No room call, no timers.
const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const ROOM = 'https://converspan.com/room';
const PHONES = [
  { width: 390, height: 844 },
  { width: 375, height: 667 },
];
const shotDir = '/opt/cursor/artifacts';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.__flowTimers = [];
    function note(name) {
      var stack = '';
      try { stack = String(new Error().stack || ''); } catch (err) { stack = ''; }
      if (stack.indexOf('flow.js') !== -1) window.__flowTimers.push(name);
    }
    var setTimeoutOrig = window.setTimeout;
    var setIntervalOrig = window.setInterval;
    var rafOrig = window.requestAnimationFrame;
    window.setTimeout = function () { note('setTimeout'); return setTimeoutOrig.apply(this, arguments); };
    window.setInterval = function () { note('setInterval'); return setIntervalOrig.apply(this, arguments); };
    window.requestAnimationFrame = function () { note('requestAnimationFrame'); return rafOrig.apply(this, arguments); };
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
    };
    return route.fulfill({
      body: fs.readFileSync(file),
      contentType: types[path.extname(file)] || 'text/plain',
    });
  });
});

async function layout(page) {
  return page.evaluate(() => ({
    h: document.documentElement.scrollHeight,
    w: document.documentElement.scrollWidth,
    cw: document.documentElement.clientWidth,
    top: document.getElementById('conference-start').offsetTop,
  }));
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

async function align(page, id) {
  await page.evaluate((sectionId) => {
    const el = document.getElementById(sectionId);
    const docTop = el.getBoundingClientRect().top + window.scrollY;
    const line = window.innerHeight * (sectionId === 'conference-actions' ? 0.3 : 0.36);
    window.scrollTo(0, Math.max(0, docTop - line + 8));
  }, id);
}

function contrastOf(locator) {
  return locator.evaluate((el) => {
    const rgb = (s) => (s.match(/[\d.]+/g) || []).map(Number);
    const lum = ([r, g, b]) => {
      const c = [r, g, b].map((v) => {
        v /= 255;
        return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
      });
      return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    };
    const fg = rgb(getComputedStyle(el).color);
    let node = el;
    let bg = null;
    while (node && !bg) {
      const c = rgb(getComputedStyle(node).backgroundColor);
      if (c.length >= 3 && (c.length < 4 || c[3] > 0.95)) bg = c;
      node = node.parentElement;
    }
    bg = bg || [255, 255, 255];
    const [a, b] = [lum(fg.slice(0, 3)), lum(bg.slice(0, 3))].sort((x, y) => y - x);
    return (a + 0.05) / (b + 0.05);
  });
}

for (const phone of PHONES) {
  test(`the bar appears after the hero and hides at Start and Join at ${phone.width}x${phone.height}`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize(phone);
    await page.goto('http://site.test/conferences/');
    const bar = page.locator('#conference-flow');
    const go = bar.locator('.flowbar-go');
    await expect(bar).toHaveAttribute('data-watching', '1');
    await expect(bar).not.toHaveClass(/\bis-on\b/);
    await expect(bar).toHaveAttribute('aria-hidden', 'true');
    await expect(bar).toHaveAttribute('inert', '');
    await expect(page.getByRole('navigation', { name: 'Conferences' })).toHaveCount(0);
    const before = await layout(page);

    await scrollPastHero(page);
    await expect(bar).toHaveClass(/\bis-on\b/);
    await expect(bar).toBeVisible();
    await expect(bar).not.toHaveAttribute('aria-hidden');
    await expect(bar).not.toHaveAttribute('inert');
    await expect(page.getByRole('navigation', { name: 'Conferences' })).toBeVisible();
    await expect(go).toHaveText('Start');
    await expect(go).toHaveAttribute('href', '#conference-actions');
    await expect(page.locator(`a[href="${ROOM}"]`)).toHaveCount(2);
    await expect(page.locator('#conference-start')).toHaveAttribute('href', ROOM);
    await expect(page.locator('#conference-join')).toHaveAttribute('href', ROOM);

    const after = await layout(page);
    expect(after.top).toBe(before.top);
    const hiddenHeight = await page.evaluate(() => {
      const flow = document.getElementById('conference-flow');
      const shown = document.documentElement.scrollHeight;
      flow.style.display = 'none';
      const collapsed = document.documentElement.scrollHeight;
      flow.style.display = '';
      return { shown, collapsed };
    });
    expect(hiddenHeight.shown).toBe(hiddenHeight.collapsed);
    expect(after.w).toBeLessThanOrEqual(after.cw + 1);

    const box = await go.boundingBox();
    expect(box.height).toBeGreaterThanOrEqual(48);
    expect(box.width).toBeGreaterThanOrEqual(48);
    expect(box.x).toBeGreaterThanOrEqual(-1);
    expect(box.x + box.width).toBeLessThanOrEqual(phone.width + 1);
    expect(box.y + box.height).toBeLessThanOrEqual(phone.height - 7);
    expect(await contrastOf(go)).toBeGreaterThanOrEqual(4.5);
    const pad = await bar.locator('.flowbar-in').evaluate((el) => getComputedStyle(el).paddingBottom);
    expect(parseFloat(pad)).toBeGreaterThanOrEqual(8);

    await expect(bar.locator('.flowbar-name')).toHaveText([
      'Start or join',
      'Converspan',
      'Sample recap',
      'Start',
      'Ready to join?',
    ]);
    const story = ['conference-how', 'conference-stage', 'conference-recap'];
    const current = await bar.getAttribute('data-flow-current');
    expect(story).toContain(current);
    const marks = await bar.locator('.flowbar-mark').evaluateAll((els) => els.map((el) => {
      const style = getComputedStyle(el);
      return {
        state: el.parentElement.getAttribute('data-state'),
        for: el.parentElement.getAttribute('data-for'),
        w: Math.round(parseFloat(style.width)),
        h: Math.round(parseFloat(style.height)),
        bg: style.backgroundColor,
        current: el.parentElement.getAttribute('aria-current'),
      };
    }));
    const idx = marks.findIndex((mark) => mark.for === current);
    expect(idx).toBeGreaterThanOrEqual(0);
    marks.forEach((mark, i) => {
      expect(mark.state).toBe(i < idx ? 'done' : (i === idx ? 'current' : 'todo'));
      expect(mark.current).toBe(i === idx ? 'step' : null);
    });
    const currentMark = marks[idx];
    const other = marks[idx === 0 ? 1 : 0];
    expect(currentMark.w).toBeGreaterThan(currentMark.h);
    expect(other.w).toBe(other.h);
    expect(currentMark.bg).not.toBe(other.bg);
    const todo = marks[marks.length - 1];
    expect(todo.bg).toBe('rgba(0, 0, 0, 0)');
    expect(await bar.locator('.flowbar-dots').evaluate((el) => el.style.getPropertyValue('--flow-progress'))).toBe(String(idx / (marks.length - 1)));

    fs.mkdirSync(shotDir, { recursive: true });
    await page.screenshot({ path: path.join(shotDir, `flowbar_${phone.width}x${phone.height}.png`) });

    await align(page, 'conference-actions');
    await expect(bar).not.toHaveClass(/\bis-on\b/);
    await expect(bar).toBeHidden();
    await expect(page.locator('#conference-start')).toBeInViewport();
    const covered = await page.evaluate(() => {
      const start = document.getElementById('conference-start').getBoundingClientRect();
      const x = start.left + start.width / 2;
      const y = start.top + start.height / 2;
      const node = document.elementFromPoint(x, y);
      const flow = document.getElementById('conference-flow');
      return !!(node && flow && (node === flow || flow.contains(node)));
    });
    expect(covered).toBe(false);

    await scrollPastHero(page);
    await expect(bar).toHaveClass(/\bis-on\b/);
    await go.focus();
    await expect(go).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/conferences\/#conference-actions$/);
    await expect(page.locator('#conference-actions')).toBeFocused();
    await expect(page.locator('#conference-start')).toBeInViewport();
    await expect(bar).not.toHaveClass(/\bis-on\b/);
    expect(page.url()).not.toContain('converspan.com');
    await expect(page.locator(`a[href="${ROOM}"]`)).toHaveCount(2);

    await page.evaluate(() => window.scrollTo(0, 0));
    await expect(bar).not.toHaveClass(/\bis-on\b/);
    await page.evaluate(() => document.querySelector('.flowbar-go').focus());
    expect(await page.evaluate(() => document.getElementById('conference-flow').contains(document.activeElement))).toBe(false);
    expect(await page.evaluate(() => window.__flowTimers)).toEqual([]);
  });
}

test('the bar is absent on desktop widths', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const width of [721, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('http://site.test/conferences/');
    const bar = page.locator('#conference-flow');
    await scrollPastHero(page);
    await expect(bar).toBeHidden();
    await expect(bar).not.toHaveClass(/\bis-on\b/);
    expect(await bar.evaluate((el) => getComputedStyle(el).display)).toBe('none');
    await expect(page.locator(`a[href="${ROOM}"]`)).toHaveCount(2);
  }
});

test('the bar is present at the 720 mobile edge', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 720, height: 900 });
  await page.goto('http://site.test/conferences/');
  const bar = page.locator('#conference-flow');
  await scrollPastHero(page);
  await expect(bar).toHaveClass(/\bis-on\b/);
  await expect(bar).toBeVisible();
  const box = await bar.locator('.flowbar-go').boundingBox();
  expect(box.height).toBeGreaterThanOrEqual(48);
  expect(box.width).toBeGreaterThanOrEqual(48);
});

test('reduced motion shows and hides the bar without a slide', async ({ page }) => {
  await page.setViewportSize(PHONES[0]);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('http://site.test/conferences/');
  const bar = page.locator('#conference-flow');
  const inner = bar.locator('.flowbar-in');
  const motion = async () => inner.evaluate((el) => {
    const style = getComputedStyle(el);
    const transform = style.transform;
    let ty = 0;
    const match = /matrix\(([^)]+)\)/.exec(transform);
    if (match) ty = parseFloat(match[1].split(',')[5]);
    return {
      transform,
      ty,
      transition: style.transitionProperty,
      duration: style.transitionDuration,
      animations: el.getAnimations().length + el.parentElement.getAnimations().length,
    };
  });

  await page.evaluate(() => window.scrollTo(0, 80));
  await expect(bar).not.toHaveClass(/\bis-on\b/);
  await expect(bar).not.toHaveClass(/\bis-instant\b/);
  await inner.evaluate(async (el) => {
    await Promise.all(el.getAnimations().map((anim) => anim.finished));
  });
  let frame = await motion();
  expect(frame.ty).toBeGreaterThan(20);
  expect(frame.transition).toContain('transform');
  expect(frame.duration).not.toBe('0s');

  await page.emulateMedia({ reducedMotion: 'reduce' });
  frame = await motion();
  expect(frame.transform).toBe('none');
  expect(frame.duration).toBe('0s');
  expect(frame.animations).toBe(0);

  await scrollPastHero(page);
  await expect(bar).toHaveClass(/\bis-on\b/);
  await expect(bar).toBeVisible();
  frame = await motion();
  expect(frame.transform).toBe('none');
  expect(frame.duration).toBe('0s');
  expect(frame.animations).toBe(0);

  await align(page, 'conference-actions');
  await expect(bar).not.toHaveClass(/\bis-on\b/);
  await expect(bar).toBeHidden();
  frame = await motion();
  expect(frame.transform).toBe('none');
  expect(frame.animations).toBe(0);
  expect(await page.evaluate(() => window.__flowTimers)).toEqual([]);
});

test('pagehide releases observers and pageshow restores them without timers', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize(PHONES[0]);
  await page.goto('http://site.test/conferences/');
  const bar = page.locator('#conference-flow');
  await scrollPastHero(page);
  await expect(bar).toHaveAttribute('data-watching', '1');
  await expect(bar).toHaveClass(/\bis-on\b/);
  const current = await bar.getAttribute('data-flow-current');
  expect(['conference-how', 'conference-stage', 'conference-recap']).toContain(current);

  await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
  });
  await expect(bar).toHaveAttribute('data-watching', '0');
  await align(page, 'conference-actions');
  await expect(bar).toHaveClass(/\bis-on\b/);
  await expect(bar).toHaveAttribute('data-flow-current', current);
  await expect(bar).toHaveAttribute('data-watching', '0');

  await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  });
  await expect(bar).toHaveAttribute('data-watching', '1');
  await expect(bar).not.toHaveClass(/\bis-on\b/);
  await expect(bar).toHaveAttribute('data-flow-current', 'conference-actions');

  await scrollPastHero(page);
  await expect(bar).toHaveClass(/\bis-on\b/);
  await expect(bar).toHaveAttribute('data-flow-current', current);

  await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  });
  await expect(bar).toHaveAttribute('data-watching', '1');
  await expect(bar).toHaveAttribute('data-flow-current', current);
  expect(await page.evaluate(() => window.__flowTimers)).toEqual([]);
  await expect(page.locator(`a[href="${ROOM}"]`)).toHaveCount(2);
});

for (const phone of PHONES) {
  test(`the footer disclaimer stays uncovered at ${phone.width}x${phone.height}`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize(phone);
    await page.goto('http://site.test/conferences/');
    const bar = page.locator('#conference-flow');
    const note = page.locator('.chrome-disclaimer');
    await scrollPastHero(page);
    await expect(bar).toHaveClass(/\bis-on\b/);
    await note.evaluate((el) => {
      const rect = el.getBoundingClientRect();
      window.scrollBy(0, rect.bottom - (window.innerHeight - 24));
    });
    await expect(bar).not.toHaveClass(/\bis-on\b/);
    await expect(bar).toBeHidden();
    await expect(note).toBeVisible();
    await expect(note).toContainText('not affiliated with, endorsed by, or sponsored by Salesforce');
    const hit = await page.evaluate(() => {
      const el = document.querySelector('.chrome-disclaimer');
      const rect = el.getBoundingClientRect();
      const flow = document.getElementById('conference-flow');
      const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
      const xs = [rect.left + 12, (rect.left + rect.right) / 2, rect.right - 12];
      const ys = [rect.top + 8, (rect.top + rect.bottom) / 2, rect.bottom - 8];
      const points = [];
      for (const x of xs) {
        for (const y of ys) {
          points.push([
            clamp(x, 1, window.innerWidth - 2),
            clamp(y, 1, window.innerHeight - 2),
          ]);
        }
      }
      return {
        rect: { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right },
        height: window.innerHeight,
        width: window.innerWidth,
        covered: points.map(([x, y]) => {
          const node = document.elementFromPoint(x, y);
          return !!(node && flow && (node === flow || flow.contains(node)));
        }),
      };
    });
    expect(hit.rect.top).toBeGreaterThanOrEqual(-1);
    expect(hit.rect.bottom).toBeLessThanOrEqual(hit.height + 1);
    expect(hit.rect.left).toBeGreaterThanOrEqual(-1);
    expect(hit.rect.right).toBeLessThanOrEqual(hit.width + 1);
    expect(hit.covered.some(Boolean)).toBe(false);

    const link = page.locator('.meta a');
    await link.evaluate((el) => {
      el.focus();
      const zone = 80;
      const rect = el.getBoundingClientRect();
      const delta = rect.bottom - (window.innerHeight - zone);
      window.scrollBy(0, delta);
    });
    await expect(bar).not.toHaveClass(/\bis-on\b/);
    const linkCovered = await link.evaluate((el) => {
      const rect = el.getBoundingClientRect();
      const node = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      const flow = document.getElementById('conference-flow');
      return !!(node && flow && (node === flow || flow.contains(node)));
    });
    expect(linkCovered).toBe(false);
    expect(await page.evaluate(() => window.__flowTimers)).toEqual([]);
  });
}
