// The "agents joining" stage on /conference/: a stopwatch from the Join press, and chips that light only
// on a real message from the room's own frame and origin (room.sfdc24.com).
const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const ROOM = 'https://room.sfdc24.com';

test.beforeEach(async ({ page }) => {
  // The context, not the page, so the sign-in window (a popup) is served the room fixture too.
  await page.context().route('**/*', async (route) => {
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
  await fromRoom(frame, { source: 'sfdc24-room', agents: ['claude', 'grok', 'codex', 'gemini'] });
  await fromRoom(frame, { source: 'sfdc24-room', chair: 'starting', agents: ['claude', 'grok', 'codex', 'gemini'] });
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
  test.slow();  // 90 s of 100 ms ticks on the fake clock
  await join(page);
  await page.clock.runFor(90500);
  await expect(page.locator('#conf-joining')).toHaveAttribute('data-state', 'slow');
  await expect(page.locator('.cj-say')).toHaveText('Agents still joining. No word from the room yet.');
  await expect(lit(page)).toHaveCount(0);
  await page.locator('.cj-x').click();
  await expect(page.locator('#conf-joining')).toHaveCount(0);
});

test('the room loads signed in and says so: no sign-in window, nothing to click', async ({ page }) => {
  const frame = await join(page);
  const popups = [];
  page.on('popup', (p) => popups.push(p));
  await fromRoom(frame, { source: 'sfdc24-room', auth: 'ok' });
  await page.clock.runFor(25000);
  expect(popups).toHaveLength(0);
  await expect(page.locator('.cj-hint')).toHaveCount(0);
  await expect(page.locator('.cj-reconnect')).toHaveCount(0);
});

test('no word from the frame within 3.5 s: the sign-in window opens by itself and closes on auth ok', async ({ page }) => {
  await join(page);
  const before = await page.locator('#conf-room-frame').getAttribute('src');
  const popupSeen = page.waitForEvent('popup');
  await page.clock.runFor(3600);
  const popup = await popupSeen;
  expect(popup.url()).toBe('https://room.sfdc24.com/?signin=1');
  await expect(page.locator('.cj-say')).toHaveText('Finish signing in in the small window: pick your Google account there.');
  const closed = popup.waitForEvent('close');
  await popup.evaluate(() => window.opener.postMessage({ source: 'sfdc24-room', auth: 'ok' }, '*'));
  await closed;
  await expect(page.locator('.cj-say')).toHaveText('Signed in. Connecting\u2026');
  const after = await page.locator('#conf-room-frame').getAttribute('src');
  expect(after).not.toBe(before);
  expect(after.startsWith('https://room.sfdc24.com/?r=')).toBe(true);
});

test('signed out: the pane never shows the framed Google page; covered until the room itself says ok', async ({ page }) => {
  const frame = await join(page);
  const room = page.locator('#conf-room');
  const pane = page.locator('#conf-room-frame');
  await expect(room).toHaveAttribute('data-auth', 'pending');
  await expect(pane).toHaveCSS('visibility', 'hidden');
  await expect(page.locator('#conf-room .cj-cover')).toBeVisible();
  // Sign-in window says ok: the frame reloads, and stays covered until the reloaded room speaks.
  const popupSeen = page.waitForEvent('popup');
  await page.clock.runFor(3600);
  const popup = await popupSeen;
  const closed = popup.waitForEvent('close');
  await popup.evaluate(() => window.opener.postMessage({ source: 'sfdc24-room', auth: 'ok' }, '*'));
  await closed;
  await expect(pane).toHaveCSS('visibility', 'hidden');
  const fresh = page.frames().find((f) => f.url().startsWith(ROOM) && f !== popup.mainFrame());
  await fresh.waitForLoadState('load');
  // Auth ok from another window, or "expired" from the frame, never uncovers it.
  await page.evaluate(() => window.postMessage({ source: 'sfdc24-room', auth: 'ok' }, '*'));
  await fromRoom(fresh, { source: 'sfdc24-room', auth: 'expired' });
  await expect(pane).toHaveCSS('visibility', 'hidden');
  await fromRoom(fresh, { source: 'sfdc24-room', auth: 'ok' });
  await expect(room).toHaveAttribute('data-auth', 'ok');
  await expect(pane).toHaveCSS('visibility', 'visible');
  await expect(page.locator('#conf-room .cj-cover')).toBeHidden();
});

test('signed in: the room uncovers on its first word (auth ok, or a connection status)', async ({ page }) => {
  const frame = await join(page);
  await expect(page.locator('#conf-room-frame')).toHaveCSS('visibility', 'hidden');
  await fromRoom(frame, { source: 'sfdc24-room', connection: 'disconnected' });
  await expect(page.locator('#conf-room-frame')).toHaveCSS('visibility', 'visible');
  await expect(page.locator('#conf-room .cj-cover')).toBeHidden();
});

test('a message from another window, or auth ok from the frame itself, never closes or reloads anything', async ({ page }) => {
  const frame = await join(page);
  const popupSeen = page.waitForEvent('popup');
  await page.clock.runFor(3600);
  const popup = await popupSeen;
  const src = await page.locator('#conf-room-frame').getAttribute('src');
  await page.evaluate(() => window.postMessage({ source: 'sfdc24-room', auth: 'ok' }, '*'));
  await popup.evaluate(() => window.opener.postMessage({ source: 'sfdc24-room', auth: 'nope' }, '*'));
  await page.clock.runFor(500);
  expect(popup.isClosed()).toBe(false);
  expect(await page.locator('#conf-room-frame').getAttribute('src')).toBe(src);
  await fromRoom(frame, { source: 'sfdc24-room', auth: 'ok' });
  await page.clock.runFor(500);
  expect(await page.locator('#conf-room-frame').getAttribute('src')).toBe(src);
});

test('the sign-in window closed without a word: the room reloads and Reconnect is offered; auth ok clears it', async ({ page }) => {
  const frame = await join(page);
  const popupSeen = page.waitForEvent('popup');
  await page.clock.runFor(3600);
  const popup = await popupSeen;
  const src = await page.locator('#conf-room-frame').getAttribute('src');
  await popup.close();
  await page.clock.runFor(600);
  await expect(page.locator('.cj-reconnect')).toHaveCount(1);
  expect(await page.locator('#conf-room-frame').getAttribute('src')).not.toBe(src);
  const reloaded = page.frames().find((f) => f.url().startsWith(ROOM));
  await reloaded.waitForLoadState('load');
  await fromRoom(reloaded, { source: 'sfdc24-room', auth: 'ok' });
  await expect(page.locator('.cj-reconnect')).toHaveCount(0);
});

test('the frame reports its sign-in lapsed: one Reconnect button, which opens the sign-in window; no new-tab link anywhere', async ({ page }) => {
  const frame = await join(page);
  await fromRoom(frame, { source: 'sfdc24-room', auth: 'ok' });
  await fromRoom(frame, { source: 'sfdc24-room', auth: 'expired' });
  const button = page.locator('.cj-reconnect');
  await expect(button).toHaveCount(1);
  await expect(page.locator('.cj-say')).toHaveText('Sign-in lapsed');
  const popupSeen = page.waitForEvent('popup');
  await button.click();
  const popup = await popupSeen;
  expect(popup.url()).toBe('https://room.sfdc24.com/?signin=1');
  await expect(page.locator('#conf-room a[target="_blank"]')).toHaveCount(0);
  await expect(page.locator('#conf-joining a')).toHaveCount(0);
});

test('no word after 20 s and no sign-in window allowed: a Reconnect button, cleared by a room message', async ({ page }) => {
  await page.addInitScript(() => { window.open = () => null; });
  const frame = await join(page);
  await page.clock.runFor(3600);
  await expect(page.locator('.cj-reconnect')).toHaveCount(1);
  await expect(page.locator('.cj-hint')).toContainText('Allow pop-ups for sfdc24.com');
  await fromRoom(frame, { source: 'sfdc24-room', chair: 'ready', agents: ['claude'] });
  await expect(page.locator('.cj-hint')).toHaveCount(0);
});

test('some in, then the wait runs out: it names who is still missing', async ({ page }) => {
  test.slow();  // 90 s of 100 ms ticks on the fake clock
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

test('initial disconnected and auth ok are not a room connection or chair readiness', async ({ page }) => {
  const frame = await join(page);
  await fromRoom(frame, { source: 'sfdc24-room', connection: 'disconnected' });
  await expect(page.locator('#conf-joining')).toHaveAttribute('data-state', 'not-connected');
  await expect(page.locator('.cj-say')).toHaveText('Not connected. Choose a mode in the room, then Join.');
  await expect(lit(page)).toHaveCount(0);
  await fromRoom(frame, { source: 'sfdc24-room', auth: 'ok' });
  await expect(page.locator('#conf-joining')).toHaveAttribute('data-state', 'not-connected');
  await fromRoom(frame, { source: 'sfdc24-room', connection: 'connected', agents: ['claude', 'grok', 'codex', 'gemini'] });
  await expect(page.locator('#conf-joining')).toHaveAttribute('data-state', 'connected');
  await expect(lit(page)).toHaveCount(0);
  await fromRoom(frame, { source: 'sfdc24-room', chair: 'ready', agents: ['claude'] });
  await expect(lit(page)).toHaveText(['Claude']);
  await fromRoom(frame, { source: 'sfdc24-room', connection: 'disconnected' });
  await expect(page.locator('#conf-joining')).toHaveAttribute('data-state', 'disconnected');
  await expect(page.locator('.cj-chips')).toBeHidden();
  await expect(lit(page)).toHaveCount(0);
  await fromRoom(frame, { source: 'sfdc24-room', chair: 'ready', agents: ['claude', 'grok', 'codex', 'gemini'] });
  await expect(page.locator('#conf-joining')).toHaveAttribute('data-state', 'disconnected');
  await expect(lit(page)).toHaveCount(0);
});

test('connection-only initial status keeps the existing sign-in probe active', async ({ page }) => {
  const frame = await join(page);
  await fromRoom(frame, { source: 'sfdc24-room', connection: 'disconnected' });
  const popupSeen = page.waitForEvent('popup');
  await page.clock.runFor(3600);
  const popup = await popupSeen;
  expect(popup.url()).toBe('https://room.sfdc24.com/?signin=1');
  await expect(page.locator('#conf-joining')).toHaveAttribute('data-state', 'not-connected');
});

test('auth-required uses the existing Reconnect control; fresh joining recovers, chair-ready alone cannot', async ({ page }) => {
  const frame = await join(page);
  await fromRoom(frame, { source: 'sfdc24-room', auth: 'ok' });
  await fromRoom(frame, { source: 'sfdc24-room', connection: 'auth-required' });
  await expect(page.locator('#conf-joining')).toHaveAttribute('data-state', 'auth-required');
  await expect(page.locator('.cj-reconnect')).toHaveCount(1);
  await expect(page.locator('#conf-joining a')).toHaveCount(0);
  await fromRoom(frame, { source: 'sfdc24-room', connection: 'disconnected' });
  await fromRoom(frame, { source: 'sfdc24-room', chair: 'ready', agents: ['claude', 'grok', 'codex', 'gemini'] });
  await expect(page.locator('#conf-joining')).toHaveAttribute('data-state', 'auth-required');
  await expect(lit(page)).toHaveCount(0);
  await fromRoom(frame, { source: 'sfdc24-room', connection: 'joining' });
  await expect(page.locator('#conf-joining')).toHaveAttribute('data-state', 'joining');
  await expect(page.locator('.cj-reconnect')).toHaveCount(0);
  await fromRoom(frame, { source: 'sfdc24-room', connection: 'connected' });
  await expect(page.locator('#conf-joining')).toHaveAttribute('data-state', 'connected');
  await expect(lit(page)).toHaveCount(0);
  await fromRoom(frame, { source: 'sfdc24-room', chair: 'ready', agents: ['claude'] });
  await expect(lit(page)).toHaveText(['Claude']);
});

test('failed and disconnected attempts need a fresh connection; malformed messages do not light chips', async ({ page }) => {
  const frame = await join(page);
  await fromRoom(frame, { source: 'sfdc24-room', auth: 'ok' });
  for (const failure of ['failed', 'disconnected']) {
    await fromRoom(frame, { source: 'sfdc24-room', connection: 'connected' });
    await fromRoom(frame, { source: 'sfdc24-room', connection: failure });
    await expect(page.locator('#conf-joining')).toHaveAttribute('data-state', failure);
    await page.evaluate(() => window.postMessage({ source: 'sfdc24-room', connection: 'connected', chair: 'ready', agents: ['claude'] }, '*'));
    await fromRoom(frame, { source: 'sfdc24-room', connection: 'other', chair: 'ready', agents: ['claude'] });
    await fromRoom(frame, { source: 'sfdc24-room', chair: 'ready', agents: ['claude'] });
    await expect(page.locator('#conf-joining')).toHaveAttribute('data-state', failure);
    await expect(lit(page)).toHaveCount(0);
    await fromRoom(frame, { source: 'sfdc24-room', connection: 'connected' });
    await expect(page.locator('#conf-joining')).toHaveAttribute('data-state', 'connected');
    await expect(lit(page)).toHaveCount(0);
    await page.locator('#conf-room-toggle').click();
    await page.locator('#conf-room-toggle').click();
  }
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

test('reload with the room restored open: covered, stage up, and the sign-in window still opens by itself', async ({ page }) => {
  await join(page);
  const popups = [];
  page.on('popup', (p) => popups.push(p));
  await page.reload({ waitUntil: 'load' });
  await expect(page.locator('#conf-room')).toBeVisible();
  await expect(page.locator('#conf-room')).toHaveAttribute('data-auth', 'pending');
  await expect(page.locator('#conf-room-frame')).toHaveCSS('visibility', 'hidden');
  await expect(page.locator('#conf-room .cj-cover')).toBeVisible();
  await expect(page.locator('#conf-joining')).toBeVisible();
  await page.clock.runFor(3600);
  await expect.poll(() => popups.length).toBe(1);
  expect(popups[0].url()).toBe('https://room.sfdc24.com/?signin=1');
});

test('timer hidden before 3.5 s: the sign-in window still opens by itself, and the room uncovers once it says ok', async ({ page }) => {
  await join(page);
  await page.clock.runFor(1000);
  await page.locator('.cj-x').click();
  await expect(page.locator('#conf-joining')).toHaveCount(0);
  const popupSeen = page.waitForEvent('popup');
  await page.clock.runFor(2600);
  const popup = await popupSeen;
  expect(popup.url()).toBe('https://room.sfdc24.com/?signin=1');
  await expect(page.locator('#conf-room')).toHaveAttribute('data-auth', 'pending');
  const closed = popup.waitForEvent('close');
  await popup.evaluate(() => window.opener.postMessage({ source: 'sfdc24-room', auth: 'ok' }, '*'));
  await closed;
  const fresh = page.frames().find((f) => f.url().startsWith(ROOM) && f !== popup.mainFrame());
  await fresh.waitForLoadState('load');
  await fromRoom(fresh, { source: 'sfdc24-room', auth: 'ok' });
  await expect(page.locator('#conf-room-frame')).toHaveCSS('visibility', 'visible');
});

test('timer hidden, then the sign-in window is cancelled or blocked: Reconnect stays on the cover', async ({ page }) => {
  const frame = await join(page);
  await page.locator('.cj-x').click();
  const popupSeen = page.waitForEvent('popup');
  await page.clock.runFor(3600);
  const popup = await popupSeen;
  await popup.close();
  await page.clock.runFor(600);
  await expect(page.locator('#conf-room .cj-cover .cj-reconnect')).toBeVisible();
  const again = page.waitForEvent('popup');
  await page.locator('#conf-room .cj-cover .cj-reconnect').click();
  expect((await again).url()).toBe('https://room.sfdc24.com/?signin=1');
  await expect(page.locator('#conf-room .cj-cover .cj-reconnect')).toHaveCount(0);
});

test('sign-in window cancelled first, THEN the timer hidden: Reconnect moves to the cover and still works', async ({ page }) => {
  await join(page);
  const popupSeen = page.waitForEvent('popup');
  await page.clock.runFor(3600);
  const popup = await popupSeen;
  await popup.close();
  await page.clock.runFor(600);
  await expect(page.locator('#conf-joining .cj-reconnect')).toHaveCount(1);
  await page.locator('.cj-x').click();
  await expect(page.locator('#conf-joining')).toHaveCount(0);
  const button = page.locator('#conf-room .cj-cover .cj-reconnect');
  await expect(button).toBeVisible();
  const again = page.waitForEvent('popup');
  await button.click();
  expect((await again).url()).toBe('https://room.sfdc24.com/?signin=1');
});

test('sign-in window blocked first, THEN the timer hidden: Reconnect stays visible on the cover', async ({ page }) => {
  await page.addInitScript(() => { window.open = () => null; });
  await join(page);
  await page.clock.runFor(3600);
  await expect(page.locator('#conf-joining .cj-reconnect')).toHaveCount(1);
  await page.locator('.cj-x').click();
  await expect(page.locator('#conf-joining')).toHaveCount(0);
  await expect(page.locator('#conf-room .cj-cover .cj-reconnect')).toBeVisible();
  await expect(page.locator('#conf-room .cj-cover .cj-hint')).toContainText('Allow pop-ups for sfdc24.com');
});

// Speaker chips (owner, 2026-10-28 call): right after Brochure, who is in the room and who is speaking, lit only
// by the room frame's own {speaking, listening} message, and still there when the room pane is hidden.
const speakers = (page) => page.locator('#conf-speakers');
const speakerState = (page, id) => page.locator('#conf-speakers [data-agent="' + id + '"]');

test('speaker chips sit right after Brochure and light only from the room frame', async ({ page }) => {
  const frame = await join(page);
  await expect(page.locator('#conf-brochure-toggle + #conf-speakers')).toHaveCount(1);
  await expect(speakers(page)).toBeHidden();
  await page.evaluate(() => window.postMessage({ source: 'sfdc24-room', speaking: 'claude', listening: ['claude', 'grok', 'codex', 'gemini'] }, '*'));
  await fromRoom(frame, { source: 'someone-else', speaking: 'claude', listening: ['claude'] });
  await expect(speakers(page)).toBeHidden();
  await fromRoom(frame, { source: 'sfdc24-room', speaking: 'codex', listening: ['claude', 'grok', 'codex', 'gemini'] });
  await expect(speakers(page)).toBeVisible();
  await expect(page.locator('#conf-speakers .cs-chip')).toHaveText(['Claude', 'Grok', 'Codex', 'Gemini']);
  await expect(speakerState(page, 'codex')).toHaveAttribute('data-state', 'speaking');
  for (const id of ['claude', 'grok', 'gemini']) await expect(speakerState(page, id)).toHaveAttribute('data-state', 'listening');
  await fromRoom(frame, { source: 'sfdc24-room', speaking: null, listening: ['claude', 'grok', 'codex', 'gemini'] });
  await expect(page.locator('#conf-speakers [data-state="speaking"]')).toHaveCount(0);
});

test('speaker chips take only the four ids; a speaker not in the room is nobody; an empty room hides them', async ({ page }) => {
  const frame = await join(page);
  await fromRoom(frame, { source: 'sfdc24-room', speaking: 'someone', listening: ['claude', 'someone', 'grok'] });
  await expect(page.locator('#conf-speakers .cs-chip')).toHaveCount(4);
  await expect(page.locator('#conf-speakers [data-state="speaking"]')).toHaveCount(0);
  await expect(speakerState(page, 'claude')).toHaveAttribute('data-state', 'listening');
  await expect(speakerState(page, 'codex')).toHaveAttribute('data-state', 'idle');
  await fromRoom(frame, { source: 'sfdc24-room', speaking: 'gemini', listening: ['claude'] });
  await expect(speakerState(page, 'gemini')).toHaveAttribute('data-state', 'idle');
  await fromRoom(frame, { source: 'sfdc24-room', speaking: 'claude', listening: 'claude' });
  await expect(speakers(page)).toBeHidden();
  await fromRoom(frame, { source: 'sfdc24-room', speaking: null, listening: [] });
  await expect(speakers(page)).toBeHidden();
});

test('speaker chips stay in view with the room pane hidden, and leave the joining stage alone', async ({ page }) => {
  const frame = await join(page);
  await fromRoom(frame, { source: 'sfdc24-room', speaking: 'grok', listening: ['claude', 'grok', 'codex', 'gemini'] });
  await expect(lit(page)).toHaveCount(0);
  await expect(page.locator('.cj-say')).toHaveText('Agents joining');
  await page.locator('#conf-room-toggle').click();
  await expect(page.locator('#conf-room')).toBeHidden();
  await expect(speakers(page)).toBeVisible();
  await expect(speakerState(page, 'grok')).toHaveAttribute('data-state', 'speaking');
});
