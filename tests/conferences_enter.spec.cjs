// A plain click or Enter on a room link plays a short sweep, then leaves.
// Modified clicks, reduced motion, and no JavaScript go straight to the room.
// Navigation is intercepted here. Nothing in this file contacts converspan.com.
const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const ROOM = 'https://converspan.com/room';
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function serve(route) {
  const url = new URL(route.request().url());
  if (url.origin === 'https://converspan.com') {
    return route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>room</title></head><body></body></html>',
    });
  }
  if (url.origin !== 'http://site.test') return route.abort();
  let rel = decodeURIComponent(url.pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.resolve(root, '.' + rel);
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    return route.fulfill({ status: 404, body: '' });
  }
  return route.fulfill({
    body: fs.readFileSync(file),
    contentType: types[path.extname(file)] || 'text/plain',
  });
}

async function openConferences(page, motion) {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: motion });
  await page.goto('http://site.test/conferences/', { waitUntil: 'load' });
  await expect(page.locator('#conference-start')).toHaveAttribute('href', ROOM);
  await expect(page.locator('#conference-join')).toHaveAttribute('href', ROOM);
  await expect(page.locator(`a[href="${ROOM}"]`)).toHaveCount(2);
  if (motion === 'no-preference') {
    await page.waitForFunction(() => {
      const veil = document.getElementById('conference-enter');
      return getComputedStyle(veil).getPropertyValue('--enter-ready').trim() === '1';
    });
  }
}

async function watchSweep(page) {
  const marks = [];
  page.on('console', (msg) => {
    const text = msg.text();
    if (text.indexOf('ENTER ') === 0) marks.push(JSON.parse(text.slice(6)));
  });
  await page.evaluate(() => {
    const veil = document.getElementById('conference-enter');
    const note = (kind) => {
      console.log('ENTER ' + JSON.stringify({
        kind: kind,
        on: veil.classList.contains('is-on'),
        aria: veil.getAttribute('aria-hidden'),
        opacity: getComputedStyle(veil).opacity,
        visibility: getComputedStyle(veil).visibility,
      }));
    };
    new MutationObserver(() => {
      if (veil.classList.contains('is-on')) note('on');
    }).observe(veil, { attributes: true, attributeFilter: ['class'] });
    veil.addEventListener('animationend', (event) => {
      if (event.animationName !== 'enter-sweep') return;
      note('end');
      console.log('ENTER ' + JSON.stringify({ kind: 'time', dt: Math.round(event.elapsedTime * 1000) }));
    });
  });
  return marks;
}

test.beforeEach(async ({ context }) => {
  await context.route('**/*', serve);
});

test('a plain click or Enter plays the sweep, then opens the room', async ({ page }) => {
  const steps = [
    {
      name: 'Start click',
      run: (opened) => opened.locator('#conference-start').click(),
    },
    {
      name: 'Join Enter',
      run: async (opened) => {
        await opened.locator('#conference-join').focus();
        await opened.keyboard.press('Enter');
      },
    },
  ];
  for (const step of steps) {
    await openConferences(page, 'no-preference');
    const marks = await watchSweep(page);
    const hits = [];
    const onRequest = (req) => {
      if (req.url().startsWith('https://converspan.com')) hits.push(req.url());
    };
    page.on('request', onRequest);
    const started = Date.now();
    await Promise.all([
      page.waitForURL(ROOM),
      step.run(page),
    ]);
    const elapsed = Date.now() - started;
    page.off('request', onRequest);
    await expect.poll(() => marks.filter((mark) => mark.kind === 'end').length).toBe(1);
    const shown = marks.find((mark) => mark.kind === 'on');
    const ended = marks.find((mark) => mark.kind === 'end');
    const timed = marks.find((mark) => mark.kind === 'time');
    expect(shown, step.name).toMatchObject({ on: true, aria: 'true', visibility: 'visible' });
    expect(ended, step.name).toMatchObject({ on: true, aria: 'true' });
    expect(timed.dt, step.name).toBeGreaterThanOrEqual(300);
    expect(timed.dt, step.name).toBeLessThanOrEqual(450);
    expect(elapsed, step.name).toBeLessThanOrEqual(700);
    expect(hits, step.name).toEqual([ROOM]);
    await expect(page).toHaveURL(ROOM);
    await expect(page).toHaveTitle('room');
  }
});

