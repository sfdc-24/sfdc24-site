// /conferences/ keeps its loops and decorative motion off until a section
// is on screen, and pauses them again when it leaves or the tab is hidden.
// Reduced motion, and a browser without IntersectionObserver, stay on the
// still frame. The room links do not change.
const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const ROOM = 'https://converspan.com/room';
const PHONES = [
  { width: 390, height: 844 },
  { width: 375, height: 667 },
  { width: 320, height: 700 },
];
const shotDir = '/opt/cursor/artifacts';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const api = { writeText() { return Promise.resolve(); } };
    try {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, writable: true, value: api });
    } catch (err) {}
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
      '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon',
    };
    return route.fulfill({
      body: fs.readFileSync(file),
      contentType: types[path.extname(file)] || 'text/plain',
    });
  });
});

async function playState(locator) {
  return locator.evaluate((el) => getComputedStyle(el).animationPlayState);
}

async function hideTab(page, hidden) {
  await page.evaluate((value) => {
    if (!window.__setTabHidden) {
      const desc = Object.getOwnPropertyDescriptor(Document.prototype, 'hidden');
      if (!desc || desc.configurable === false) throw new Error('document.hidden is not configurable');
      let flag = false;
      Object.defineProperty(Document.prototype, 'hidden', { configurable: true, get: () => flag });
      window.__setTabHidden = (next) => {
        flag = next;
        document.dispatchEvent(new Event('visibilitychange'));
      };
    }
    window.__setTabHidden(value);
  }, hidden);
}

function runningCount(locator) {
  return locator.evaluate((el) => {
    let running = 0;
    const nodes = [el, ...el.querySelectorAll('*')];
    for (const node of nodes) {
      for (const anim of node.getAnimations()) {
        if (anim.playState === 'running') running += 1;
      }
    }
    return running;
  });
}

test('looping room and recap pause offscreen and while the tab is hidden', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.setViewportSize({ width: 390, height: 220 });
  await page.goto('http://site.test/conferences/');
  const stage = page.locator('#conference-stage');
  const recap = page.locator('#conference-recap');
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect.poll(async () => stage.evaluate((el) => el.getBoundingClientRect().top)).toBeGreaterThan(220);
  await expect(stage).toHaveClass(/\bis-armed\b/);
  await expect(stage).not.toHaveClass(/\bis-live\b/);
  expect(await playState(stage.locator('.tick').first())).toBe('paused');
  await expect(recap).not.toHaveClass(/\bis-live\b/);
  expect(await playState(recap.locator('.chip').first())).toBe('paused');

  await stage.scrollIntoViewIfNeeded();
  await expect(stage).toHaveClass(/\bis-live\b/);
  expect(await playState(stage.locator('.edge.draw'))).toBe('running');
  await recap.scrollIntoViewIfNeeded();
  await expect(recap).toHaveClass(/\bis-live\b/);
  expect(await playState(recap.locator('.done'))).toBe('running');

  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(stage).not.toHaveClass(/\bis-live\b/);
  expect(await playState(stage.locator('.tick').first())).toBe('paused');
  await expect(recap).not.toHaveClass(/\bis-live\b/);
  expect(await playState(recap.locator('.chip').first())).toBe('paused');

  await stage.scrollIntoViewIfNeeded();
  await expect(stage).toHaveClass(/\bis-live\b/);
  await hideTab(page, true);
  await expect(stage).not.toHaveClass(/\bis-live\b/);
  expect(await playState(stage.locator('.core'))).toBe('paused');
  await hideTab(page, false);
  await expect(stage).toHaveClass(/\bis-live\b/);
  expect(await playState(stage.locator('.core'))).toBe('running');
  await expect(page.locator('#conference-start')).toHaveAttribute('href', ROOM);
  await expect(page.locator('#conference-join')).toHaveAttribute('href', ROOM);
});

