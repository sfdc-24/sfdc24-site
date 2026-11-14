// /guest/ is the invited seat. A hash code joins on its own. With no hash,
// the page shows one box labeled "Enter your code" and a Join button.
// A query-string code is ignored. The posted code is the hash, or exactly
// what was typed. The code is not written into the page, storage, or the console.
const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const INVITE = 'invite-hash-token';
const QUERY_CODE = 'invite-query-token';
const MEDIA = 'media-access-token';
const MEDIA_URL = 'wss://media.example/live';
const SERVICE = 'https://conference-guest-96522051727.us-central1.run.app';
const JOIN = SERVICE + '/api/guest/join';
const ID_OK = /^[A-Za-z0-9_-]{16,128}$/;

async function pauseGuestClock(page) {
  // pauseAt(Date.now()) races the page clock: by the time the call arrives
  // the browser is already past that timestamp. Step a short way ahead of
  // the page clock, still inside the 10 second retry.
  const pageNow = await page.evaluate(() => Date.now());
  await page.clock.pauseAt(pageNow + 1000);
}

function successBody(extra) {
  return JSON.stringify(Object.assign({
    livekit_url: MEDIA_URL,
    room: 'room-1',
    identity: 'gst_0123456789abcdef',
    join_token: MEDIA,
    join_expires_at: 1,
    name: 'Ada',
    deadline: 2,
  }, extra || {}));
}

