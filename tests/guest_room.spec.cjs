// /guest/ is the invited seat. The invite code lives in the hash only.
// A query-string code is ignored. The code is posted to the join service
// and is not written into the page, storage, or the console.
const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const INVITE = 'invite-hash-token';
const QUERY_CODE = 'invite-query-token';
const MEDIA = 'media-access-token';
const MEDIA_URL = 'wss://media.example/live';
const JOIN = 'https://conference-guest.sfdc24.com/api/guest/join';

const MOCK = `
(function () {
  function Participant(identity, name, isLocal) {
    this.identity = identity;
    this.name = name || "";
    this.isLocal = !!isLocal;
  }
  function bindLocal(p) {
    p.micEnabled = null;
    p.cameraEnabled = null;
    p.screenEnabled = null;
    p.setMicrophoneEnabled = function (on) { p.micEnabled = on; return Promise.resolve(); };
    p.setCameraEnabled = function (on) { p.cameraEnabled = on; return Promise.resolve(); };
    p.setScreenShareEnabled = function (on) { p.screenEnabled = on; return Promise.resolve(); };
  }
  function MediaTrack(kind) {
    this.kind = kind;
    this._els = [];
  }
  MediaTrack.prototype.attach = function () {
    var el = document.createElement(this.kind === "audio" ? "audio" : "video");
    el.setAttribute("data-kind", this.kind);
    this._els.push(el);
    return el;
  };
  MediaTrack.prototype.detach = function () {
    var els = this._els.slice();
    this._els = [];
    return els;
  };
  function Room() {
    this.localParticipant = new Participant("local-guest", "", true);
    bindLocal(this.localParticipant);
    this.remoteParticipants = new Map();
    this._handlers = {};
    this.url = "";
    this.token = "";
    this.disconnected = false;
    window.__guestRooms = window.__guestRooms || [];
    window.__guestRooms.push(this);
  }
  Room.prototype.on = function (event, fn) {
    (this._handlers[event] = this._handlers[event] || []).push(fn);
    return this;
  };
  Room.prototype.emit = function (event) {
    var fns = this._handlers[event] || [];
    var args = Array.prototype.slice.call(arguments, 1);
    fns.forEach(function (fn) { fn.apply(null, args); });
  };
  Room.prototype.connect = function (url, token) {
    this.url = url;
    this.token = token;
    return Promise.resolve();
  };
  Room.prototype.disconnect = function () {
    this.disconnected = true;
    this.emit("disconnected");
    return Promise.resolve();
  };
  Room.prototype.addRemote = function (identity, name) {
    var p = new Participant(identity, name, false);
    this.remoteParticipants.set(identity, p);
    this.emit("participantConnected", p);
    return p;
  };
  Room.prototype.addTrack = function (participant, kind) {
    var track = new MediaTrack(kind);
    this.emit("trackSubscribed", track, { kind: kind }, participant);
    return track;
  };
  window.LivekitClient = {
    Room: Room,
    RoomEvent: {
      TrackSubscribed: "trackSubscribed",
      TrackUnsubscribed: "trackUnsubscribed",
      ParticipantConnected: "participantConnected",
      ParticipantDisconnected: "participantDisconnected",
      Disconnected: "disconnected"
    },
    Track: { Kind: { Audio: "audio", Video: "video" } },
    LogLevel: { silent: 5 },
    setLogLevel: function () {}
  };
})();
`;

let joins = [];
let joinHandler = null;
let mockMedia = true;
let logs = [];

function serve(route, url) {
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
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
  };
  return route.fulfill({
    body: fs.readFileSync(file),
    contentType: types[path.extname(file)] || 'application/octet-stream',
  });
}

test.beforeEach(async ({ page }) => {
  joins = [];
  joinHandler = null;
  mockMedia = true;
  logs = [];
  page.on('console', (msg) => logs.push(msg.text()));
  page.on('pageerror', (err) => logs.push(String(err)));
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === 'https://conference-guest.sfdc24.com') {
      joins.push({
        url: route.request().url(),
        method: route.request().method(),
        body: route.request().postData() || '',
      });
      if (!joinHandler) return route.abort();
      return joinHandler(route);
    }
    if (url.origin !== 'http://site.test') return route.abort();
    if (mockMedia && url.pathname === '/assets/guest-media-client.js') {
      return route.fulfill({ body: MOCK, contentType: 'application/javascript' });
    }
    return serve(route, url);
  });
});

function postedBodies() {
  return joins.map((entry) => JSON.parse(entry.body));
}

function expectNoSecretLeak() {
  const text = logs.join('\n');
  expect(text).not.toContain(INVITE);
  expect(text).not.toContain(MEDIA);
  expect(text).not.toContain(QUERY_CODE);
  for (const entry of joins) {
    expect(entry.url).toBe(JOIN);
    expect(entry.url).not.toContain(INVITE);
    expect(entry.url).not.toContain(QUERY_CODE);
    expect(entry.method).toBe('POST');
  }
}