test('modified clicks skip the sweep and still open the room', async ({ page }) => {
  await openConferences(page, 'no-preference');
  const dispatched = await page.evaluate(() => {
    const link = document.getElementById('conference-start');
    const veil = document.getElementById('conference-enter');
    const cases = [
      { ctrlKey: true },
      { metaKey: true },
      { shiftKey: true },
      { altKey: true },
      { button: 1 },
    ];
    return cases.map((extra) => {
      const event = new MouseEvent('click', Object.assign({
        bubbles: true,
        cancelable: true,
        button: 0,
        view: window,
      }, extra));
      return {
        kept: link.dispatchEvent(event),
        on: veil.classList.contains('is-on'),
      };
    });
  });
  for (const result of dispatched) {
    expect(result.kept).toBe(true);
    expect(result.on).toBe(false);
  }

  const real = [
    { name: 'Control', click: { modifiers: ['Control'] }, tab: true },
    { name: 'Meta', click: { modifiers: ['Meta'] }, tab: false },
    { name: 'Shift', click: { modifiers: ['Shift'] }, tab: true },
    { name: 'middle', click: { button: 'middle' }, tab: true },
  ];
  for (const step of real) {
    for (const extra of page.context().pages()) {
      if (extra !== page) await extra.close();
    }
    await openConferences(page, 'no-preference');
    const marks = await watchSweep(page);
    const hits = [];
    const onRequest = (req) => {
      if (req.url() === ROOM) hits.push({ at: Date.now(), type: req.resourceType() });
    };
    page.context().on('request', onRequest);
    const started = Date.now();
    await page.locator('#conference-join').click(step.click);
    expect(marks, step.name).toEqual([]);
    await expect.poll(() => hits.length, { timeout: 1000 }).toBeGreaterThan(0);
    expect(hits[0].type, step.name).toBe('document');
    expect(hits[0].at - started, step.name).toBeLessThan(350);
    page.context().off('request', onRequest);
    if (step.tab) expect(page.url(), step.name).toContain('/conferences/');
  }
});

test('reduced motion skips the sweep and opens the room immediately', async ({ page }) => {
  await openConferences(page, 'reduce');
  const marks = await watchSweep(page);
  const ready = await page.locator('#conference-enter').evaluate((el) => {
    return getComputedStyle(el).getPropertyValue('--enter-ready').trim();
  });
  expect(ready).toBe('');
  const started = Date.now();
  await Promise.all([
    page.waitForURL(ROOM),
    page.locator('#conference-start').click(),
  ]);
  const elapsed = Date.now() - started;
  expect(marks).toEqual([]);
  expect(elapsed).toBeLessThan(350);
  await expect(page).toHaveURL(ROOM);
  await expect(page.locator('#conference-enter')).toHaveCount(0);
});

test('without JavaScript the room link navigates immediately', async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await context.route('**/*', serve);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('http://site.test/conferences/', { waitUntil: 'load' });
  await expect(page.locator('#conference-start')).toHaveAttribute('href', ROOM);
  await expect(page.locator('#conference-enter')).toHaveAttribute('aria-hidden', 'true');
  const started = Date.now();
  await Promise.all([
    page.waitForURL(ROOM),
    page.locator('#conference-start').click(),
  ]);
  expect(Date.now() - started).toBeLessThan(350);
  await expect(page).toHaveURL(ROOM);
  await context.close();
});

test('the sweep stays decorative and the keyboard path is unchanged', async ({ page }) => {
  await openConferences(page, 'no-preference');
  const veil = page.locator('#conference-enter');
  await expect(veil).toHaveAttribute('aria-hidden', 'true');
  await expect(veil).toHaveCount(1);
  expect(await veil.getAttribute('tabindex')).toBeNull();
  await expect(veil).toBeHidden();
  await expect(page.locator('#conference-start')).toHaveAccessibleName('Host Open the room. Start');
  await expect(page.locator('#conference-join')).toHaveAccessibleName('Join Enter the room. Join');
  await page.locator('#conference-start').focus();
  await expect(page.locator('#conference-start')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.locator('#conference-join')).toBeFocused();
  expect(await page.evaluate(() => document.activeElement.id)).not.toBe('conference-enter');
  await expect(page.locator('.chrome-disclaimer')).toContainText('not affiliated with, endorsed by, or sponsored by Salesforce');
  const blocked = await page.evaluate(() => {
    const link = document.getElementById('conference-enter');
    const style = getComputedStyle(link);
    return style.position === 'fixed' && style.visibility === 'hidden';
  });
  expect(blocked).toBe(true);
});
