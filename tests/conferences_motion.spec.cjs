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
  await expect(page.locator('#conference-faq-a1 p')).toHaveText('The Converspan room.');
  await expect(page.locator('#conference-start')).toHaveAttribute('href', ROOM);
  await expect(page.locator('#conference-join')).toHaveAttribute('href', ROOM);
  await expect(page.locator(`a[href="${ROOM}"]`)).toHaveCount(4);
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
  const lobby = page.locator('#conference-lobby');
  await expect(lobby.locator('.lobby-kicker')).toHaveText('Sample lobby');
  await expect(lobby.locator('.lobby-status')).toHaveText('Waiting for your host');
  await expect(lobby.locator('.lobby-clock')).toHaveText('0:00');
  await expect(lobby.locator('.lobby-tip')).toHaveText([
    'Your host opens the room.',
    'This preview does not join.',
    'Nothing here is recorded.',
  ]);
  const lobbyMotion = await lobby.locator('.lobby-ring, .lobby-core, .lobby-beat, .lobby-tip').evaluateAll((els) => els.map((el) => ({
    name: getComputedStyle(el).animationName,
    transition: getComputedStyle(el).transitionDuration,
  })));
  expect(lobbyMotion.length).toBeGreaterThanOrEqual(6);
  for (const part of lobbyMotion) {
    expect(part.name).toBe('none');
    expect(part.transition).toBe('0s');
  }
  const stillShown = await lobby.locator('.lobby-core, .lobby-beat, .lobby-tip').evaluateAll((els) => els.map((el) => getComputedStyle(el).opacity));
  expect(stillShown.length).toBeGreaterThanOrEqual(5);
  for (const opacity of stillShown) expect(opacity).toBe('1');
  expect(await lobby.locator('.lobby-ring').nth(0).evaluate((el) => getComputedStyle(el).opacity)).toBe('0.75');
  expect(await lobby.locator('.lobby-ring').nth(1).evaluate((el) => getComputedStyle(el).opacity)).toBe('0.4');
  await expect(lobby.locator('.lobby-tip[aria-hidden="true"]')).toHaveCount(0);
  await page.locator('#conference-faq-q2').click();
  await expect(page.locator('#conference-faq-a2 p')).toHaveText('No microphone here.');
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
  const lobby = page.locator('#conference-lobby');
  await expect(lobby).not.toHaveClass(/\bis-armed\b/);
  await expect(lobby).not.toHaveClass(/\bis-live\b/);
  await expect(lobby.locator('.lobby-clock')).toHaveText('0:00');
  await expect(lobby.locator('.lobby-kicker')).toHaveText('Sample lobby');
  const goals = page.locator('#conference-goals');
  await expect(goals).not.toHaveClass(/\bis-armed\b/);
  await expect(goals).not.toHaveClass(/\bis-live\b/);
  await expect(goals.locator('.goals-kicker')).toHaveText(/Sample objectives/);
  await expect(goals.locator('#conference-goals-num')).toHaveText('4');
  await expect(goals.locator('.goal.is-done')).toHaveCount(4);
  await expect(goals.locator('#conference-goals-live')).toHaveText('');
  expect(await goals.locator('.goal').first().evaluate((el) => getComputedStyle(el, '::before').animationName)).toBe('none');
  expect(await lobby.locator('.lobby-ring').first().evaluate((el) => getComputedStyle(el).animationName)).toBe('none');
  expect(await lobby.locator('.lobby-tip.is-on').evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
  const invite = page.locator('#conference-invite-toast');
  await expect(invite).toHaveClass(/\bis-still\b/);
  await page.locator('#conference-invite').click();
  await expect(invite.locator('.invite-chip')).toHaveText('Copied');
  expect(await invite.locator('.invite-chip').evaluate((el) => getComputedStyle(el).animationName)).toBe('none');
  expect(await invite.locator('.invite-chip').evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
  await expect(page.locator('#conference-start')).toHaveAttribute('href', ROOM);
  await expect(page.locator('#conference-join')).toHaveAttribute('href', ROOM);
  await expect(page.locator(`a[href="${ROOM}"]`)).toHaveCount(4);
});

