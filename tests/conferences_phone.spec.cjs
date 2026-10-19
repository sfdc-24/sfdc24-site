// /conferences/ at phone widths: no sideways scroll, and the sticky header
// and the fixed guide bar stay off the Host and Join controls.
const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const PHONES = [
  { name: '320', width: 320, height: 568 },
  { name: '360', width: 360, height: 800 },
  { name: '375', width: 375, height: 812 },
  { name: '390', width: 390, height: 844 },
  { name: '414', width: 414, height: 896 },
  { name: '430', width: 430, height: 932 },
  { name: '390 landscape', width: 844, height: 390 },
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

function layout() {
  function box(el) {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, r: r.right, b: r.bottom, w: r.width, h: r.height };
  }
  function overlap(a, b) {
    if (!a || !b || a.w < 1 || a.h < 1 || b.w < 1 || b.h < 1) return 0;
    const x = Math.min(a.r, b.r) - Math.max(a.x, b.x);
    const y = Math.min(a.b, b.b) - Math.max(a.y, b.y);
    return x > 1 && y > 1 ? Math.round(y) : 0;
  }
  const headerEl = document.querySelector('header.masthead');
  const flow = document.getElementById('conference-flow');
  const start = document.getElementById('conference-start');
  const join = document.getElementById('conference-join');
  const header = box(headerEl);
  const flowOn = !!(flow && flow.classList.contains('is-on') && getComputedStyle(flow).visibility !== 'hidden');
  const flowBox = flowOn ? box(flow) : null;
  const startBox = box(start);
  const joinBox = box(join);
  return {
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    header,
    flowOn,
    start: startBox,
    join: joinBox,
    coverStart: overlap(header, startBox) + (flowBox ? overlap(flowBox, startBox) : 0),
    coverJoin: overlap(header, joinBox) + (flowBox ? overlap(flowBox, joinBox) : 0),
  };
}

async function jumpToActions(page) {
  await page.evaluate(() => {
    if (location.hash) {
      history.replaceState(null, '', location.pathname);
    }
    window.scrollTo(0, 0);
  });
  await page.evaluate(() => { location.hash = 'conference-actions'; });
  await page.waitForTimeout(80);
}

for (const phone of PHONES) {
  test(`no sideways scroll and the bars stay off Host and Join at ${phone.name}`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ width: phone.width, height: phone.height });
    await page.goto('http://site.test/conferences/', { waitUntil: 'load' });

    const stops = ['top', 'flow', 'jump', 'bottom'];
    for (const stop of stops) {
      if (stop === 'top') {
        await page.evaluate(() => window.scrollTo(0, 0));
      } else if (stop === 'flow') {
        await page.evaluate(() => {
          const lede = document.querySelector('main .lede');
          const past = lede.getBoundingClientRect().bottom + window.scrollY + 40;
          const actions = document.getElementById('conference-actions');
          const actionsTop = actions.getBoundingClientRect().top + window.scrollY;
          const beforeJoin = actionsTop - window.innerHeight * 0.45 - 24;
          window.scrollTo(0, Math.max(0, Math.min(past, beforeJoin)));
        });
        await page.waitForTimeout(80);
      } else if (stop === 'jump') {
        await jumpToActions(page);
      } else {
        await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
        await page.waitForTimeout(80);
      }
      const box = await page.evaluate(layout);
      expect(box.overflow, `${phone.name} ${stop}`).toBeLessThanOrEqual(0);
      expect(box.coverStart, `${phone.name} ${stop} start`).toBe(0);
      expect(box.coverJoin, `${phone.name} ${stop} join`).toBe(0);
      if (stop === 'jump') {
        expect(box.start.y, `${phone.name} start on screen`).toBeGreaterThanOrEqual(box.header.b - 1);
        expect(box.start.y).toBeLessThan(phone.height);
        expect(box.join.y).toBeGreaterThanOrEqual(box.header.b - 1);
        expect(box.join.y).toBeLessThan(phone.height);
      }
    }
  });
}