test('the seat is unlisted, and the service address lives in one config', () => {
  const html = fs.readFileSync(path.join(root, 'guest/index.html'), 'utf8');
  const src = fs.readFileSync(path.join(root, 'assets/guest-room.js'), 'utf8');
  const cfg = JSON.parse(fs.readFileSync(path.join(root, 'data/guest-join.json'), 'utf8'));
  const sitemap = fs.readFileSync(path.join(root, 'sitemap.xml'), 'utf8');
  expect(html).toMatch(/<meta name="robots" content="noindex">/);
  expect(sitemap).not.toMatch(/\/guest/);
  expect(cfg.serviceUrl).toBe('https://conference-guest.sfdc24.com');
  expect(html).not.toContain('conference-guest');
  expect(src).not.toContain('conference-guest.sfdc24.com');
  expect(src).not.toMatch(/location\.search|location\.href|document\.URL|URLSearchParams|console\./);
  expect(src).toContain('location.hash');
  expect(src).toContain('setMicrophoneEnabled');
  expect(src).not.toContain('setCameraEnabled');
  expect(src).not.toContain('setScreenShareEnabled');
  expect(src).toContain('setLogLevel');
  expect(src).toContain('LogLevel.silent');
  expect(src).toContain('scr_');
  expect(src).toContain('RETRY_MS = 10000');
  const footer = (html.match(/<footer class="chrome-foot"[\s\S]*?<\/footer>/) || [''])[0];
  expect(footer).not.toMatch(/<p\b/i);
  expect(html).not.toMatch(/\b(Claude|Gemini|LiveKit|OpenAI|Grok)\b/);
});

test('a missing hash does not call the join service, even when a query code is present', async ({ page }) => {
  await page.goto('http://site.test/guest/?token=' + QUERY_CODE);
  await expect(page.locator('#guest-status')).toHaveText('This invite is missing its code.');
  expect(joins).toEqual([]);
  await expect(page.locator('#guest-stage')).toBeHidden();
  await expect(page.locator('#chrome-mic')).toHaveCount(0);
  const html = await page.locator('#guest').innerHTML();
  expect(html).not.toContain(QUERY_CODE);
  expectNoSecretLeak();
});

test('the hash is the only invite code posted, and the media room is mic only', async ({ page }) => {
  joinHandler = (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ url: MEDIA_URL, token: MEDIA }),
  });
  await page.goto('http://site.test/guest/?token=' + QUERY_CODE + '#' + INVITE);
  await expect(page.locator('#guest-status')).toHaveText('In the call.');
  expect(postedBodies()).toEqual([{ token: INVITE, device: expect.any(String) }]);
  expect(postedBodies()[0].device).not.toBe(INVITE);
  const room = await page.evaluate(() => {
    const live = window.__guestRooms[0];
    return {
      url: live.url,
      token: live.token,
      mic: live.localParticipant.micEnabled,
      camera: live.localParticipant.cameraEnabled,
      screen: live.localParticipant.screenEnabled,
    };
  });
  expect(room).toEqual({ url: MEDIA_URL, token: MEDIA, mic: true, camera: null, screen: null });
  const html = await page.locator('body').innerHTML();
  expect(html).not.toContain(INVITE);
  expect(html).not.toContain(MEDIA);
  const stored = await page.evaluate(() => {
    function dump(store) {
      const out = {};
      for (let i = 0; i < store.length; i++) {
        const key = store.key(i);
        out[key] = store.getItem(key);
      }
      return out;
    }
    return JSON.stringify({ s: dump(sessionStorage), l: dump(localStorage) });
  });
  expect(stored).not.toContain(INVITE);
  expect(stored).not.toContain(MEDIA);
  expectNoSecretLeak();
});

test('a token= prefix inside the hash is the invite code, and the query is still ignored', async ({ page }) => {
  joinHandler = (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ url: MEDIA_URL, token: MEDIA }),
  });
  await page.goto('http://site.test/guest/?token=' + QUERY_CODE + '#token=' + INVITE);
  await expect(page.locator('#guest-status')).toHaveText('In the call.');
  expect(postedBodies()[0].token).toBe(INVITE);
  expectNoSecretLeak();
});