for (const phone of PHONES) {
  test(`still frame at ${phone.width}px stays inside the screen`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize(phone);
    await page.goto('http://site.test/conferences/');
    await expect(page.locator('#conference-how .label')).toHaveText(['Start or join', 'Room opens', 'Summary after']);
    await expect(page.locator('#conference-stage .stage-name')).toHaveText('Converspan');
    await expect(page.locator('#conference-recap .done')).toHaveText('Done');
    await expect(page.locator('#conference-lobby .lobby-kicker')).toHaveText('Sample lobby');
    await expect(page.locator('#conference-lobby .lobby-status')).toHaveText('Waiting for your host');
    await expect(page.locator('#conference-lobby .lobby-clock')).toHaveText('0:00');
    await expect(page.locator('#conference-goals .goals-kicker')).toHaveText(/Sample objectives/);
    await expect(page.locator('#conference-goals-num')).toHaveText('4');
    await expect(page.locator('#conference-goals .goal.is-done')).toHaveCount(4);
    await expect(page.locator('#conference-goals-live')).toHaveText('');
    expect(await page.locator('#conference-goals .goal').first().evaluate((el) => getComputedStyle(el, '::before').animationName)).toBe('none');
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

const PHONE_URL = 'https://sfdc24.com/conferences/';

test('the phone card is a conferences QR on desktop and is hidden at 390', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('http://site.test/conferences/');
  const card = page.locator('#conference-phone');
  const link = card.locator('.phone-go');
  await expect(card).toBeVisible();
  await expect(link).toHaveAttribute('href', PHONE_URL);
  await expect(card.locator('.phone-qr')).toHaveAttribute('alt', `QR code that opens ${PHONE_URL}`);
  await expect(link).toHaveAccessibleName(/QR code that opens https:\/\/sfdc24\.com\/conferences\//);
  await expect(link).toHaveAccessibleName(/Continue on your phone/);
  await expect(card.locator('.phone-line')).toHaveText('Continue on your phone');
  const box = await link.boundingBox();
  expect(box.width).toBeGreaterThanOrEqual(48);
  expect(box.height).toBeGreaterThanOrEqual(48);
  const contrast = await card.locator('.phone-line').evaluate((el) => {
    const rgb = (s) => (String(s).match(/[\d.]+/g) || []).map(Number);
    const lum = ([r, g, b]) => {
      const c = [r, g, b].map((v) => {
        v /= 255;
        return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
      });
      return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    };
    const fg = rgb(getComputedStyle(el).color).slice(0, 3);
    let node = el;
    let bg = null;
    while (node && !bg) {
      const c = rgb(getComputedStyle(node).backgroundColor);
      if (c.length >= 3 && (c.length < 4 || c[3] > 0.95)) bg = c.slice(0, 3);
      node = node.parentElement;
    }
    bg = bg || [16, 20, 28];
    const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x);
    return (a + 0.05) / (b + 0.05);
  });
  expect(contrast).toBeGreaterThanOrEqual(4.5);
  await page.locator('#conference-join').focus();
  await page.keyboard.press('Tab');
  await expect(link).toBeFocused();
  const ring = await link.evaluate((el) => {
    const cs = getComputedStyle(el);
    return `${cs.outlineWidth} ${cs.outlineStyle} ${cs.outlineColor}`;
  });
  expect(ring).toBe('2px solid rgb(10, 102, 194)');

  await page.setViewportSize({ width: 1280, height: 220 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect.poll(async () => card.evaluate((el) => el.getBoundingClientRect().top)).toBeGreaterThan(220);
  await expect(card).toHaveClass(/\bis-armed\b/);
  await expect(card).not.toHaveClass(/\bis-live\b/);
  expect(await playState(card.locator('.phone-frame'))).toBe('paused');
  const moved = await card.locator('.phone-frame').evaluate((el) => {
    const names = [];
    for (const anim of el.getAnimations()) {
      const timing = anim.effect && anim.effect.getTiming ? anim.effect.getTiming() : {};
      names.push(timing.iterations === Infinity ? (anim.animationName || 'transition') : 'finite');
    }
    return names;
  });
  expect(moved).toEqual(['phone-frame']);
  await card.scrollIntoViewIfNeeded();
  await expect(card).toHaveClass(/\bis-live\b/);
  expect(await playState(card.locator('.phone-frame'))).toBe('running');
  await hideTab(page, true);
  await expect(card).not.toHaveClass(/\bis-live\b/);
  expect(await playState(card.locator('.phone-frame'))).toBe('paused');
  await hideTab(page, false);
  await expect(card).toHaveClass(/\bis-live\b/);
  const lineCut = await card.locator('.phone-line').evaluate((el) => el.scrollWidth > el.clientWidth + 1);
  expect(lineCut).toBe(false);
  const sideways = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(sideways).toBeLessThanOrEqual(0);
  await expect(page.locator('#conference-start')).toHaveAttribute('href', ROOM);
  await expect(page.locator('#conference-join')).toHaveAttribute('href', ROOM);
  await expect(page.locator(`a[href="${ROOM}"]`)).toHaveCount(4);
  await expect(page.locator('.chrome-disclaimer')).toContainText('not affiliated with, endorsed by, or sponsored by Salesforce');

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('http://site.test/conferences/');
  await card.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    const top = window.scrollY + rect.top - (window.innerHeight - rect.height) / 2;
    window.scrollTo(0, Math.max(0, top));
  });
  expect(await card.locator('.phone-frame').evaluate((el) => getComputedStyle(el).animationName)).toBe('none');
  expect(await card.locator('.phone-frame').evaluate((el) => getComputedStyle(el).transform)).toMatch(/none|matrix\(1,\s*0,\s*0,\s*1,\s*0,\s*0\)/);
  fs.mkdirSync(shotDir, { recursive: true });
  await page.screenshot({ path: path.join(shotDir, 'conferences_phone_desktop.png') });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#conference-actions').evaluate((el) => {
    const rect = el.getBoundingClientRect();
    const top = window.scrollY + rect.top - 24;
    window.scrollTo(0, Math.max(0, top));
  });
  await expect(card).toBeHidden();
  expect(await card.evaluate((el) => getComputedStyle(el).display)).toBe('none');
  expect(await card.boundingBox()).toBeNull();
  await page.locator('#conference-join').focus();
  await page.keyboard.press('Tab');
  await expect(page.locator('#conference-invite')).toBeFocused();
  const phoneSideways = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(phoneSideways).toBeLessThanOrEqual(0);
  await expect(page.locator(`a[href="${ROOM}"]`)).toHaveCount(4);
  await page.screenshot({ path: path.join(shotDir, 'conferences_phone_390x844.png') });
});

