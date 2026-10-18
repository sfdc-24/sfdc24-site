// /conferences/ shows the handoff in three steps: start or join, the room
// opens, the summary comes after. The sequence plays once on scroll.
// Reduced motion leaves the steps still. The page still has no microphone.
const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const ROOM = 'https://converspan.com/room';
const PHONES = [
  { width: 390, height: 844 },
  { width: 375, height: 667 },
];

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.__srBuilt = 0;
    window.__srStarts = 0;
    class Rec {
      constructor() { window.__srBuilt += 1; }
      start() { window.__srStarts += 1; }
      stop() {}
      abort() {}
    }
    window.SpeechRecognition = Rec;
    window.webkitSpeechRecognition = Rec;
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

async function settled(page) {
  const steps = page.locator('#conference-how .step');
  await expect(steps).toHaveCount(3);
  await steps.nth(2).evaluate(async (el) => {
    const pending = el.getAnimations().map((a) => a.finished);
    if (pending.length) await Promise.all(pending);
  });
}

test('the three-step visual renders and Start and Join stay on the room', async ({ page }) => {
  await page.setViewportSize(PHONES[0]);
  await page.goto('http://site.test/conferences/');
  const how = page.locator('#conference-how');
  await expect(how).toHaveAttribute('aria-label', 'How a conference works');
  await expect(how).toHaveClass(/is-in/);
  const steps = how.locator('.step');
  await settled(page);
  await expect(steps.nth(0)).toContainText('Start or join');
  await expect(steps.nth(1)).toContainText('Room opens');
  await expect(steps.nth(2)).toContainText('Summary after');
  await expect(how.locator('.glyph svg')).toHaveCount(3);
  for (const step of [0, 1, 2]) await expect(steps.nth(step).locator('.label')).toBeVisible();
  await expect(page.locator('#conference-start')).toHaveAttribute('href', ROOM);
  await expect(page.locator('#conference-join')).toHaveAttribute('href', ROOM);
  await expect(page.locator(`a[href="${ROOM}"]`)).toHaveCount(2);
  await expect(page.locator('.consent')).toContainText('PIPEDA and the CRTC require that consent');
  await expect(page.locator('.consent')).toContainText('This page has no microphone and does not take a transcript.');
  await expect(page.locator('.note')).toContainText('does not send a name or a company');
  await expect(page.getByText('Start and Join both open the Converspan room.')).toHaveCount(0);
  await expect(page.locator('#chrome-mic')).toHaveCount(0);
  await expect(page.locator('#chrome-ask, #chrome-ask-shell, #chrome-box')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /ask out loud|listening/i })).toHaveCount(0);
  expect(await page.evaluate(() => window.__srBuilt)).toBe(0);
  expect(await page.evaluate(() => window.__srStarts)).toBe(0);
  expect(await page.locator('body').innerHTML()).not.toMatch(/tel:/i);
  await expect(page.locator('.chrome-disclaimer')).toContainText('not affiliated with, endorsed by, or sponsored by Salesforce');
});

test('reduced motion shows the steps statically', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize(PHONES[1]);
  await page.goto('http://site.test/conferences/');
  const steps = page.locator('#conference-how .step');
  await expect(steps).toHaveCount(3);
  await expect(steps.nth(0)).toBeVisible();
  await expect(steps.nth(1)).toBeVisible();
  await expect(steps.nth(2)).toBeVisible();
  const motion = await steps.evaluateAll((els) => els.map((el) => {
    const s = getComputedStyle(el);
    return { name: s.animationName, opacity: s.opacity, transform: s.transform };
  }));
  for (const step of motion) {
    expect(step.name).toBe('none');
    expect(step.opacity).toBe('1');
    expect(['none', 'matrix(1, 0, 0, 1, 0, 0)']).toContain(step.transform);
  }
  const line = await page.locator('#conference-how').evaluate((el) => {
    const s = getComputedStyle(el, '::before');
    return { name: s.animationName, transform: s.transform };
  });
  expect(line.name).toBe('none');
  expect(['none', 'matrix(1, 0, 0, 1, 0, 0)']).toContain(line.transform);
  expect(await page.evaluate(() => window.__srStarts)).toBe(0);
  await expect(page.locator('#chrome-mic')).toHaveCount(0);
});

