// Keyboard path and axe on /conferences/. axe is injected from node_modules
// against this static server. The page itself does not load it.
const { test, expect } = require('@playwright/test');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const ROOM = 'https://sfdc24.com/conferences/room/';
const STAGE = 'SFDC24 room. Objectives: Open the brief, Mark the aim, Draw the path.';
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

let server;
let base;

test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    let rel = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.resolve(root, '.' + rel);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404);
      res.end('');
      return;
    }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'text/plain' });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

async function openConferences(page, size, motion) {
  await page.setViewportSize(size);
  await page.emulateMedia({ reducedMotion: motion });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      writable: true,
      value: undefined,
    });
    document.addEventListener('click', (event) => {
      const link = event.target && event.target.closest && event.target.closest('a[href]');
      if (!link) return;
      const href = link.getAttribute('href') || '';
      if (href.indexOf('sfdc24.com/conferences/room') !== -1) event.preventDefault();
    }, true);
  });
  await page.goto(base + '/conferences/', { waitUntil: 'load' });
}

async function axeViolations(page) {
  await page.addScriptTag({ path: require.resolve('axe-core') });
  return page.evaluate(async () => {
    const result = await window.axe.run(document, { resultTypes: ['violations'] });
    return result.violations.map((item) => ({
      id: item.id,
      impact: item.impact,
      nodes: item.nodes.length,
      target: item.nodes[0] ? item.nodes[0].target.join(' ') : '',
    }));
  });
}

async function obscured(page) {
  return page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body || el === document.documentElement) return '';
    const rect = el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return '';
    const name = (el.getAttribute('aria-label') || el.innerText || el.id || el.tagName || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 48);
    const hits = [];
    for (const id of ['conference-flow']) {
      const bar = document.getElementById(id);
      if (!bar || !bar.classList.contains('is-on') || bar.contains(el)) continue;
      const box = bar.getBoundingClientRect();
      if (box.height < 2) continue;
      const overlap = Math.min(rect.bottom, box.bottom) - Math.max(rect.top, box.top);
      if (overlap > 1 && rect.right > box.left && rect.left < box.right) hits.push(id);
    }
    return hits.length ? name + ' under ' + hits.join(' ') : '';
  });
}

async function scrollPastChooser(page) {
  await expect(page.locator('#conference-flow')).toHaveAttribute('data-watching', '1');
  await page.waitForFunction(() => {
    const height = document.documentElement.scrollHeight;
    if (window.__flowHeight === height) return true;
    window.__flowHeight = height;
    return false;
  }, null, { polling: 80, timeout: 2000 });
  await page.evaluate(() => {
    const actions = document.getElementById('conference-actions');
    const edge = actions.getBoundingClientRect().bottom + window.scrollY + Math.round(window.innerHeight * 0.35);
    const note = document.querySelector('.chrome-disclaimer');
    const limit = note ? note.getBoundingClientRect().top + window.scrollY - window.innerHeight : edge;
    window.scrollTo(0, Math.max(0, Math.min(edge, limit)));
  });
  await expect(page.locator('#conference-flow')).toHaveClass(/\bis-on\b/);
}

async function tabUntil(page, selector) {
  for (let i = 0; i < 40; i++) {
    if (await page.locator(selector).evaluate((el) => el === document.activeElement)) return;
    expect(await obscured(page)).toBe('');
    await page.keyboard.press('Tab');
  }
  throw new Error('Tab never reached ' + selector);
}

test('axe reports no serious or critical violations on /conferences/', async ({ page }) => {
  const sizes = [{ width: 390, height: 844 }, { width: 1280, height: 800 }];
  for (const size of sizes) {
    for (const motion of ['reduce', 'no-preference']) {
      await openConferences(page, size, motion);
      const found = await axeViolations(page);
      const blocked = found.filter((item) => item.impact === 'serious' || item.impact === 'critical');
      expect(blocked, `${size.width}x${size.height} ${motion}`).toEqual([]);
      expect(found, `${size.width}x${size.height} ${motion}`).toEqual([]);
    }
  }
});