test('the sample lobby waits, ticks, and pauses offscreen', async ({ page }) => {
  const leaked = [];
  page.on('request', (req) => {
    if (!req.url().startsWith('http://site.test')) leaked.push(req.url());
  });
  page.on('websocket', (socket) => leaked.push(socket.url()));
  await page.clock.install();
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.setViewportSize({ width: 390, height: 220 });
  await page.goto('http://site.test/conferences/');
  const lobby = page.locator('#conference-lobby');
  const clock = lobby.locator('.lobby-clock');
  const tips = lobby.locator('.lobby-tip');
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect.poll(async () => lobby.evaluate((el) => el.getBoundingClientRect().top)).toBeGreaterThan(220);
  await expect(lobby).toHaveClass(/\bis-armed\b/);
  await expect(lobby).not.toHaveClass(/\bis-live\b/);
  await expect(clock).toHaveText('0:00');
  await expect(tips.nth(0)).toHaveClass(/\bis-on\b/);
  await expect(tips.nth(1)).toHaveAttribute('aria-hidden', 'true');
  expect(await playState(lobby.locator('.lobby-ring').first())).toBe('paused');
  expect(await playState(lobby.locator('.lobby-beat'))).toBe('paused');
  await page.clock.fastForward(8000);
  await expect(clock).toHaveText('0:00');
  await expect(tips.nth(0)).toHaveClass(/\bis-on\b/);

  await lobby.scrollIntoViewIfNeeded();
  await expect(lobby).toHaveClass(/\bis-live\b/);
  expect(await playState(lobby.locator('.lobby-core'))).toBe('running');
  expect(await playState(lobby.locator('.lobby-beat'))).toBe('running');
  const moved = await lobby.locator('.lobby-ring').first().evaluate((el) => {
    const names = [];
    for (const anim of el.getAnimations()) {
      const timing = anim.effect && anim.effect.getTiming ? anim.effect.getTiming() : {};
      if (timing.iterations !== Infinity) continue;
      const frames = anim.effect.getKeyframes ? anim.effect.getKeyframes() : [];
      const props = new Set();
      for (const frame of frames) {
        for (const key of Object.keys(frame)) {
          if (key !== 'offset' && key !== 'computedOffset' && key !== 'easing' && key !== 'composite') props.add(key);
        }
      }
      names.push([...props].sort().join(','));
    }
    return names;
  });
  expect(moved.length).toBeGreaterThan(0);
  for (const props of moved) expect(props).toBe('opacity,transform');
  await page.clock.fastForward(2000);
  await expect(clock).toHaveText('0:02');
  await expect(tips.nth(0)).toHaveClass(/\bis-on\b/);

  await hideTab(page, true);
  await expect(lobby).not.toHaveClass(/\bis-live\b/);
  expect(await playState(lobby.locator('.lobby-core'))).toBe('paused');
  await page.clock.fastForward(6000);
  await expect(clock).toHaveText('0:02');
  await expect(tips.nth(1)).toHaveAttribute('aria-hidden', 'true');
  await hideTab(page, false);
  await expect(lobby).toHaveClass(/\bis-live\b/);
  expect(await playState(lobby.locator('.lobby-beat'))).toBe('running');
  await page.clock.fastForward(3000);
  await expect(clock).toHaveText('0:05');
  await expect(tips.nth(1)).toHaveClass(/\bis-on\b/);
  await expect(tips.nth(1)).not.toHaveAttribute('aria-hidden', 'true');
  await expect(tips.nth(0)).toHaveAttribute('aria-hidden', 'true');
  await expect(lobby.locator('.lobby-status')).toHaveText('Waiting for your host');
  await expect(lobby.locator('.lobby-status')).toHaveAttribute('aria-live', 'polite');

  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(lobby).not.toHaveClass(/\bis-live\b/);
  expect(await playState(lobby.locator('.lobby-ring').first())).toBe('paused');
  await page.clock.fastForward(5000);
  await expect(clock).toHaveText('0:05');

  const contrast = await lobby.locator('.lobby-status').evaluate((el) => {
    const rgb = (s) => (String(s).match(/[\d.]+/g) || []).map(Number);
    const lum = ([r, g, b]) => {
      const c = [r, g, b].map((v) => {
        v /= 255;
        return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
      });
      return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    };
    const fg = rgb(getComputedStyle(el).color).slice(0, 3);
    let node = el;
    let bg = null;
    while (node && !bg) {
      const c = rgb(getComputedStyle(node).backgroundColor);
      if (c.length >= 3 && (c.length < 4 || c[3] > 0.95)) bg = c.slice(0, 3);
      node = node.parentElement;
    }
    bg = bg || [16, 20, 28];
    const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x);
    return (a + 0.05) / (b + 0.05);
  });
  expect(contrast).toBeGreaterThanOrEqual(4.5);
  const orb = await lobby.locator('.lobby-orb').boundingBox();
  expect(orb.width).toBeGreaterThanOrEqual(48);
  expect(orb.height).toBeGreaterThanOrEqual(48);
  await expect(lobby.locator('a, button')).toHaveCount(0);
  await expect(page.locator('#conference-start')).toHaveAttribute('href', ROOM);
  await expect(page.locator('#conference-join')).toHaveAttribute('href', ROOM);
  await expect(page.locator(`a[href="${ROOM}"]`)).toHaveCount(4);
  expect(leaked.every((url) => url.startsWith('https://fonts.googleapis.com/css2'))).toBe(true);

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('http://site.test/conferences/');
  await lobby.scrollIntoViewIfNeeded();
  await page.clock.fastForward(9000);
  await expect(clock).toHaveText('0:00');
  await expect(lobby).not.toHaveClass(/\bis-live\b/);
  await expect(tips).toHaveCount(3);
  const stillTips = await tips.evaluateAll((els) => els.map((el) => ({
    hidden: el.getAttribute('aria-hidden'),
    opacity: getComputedStyle(el).opacity,
    name: getComputedStyle(el).animationName,
  })));
  for (const tip of stillTips) {
    expect(tip.hidden).toBeNull();
    expect(tip.opacity).toBe('1');
    expect(tip.name).toBe('none');
  }
  expect(await lobby.locator('.lobby-beat').evaluate((el) => getComputedStyle(el).animationName)).toBe('none');
  expect(leaked.every((url) => url.startsWith('https://fonts.googleapis.com/css2'))).toBe(true);

  fs.mkdirSync(shotDir, { recursive: true });
  for (const phone of [{ width: 390, height: 844 }, { width: 375, height: 667 }]) {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.setViewportSize(phone);
    await page.goto('http://site.test/conferences/');
    await expect(lobby).toHaveClass(/\bis-armed\b/);
    await lobby.evaluate((el) => {
      const bar = document.querySelector('header.chrome-bar');
      const offset = (bar ? bar.getBoundingClientRect().height : 56) + 12;
      const top = el.getBoundingClientRect().top + window.scrollY - offset;
      window.scrollTo(0, Math.max(0, top));
    });
    await expect(lobby).toHaveClass(/\bis-live\b/);
    await expect(clock).toHaveText('0:00');
    await lobby.evaluate((el) => {
      const nodes = [el, ...el.querySelectorAll('.lobby-ring, .lobby-core, .lobby-beat')];
      for (const node of nodes) {
        for (const anim of node.getAnimations()) {
          anim.pause();
          const timing = anim.effect && anim.effect.getTiming ? anim.effect.getTiming() : {};
          const dur = timing.duration || 1000;
          anim.currentTime = typeof dur === 'number' ? dur * 0.35 : 400;
        }
      }
    });
    const cut = await lobby.locator('.lobby-kicker, .lobby-status, .lobby-clock, .lobby-tip.is-on').evaluateAll((els) => (
      els.filter((el) => el.scrollWidth > el.clientWidth + 1).map((el) => el.textContent)
    ));
    expect(cut).toEqual([]);
    const box = await lobby.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(-1);
    expect(box.x + box.width).toBeLessThanOrEqual(phone.width + 1);
    const sideways = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(sideways).toBeLessThanOrEqual(0);
    await page.screenshot({
      path: path.join(shotDir, `conferences_lobby_${phone.width}x${phone.height}.png`),
    });
  }
  await expect(page.locator('.chrome-disclaimer')).toContainText('not affiliated with, endorsed by, or sponsored by Salesforce');
});