test('the step sequence and the ready row pause offscreen and while hidden', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.setViewportSize({ width: 390, height: 140 });
  await page.goto('http://site.test/conferences/');
  const how = page.locator('#conference-how');
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect.poll(async () => how.evaluate((el) => el.getBoundingClientRect().top)).toBeGreaterThan(140);
  await expect(how).not.toHaveClass(/\bis-in\b/);

  await how.evaluate((el) => {
    window.__howStarts = 0;
    el.addEventListener('animationstart', (event) => {
      if (event.animationName === 'how-in' || event.animationName === 'how-line') window.__howStarts += 1;
    }, true);
  });
  await how.scrollIntoViewIfNeeded();
  await expect(how).toHaveClass(/\bis-in\b/);
  await expect(how).not.toHaveClass(/\bis-held\b/);
  await expect.poll(async () => page.evaluate(() => window.__howStarts)).toBe(4);
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(how).toHaveClass(/\bis-held\b/);
  expect(await playState(how.locator('.step').first())).toBe('paused');
  await how.scrollIntoViewIfNeeded();
  await expect(how).not.toHaveClass(/\bis-held\b/);
  expect(await page.evaluate(() => window.__howStarts)).toBe(4);

  await hideTab(page, true);
  await expect(how).toHaveClass(/\bis-held\b/);
  expect(await runningCount(how)).toBe(0);
  await hideTab(page, false);
  await expect(how).not.toHaveClass(/\bis-held\b/);

  await page.setViewportSize({ width: 390, height: 220 });
  const ready = page.locator('#conference-ready');
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(ready).not.toHaveClass(/\bis-in\b/);
  await ready.evaluate((el) => {
    window.__readyStarts = 0;
    el.addEventListener('animationstart', (event) => {
      if (event.animationName === 'ready-lit') window.__readyStarts += 1;
    }, true);
  });
  await ready.scrollIntoViewIfNeeded();
  await expect(ready).toHaveClass(/\bis-in\b/);
  await expect(ready).not.toHaveClass(/\bis-held\b/);
  await expect.poll(async () => page.evaluate(() => window.__readyStarts)).toBe(5);
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(ready).toHaveClass(/\bis-held\b/);
  expect(await playState(ready.locator('.ready-chip').nth(4))).toBe('paused');
  await ready.scrollIntoViewIfNeeded();
  await expect(ready).not.toHaveClass(/\bis-held\b/);
  expect(await page.evaluate(() => window.__readyStarts)).toBe(5);
  await hideTab(page, true);
  await expect(ready).toHaveClass(/\bis-held\b/);
  expect(await playState(ready.locator('.ready-chip').first())).not.toBe('running');
  await hideTab(page, false);
  await expect(page.locator('#conference-start')).toHaveAttribute('href', ROOM);
  await expect(page.locator('#conference-join')).toHaveAttribute('href', ROOM);
});

test('invite and questions pause after they leave the screen', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.setViewportSize(PHONES[0]);
  await page.goto('http://site.test/conferences/');
  const button = page.locator('#conference-invite');
  const toast = page.locator('#conference-invite-toast');
  await button.scrollIntoViewIfNeeded();
  await button.click();
  await expect(toast).toHaveClass(/\bis-on\b/);
  expect(await playState(toast.locator('.invite-chip'))).toBe('running');
  await page.locator('.chrome-disclaimer').scrollIntoViewIfNeeded();
  await expect.poll(async () => button.evaluate((el) => el.getBoundingClientRect().bottom)).toBeLessThan(0);
  await expect(toast).toHaveClass(/\bis-held\b/);
  expect(await playState(toast.locator('.invite-chip'))).toBe('paused');
  await button.scrollIntoViewIfNeeded();
  await expect(toast).not.toHaveClass(/\bis-held\b/);
  expect(await playState(toast.locator('.invite-chip'))).toBe('running');
  await hideTab(page, true);
  await expect(toast).toHaveClass(/\bis-held\b/);
  expect(await playState(toast.locator('.invite-chip'))).toBe('paused');
  await hideTab(page, false);

  const faq = page.locator('#conference-faq');
  await faq.scrollIntoViewIfNeeded();
  await page.locator('#conference-faq-q1').click();
  await expect(page.locator('#conference-faq-q1')).toHaveAttribute('aria-expanded', 'true');
  await expect.poll(async () => runningCount(faq)).toBeGreaterThan(0);
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(faq).toHaveClass(/\bis-held\b/);
  await expect.poll(async () => runningCount(faq)).toBe(0);
  await faq.scrollIntoViewIfNeeded();
  await expect(faq).not.toHaveClass(/\bis-held\b/);
  await expect(page.locator('#conference-faq-a1 p')).toHaveText('In the Converspan room. Start or Join on this page opens it.');
  await expect(page.locator('#conference-start')).toHaveAttribute('href', ROOM);
  await expect(page.locator('#conference-join')).toHaveAttribute('href', ROOM);
  await expect(page.locator(`a[href="${ROOM}"]`)).toHaveCount(2);
});