test('keyboard runs Host, Join, invite, and the questions at 390 and 1280', async ({ page }) => {
  for (const size of [{ width: 390, height: 844 }, { width: 1280, height: 800 }]) {
    await openConferences(page, size, 'reduce');
    await expect(page.locator('#conference-stage')).toHaveRole('img');
    await expect(page.locator('#conference-stage')).toHaveAttribute('aria-label', STAGE);
    const stageTree = await page.locator('#conference-stage').ariaSnapshot();
    expect(stageTree).toContain('SFDC24 room');
    expect(stageTree).not.toContain('listitem');

    await page.locator('a.skip').focus();
    await tabUntil(page, '#conference-start');
    const start = page.locator('#conference-start');
    await expect(start).toBeFocused();
    await expect(start).toHaveAccessibleName('Host Open the room. Start');
    await expect(start).toHaveAttribute('href', ROOM);
    const startRing = await start.evaluate((el) => ({
      on: el.matches(':focus-visible'),
      outline: getComputedStyle(el).outline,
      shadow: getComputedStyle(el).boxShadow,
    }));
    expect(startRing.on).toBe(true);
    expect(startRing.outline).toBe('rgb(143, 199, 255) solid 2px');
    expect(startRing.shadow).toContain('rgb(143, 199, 255)');
    expect(startRing.shadow).toContain('rgb(6, 16, 24)');
    expect(await obscured(page)).toBe('');
    await page.keyboard.press('Enter');
    await expect(start).toBeFocused();
    expect(page.url()).not.toContain('sfdc24.com/conferences/room');

    await page.keyboard.press('Tab');
    const join = page.locator('#conference-join');
    await expect(join).toBeFocused();
    await expect(join).toHaveAccessibleName('Join Enter the room. Join');
    await expect(join).toHaveAttribute('href', ROOM);
    expect(await join.evaluate((el) => el.matches(':focus-visible'))).toBe(true);
    expect(await obscured(page)).toBe('');
    await page.keyboard.press('Enter');
    await expect(join).toBeFocused();

    await start.click();
    await expect(start).toBeFocused();
    expect(await start.evaluate((el) => el.matches(':focus-visible'))).toBe(false);
    const rested = await start.evaluate((el) => getComputedStyle(el).outlineStyle);
    expect(rested).toBe('none');

    await page.locator('#conference-invite').focus();
    await page.keyboard.press('Enter');
    const field = page.locator('#conference-invite-link');
    await expect(field).toBeFocused();
    await expect(field).toHaveAccessibleName('SFDC24 room link');
    await page.keyboard.press('Tab');
    await expect(field).not.toBeFocused();
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false);
    await page.keyboard.press('Shift+Tab');
    await expect(field).toBeFocused();

    await tabUntil(page, '#conference-faq-q1');
    await page.keyboard.press('Enter');
    await expect(page.locator('#conference-faq-q1')).toBeFocused();
    await expect(page.locator('#conference-faq-q1')).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('#conference-faq-a1')).toContainText('The SFDC24 room.');
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('#conference-faq-q2')).toBeFocused();
    await expect(page.locator('#conference-faq-q2')).toHaveAttribute('aria-expanded', 'false');
    await page.keyboard.press(' ');
    await expect(page.locator('#conference-faq-q2')).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('#conference-faq-q1')).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('#conference-faq-q2')).toBeFocused();
    expect(await obscured(page)).toBe('');

    await page.locator('a.skip').focus();
    const covered = [];
    for (let i = 0; i < 24; i++) {
      await page.keyboard.press('Tab');
      const problem = await obscured(page);
      if (problem) covered.push(problem);
      const done = await page.evaluate(() => (document.activeElement.innerText || '').indexOf('abdus@sfdc24.com') !== -1);
      if (done) break;
    }
    expect(covered).toEqual([]);
    await expect(page.locator('.chrome-disclaimer')).toContainText('not affiliated with, endorsed by, or sponsored by Salesforce');
  }
});

test('the guide button keeps a luminous ring and stays clear at 390x844', async ({ page }) => {
  await openConferences(page, { width: 390, height: 844 }, 'reduce');
  await expect(page.locator('#conference-dock')).toHaveCount(0);
  await scrollPastChooser(page);
  const go = page.locator('.flowbar-go');
  await expect(go).toBeVisible();
  const before = await go.evaluate((el) => getComputedStyle(el).boxShadow);
  expect(before).toContain('rgba(143, 199, 255, 0.65)');
  expect(before).not.toContain('rgb(6, 16, 24)');

  await page.locator('a.skip').focus();
  await page.keyboard.press('Tab');
  await expect(page.locator('a.chrome-mark')).toBeFocused();
  await scrollPastChooser(page);
  await expect(go).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(page.locator('#chrome-menu summary')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(go).toBeFocused();
  expect(await go.evaluate((el) => el.matches(':focus-visible'))).toBe(true);
  await expect(go).toHaveAccessibleName('Go to Start');
  const ring = await go.evaluate((el) => ({
    on: el.matches(':focus-visible'),
    outline: getComputedStyle(el).outline,
    shadow: getComputedStyle(el).boxShadow,
  }));
  expect(ring.on).toBe(true);
  expect(ring.outline).toBe('rgb(143, 199, 255) solid 2px');
  expect(ring.shadow).toContain('rgb(6, 16, 24)');
  expect(await obscured(page)).toBe('');
  await page.keyboard.press('Tab');
  await expect(page.locator('#conference-start')).toBeFocused();
  expect(await obscured(page)).toBe('');
  await expect(page.locator(`a[href="${ROOM}"]`)).toHaveCount(2);
});