test('the shared screen is large and other people sit in a row, with mute and leave', async ({ page }) => {
  joinHandler = (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ serverUrl: 'https://media.example/live', accessToken: MEDIA }),
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('http://site.test/guest/#' + INVITE);
  await expect(page.locator('#guest-status')).toHaveText('In the call.');
  await page.evaluate(() => {
    const live = window.__guestRooms[0];
    const screen = live.addRemote('scr_host', 'Board');
    const alex = live.addRemote('alex', 'Alex');
    live.addTrack(screen, 'video');
    live.addTrack(screen, 'audio');
    live.addTrack(alex, 'video');
    live.addTrack(alex, 'audio');
  });
  await expect(page.locator('#guest-screen-videos video')).toHaveCount(1);
  await expect(page.locator('#guest-people [data-person="scr_host"]')).toHaveCount(0);
  await expect(page.locator('#guest-people [data-person="alex"]')).toBeVisible();
  await expect(page.locator('#guest-people [data-person="local"]')).toContainText('Guest');
  await expect(page.locator('#guest-audio audio')).toHaveCount(2);
  const layout = await page.evaluate(() => {
    const rect = (el) => {
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, left: r.left, height: r.height, width: r.width };
    };
    return {
      screen: rect(document.getElementById('guest-screen')),
      people: rect(document.getElementById('guest-people')),
      blocks: [...document.querySelectorAll('.guest-person')].map(rect),
      sideways: document.scrollingElement.scrollWidth - document.scrollingElement.clientWidth,
    };
  });
  expect(layout.screen.height).toBeGreaterThan(layout.people.height);
  expect(layout.screen.bottom).toBeLessThanOrEqual(layout.people.top + 1);
  expect(layout.blocks.length).toBe(2);
  expect(Math.abs(layout.blocks[0].top - layout.blocks[1].top)).toBeLessThanOrEqual(2);
  expect(layout.blocks[1].left).toBeGreaterThan(layout.blocks[0].left);
  expect(layout.sideways).toBeLessThanOrEqual(1);

  await page.getByRole('button', { name: 'Mute' }).click();
  await expect(page.getByRole('button', { name: 'Unmute' })).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => window.__guestRooms[0].localParticipant.micEnabled)).toBe(false);

  await page.getByRole('button', { name: 'Leave' }).click();
  await expect(page.locator('#guest-status')).toHaveText('Left the call.');
  expect(await page.evaluate(() => window.__guestRooms[0].disconnected)).toBe(true);
  expect(new URL(page.url()).hash).toBe('');
  expect(page.url()).not.toContain(INVITE);
  await expect(page.locator('#guest-stage')).toBeHidden();
  expectNoSecretLeak();
});

test('a not-started call waits and retries every 10 seconds from the same device', async ({ page }) => {
  await page.clock.install();
  let calls = 0;
  joinHandler = (route) => {
    calls += 1;
    if (calls < 3) {
      return route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'the call has not started' }),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ url: MEDIA_URL, token: MEDIA }),
    });
  };
  await page.goto('http://site.test/guest/#' + INVITE);
  await expect(page.locator('#guest-status')).toHaveText('The call has not started. Waiting.');
  expect(joins).toHaveLength(1);
  // Real time keeps moving until the clock is paused, so a 9999ms jump can
  // already be past a timer that was armed a moment ago. Pause first, then
  // prove a short jump does not retry and a further 10s jump does.
  await page.clock.pauseAt(Date.now());
  await page.clock.fastForward(4000);
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(joins).toHaveLength(1);
  await page.clock.fastForward(10000);
  await expect.poll(() => joins.length).toBe(2);
  expect(postedBodies()[0].device).toBe(postedBodies()[1].device);
  expect(postedBodies()[0].token).toBe(INVITE);
  await page.clock.fastForward(10000);
  await expect(page.locator('#guest-status')).toHaveText('In the call.');
  expect(joins).toHaveLength(3);
  expectNoSecretLeak();
});

test('a not_started code waits, and Leave stops the retry', async ({ page }) => {
  await page.clock.install();
  joinHandler = (route) => route.fulfill({
    status: 409,
    contentType: 'application/json',
    body: JSON.stringify({ code: 'call_not_started' }),
  });
  await page.goto('http://site.test/guest/#token=' + INVITE);
  await expect(page.locator('#guest-status')).toHaveText('The call has not started. Waiting.');
  await page.getByRole('button', { name: 'Leave' }).click();
  await page.clock.pauseAt(Date.now());
  await page.clock.fastForward(10000);
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(joins).toHaveLength(1);
  await expect(page.locator('#guest-status')).toHaveText('Left the call.');
  expectNoSecretLeak();
});

test('a different 409 does not retry', async ({ page }) => {
  await page.clock.install();
  joinHandler = (route) => route.fulfill({
    status: 409,
    contentType: 'text/plain',
    body: 'already used',
  });
  await page.goto('http://site.test/guest/#' + INVITE);
  await expect(page.locator('#guest-status')).toHaveText('The call could not be joined.');
  await page.clock.pauseAt(Date.now());
  await page.clock.fastForward(10000);
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(joins).toHaveLength(1);
  expectNoSecretLeak();
});

test('the real media client is on the page and stays quiet without an invite', async ({ page }) => {
  mockMedia = false;
  await page.goto('http://site.test/guest/?token=' + QUERY_CODE);
  await expect(page.locator('#guest-status')).toHaveText('This invite is missing its code.');
  const ready = await page.evaluate(() => ({
    room: typeof window.LivekitClient.Room,
    silence: typeof window.LivekitClient.setLogLevel,
    level: window.LivekitClient.LogLevel.silent,
  }));
  expect(ready).toEqual({ room: 'function', silence: 'function', level: 5 });
  expect(joins).toEqual([]);
  expectNoSecretLeak();
});
