// Controls a visitor must read, and regions a keyboard user must scroll.
// Found on 2026-09-24 with axe on www: the intake "Submit request" label was
// #04120C on the ink button (1.08:1) - the site accent became ink and the old
// near-black text stayed (the same bug /voice/ fixed on 2026-09-18) - and the
// intake payload preview and the Method speed log scrolled but could not be
// reached by keyboard.
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
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
    const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json' };
    return route.fulfill({ body: fs.readFileSync(file), contentType: types[path.extname(file)] || 'application/octet-stream' });
  });
});

// WCAG contrast of an element's text against the first opaque background
// behind it, as the browser computed them.
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
    const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x);
    return (a + 0.05) / (b + 0.05);
  });
}

test('the intake Submit label is readable, enabled or not', async ({ page }) => {
  await page.goto('http://site.test/intake/');
  const label = page.locator('#submitBtn');
  await expect(label).toBeVisible();
  // Disabled uses opacity .6; the ratio is on the colours, so check both states.
  expect(await contrast(label), 'Submit label contrast').toBeGreaterThanOrEqual(4.5);
  const span = label.locator('span').first();
  if (await span.count()) expect(await contrast(span), 'Submit label span contrast').toBeGreaterThanOrEqual(4.5);
});

// No script sets .done-s today; the rule is kept readable in case one does.
test('a completed intake step keeps its number readable', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('http://site.test/intake/');
  const node = page.locator('.stage .node').first();
  await node.evaluate((el) => el.closest('.stage').classList.add('done-s'));
  await page.waitForTimeout(400); // the node's colours transition over .3s
  expect(await contrast(node)).toBeGreaterThanOrEqual(4.5);
});

test('the intake payload preview can be reached and scrolled by keyboard', async ({ page }) => {
  await page.goto('http://site.test/intake/');
  const view = page.locator('#payloadView');
  await expect(view).toHaveAttribute('tabindex', '0');
  await expect(view).toHaveAttribute('aria-label', /payload/i);
});

test('the Method speed log can be reached and scrolled by keyboard', async ({ page }) => {
  await page.goto('http://site.test/method/');
  const log = page.locator('.speed-log');
  await expect(log).toBeAttached({ timeout: 10000 });
  await expect(log).toHaveAttribute('tabindex', '0');
  await expect(log).toHaveAttribute('aria-label', /log/i);
});

// /org/ names each agent in its own colour. axe on www: Codex's amber was
// 3.72:1 and grok's grey 3.22:1 on white. Every agent colour must read.
test('every agent name on /org/ is readable', async ({ page }) => {
  await page.goto('http://site.test/org/');
  const who = page.locator('.say .who');
  await expect(who.first()).toBeVisible({ timeout: 10000 });
  // Render one label per agent colour, whether or not the snapshot has a
  // line from that agent today.
  const labels = await page.evaluate(() => {
    const host = document.querySelector('.say');
    return ['claude', 'codex', 'foundry', 'gemini', 'grok'].map((name) => {
      const el = document.createElement('span');
      el.className = 'who ' + name;
      el.textContent = name;
      host.appendChild(el);
      return name;
    });
  });
  for (const name of labels) {
    const el = page.locator('.say .who.' + name).last();
    expect(await contrast(el), name + ' label contrast').toBeGreaterThanOrEqual(4.5);
  }
});