const MOCK = `
(function () {
  function Participant(identity, name, isLocal) {
    this.identity = identity;
    this.name = name || "";
    this.isLocal = !!isLocal;
    this.audioTrackPublications = new Map();
    this.videoTrackPublications = new Map();
  }
  function bindLocal(p) {
    p.micEnabled = null;
    p.cameraEnabled = null;
    p.screenEnabled = null;
    p._micWait = [];
    p.setMicrophoneEnabled = function (on) {
      p.micEnabled = on;
      if (window.__holdMic) {
        return new Promise(function (resolve, reject) {
          p._micWait.push(function (ok) {
            if (ok === false) reject(new Error("mic"));
            else resolve();
          });
        });
      }
      return Promise.resolve();
    };
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
    if (window.__holdConnect) {
      var room = this;
      return new Promise(function (resolve, reject) {
        room._connectWait = function (ok) {
          if (ok === false) reject(new Error("connect"));
          else resolve();
        };
      });
    }
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
  Room.prototype.seedRemote = function (identity, name, kinds) {
    var p = new Participant(identity, name, false);
    this.remoteParticipants.set(identity, p);
    (kinds || []).forEach(function (kind) {
      var track = new MediaTrack(kind);
      var pub = { kind: kind, track: track };
      var map = kind === "audio" ? p.audioTrackPublications : p.videoTrackPublications;
      map.set(kind, pub);
    });
    return p;
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

function isGuestPage(url) {
  let host = String(url.hostname || '').toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  const loopback = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  if (host !== 'site.test' && !loopback) return false;
  return url.protocol === 'http:' || url.protocol === 'https:';
}

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
    if (url.origin === SERVICE) {
      joins.push({
        url: route.request().url(),
        method: route.request().method(),
        body: route.request().postData() || '',
      });
      if (!joinHandler) return route.abort();
      return joinHandler(route);
    }
    if (!isGuestPage(url)) return route.abort();
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
  expect(html).toContain('Enter your code');
  expect(html).toContain('>Join<');
  expect(html).toContain('id="guest-code"');
  expect(html).toMatch(/<p class="guest-offer" id="guest-offer">Assessment, automation, and AI enablement\.<\/p>/);
  expect(src).toContain('localDevPage');
  expect(src).toContain('The signal address must be wss://');
  expect(html).not.toMatch(/<input[^>]*\sname=/);
  expect(sitemap).not.toMatch(/\/guest/);
  expect(cfg.serviceUrl).toBe(SERVICE);
  // The Content-Security-Policy tag must name the service in connect-src.
  // tools/site_csp.py reads it from the config, so the config stays the one
  // place the address is written; the tag is checked to follow it.
  const policy = (html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]*)">/) || [])[1] || '';
  const markup = html.replace(/<meta http-equiv="Content-Security-Policy" content="[^"]*">/, '');
  const connect = policy.split(';').map((d) => d.trim().split(/\s+/)).find((d) => d[0] === 'connect-src') || [];
  expect(connect).toContain(cfg.serviceUrl);
  expect(markup).not.toContain('conference-guest');
  expect(src).not.toContain(SERVICE);
  expect(src).not.toContain('conference-guest.sfdc24.com');
  expect(src).toContain('join_nonce');
  expect(src).toContain('livekit_url');
  expect(src).toContain('join_token');
  expect(src).not.toContain('accessToken');
  expect(src).not.toContain('serverUrl');
  expect(src).not.toMatch(/location\.href|document\.URL|URLSearchParams|console\./);
  expect(src).toContain('location.pathname + location.search');
  expect(src).not.toContain('Math.random');
  expect(src).toContain('new URL(');
  expect(src).toContain('parsed.protocol !== "https:"');
  expect(src).not.toContain('pointerdown');
  expect(src).toContain('"click", unlockAudio');
  expect(src).toContain('location.hash');
  expect(src).toContain('setMicrophoneEnabled');
  expect(src).not.toContain('setCameraEnabled');
  expect(src).not.toContain('setScreenShareEnabled');
  expect(src).toContain('setLogLevel');
  expect(src).toContain('LogLevel.silent');
  expect(src).toContain('JSON.stringify({ code: code, device: device, join_nonce: nonce })');
  expect(src).not.toMatch(/JSON\.stringify\(\{\s*token:/);
  expect(src).toContain('presenter');
  expect(src).toContain('Too many invalid codes. Wait ten minutes.');
  expect(src).toContain('scr_');
  expect(src).toContain('prs_');
  expect(src).toContain('bnd_');
  expect(src).toContain('RETRY_MS = 10000');
  const footer = (html.match(/<footer class="chrome-foot"[\s\S]*?<\/footer>/) || [''])[0];
  expect(footer).not.toMatch(/<p\b/i);
  expect(html).not.toMatch(/\b(Claude|Gemini|LiveKit|OpenAI|Grok)\b/);
});

test('a missing hash shows only the code box, and a query code is ignored', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('http://site.test/guest/?token=' + QUERY_CODE);
  await expect(page.locator('#guest-enter')).toBeVisible();
  await expect(page.getByLabel('Enter your code')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Join' })).toBeVisible();
  await expect(page.locator('#guest-offer')).toBeHidden();
  await expect(page.locator('#guest-offer')).toHaveText('Assessment, automation, and AI enablement.');
  await expect(page.locator('#guest-role')).toBeHidden();
  await expect(page.locator('#guest-status')).toBeHidden();
  await expect(page.locator('#guest-stage')).toBeHidden();
  await expect(page.locator('#guest-mute')).toBeHidden();
  await expect(page.locator('#guest-leave')).toBeHidden();
  const visible = (await page.locator('#guest').innerText()).replace(/\s+/g, ' ').trim();
  expect(visible).toBe('Enter your code Join');
  expect(await page.locator('#guest-code').inputValue()).toBe('');
  expect(joins).toEqual([]);
  await expect(page.locator('#chrome-mic')).toHaveCount(0);
  const html = await page.locator('#guest').innerHTML();
  expect(html).not.toContain(QUERY_CODE);
  const sideways = await page.evaluate(() => document.scrollingElement.scrollWidth - document.scrollingElement.clientWidth);
  expect(sideways).toBeLessThanOrEqual(1);
  await page.getByRole('button', { name: 'Join' }).click();
  await page.getByLabel('Enter your code').fill('   ');
  await page.getByRole('button', { name: 'Join' }).click();
  expect(joins).toEqual([]);
  expect(new URL(page.url()).search).toBe('?token=' + QUERY_CODE);
  expect(new URL(page.url()).hash).toBe('');
  expectNoSecretLeak();
});

test('the hash is the only invite code posted, and the media room is mic only', async ({ page }) => {
  joinHandler = (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: successBody(),
  });
  await page.goto('http://site.test/guest/?token=' + QUERY_CODE + '#' + INVITE);
  await expect(page.locator('#guest-status')).toHaveText('In the call.');
  await expect(page.locator('#guest-enter')).toBeHidden();
  await expect(page.locator('#guest-offer')).toBeVisible();
  const body = postedBodies()[0];
  expect(Object.keys(body).sort()).toEqual(['code', 'device', 'join_nonce']);
  expect(body.code).toBe(INVITE);
  expect(body.device).toMatch(ID_OK);
  expect(body.join_nonce).toMatch(ID_OK);
  expect(body.device).not.toBe(INVITE);
  expect(body.join_nonce).not.toBe(body.device);
  await expect(page.locator('#guest-people [data-person="local"]')).toContainText('Ada');
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

test('an https or public page requires wss, and localhost development may use ws', async ({ page }) => {
  test.setTimeout(45000);
  const cases = [
    ['https://site.test/guest/', 'ws://media.example/live', ''],
    ['https://site.test/guest/', 'http://media.example/live', ''],
    ['https://site.test/guest/', 'ws://localhost:7880/live', ''],
    ['https://site.test/guest/', 'http://127.0.0.1:7880/live', ''],
    ['https://localhost/guest/', 'ws://localhost:7880/live', ''],
    ['http://site.test/guest/', 'ws://media.example/live', ''],
    ['http://site.test/guest/', 'http://localhost:7880/live', ''],
    ['http://localhost/guest/', 'ws://media.example/live', ''],
    ['http://localhost/guest/', 'ws://evil.localhost/live', ''],
    ['http://localhost/guest/', 'ws://user@localhost:7880/live', ''],
    ['https://site.test/guest/', 'wss://media.example/live', 'wss://media.example/live'],
    ['https://site.test/guest/', 'https://media.example/live', 'wss://media.example/live'],
    ['https://site.test/guest/', 'HTTPS://media.example/live', 'wss://media.example/live'],
    ['http://site.test/guest/', 'wss://media.example/live', 'wss://media.example/live'],
    ['http://localhost/guest/', 'wss://media.example/live', 'wss://media.example/live'],
    ['http://localhost/guest/', 'ws://localhost:7880/live', 'ws://localhost:7880/live'],
    ['http://localhost/guest/', 'http://localhost:7880/live', 'ws://localhost:7880/live'],
    ['http://localhost/guest/', 'ws://127.0.0.1:7880/live', 'ws://127.0.0.1:7880/live'],
    ['http://127.0.0.1/guest/', 'ws://127.0.0.1:7880/live', 'ws://127.0.0.1:7880/live'],
    ['http://127.0.0.1/guest/', 'http://[::1]:7880/live', 'ws://[::1]:7880/live'],
    ['http://[::1]/guest/', 'ws://[::1]:7880/live', 'ws://[::1]:7880/live'],
  ];
  for (let i = 0; i < cases.length; i++) {
    const [pageUrl, livekit, roomUrl] = cases[i];
    const label = livekit + ' on ' + pageUrl;
    joins = [];
    joinHandler = (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: successBody({ livekit_url: livekit }),
    });
    // A new query forces a fresh document. The same hash on the same origin
    // would otherwise leave the previous room in place.
    await page.goto(pageUrl + '?n=' + i + '#' + INVITE);
    if (roomUrl) {
      await expect(page.locator('#guest-status'), label).toHaveText('In the call.');
      const room = await page.evaluate(() => {
        const live = window.__guestRooms[0];
        return { url: live.url, token: live.token };
      });
      expect(room, label).toEqual({ url: roomUrl, token: MEDIA });
    } else {
      await expect(page.locator('#guest-status'), label).toHaveText('The call could not be joined.');
      expect(await page.evaluate(() => window.__guestRooms || []), label).toEqual([]);
    }
    const html = await page.locator('body').innerHTML();
    expect(html, label).not.toContain(MEDIA);
    expect(html, label).not.toContain(INVITE);
  }
  expectNoSecretLeak();
});

test('a late connect after disconnect does not restore the ended call', async ({ page }) => {
  await page.addInitScript(() => { window.__holdConnect = true; window.__holdMic = true; });
  joinHandler = (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: successBody(),
  });
  await page.goto('http://site.test/guest/#' + INVITE);
  await expect.poll(() => page.evaluate(() => (window.__guestRooms || []).length)).toBe(1);
  await page.evaluate(() => { window.__guestRooms[0].emit('disconnected'); });
  await expect(page.locator('#guest-status')).toHaveText('The call ended.');
  await page.evaluate(() => { window.__guestRooms[0]._connectWait(true); });
  await expect(page.locator('#guest-status')).toHaveText('The call ended.');
  await page.evaluate(() => {
    const waits = window.__guestRooms[0].localParticipant._micWait || [];
    if (waits[0]) waits[0](false);
  });
  await expect(page.locator('#guest-status')).toHaveText('The call ended.');
  await expect(page.locator('#guest-mute')).toBeHidden();
  await expect(page.locator('#guest-stage')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Leave' })).toBeVisible();
  await page.getByRole('button', { name: 'Leave' }).click();
  await expect(page.locator('#guest-status')).toHaveText('Left the call.');
  await expect(page.locator('#guest-enter')).toBeVisible();
  expectNoSecretLeak();
});

test('a late microphone result after disconnect does not overwrite the next room', async ({ page }) => {
  await page.addInitScript(() => { window.__holdConnect = true; window.__holdMic = true; });
  joinHandler = (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: successBody(),
  });
  const nextCode = 'next-seat-code';
  await page.goto('http://site.test/guest/#' + INVITE);
  await expect.poll(() => page.evaluate(() => (window.__guestRooms || []).length)).toBe(1);
  await page.evaluate(() => { window.__guestRooms[0].emit('disconnected'); });
  await expect(page.locator('#guest-status')).toHaveText('The call ended.');
  await page.evaluate((code) => { location.hash = code; }, nextCode);
  await expect.poll(() => page.evaluate(() => (window.__guestRooms || []).length)).toBe(2);
  await expect(page.locator('#guest-status')).toHaveText('Checking the invite.');
  await page.evaluate(() => {
    const first = window.__guestRooms[0];
    first._connectWait(true);
    const waits = first.localParticipant._micWait || [];
    if (waits[0]) waits[0](false);
    first.emit('disconnected');
  });
  await expect(page.locator('#guest-status')).toHaveText('Checking the invite.');
  expect(await page.evaluate(() => window.__guestRooms[1].disconnected)).toBe(false);
  await expect(page.locator('#guest-stage')).toBeHidden();
  await page.evaluate(() => { window.__guestRooms[1]._connectWait(true); });
  await expect(page.locator('#guest-status')).toHaveText('In the call.');
  expect(await page.evaluate(() => window.__guestRooms[1].disconnected)).toBe(false);
  await page.evaluate(() => { window.__guestRooms[1].emit('disconnected'); });
  await expect(page.locator('#guest-status')).toHaveText('The call ended.');
  await page.evaluate(() => {
    const waits = window.__guestRooms[1].localParticipant._micWait || [];
    waits[0](false);
  });
  await expect(page.locator('#guest-status')).toHaveText('The call ended.');
  await expect(page.locator('#guest-mute')).toBeHidden();
  await expect(page.locator('#guest-stage')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Leave' })).toBeVisible();
  const pageText = await page.evaluate(() => document.body.innerText);
  expect(pageText).not.toContain(nextCode);
  expect(pageText).not.toContain('microphone is off');
  expectNoSecretLeak();
});

test('a microphone reply after Leave does not rewrite the departed call', async ({ page }) => {
  await page.addInitScript(() => { window.__holdMic = true; });
  joinHandler = (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: successBody(),
  });
  await page.goto('http://site.test/guest/#' + INVITE);
  await expect(page.locator('#guest-status')).toHaveText('In the call.');
  await page.getByRole('button', { name: 'Leave' }).click();
  await expect(page.locator('#guest-status')).toHaveText('Left the call.');
  await page.evaluate(() => {
    const waits = window.__guestRooms[0].localParticipant._micWait;
    waits[0](false);
  });
  await expect(page.locator('#guest-status')).toHaveText('Left the call.');
  await expect(page.locator('#guest-mute')).toBeHidden();
  await expect(page.locator('#guest-enter')).toBeVisible();
  expect(await page.locator('#guest-code').inputValue()).toBe('');
  expectNoSecretLeak();
});

test('a presenter role is refused and the call stays closed', async ({ page }) => {
  joinHandler = (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: successBody({ role: 'presenter', name: 'Ada' }),
  });
  await page.goto('http://site.test/guest/#' + INVITE);
  await expect(page.locator('#guest-status')).toHaveText('This page is for guests. A presenter cannot join here.');
  await expect(page.locator('#guest-stage')).toBeHidden();
  await expect(page.locator('#guest-mute')).toBeHidden();
  await expect(page.locator('#guest-enter')).toBeHidden();
  expect(await page.evaluate(() => window.__guestRooms || [])).toEqual([]);
  expect(postedBodies()[0].code).toBe(INVITE);
  const html = await page.locator('body').innerHTML();
  expect(html).not.toContain(INVITE);
  expect(html).not.toContain(MEDIA);
  expectNoSecretLeak();
});

test('a guest role still joins', async ({ page }) => {
  joinHandler = (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: successBody({ role: 'guest' }),
  });
  await page.goto('http://site.test/guest/#' + INVITE);
  await expect(page.locator('#guest-status')).toHaveText('In the call.');
  expect(postedBodies()[0].code).toBe(INVITE);
  expect(await page.evaluate(() => window.__guestRooms.length)).toBe(1);
  expectNoSecretLeak();
});

test('a typed presenter code is refused and the box comes back empty', async ({ page }) => {
  joinHandler = (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: successBody({ role: ' presenter ' }),
  });
  const typed = 'prsnt-code';
  await page.goto('http://site.test/guest/');
  await page.getByLabel('Enter your code').fill(typed);
  await page.getByRole('button', { name: 'Join' }).click();
  await expect(page.locator('#guest-status')).toHaveText('This page is for guests. A presenter cannot join here.');
  await expect(page.locator('#guest-enter')).toBeVisible();
  expect(await page.locator('#guest-code').inputValue()).toBe('');
  expect(await page.evaluate(() => window.__guestRooms || [])).toEqual([]);
  const pageText = await page.evaluate(() => document.body.innerText);
  expect(pageText).not.toContain(typed);
  expectNoSecretLeak();
});

test('the old url-and-token body does not join, and a percent-encoded hash is posted whole', async ({ page }) => {
  joinHandler = (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ url: MEDIA_URL, token: MEDIA }),
  });
  await page.goto('http://site.test/guest/#' + INVITE);
  await expect(page.locator('#guest-status')).toHaveText('The call could not be joined.');
  expect(await page.evaluate(() => window.__guestRooms || [])).toEqual([]);

  joins = [];
  joinHandler = (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: successBody(),
  });
  await page.goto('http://site.test/guest/?token=' + QUERY_CODE + '#ada%2Dkept');
  await expect(page.locator('#guest-status')).toHaveText('In the call.');
  expect(postedBodies()[0].code).toBe('ada-kept');
  expectNoSecretLeak();
});

test('a hash keeps its spaces, and Leave keeps the query string', async ({ page }) => {
  joinHandler = (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: successBody(),
  });
  await page.goto('http://site.test/guest/?token=' + QUERY_CODE + '#%20ada%20kept%20');
  await expect(page.locator('#guest-status')).toHaveText('In the call.');
  expect(postedBodies()[0].code).toBe(' ada kept ');
  await page.getByRole('button', { name: 'Leave' }).click();
  const url = new URL(page.url());
  expect(url.hash).toBe('');
  expect(url.search).toBe('?token=' + QUERY_CODE);
  expect(joins).toHaveLength(1);
  const pageText = await page.evaluate(() => document.body.innerText);
  expect(pageText).not.toContain('ada kept');
  expectNoSecretLeak();
});

test('an all-whitespace hash does not join', async ({ page }) => {
  await page.goto('http://site.test/guest/#%20%20%20');
  await expect(page.locator('#guest-enter')).toBeVisible();
  await expect(page.locator('#guest-offer')).toBeHidden();
  await expect(page.locator('#guest-status')).toBeHidden();
  expect(joins).toEqual([]);
});

test('the shared screen is large and other people sit in a row, with mute and leave', async ({ page }) => {
  joinHandler = (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: successBody({ name: 'Ada' }),
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('http://site.test/guest/#' + INVITE);
  await expect(page.locator('#guest-status')).toHaveText('In the call.');
  await page.evaluate(() => {
    const live = window.__guestRooms[0];
    const screen = live.addRemote('scr_host', 'Board');
    const upcoming = live.addRemote('prs_deck', 'Slides');
    const alex = live.addRemote('alex', 'Alex');
    live.addTrack(screen, 'video');
    live.addTrack(screen, 'audio');
    live.addTrack(upcoming, 'video');
    live.addTrack(alex, 'video');
    live.addTrack(alex, 'audio');
  });
  await expect(page.locator('#guest-screen-videos video')).toHaveCount(2);
  await expect(page.locator('#guest-screen-videos video[data-from="scr_host"]')).toHaveCount(1);
  await expect(page.locator('#guest-screen-videos video[data-from="prs_deck"]')).toHaveCount(1);
  await expect(page.locator('#guest-people [data-person="scr_host"]')).toHaveCount(0);
  await expect(page.locator('#guest-people [data-person="prs_deck"]')).toHaveCount(0);
  await expect(page.locator('#guest-people [data-person="alex"]')).toBeVisible();
  await expect(page.locator('#guest-people video')).toHaveCount(0);
  await expect(page.locator('#guest-people [data-person="local"]')).toContainText('Ada');
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

  await page.evaluate(() => {
    window.__guestPlays = 0;
    document.querySelectorAll('audio, video').forEach((el) => {
      el.play = function () { window.__guestPlays += 1; return Promise.resolve(); };
    });
  });
  await page.getByRole('button', { name: 'Mute' }).focus();
  await page.keyboard.press('Enter');
  expect(await page.evaluate(() => window.__guestPlays)).toBeGreaterThan(0);
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

test('a bnd_ identity is not a tile, a roster row, or part of the people count', async ({ page }) => {
  await page.addInitScript(() => { window.__holdConnect = true; });
  joinHandler = (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: successBody({ name: 'Ada' }),
  });
  await page.goto('http://site.test/guest/#' + INVITE);
  await expect.poll(() => page.evaluate(() => (window.__guestRooms || []).length)).toBe(1);
  await page.evaluate(() => {
    const live = window.__guestRooms[0];
    live.seedRemote('bnd_claude', 'Binder Claude', ['video', 'audio']);
    live.seedRemote('scr_host', 'Board', ['video', 'audio']);
    live.seedRemote('alex', 'Alex', ['audio']);
  });
  await page.evaluate(() => { window.__guestRooms[0]._connectWait(true); });
  await expect(page.locator('#guest-status')).toHaveText('In the call.');
  await expect(page.locator('#guest-screen-videos video')).toHaveCount(1);
  await expect(page.locator('#guest-screen-videos video[data-from="scr_host"]')).toHaveCount(1);
  await expect(page.locator('#guest-screen-videos video[data-from^="bnd_"]')).toHaveCount(0);
  await expect(page.locator('#guest-people [data-person="alex"]')).toBeVisible();
  await expect(page.locator('#guest-people [data-person="local"]')).toContainText('Ada');
  await expect(page.locator('#guest-people [data-person^="bnd_"]')).toHaveCount(0);
  await expect(page.locator('#guest-audio audio')).toHaveCount(2);

  await page.evaluate(() => {
    const live = window.__guestRooms[0];
    const binder = live.addRemote('bnd_grok', 'Binder Grok');
    const slides = live.addRemote('prs_deck', 'Slides');
    const near = live.addRemote('nbnd_ada', 'Near Miss');
    live.addTrack(binder, 'video');
    live.addTrack(binder, 'audio');
    live.addTrack(slides, 'video');
    live.addTrack(near, 'audio');
    live.addRemote('bnd_', 'Bare Binder');
  });

  await expect(page.locator('#guest-screen-videos video')).toHaveCount(2);
  const tiles = await page.locator('#guest-screen-videos video').evaluateAll((nodes) => (
    nodes.map((node) => node.getAttribute('data-from')).sort()
  ));
  expect(tiles).toEqual(['prs_deck', 'scr_host']);
  const roster = await page.locator('#guest-people [data-person]').evaluateAll((nodes) => (
    nodes.map((node) => node.getAttribute('data-person')).sort()
  ));
  expect(roster).toEqual(['alex', 'local', 'nbnd_ada']);
  await expect(page.locator('#guest-people [data-person="nbnd_ada"]')).toContainText('Near Miss');
  await expect(page.locator('#guest-audio audio')).toHaveCount(3);
  const visible = await page.locator('#guest').innerText();
  expect(visible).toContain('Ada');
  expect(visible).toContain('Alex');
  expect(visible).toContain('Near Miss');
  expect(visible).not.toContain('Binder Claude');
  expect(visible).not.toContain('Binder Grok');
  expect(visible).not.toContain('Bare Binder');
  expect(visible).not.toContain('bnd_');

  await page.evaluate(() => {
    const live = window.__guestRooms[0];
    live.emit('participantDisconnected', { identity: 'bnd_claude', name: 'Binder Claude', isLocal: false });
    live.emit('participantDisconnected', { identity: 'bnd_grok', name: 'Binder Grok', isLocal: false });
    live.emit('participantDisconnected', { identity: 'bnd_', name: 'Bare Binder', isLocal: false });
  });
  const rosterAfter = await page.locator('#guest-people [data-person]').evaluateAll((nodes) => (
    nodes.map((node) => node.getAttribute('data-person')).sort()
  ));
  expect(rosterAfter).toEqual(['alex', 'local', 'nbnd_ada']);
  await expect(page.locator('#guest-screen-videos video')).toHaveCount(2);
  await expect(page.locator('#guest-audio audio')).toHaveCount(3);
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
      body: successBody(),
    });
  };
  await page.goto('http://site.test/guest/#' + INVITE);
  await expect(page.locator('#guest-status')).toHaveText('The call has not started. Waiting.');
  expect(joins).toHaveLength(1);
  // Real time keeps moving until the clock is paused, so a 9999ms jump can
  // already be past a timer that was armed a moment ago. Pause first, then
  // prove a short jump does not retry and a further 10s jump does.
  await pauseGuestClock(page);
  await page.clock.fastForward(4000);
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(joins).toHaveLength(1);
  await page.clock.fastForward(10000);
  await expect.poll(() => joins.length).toBe(2);
  expect(postedBodies()[0].device).toBe(postedBodies()[1].device);
  expect(postedBodies()[0].code).toBe(INVITE);
  expect(postedBodies()[0].join_nonce).not.toBe(postedBodies()[1].join_nonce);
  expect(postedBodies()[1].join_nonce).toMatch(ID_OK);
  const nonces = postedBodies().map((body) => body.join_nonce);
  const stored = await page.evaluate(() => {
    const out = {};
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i);
      out[key] = sessionStorage.getItem(key);
    }
    return JSON.stringify(out);
  });
  for (const nonce of nonces) expect(stored).not.toContain(nonce);
  await page.clock.fastForward(10000);
  await expect(page.locator('#guest-status')).toHaveText('In the call.');
  expect(joins).toHaveLength(3);
  expectNoSecretLeak();
});

test('a refused device write keeps one device id across 10 second retries', async ({ page }) => {
  await page.addInitScript(() => {
    const setItem = window.sessionStorage.setItem.bind(window.sessionStorage);
    window.sessionStorage.setItem = function (key, value) {
      if (key === 'sfdc24-guest-device') throw new Error('quota');
      return setItem(key, value);
    };
  });
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
      body: successBody(),
    });
  };
  await page.goto('http://site.test/guest/#' + INVITE);
  await expect(page.locator('#guest-status')).toHaveText('The call has not started. Waiting.');
  expect(joins).toHaveLength(1);
  await pauseGuestClock(page);
  await page.clock.fastForward(10000);
  await expect.poll(() => joins.length).toBe(2);
  await page.clock.fastForward(10000);
  await expect(page.locator('#guest-status')).toHaveText('In the call.');
  expect(joins).toHaveLength(3);
  const devices = postedBodies().map((body) => body.device);
  expect(devices[0]).toMatch(ID_OK);
  expect(devices[1]).toBe(devices[0]);
  expect(devices[2]).toBe(devices[0]);
  const nonces = postedBodies().map((body) => body.join_nonce);
  expect(new Set(nonces).size).toBe(3);
  nonces.forEach((nonce) => expect(nonce).toMatch(ID_OK));
  const stored = await page.evaluate(() => sessionStorage.getItem('sfdc24-guest-device'));
  expect(stored).toBeNull();
  expectNoSecretLeak();
});

test('Leave stops a not-started retry', async ({ page }) => {
  await page.clock.install();
  joinHandler = (route) => route.fulfill({
    status: 409,
    contentType: 'application/json',
    body: JSON.stringify({ error: 'the call has not started' }),
  });
  await page.goto('http://site.test/guest/#' + INVITE);
  await expect(page.locator('#guest-status')).toHaveText('The call has not started. Waiting.');
  await page.getByRole('button', { name: 'Leave' }).click();
  await pauseGuestClock(page);
  await page.clock.fastForward(10000);
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(joins).toHaveLength(1);
  await expect(page.locator('#guest-status')).toHaveText('Left the call.');
  expectNoSecretLeak();
});

for (const refusal of [
  { status: 409, body: { error: 'the call is full' }, text: 'The call is full.' },
  { status: 409, body: { error: 'call_not_started' }, text: 'The call could not be joined.' },
  { status: 403, body: { error: 'this invite is not valid' }, text: 'This invite is not valid.' },
  { status: 429, body: { error: 'too many invalid codes' }, text: 'Too many invalid codes. Wait ten minutes.' },
  { status: 503, body: { error: 'the call could not be reached; try again' }, text: 'The call could not be reached.' },
]) {
  test(`HTTP ${refusal.status} ${refusal.body.error} does not retry`, async ({ page }) => {
    await page.clock.install();
    joinHandler = (route) => route.fulfill({
      status: refusal.status,
      contentType: 'application/json',
      body: JSON.stringify(refusal.body),
    });
    await page.goto('http://site.test/guest/#' + INVITE);
    await expect(page.locator('#guest-status')).toHaveText(refusal.text);
    await pauseGuestClock(page);
    await page.clock.fastForward(10000);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(joins).toHaveLength(1);
    expectNoSecretLeak();
  });
}

test('a typed code is posted unchanged, then retried with a new nonce', async ({ page }) => {
  await page.clock.install();
  const typed = 'Ab cde-FGHIJ';
  let calls = 0;
  joinHandler = (route) => {
    calls += 1;
    if (calls < 2) {
      return route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'the call has not started' }),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: successBody(),
    });
  };
  await page.goto('http://site.test/guest/?token=' + QUERY_CODE);
  await page.getByLabel('Enter your code').fill(typed);
  await page.getByLabel('Enter your code').press('Enter');
  await expect(page.locator('#guest-status')).toHaveText('The call has not started. Waiting.');
  await expect(page.locator('#guest-enter')).toBeHidden();
  expect(await page.locator('#guest-code').inputValue()).toBe('');
  expect(postedBodies()[0].code).toBe(typed);
  expect(postedBodies()[0].device).toMatch(ID_OK);
  expect(postedBodies()[0].join_nonce).toMatch(ID_OK);
  expect(page.url()).not.toContain(encodeURIComponent(typed));
  expect(page.url()).not.toContain('Ab');
  expect(new URL(page.url()).hash).toBe('');
  const pageText = await page.evaluate(() => document.body.innerText);
  expect(pageText).not.toContain(typed);
  expect(pageText).not.toContain('FGHIJ');
  await pauseGuestClock(page);
  await page.clock.fastForward(10000);
  await expect(page.locator('#guest-status')).toHaveText('In the call.');
  expect(joins).toHaveLength(2);
  expect(postedBodies()[1].code).toBe(typed);
  expect(postedBodies()[1].device).toBe(postedBodies()[0].device);
  expect(postedBodies()[1].join_nonce).not.toBe(postedBodies()[0].join_nonce);
  expect(await page.locator('#guest-code').inputValue()).toBe('');
  await expect(page.locator('#guest-enter')).toBeHidden();
  await expect(page.locator('#guest-mute')).toBeVisible();
  await expect(page.locator('#guest-leave')).toBeVisible();
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
  expect(stored).not.toContain(typed);
  expect(logs.join('\n')).not.toContain(typed);
  expect(stored).not.toContain(postedBodies()[0].join_nonce);
  expect(stored).not.toContain(postedBodies()[1].join_nonce);
  const html = await page.locator('body').innerHTML();
  expect(html).not.toContain(typed);
  expect(html).not.toContain(MEDIA);
  expectNoSecretLeak();
});

test('adding a hash on the open page joins and hides the code box', async ({ page }) => {
  joinHandler = (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: successBody(),
  });
  await page.goto('http://site.test/guest/');
  await expect(page.locator('#guest-enter')).toBeVisible();
  await page.evaluate((code) => { location.hash = code; }, INVITE);
  await expect(page.locator('#guest-status')).toHaveText('In the call.');
  await expect(page.locator('#guest-enter')).toBeHidden();
  expect(postedBodies()[0].code).toBe(INVITE);
  expect(new URL(page.url()).search).toBe('');
  const html = await page.locator('body').innerHTML();
  expect(html).not.toContain(INVITE);
  expect(html).not.toContain(MEDIA);
  expectNoSecretLeak();
});

test('a hash join that cannot be reached keeps the code box hidden', async ({ page }) => {
  await page.goto('http://site.test/guest/#' + INVITE);
  await expect(page.locator('#guest-status')).toHaveText('The call could not be reached.');
  await expect(page.locator('#guest-enter')).toBeHidden();
  await expect(page.locator('#guest-leave')).toBeVisible();
  const html = await page.locator('body').innerHTML();
  expect(html).not.toContain(INVITE);
  expectNoSecretLeak();
});

test('a refused typed code does not retry, and the box comes back empty', async ({ page }) => {
  await page.clock.install();
  const typed = 'zzzzz-zzzzz';
  joinHandler = (route) => route.fulfill({
    status: 403,
    contentType: 'application/json',
    body: JSON.stringify({ error: 'this invite is not valid' }),
  });
  await page.goto('http://site.test/guest/');
  await page.getByLabel('Enter your code').fill(typed);
  await page.getByRole('button', { name: 'Join' }).click();
  await expect(page.locator('#guest-status')).toHaveText('This invite is not valid.');
  await expect(page.locator('#guest-enter')).toBeVisible();
  await expect(page.locator('#guest-offer')).toBeHidden();
  expect(await page.locator('#guest-code').inputValue()).toBe('');
  await pauseGuestClock(page);
  await page.clock.fastForward(10000);
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(joins).toHaveLength(1);
  expect(postedBodies()[0].code).toBe(typed);
  expect(new URL(page.url()).hash).toBe('');
  expect(page.url()).not.toContain(typed);
  const pageText = await page.evaluate(() => document.body.innerText);
  expect(pageText).not.toContain(typed);
  expectNoSecretLeak();
});

test('the real media client is on the page and stays quiet without an invite', async ({ page }) => {
  mockMedia = false;
  await page.goto('http://site.test/guest/?token=' + QUERY_CODE);
  await expect(page.locator('#guest-enter')).toBeVisible();
  await expect(page.locator('#guest-status')).toBeHidden();
  const ready = await page.evaluate(() => ({
    room: typeof window.LivekitClient.Room,
    silence: typeof window.LivekitClient.setLogLevel,
    level: window.LivekitClient.LogLevel.silent,
  }));
  expect(ready).toEqual({ room: 'function', silence: 'function', level: 5 });
  expect(joins).toEqual([]);
  expectNoSecretLeak();
});