test('the sequence plays once when the steps scroll into view', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.setViewportSize({ width: 390, height: 120 });
  await page.goto('http://site.test/conferences/');
  const how = page.locator('#conference-how');
  await page.waitForTimeout(250);
  expect(await how.getAttribute('class') || '').not.toContain('is-in');
  await how.evaluate((el) => {
    window.__howStarts = 0;
    el.addEventListener('animationstart', (event) => {
      if (event.animationName === 'how-in' || event.animationName === 'how-line') window.__howStarts += 1;
    }, true);
  });
  await how.scrollIntoViewIfNeeded();
  await expect(how).toHaveClass(/is-in/);
  await page.waitForTimeout(900);
  expect(await page.evaluate(() => window.__howStarts)).toBe(4);
  const running = await how.locator('.step').nth(2).evaluate((el) => {
    const anim = el.getAnimations().find((a) => a.animationName === 'how-in');
    return anim ? { count: anim.effect.getTiming().iterations, state: anim.playState } : null;
  });
  expect(running.count).toBe(1);
  expect(running.state).toBe('finished');
  await page.evaluate(() => window.scrollTo(0, 0));
  await how.scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  expect(await page.evaluate(() => window.__howStarts)).toBe(4);
});

for (const phone of PHONES) {
  test(`phone layout at ${phone.width}x${phone.height} keeps the steps, the room links, and the mic off`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize(phone);
    await page.goto('http://site.test/conferences/');
    const how = page.locator('#conference-how');
    await expect(how).toBeVisible();
    const steps = how.locator('.step');
    await expect(steps).toHaveCount(3);
    const boxes = await steps.evaluateAll((els) => els.map((el) => {
      const r = el.getBoundingClientRect();
      const label = el.querySelector('.label');
      const glyph = el.querySelector('.glyph');
      const g = glyph.getBoundingClientRect();
      const lr = label.getBoundingClientRect();
      return {
        x: r.x, y: r.y, w: r.width, h: r.height,
        text: label.textContent,
        labelCut: label.scrollWidth > label.clientWidth + 1,
        labelPast: lr.right > r.right + 1 || lr.left < r.left - 1,
        gw: g.width, gh: g.height,
      };
    }));
    expect(Math.max(...boxes.map((b) => b.y)) - Math.min(...boxes.map((b) => b.y))).toBeLessThanOrEqual(2);
    for (const box of boxes) {
      expect(box.x).toBeGreaterThanOrEqual(-1);
      expect(box.x + box.w).toBeLessThanOrEqual(phone.width + 1);
      expect(box.labelCut, box.text).toBe(false);
      expect(box.labelPast, box.text).toBe(false);
      expect(box.gw).toBeGreaterThanOrEqual(48);
      expect(box.gh).toBeGreaterThanOrEqual(48);
    }
    expect(boxes[0].x).toBeLessThan(boxes[1].x);
    expect(boxes[1].x).toBeLessThan(boxes[2].x);
    for (const id of ['#conference-start', '#conference-join']) {
      const button = await page.locator(id).boundingBox();
      expect(button.height).toBeGreaterThanOrEqual(48);
      expect(button.width).toBeGreaterThanOrEqual(48);
      await expect(page.locator(id)).toHaveAttribute('href', ROOM);
    }
    const sideways = await page.evaluate(() => {
      const el = document.scrollingElement || document.documentElement;
      return el.scrollWidth - el.clientWidth;
    });
    expect(sideways).toBeLessThanOrEqual(0);
    await expect(page.locator('#chrome-mic')).toHaveCount(0);
    await expect(page.locator('#chrome-ask, #chrome-ask-shell')).toHaveCount(0);
    expect(await page.locator('body').innerHTML()).not.toMatch(/tel:/i);
  });
}