test('reduced motion is a still readable page', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize(PHONES[1]);
  await page.goto('http://site.test/conferences/');
  const how = page.locator('#conference-how .step');
  await expect(how).toHaveCount(3);
  const steps = await how.evaluateAll((els) => els.map((el) => getComputedStyle(el).animationName));
  for (const name of steps) expect(name).toBe('none');
  await expect(how.nth(0)).toContainText('Start or join');
  await expect(how.nth(1)).toContainText('Room opens');
  await expect(how.nth(2)).toContainText('Summary after');
  const stage = page.locator('#conference-stage');
  await expect(stage).not.toHaveClass(/\bis-live\b/);
  expect(await stage.locator('.tick').first().evaluate((el) => getComputedStyle(el).animationName)).toBe('none');
  await expect(stage.locator('.aim-label')).toHaveText(['Open the brief', 'Mark the aim', 'Draw the path']);
  const recap = page.locator('#conference-recap');
  await expect(recap).not.toHaveClass(/\bis-live\b/);
  expect(await recap.locator('.done').evaluate((el) => getComputedStyle(el).animationName)).toBe('none');
  expect(await recap.locator('.done').evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
  expect(await recap.locator('.fold').evaluate((el) => getComputedStyle(el).opacity)).toBe('0');
  await expect(recap.locator('.chip')).toHaveText(['Send brief', 'Book next', 'Share map']);
  const ready = page.locator('#conference-ready');
  await ready.scrollIntoViewIfNeeded();
  await expect(ready.locator('.ready-chip[data-state="pending"]')).toHaveCount(0);
  const readyMotion = await ready.locator('.ready-chip').evaluateAll((els) => els.map((el) => ({
    name: getComputedStyle(el).animationName,
    opacity: getComputedStyle(el).opacity,
  })));
  expect(readyMotion).toHaveLength(5);
  for (const chip of readyMotion) {
    expect(chip.name).toBe('none');
    expect(chip.opacity).toBe('1');
  }
  await page.locator('#conference-faq-q2').click();
  await expect(page.locator('#conference-faq-a2 p')).toHaveText('No. This page has no microphone. The Converspan room asks only after you join.');
  expect(await page.locator('#conference-faq-a2').evaluate((el) => getComputedStyle(el).transitionDuration)).toBe('0s');
  await expect(page.locator('.chrome-disclaimer')).toContainText('not affiliated with, endorsed by, or sponsored by Salesforce');
  await expect(page.locator('#conference-start')).toHaveAttribute('href', ROOM);
  await expect(page.locator('#conference-join')).toHaveAttribute('href', ROOM);
});