test('the sample objectives tracker checks off, then rests', async ({ page }) => {
  const leaked = [];
  page.on('request', (req) => {
    if (!req.url().startsWith('http://site.test')) leaked.push(req.url());
  });
  page.on('websocket', (socket) => leaked.push(socket.url()));
  await page.clock.install();
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.setViewportSize({ width: 390, height: 220 });
  await page.goto('http://site.test/conferences/');
  const card = page.locator('#conference-goals');
  const num = page.locator('#conference-goals-num');
  const live = page.locator('#conference-goals-live');
  const goals = card.locator('.goal');
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect.poll(async () => card.evaluate((el) => el.getBoundingClientRect().top)).toBeGreaterThan(220);
  await expect(card).toHaveClass(/\bis-armed\b/);
  await expect(card).not.toHaveClass(/\bis-live\b/);
  await expect(num).toHaveText('0');
  await expect(live).toHaveText('');
  await expect(goals.nth(0)).toHaveClass(/\bis-lit\b/);
  await page.clock.runFor(4000);
  await expect(num).toHaveText('0');
  await expect(goals.nth(0)).toHaveClass(/\bis-lit\b/);
  await expect(goals.nth(1)).not.toHaveClass(/\bis-done\b/);

  await card.scrollIntoViewIfNeeded();
  await expect(card).toHaveClass(/\bis-live\b/);
  await expect(num).toHaveText('0');
  const moved = await goals.nth(0).evaluate((el) => {
    const probe = getComputedStyle(el, '::before');
    const frames = [];
    for (const sheet of document.styleSheets) {
      let rules;
      try { rules = sheet.cssRules; } catch (err) { continue; }
      for (const rule of rules) {
        if (rule.type !== CSSRule.KEYFRAMES_RULE || rule.name !== 'gp') continue;
        for (const frame of rule.cssRules) frames.push(frame.style.cssText);
      }
    }
    return { play: probe.animationPlayState, name: probe.animationName, frames };
  });
  expect(moved.play).toBe('running');
  expect(moved.name).toBe('gp');
  expect(moved.frames.length).toBeGreaterThan(0);
  for (const frame of moved.frames) {
    expect(frame).toMatch(/opacity|transform/);
    expect(frame).not.toMatch(/box-shadow|filter|left|top|width|height|background/);
  }

  await page.clock.runFor(1800);
  await expect(num).toHaveText('2');
  await expect(live).toHaveText('');
  await expect(goals.nth(0)).toHaveClass(/\bis-done\b/);
  await expect(goals.nth(1)).toHaveClass(/\bis-done\b/);
  await expect(goals.nth(2)).toHaveClass(/\bis-lit\b/);
  await expect(goals.nth(3)).not.toHaveClass(/\bis-done\b/);
  await expect(goals.nth(3)).not.toHaveClass(/\bis-lit\b/);
  await hideTab(page, true);
  await expect(card).not.toHaveClass(/\bis-live\b/);
  await page.clock.runFor(3000);
  await expect(num).toHaveText('2');
  await expect(live).toHaveText('');
  await hideTab(page, false);
  await expect(card).toHaveClass(/\bis-live\b/);
  await page.clock.runFor(900);
  await expect(num).toHaveText('3');
  await expect(live).toHaveText('');
  await page.clock.runFor(900);
  await expect(num).toHaveText('4');
  await expect(live).toHaveText('4 of 4 done');
  await expect(goals).toHaveCount(4);
  for (let i = 0; i < 4; i++) await expect(goals.nth(i)).toHaveClass(/\bis-done\b/);
  const contrast = await card.locator('.goal').first().evaluate((el) => {
    const rgb = (s) => (String(s).match(/[\d.]+/g) || []).map(Number);
    const lum = ([r, g, b]) => {
      const c = [r, g, b].map((v) => {
        v /= 255;
        return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
      });
      return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    };
    const ratio = (fg, bg) => {
      const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x);
      return (a + 0.05) / (b + 0.05);
    };
    const fg = rgb(getComputedStyle(el).color).slice(0, 3);
    let node = el;
    let bg = null;
    while (node && !bg) {
      const c = rgb(getComputedStyle(node).backgroundColor);
      if (c.length >= 3 && (c.length < 4 || c[3] > 0.95)) bg = c.slice(0, 3);
      node = node.parentElement;
    }
    const mark = getComputedStyle(el, '::before');
    const markFg = rgb(mark.color).slice(0, 3);
    const markBg = rgb(mark.backgroundColor).slice(0, 3);
    return { text: ratio(fg, bg || [16, 20, 28]), mark: ratio(markFg, markBg) };
  });
  expect(contrast.text).toBeGreaterThanOrEqual(4.5);
  expect(contrast.mark).toBeGreaterThanOrEqual(4.5);
  await page.clock.runFor(1800);
  await expect(num).toHaveText('0');
  await expect(live).toHaveText('');
  await expect(goals.nth(0)).toHaveClass(/\bis-lit\b/);

  const counterLive = await num.evaluate((el) => {
    let node = el;
    while (node && node !== document.body) {
      if (node.getAttribute('aria-live') || node.getAttribute('role') === 'status') return true;
      node = node.parentElement;
    }
    return false;
  });
  expect(counterLive).toBe(false);
  await expect(live).toHaveAttribute('aria-live', 'polite');
  await expect(card.locator('a, button, input, textarea')).toHaveCount(0);
  await expect(page.locator('#conference-start')).toHaveAttribute('href', ROOM);
  await expect(page.locator('#conference-join')).toHaveAttribute('href', ROOM);
  await expect(page.locator(`a[href="${ROOM}"]`)).toHaveCount(4);
  expect(leaked.every((url) => url.startsWith('https://fonts.googleapis.com/css2'))).toBe(true);

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(num).toHaveText('4');
  await expect(live).toHaveText('');
  await expect(card).not.toHaveClass(/\bis-live\b/);
  for (let i = 0; i < 4; i++) await expect(goals.nth(i)).toHaveClass(/\bis-done\b/);
  expect(await goals.first().evaluate((el) => getComputedStyle(el, '::before').animationName)).toBe('none');
  expect(await goals.first().evaluate((el) => getComputedStyle(el, '::after').transitionDuration)).toBe('0s');
  await page.clock.runFor(5000);
  await expect(num).toHaveText('4');
  await expect(live).toHaveText('');

  fs.mkdirSync(shotDir, { recursive: true });
  const shotContext = await page.context().browser().newContext();
  const shot = await shotContext.newPage();
  await shot.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://site.test') return route.abort();
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.resolve(root, '.' + rel);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) {
      return route.fulfill({ status: 404, body: '' });
    }
    const types = {
      '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
      '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
    };
    return route.fulfill({
      body: fs.readFileSync(file),
      contentType: types[path.extname(file)] || 'text/plain',
    });
  });
  for (const phone of [{ width: 390, height: 844 }, { width: 375, height: 667 }]) {
    await shot.emulateMedia({ reducedMotion: 'no-preference' });
    await shot.setViewportSize(phone);
    await shot.goto('http://site.test/conferences/');
    const sample = shot.locator('#conference-goals');
    await sample.evaluate((el) => {
      const bar = document.querySelector('header.chrome-bar');
      const offset = (bar ? bar.getBoundingClientRect().height : 56) + 12;
      const top = el.getBoundingClientRect().top + window.scrollY - offset;
      window.scrollTo(0, Math.max(0, top));
    });
    await expect(sample).toHaveClass(/\bis-live\b/);
    await expect(shot.locator('#conference-goals-num')).toHaveText('2', { timeout: 4000 });
    await expect(sample.locator('.goal').nth(1)).toHaveClass(/\bis-done\b/);
    // The connector draws over 400ms and only then reports transform "none".
    // Wait on the page clock so a busy runner cannot sample the line mid-draw,
    // and stop before the tracker steps on to 3.
    const drawn = await sample.locator('.goal').nth(1).evaluate(async (el) => {
      const num = document.getElementById('conference-goals-num');
      const start = performance.now();
      let transform = '';
      while (performance.now() - start < 650) {
        transform = getComputedStyle(el, '::after').transform;
        const ready = transform === 'none' || /matrix\(1,\s*0,\s*0,\s*1,/.test(transform);
        if (ready && num.textContent === '2') return { ready: true, transform, num: num.textContent };
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
      return { ready: false, transform, num: num.textContent };
    });
    expect(drawn.ready, JSON.stringify(drawn)).toBe(true);
    await shot.screenshot({
      path: path.join(shotDir, `conferences_goals_${phone.width}x${phone.height}.png`),
    });
    const cut = await sample.locator('.goals-kicker, .goal').evaluateAll((els) => (
      els.filter((el) => el.scrollWidth > el.clientWidth + 1).map((el) => (el.textContent || '').trim())
    ));
    expect(cut).toEqual([]);
    const box = await sample.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(-1);
    expect(box.x + box.width).toBeLessThanOrEqual(phone.width + 1);
    const sideways = await shot.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(sideways).toBeLessThanOrEqual(0);
  }
  await shotContext.close();
  await expect(page.locator('.chrome-disclaimer')).toContainText('not affiliated with, endorsed by, or sponsored by Salesforce');
});

