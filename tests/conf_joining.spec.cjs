// The "agents joining" stage on /conference/: a stopwatch from the Join press, and chips that light only
// on a real message from the room's own frame and origin (room.sfdc24.com).
const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const ROOM = 'https://room.sfdc24.com';

test.beforeEach(async ({ page }) => {
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === ROOM) return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>room</title><p>room fixture</p>' });
    if (url.origin !== 'http://site.test') return route.abort();
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.resolve(root, '.' + rel);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
    const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json' };
    return route.fulfill({ body: fs.readFileSync(file), contentType: types[path.extname(file)] || 'application/octet-stream' });
  });
});

async function join(page) {
  await page.clock.install({ time: new Date('2026-10-24T05:00:00Z') });
  await page.goto('http://site.test/conference/?room=workshop', { waitUntil: 'load' });
  await expect(page.locator('#conf-joining')).toHaveCount(0);
  await page.clock.pauseAt(new Date('2026-10-24T05:01:00Z'));  // time stands still until runFor moves it
  await page.locator('#conf-room-toggle').click();
  await expect(page.locator('#conf-joining')).toBeVisible();
  const frame = await expect.poll(() => page.frames().find((f) => f.url().startsWith(ROOM)) || null).not.toBeNull()
    .then(() => page.frames().find((f) => f.url().startsWith(ROOM)));
  await frame.waitForLoadState('load');
  return frame;
}

function fromRoom(frame, data) {
  return frame.evaluate((d) => window.parent.postMessage(d, '*'), data);
}

const chips = (page) => page.locator('#conf-joining .cj-chip');
const lit = (page) => page.locator('#conf-joining .cj-chip[data-on="1"]');

test('Join starts a stopwatch from the press; four chips wait, unlit, under their own names', async ({ page }) => {
  await join(page);
  await expect(page.locator('.cj-clock')).toHaveText('0:00.0');
  await page.clock.runFor(3200);
  await expect(page.locator('.cj-clock')).toHaveText('0:03.2');
  await expect(chips(page)).toHaveText(['Claude', 'Grok', 'Codex', 'Gemini']);
  await expect(lit(page)).toHaveCount(0);
  await expect(page.locator('.cj-say')).toHaveText('Agents joining');
});

test('only the room frame, from its own origin, can light a chip', async ({ page }) => {
  const frame = await join(page);
  await page.evaluate(() => window.postMessage({ source: 'sfdc24-room', agents: ['claude', 'grok', 'codex', 'gemini'] }, '*'));
  await fromRoom(frame, { source: 'someone-else', agents: ['claude'] });
  await fromRoom(frame, 'claude');
  await page.clock.runFor(500);
  await expect(lit(page)).toHaveCount(0);
  await fromRoom(frame, { source: 'sfdc24-room', chair: 'ready', agents: ['claude', 'grok', 'nobody'] });
  await expect(lit(page)).toHaveText(['Claude', 'Grok']);
  await expect(page.locator('.cj-say')).toHaveText('2 of 4 in');
});

test('everyone in: the stopwatch stops, says so, and the stage gets out of the way', async ({ page }) => {
  const frame = await join(page);
  await page.clock.runFor(4000);
  await fromRoom(frame, { source: 'sfdc24-room', chair: 'ready', agents: ['claude', 'grok'] });
  await fromRoom(frame, { source: 'sfdc24-room', chair: 'ready', agents: ['codex', 'gemini'] });
  await expect(lit(page)).toHaveCount(4);
  await expect(page.locator('.cj-say')).toHaveText('Everyone\u2019s in');
  const at = await page.locator('.cj-clock').textContent();
  await page.clock.runFor(1000);
  await expect(page.locator('.cj-clock')).toHaveText(at);
  await page.clock.runFor(2000);
  await expect(page.locator('#conf-joining')).toHaveCount(0);
  await expect(page.locator('#conf-room-frame')).toBeVisible();
});

test('no word from the room: after the wait it says so honestly and lights nothing', async ({ page }) => {
  await join(page);
  await page.clock.runFor(90500);
  await expect(page.locator('#conf-joining')).toHaveAttribute('data-state', 'slow');
  await expect(page.locator('.cj-say')).toHaveText('Agents still joining. No word from the room yet.');
  await expect(lit(page)).toHaveCount(0);
  await page.locator('.cj-x').click();
  await expect(page.locator('#conf-joining')).toHaveCount(0);
});

test('no word after 20 s: offers the one-time sign-in in a new tab; a room message clears it', async ({ page }) => {
  const frame = await join(page);
  await page.clock.runFor(19000);
  await expect(page.locator('.cj-hint')).toHaveCount(0);
  await page.clock.runFor(1500);
  const link = page.locator('.cj-hint a');
  await expect(link).toHaveAttribute('href', 'https://room.sfdc24.com/');
  await expect(link).toHaveAttribute('target', '_blank');
  await fromRoom(frame, { source: 'sfdc24-room', chair: 'ready', agents: ['claude'] });
  await expect(page.locator('.cj-hint')).toHaveCount(0);
});

test('some in, then the wait runs out: it names who is still missing', async ({ page }) => {
  const frame = await join(page);
  await fromRoom(frame, { source: 'sfdc24-room', chair: 'ready', agents: ['claude', 'gemini'] });
  await page.clock.runFor(90500);
  await expect(page.locator('.cj-say')).toHaveText('Still waiting on Grok, Codex');
});

test('the chair reports down: no chips, a plain line', async ({ page }) => {
  const frame = await join(page);
  await fromRoom(frame, { source: 'sfdc24-room', chair: 'down' });
  await expect(page.locator('.cj-say')).toHaveText('The chair is down. The agents are not in the room.');
  await expect(page.locator('#conf-joining .cj-chips')).toBeHidden();
});

test('Hide the room clears the stage; reduced motion stills the chips', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await join(page);
  const anim = await chips(page).first().evaluate((n) => getComputedStyle(n).animationName);
  expect(anim).toBe('none');
  await page.locator('#conf-room-toggle').click();
  await expect(page.locator('#conf-joining')).toHaveCount(0);
});

test('with motion allowed, waiting chips breathe', async ({ page }) => {
  await join(page);
  const anim = await chips(page).first().evaluate((n) => getComputedStyle(n).animationName);
  expect(anim).toBe('cj-wait');
});