test('without IntersectionObserver the page stays on the still frame', async ({ page }) => {
  await page.addInitScript(() => {
    window.IntersectionObserver = undefined;
  });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.setViewportSize(PHONES[0]);
  await page.goto('http://site.test/conferences/');
  const how = page.locator('#conference-how');
  await expect(how).toHaveClass(/\bis-still\b/);
  const stepMotion = await how.locator('.step').evaluateAll((els) => els.map((el) => ({
    name: getComputedStyle(el).animationName,
    opacity: getComputedStyle(el).opacity,
  })));
  for (const step of stepMotion) {
    expect(step.name).toBe('none');
    expect(step.opacity).toBe('1');
  }
  const stage = page.locator('#conference-stage');
  await expect(stage).not.toHaveClass(/\bis-armed\b/);
  await expect(stage).not.toHaveClass(/\bis-live\b/);
  const still = await stage.evaluate((el) => {
    const read = (sel) => {
      const node = el.querySelector(sel);
      const style = getComputedStyle(node);
      return { name: style.animationName, opacity: style.opacity, dash: style.strokeDashoffset };
    };
    return { tick: read('.tick'), link: read('.edge.draw'), born: read('.node-new') };
  });
  for (const part of [still.tick, still.link, still.born]) expect(part.name).toBe('none');
  expect(['0px', '0']).toContain(still.tick.dash);
  expect(['0px', '0']).toContain(still.link.dash);
  expect(still.born.opacity).toBe('1');
  await expect(stage.locator('.stage-name')).toHaveText('Converspan');
  const recap = page.locator('#conference-recap');
  await expect(recap).not.toHaveClass(/\bis-armed\b/);
  await expect(recap).not.toHaveClass(/\bis-live\b/);
  expect(await recap.locator('.fold').evaluate((el) => getComputedStyle(el).opacity)).toBe('0');
  expect(await recap.locator('.done').evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
  expect(await recap.locator('.chip').first().evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
  const ready = page.locator('#conference-ready');
  await expect(ready).toHaveClass(/\bis-still\b/);
  await expect(ready).toHaveClass(/\bis-in\b/);
  await expect(ready.locator('[data-check="mic"] .ready-label')).not.toHaveText('Checking');
  expect(await ready.locator('.ready-chip').first().evaluate((el) => getComputedStyle(el).animationName)).toBe('none');
  expect(await ready.locator('.ready-chip').first().evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
  const invite = page.locator('#conference-invite-toast');
  await expect(invite).toHaveClass(/\bis-still\b/);
  await page.locator('#conference-invite').click();
  await expect(invite.locator('.invite-chip')).toHaveText('Copied');
  expect(await invite.locator('.invite-chip').evaluate((el) => getComputedStyle(el).animationName)).toBe('none');
  expect(await invite.locator('.invite-chip').evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
  await expect(page.locator('#conference-start')).toHaveAttribute('href', ROOM);
  await expect(page.locator('#conference-join')).toHaveAttribute('href', ROOM);
  await expect(page.locator(`a[href="${ROOM}"]`)).toHaveCount(2);
});

for (const phone of PHONES) {
  test(`still frame at ${phone.width}px stays inside the screen`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize(phone);
    await page.goto('http://site.test/conferences/');
    await expect(page.locator('#conference-how .label')).toHaveText(['Start or join', 'Room opens', 'Summary after']);
    await expect(page.locator('#conference-stage .stage-name')).toHaveText('Converspan');
    await expect(page.locator('#conference-recap .done')).toHaveText('Done');
    const ready = page.locator('#conference-ready');
    await ready.scrollIntoViewIfNeeded();
    await expect(ready.locator('.ready-chip[data-state="pending"]')).toHaveCount(0);
    await page.evaluate(() => window.scrollTo(0, 0));
    const sideways = await page.evaluate(() => {
      const el = document.scrollingElement || document.documentElement;
      return el.scrollWidth - el.clientWidth;
    });
    expect(sideways).toBeLessThanOrEqual(0);
    for (const id of ['#conference-start', '#conference-join']) {
      const box = await page.locator(id).boundingBox();
      expect(box.height).toBeGreaterThanOrEqual(48);
      await expect(page.locator(id)).toHaveAttribute('href', ROOM);
    }
    const graphics = await page.locator('main svg').evaluateAll((els) => els.map((el) => ({
      w: el.getAttribute('width'),
      h: el.getAttribute('height'),
    })));
    expect(graphics.length).toBeGreaterThan(0);
    for (const box of graphics) {
      expect(Number(box.w)).toBeGreaterThan(0);
      expect(Number(box.h)).toBeGreaterThan(0);
    }
    fs.mkdirSync(shotDir, { recursive: true });
    await page.screenshot({
      path: path.join(shotDir, `conferences_motion_${phone.width}x${phone.height}.png`),
      fullPage: true,
    });
  });
}