async function scrollToSamples(page) {
  await page.evaluate(() => {
    const actions = document.getElementById('conference-actions');
    const edge = actions.getBoundingClientRect().bottom + window.scrollY + 2;
    window.scrollTo(0, Math.max(0, edge));
  });
}

async function dockFrame(dock) {
  return dock.locator('.dock-in').evaluate((el) => {
    const style = getComputedStyle(el);
    const transform = style.transform;
    let ty = 0;
    const match = /matrix\(([^)]+)\)/.exec(transform);
    if (match) ty = parseFloat(match[1].split(',')[5]);
    return {
      transform,
      ty,
      duration: style.transitionDuration,
      animations: el.getAnimations().length + el.parentElement.getAnimations().length,
    };
  });
}

for (const phone of [{ width: 390, height: 844 }, { width: 375, height: 667 }, { width: 320, height: 700 }, { width: 720, height: 900 }]) {
  test(`the thumb bar is on screen at ${phone.width} after the hero and hides with the chooser`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize(phone);
    await page.goto('http://site.test/conferences/');
    const dock = page.locator('#conference-dock');
    await expect(dock).toHaveAttribute('data-watching', '1');
    await expect(dock).not.toHaveClass(/\bis-on\b/);
    await expect(dock).toHaveAttribute('aria-hidden', 'true');
    await expect(dock).toHaveAttribute('inert', '');
    await expect(page.locator('body')).not.toHaveClass(/\bdock-on\b/);

    await scrollToSamples(page);
    await expect(dock).toHaveClass(/\bis-on\b/);
    await expect(dock).toBeVisible();
    await expect(dock).not.toHaveAttribute('aria-hidden');
    await expect(dock).not.toHaveAttribute('inert');
    await expect(page.locator('body')).toHaveClass(/\bdock-on\b/);
    await expect(dock.locator('.dock-host')).toHaveText('Host a conference');
    await expect(dock.locator('.dock-join')).toHaveText('Join a conference');
    await expect(dock.locator('.dock-host')).toHaveAttribute('href', ROOM);
    await expect(dock.locator('.dock-join')).toHaveAttribute('href', ROOM);
    await expect(page.locator('#conference-start')).toHaveAttribute('href', ROOM);
    await expect(page.locator('#conference-join')).toHaveAttribute('href', ROOM);
    const chooser = await page.locator('#conference-actions').boundingBox();
    expect(chooser.y + chooser.height).toBeLessThanOrEqual(1);
    const lede = await page.locator('main .lede').boundingBox();
    expect(lede.y + lede.height).toBeLessThanOrEqual(1);
    const sideways = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(sideways).toBeLessThanOrEqual(0);
    const clipped = await dock.locator('a').evaluateAll((els) => els
      .filter((el) => el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1)
      .map((el) => (el.textContent || '').trim()));
    expect(clipped).toEqual([]);
    fs.mkdirSync(shotDir, { recursive: true });
    await page.screenshot({ path: path.join(shotDir, `dock_${phone.width}x${phone.height}.png`) });

    await page.locator('#conference-actions').scrollIntoViewIfNeeded();
    await expect(dock).not.toHaveClass(/\bis-on\b/);
    await expect(dock).toBeHidden();
    await expect(page.locator('#conference-start')).toBeInViewport();
    await expect(page.locator('body')).not.toHaveClass(/\bdock-on\b/);

    await page.evaluate(() => window.scrollTo(0, 0));
    await expect(dock).not.toHaveClass(/\bis-on\b/);
    await expect(page.locator(`a[href="${ROOM}"]`)).toHaveCount(4);
    await expect(page.locator('.chrome-disclaimer')).toContainText('not affiliated with, endorsed by, or sponsored by Salesforce');
  });
}

test('the thumb bar is absent on desktop widths', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const width of [721, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('http://site.test/conferences/');
    const dock = page.locator('#conference-dock');
    await scrollToSamples(page);
    await expect(dock).toBeHidden();
    await expect(dock).not.toHaveClass(/\bis-on\b/);
    expect(await dock.evaluate((el) => getComputedStyle(el).display)).toBe('none');
    await expect(page.locator('body')).not.toHaveClass(/\bdock-on\b/);
    await expect(page.locator('#conference-start')).toHaveAttribute('href', ROOM);
    await expect(page.locator(`a[href="${ROOM}"]`)).toHaveCount(4);
  }
});

test('reduced motion shows and hides the thumb bar without a slide', async ({ page }) => {
  // Host and Join must start below this screen, so the thumb bar is parked
  // (slid down) rather than hidden because the chooser is already showing.
  await page.setViewportSize({ width: 390, height: 500 });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('http://site.test/conferences/');
  const dock = page.locator('#conference-dock');
  await expect(dock).not.toHaveClass(/\bis-on\b/);
  await dock.locator('.dock-in').evaluate(async (el) => {
    await Promise.all(el.getAnimations().map((anim) => anim.finished.catch(() => {})));
  });
  let frame = await dockFrame(dock);
  expect(frame.ty).toBeGreaterThan(20);
  expect(frame.duration).not.toBe('0s');

  await page.emulateMedia({ reducedMotion: 'reduce' });
  frame = await dockFrame(dock);
  expect(frame.transform).toBe('none');
  expect(frame.duration).toBe('0s');
  expect(frame.animations).toBe(0);

  await scrollToSamples(page);
  await expect(dock).toHaveClass(/\bis-on\b/);
  await expect(dock).toBeVisible();
  frame = await dockFrame(dock);
  expect(frame.transform).toBe('none');
  expect(frame.duration).toBe('0s');
  expect(frame.animations).toBe(0);

  await page.locator('#conference-actions').scrollIntoViewIfNeeded();
  await expect(dock).not.toHaveClass(/\bis-on\b/);
  await expect(dock).toBeHidden();
  frame = await dockFrame(dock);
  expect(frame.transform).toBe('none');
  expect(frame.animations).toBe(0);
  await expect(page.locator(`a[href="${ROOM}"]`)).toHaveCount(4);
  await expect(page.locator('.chrome-disclaimer')).toContainText('not affiliated with, endorsed by, or sponsored by Salesforce');
});
