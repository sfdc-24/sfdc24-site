// /present/ shares a screen into the owner's call.
// A hash code is bookmarkable. With no hash, the page shows one box labeled
// "Enter your code". A query-string code is ignored. The posted field is
// `code` (conference guest_app.py). The code is not written into the page,
// storage, or the console. A 200 connects only for role "presenter" (never
// "guest") with a prs_ or scr_ identity and a screen_share-only grant that
// does not subscribe. canPublishData must be false; an omitted data grant
// is refused. The join origin must be https. The signal address must be
// wss, except a loopback page may use ws to a loopback host. A 429
// invalid-code lockout stops the share.
const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const CODE = 'present-hash-code';
const QUERY_CODE = 'present-query-code';
const MEDIA_URL = 'wss://media.example/live';
const SERVICE = 'https://conference-guest-96522051727.us-central1.run.app';
const JOIN = SERVICE + '/api/guest/join';
const IDENTITY = 'scr_0123456789abcdef';
const ID_OK = /^[A-Za-z0-9_-]{16,128}$/;
const ON_AIR = 'This screen is in the call. The owner sees it, and the voices are told what is on it.';
const READY = 'Ready to share.';

function b64url(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function screenToken(video, sub) {
  return b64url({ alg: 'none', typ: 'JWT' }) + '.' + b64url(Object.assign({
    sub: sub || IDENTITY,
    video: video,
  })) + '.e30';
}

function screenVideo(extra) {
  return Object.assign({
    roomJoin: true,
    room: 'room-1',
    canPublish: true,
    canSubscribe: false,
    canPublishData: false,
    canPublishSources: ['screen_share'],
  }, extra || {});
}

function screenVideoWithoutData() {
  const video = screenVideo();
  delete video.canPublishData;
  return video;
}

function presenterBody(extra) {
  const video = extra && extra.video ? extra.video : screenVideo();
  const identity = extra && extra.identity ? extra.identity : IDENTITY;
  const token = extra && Object.prototype.hasOwnProperty.call(extra, 'join_token')
    ? extra.join_token
    : screenToken(video, identity);
  const body = {
    livekit_url: MEDIA_URL,
    room: 'room-1',
    identity: identity,
    role: 'presenter',
    join_token: token,
    join_expires_at: 1,
    name: 'Screen',
    deadline: 2,
  };
  if (extra) {
    Object.keys(extra).forEach((key) => {
      if (key === 'video') return;
      body[key] = extra[key];
    });
  }
  return JSON.stringify(body);
}

const MOCK = `
(function () {
  function Participant() {
    this.micCalls = 0;
    this.published = [];
    this.setMicrophoneEnabled = function () {
      this.micCalls += 1;
      return Promise.resolve();
    };
  }
  function Room() {
    this.localParticipant = new Participant();
    this.remoteParticipants = new Map();
    this._handlers = {};
    this.url = "";
    this.token = "";
    this.opts = null;
    this.disconnected = false;
    window.__presentRooms = window.__presentRooms || [];
    window.__presentRooms.push(this);
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
  Room.prototype.connect = function (url, token, opts) {
    this.url = url;
    this.token = token;
    this.opts = opts || null;
    return Promise.resolve();
  };
  Room.prototype.disconnect = function () {
    this.disconnected = true;
    this.emit("disconnected");
    return Promise.resolve();
  };
  Participant.prototype.publishTrack = function (track, opts) {
    this.published.push({ track: track, opts: opts || null });
    return Promise.resolve();
  };
  window.LivekitClient = {
    Room: Room,
    RoomEvent: {
      TrackSubscribed: "trackSubscribed",
      Disconnected: "disconnected"
    },
    Track: { Source: { ScreenShare: "screen_share", Microphone: "microphone" } },
    LogLevel: { silent: 5 },
    setLogLevel: function () {}
  };
})();
`;

const CAPTURE = `
(function () {
  window.__captures = [];
  window.__tracks = [];
  window.__micAsked = 0;
  window.__joinAfterCapture = 0;
  var devices = navigator.mediaDevices || {};
  devices.getUserMedia = function () {
    window.__micAsked += 1;
    return Promise.reject(new Error("mic"));
  };
  devices.getDisplayMedia = function (opts) {
    window.__captures.push(JSON.parse(JSON.stringify(opts)));
    var video = {
      kind: "video",
      readyState: "live",
      stopped: false,
      listeners: {},
      stop: function () { video.readyState = "ended"; video.stopped = true; },
      addEventListener: function (type, fn) { video.listeners[type] = fn; }
    };
    var audio = {
      kind: "audio",
      readyState: "live",
      stopped: false,
      stop: function () { audio.readyState = "ended"; audio.stopped = true; }
    };
    window.__tracks.push(video);
    window.__lastAudio = audio;
    return Promise.resolve({
      getVideoTracks: function () { return [video]; },
      getAudioTracks: function () { return window.__withAudio ? [audio] : []; },
      getTracks: function () { return window.__withAudio ? [video, audio] : [video]; }
    });
  };
  try {
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: devices });
  } catch (err) {
    navigator.mediaDevices = devices;
  }
  var orig = window.fetch;
  window.fetch = function (url) {
    var href = typeof url === "string" ? url : (url && url.url) || "";
    if (String(href).indexOf("/api/guest/join") !== -1) {
      window.__joinAfterCapture = (window.__captures || []).length;
    }
    return orig.apply(this, arguments);
  };
})();
`;

let joins = [];
let joinHandler = null;
let mockMedia = true;
let logs = [];

function isPresentPage(url) {
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
  await page.addInitScript(CAPTURE);
  page.on('console', (msg) => logs.push(msg.text()));
  page.on('pageerror', (err) => logs.push(String(err)));
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === SERVICE) {
      joins.push({
        url: route.request().url(),
        method: route.request().method(),
        body: route.request().postData() || '',
        referer: route.request().headers().referer || '',
      });
      if (!joinHandler) return route.abort();
      return joinHandler(route);
    }
    if (!isPresentPage(url)) return route.abort();
    if (mockMedia && url.pathname === '/assets/present-media-client.js') {
      return route.fulfill({ body: MOCK, contentType: 'application/javascript' });
    }
    return serve(route, url);
  });
});

function postedBodies() {
  return joins.map((entry) => JSON.parse(entry.body));
}

async function jump(page, ms) {
  // pauseAt(Date.now()) uses the test process clock. The page clock runs on
  // performance.now() and can already be ahead, which throws
  // "Cannot fast-forward to the past" before the no-retry check.
  const target = await page.evaluate((delay) => Date.now() + delay, ms);
  await page.clock.pauseAt(target);
}

function expectNoSecretLeak(extra) {
  const text = logs.join('\n');
  const banned = [CODE, QUERY_CODE, IDENTITY, MEDIA_URL].concat(extra || []);
  for (const secret of banned) {
    expect(text).not.toContain(secret);
  }
  for (const entry of joins) {
    expect(entry.url).toBe(JOIN);
    expect(entry.method).toBe('POST');
    expect(entry.referer).toBe('');
    for (const secret of banned) expect(entry.url).not.toContain(secret);
  }
}

async function share(page) {
  await page.getByRole('button', { name: 'Share this screen' }).click();
}

test('the page is unlisted, and the service address lives in one config', () => {
  const html = fs.readFileSync(path.join(root, 'present/index.html'), 'utf8');
  const src = fs.readFileSync(path.join(root, 'assets/present-room.js'), 'utf8');
  const cfg = JSON.parse(fs.readFileSync(path.join(root, 'data/present-join.json'), 'utf8'));
  const sitemap = fs.readFileSync(path.join(root, 'sitemap.xml'), 'utf8');
  expect(html).toMatch(/<meta name="robots" content="noindex">/);
  expect(html).toMatch(/<meta name="referrer" content="no-referrer">/);
  expect(html).toContain('data-chrome-ask="off"');
  expect(html).toContain('Enter your code');
  expect(html).toContain('Share this screen');
  expect(html).toContain('>Stop<');
  expect(html).toContain('SHARING TO THE CONFERENCE');
  expect(html).toContain('id="present-code"');
  expect(html).not.toMatch(/<input[^>]*\sname=/);
  expect(sitemap).not.toMatch(/\/present/);
  expect(cfg.serviceUrl).toBe(SERVICE);
  expect(html).not.toContain('guest-join.json');
  expect(src).not.toContain('guest-join.json');
  expect(src).not.toMatch(/Math\.random/);
  // The Content-Security-Policy tag must name the service in connect-src.
  // tools/site_csp.py reads it from the config, so the config stays the one
  // place the address is written; the tag is checked to follow it.
  const policy = (html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]*)">/) || [])[1] || '';
  const markup = html.replace(/<meta http-equiv="Content-Security-Policy" content="[^"]*">/, '');
  const connect = policy.split(';').map((d) => d.trim().split(/\s+/)).find((d) => d[0] === 'connect-src') || [];
  expect(connect).toContain(cfg.serviceUrl);
  expect(markup).not.toContain('conference-guest');
  expect(src).not.toContain(SERVICE);
  expect(src).toContain('join_nonce');
  expect(src).toContain('livekit_url');
  expect(src).toContain('join_token');
  expect(src).toContain('"code"');
  expect(src).toContain('role !== "presenter"');
  expect(src).toContain('prs_');
  expect(src).toContain('scr_');
  expect(src).toContain('too many invalid codes; wait ten minutes');
  expect(src).toContain('screen_share');
  expect(src).toContain('canPublishData !== false');
  expect(src).toContain('localDevPage');
  expect(src).toContain('loopbackHost');
  expect(src).toContain('The signal address must be wss://');
  expect(src).toContain('parsed.protocol !== "https:"');
  expect(src).toContain('http://[::1]');
  expect(src).toContain('autoSubscribe: false');
  expect(src).toContain('getDisplayMedia');
  expect(src).toContain('RETRY_MS = 10000');
  expect(src).toContain('referrerPolicy: "no-referrer"');
  expect(src).not.toContain('setMicrophoneEnabled');
  expect(src).not.toContain('getUserMedia');
  expect(src).not.toContain('setScreenShareEnabled');
  expect(src).toContain('setLogLevel');
  expect(src).toContain('LogLevel.silent');
  expect(src).not.toMatch(/location\.search|URLSearchParams|console\./);
  expect(src).toContain('location.hash');
  expect(html).not.toMatch(/\b(Claude|Gemini|LiveKit|OpenAI|Grok)\b/);
});

test('a missing hash shows the code box, and a query code is ignored', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('http://site.test/present/?code=' + QUERY_CODE);
  await expect(page.locator('#present-enter')).toBeVisible();
  await expect(page.getByLabel('Enter your code')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Share this screen' })).toBeVisible();
  await expect(page.locator('#present-stop')).toBeHidden();
  await expect(page.locator('#present-on-air')).toBeHidden();
  await expect(page.locator('#present-status')).toHaveText(READY);
  expect(await page.locator('#present-code').inputValue()).toBe('');
  expect(joins).toEqual([]);
  await expect(page.locator('#chrome-mic')).toHaveCount(0);
  const html = await page.locator('#present').innerHTML();
  expect(html).not.toContain(QUERY_CODE);
  const sideways = await page.evaluate(() => document.scrollingElement.scrollWidth - document.scrollingElement.clientWidth);
  expect(sideways).toBeLessThanOrEqual(1);
  await share(page);
  await page.getByLabel('Enter your code').fill('   ');
  await share(page);
  await page.getByLabel('Enter your code').press('Enter');
  expect(joins).toEqual([]);
  expect(await page.evaluate(() => window.__captures.length)).toBe(0);
  expect(new URL(page.url()).search).toBe('?code=' + QUERY_CODE);
  expect(new URL(page.url()).hash).toBe('');
  expectNoSecretLeak();
});

test('a hash code is posted as code and publishes only the screen', async ({ page }) => {
  joinHandler = (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: presenterBody(),
  });
  await page.goto('http://site.test/present/?code=' + QUERY_CODE + '#' + CODE);
  await expect(page.locator('#present-enter')).toBeHidden();
  await share(page);
  await expect(page.locator('#present-status')).toHaveText(ON_AIR);
  await expect(page.locator('#present-on-air')).toHaveText('SHARING TO THE CONFERENCE');
  await expect(page.locator('#present-stop')).toBeVisible();
  await expect(page.locator('#present-share')).toBeHidden();
  const body = postedBodies()[0];
  expect(Object.keys(body).sort()).toEqual(['code', 'device', 'join_nonce']);
  expect(body.code).toBe(CODE);
  expect(body).not.toHaveProperty('token');
  expect(body.device).toMatch(ID_OK);
  expect(body.join_nonce).toMatch(ID_OK);
  expect(body.device).not.toBe(CODE);
  expect(body.join_nonce).not.toBe(body.device);
  const room = await page.evaluate(() => {
    const live = window.__presentRooms[0];
    return {
      url: live.url,
      opts: live.opts,
      micCalls: live.localParticipant.micCalls,
      published: live.localParticipant.published.map((item) => item.opts),
      captures: window.__captures,
      joinAfterCapture: window.__joinAfterCapture,
      micAsked: window.__micAsked,
    };
  });
  expect(room.opts).toEqual({ autoSubscribe: false });
  expect(room.micCalls).toBe(0);
  expect(room.micAsked).toBe(0);
  expect(room.published).toEqual([{ source: 'screen_share' }]);
  expect(room.captures).toEqual([{ video: true, audio: false }]);
  expect(room.joinAfterCapture).toBe(1);
  expect(room.url).toBe(MEDIA_URL);
  const html = await page.locator('body').innerHTML();
  expect(html).not.toContain(CODE);
  expect(html).not.toContain(IDENTITY);
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
  expect(stored).not.toContain(CODE);
  expect(stored).not.toContain(IDENTITY);
  expect(new URL(page.url()).hash).toBe('#' + CODE);
  expectNoSecretLeak([postedBodies()[0].join_nonce]);
});

test('a prs_ presenter identity publishes only the screen', async ({ page }) => {
  const identity = 'prs_0123456789abcdef';
  joinHandler = (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: presenterBody({ identity: identity }),
  });
  await page.goto('http://site.test/present/#' + CODE);
  await share(page);
  await expect(page.locator('#present-status')).toHaveText(ON_AIR);
  const room = await page.evaluate(() => {
    const live = window.__presentRooms[0];
    return {
      opts: live.opts,
      micCalls: live.localParticipant.micCalls,
      published: live.localParticipant.published.map((item) => item.opts),
      micAsked: window.__micAsked,
    };
  });
  expect(room.opts).toEqual({ autoSubscribe: false });
  expect(room.micCalls).toBe(0);
  expect(room.micAsked).toBe(0);
  expect(room.published).toEqual([{ source: 'screen_share' }]);
  const html = await page.locator('body').innerHTML();
  expect(html).not.toContain(identity);
  expectNoSecretLeak([identity]);
});

test('an extra audio track is stopped and is not published', async ({ page }) => {
  await page.addInitScript(() => { window.__withAudio = true; });
  joinHandler = (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: presenterBody(),
  });
  await page.goto('http://site.test/present/#' + CODE);
  await share(page);
  await expect(page.locator('#present-status')).toHaveText(ON_AIR);
  const published = await page.evaluate(() => ({
    audioStopped: window.__lastAudio.stopped,
    count: window.__presentRooms[0].localParticipant.published.length,
    kind: window.__presentRooms[0].localParticipant.published[0].track.kind,
  }));
  expect(published).toEqual({ audioStopped: true, count: 1, kind: 'video' });
  expectNoSecretLeak();
});

test('a remote track is unsubscribed and nothing is attached', async ({ page }) => {
  joinHandler = (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: presenterBody(),
  });
  await page.goto('http://site.test/present/#' + CODE);
  await share(page);
  await expect(page.locator('#present-status')).toHaveText(ON_AIR);
  const subscribed = await page.evaluate(() => {
    const calls = [];
    const track = {
      detach: () => {
        const el = document.createElement('video');
        document.body.appendChild(el);
        return [el];
      },
    };
    const publication = { setSubscribed: (on) => calls.push(on) };
    window.__presentRooms[0].emit('trackSubscribed', track, publication);
    return { calls: calls, videos: document.querySelectorAll('video').length };
  });
  expect(subscribed).toEqual({ calls: [false], videos: 0 });
  expectNoSecretLeak();
});

for (const refusal of [
  { name: 'missing role', extra: { role: undefined }, text: 'This code did not open a presenter seat.' },
  { name: 'guest role', extra: { role: 'guest', identity: 'gst_0123456789abcdef' }, text: 'This code did not open a presenter seat.' },
  { name: 'guest role on a prs identity', extra: { role: 'guest', identity: 'prs_0123456789abcdef' }, text: 'This code did not open a presenter seat.' },
  { name: 'guest identity', extra: { identity: 'gst_0123456789abcdef' }, text: 'This code did not open a screen seat.' },
  { name: 'prs without underscore', extra: { identity: 'prs0123456789abcdef' }, text: 'This code did not open a screen seat.' },
  { name: 'bare prs prefix', extra: { identity: 'prs_' }, text: 'This code did not open a screen seat.' },
  { name: 'subscribe grant', extra: { video: screenVideo({ canSubscribe: true }) }, text: 'This code did not open a screen seat.' },
  { name: 'microphone grant', extra: { video: screenVideo({ canPublishSources: ['microphone'] }) }, text: 'This code did not open a screen seat.' },
  { name: 'screen and microphone', extra: { video: screenVideo({ canPublishSources: ['screen_share', 'microphone'] }) }, text: 'This code did not open a screen seat.' },
  { name: 'data grant', extra: { video: screenVideo({ canPublishData: true }) }, text: 'This code did not open a screen seat.' },
  { name: 'omitted data grant', extra: { video: screenVideoWithoutData() }, text: 'This code did not open a screen seat.' },
  { name: 'subject mismatch', extra: { join_token: screenToken(screenVideo(), 'scr_other_device') }, text: 'This code did not open a screen seat.' },
]) {
  test(`role check refuses ${refusal.name} and does not stay in the room`, async ({ page }) => {
    await page.clock.install();
    joinHandler = (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: presenterBody(refusal.extra),
    });
    await page.goto('http://site.test/present/#' + CODE);
    await share(page);
    await expect(page.locator('#present-status')).toHaveText(refusal.text);
    await expect(page.locator('#present-on-air')).toBeHidden();
    await expect(page.locator('#present-stop')).toBeHidden();
    const after = await page.evaluate(() => ({
      rooms: (window.__presentRooms || []).length,
      stopped: window.__tracks[0] ? window.__tracks[0].stopped : false,
    }));
    expect(after).toEqual({ rooms: 0, stopped: true });
    await jump(page, 10000);
    expect(joins).toHaveLength(1);
    expectNoSecretLeak();
  });
}

test('an http service address is refused and does not retry', async ({ page }) => {
  test.setTimeout(60000);
  await page.clock.install();
  const bad = [
    'http://insecure.example',
    'http://127.0.0.1:8787',
    'http://localhost:8787',
    'http://[::1]:8787',
    'https://user:pass@conference-guest.example',
    'https://conference-guest.example/extra',
    'https://conference-guest.example?x=1',
    'https://conference-guest.example#frag',
  ];
  let serviceUrl = bad[0];
  await page.route('**/data/present-join.json', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ serviceUrl: serviceUrl }),
  }));
  for (let i = 0; i < bad.length; i++) {
    serviceUrl = bad[i];
    joins = [];
    joinHandler = (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: presenterBody(),
    });
    await page.goto('http://site.test/present/?n=' + i + '#' + CODE);
    await share(page);
    await expect(page.locator('#present-status'), serviceUrl).toHaveText('The call could not be reached.');
    await expect(page.locator('#present-on-air'), serviceUrl).toBeHidden();
    expect(await page.evaluate(() => window.__tracks[0].stopped), serviceUrl).toBe(true);
    expect(await page.evaluate(() => window.__presentRooms || []), serviceUrl).toEqual([]);
    await jump(page, 10000);
    await expect.poll(() => joins.length).toBe(0);
    await page.clock.resume();
  }
});

test('an https or public page requires wss, and localhost development may use ws', async ({ page }) => {
  test.setTimeout(90000);
  const cases = [
    ['https://site.test/present/', 'ws://media.example/live', ''],
    ['https://site.test/present/', 'http://media.example/live', ''],
    ['https://site.test/present/', 'ws://localhost:7880/live', ''],
    ['https://site.test/present/', 'http://127.0.0.1:7880/live', ''],
    ['https://localhost/present/', 'ws://localhost:7880/live', ''],
    ['http://site.test/present/', 'ws://media.example/live', ''],
    ['http://site.test/present/', 'http://localhost:7880/live', ''],
    ['http://localhost/present/', 'ws://media.example/live', ''],
    ['http://localhost/present/', 'ws://evil.localhost/live', ''],
    ['http://localhost/present/', 'ws://user@localhost:7880/live', ''],
    ['https://site.test/present/', 'wss://media.example/live', 'wss://media.example/live'],
    ['https://site.test/present/', 'https://media.example/live', 'wss://media.example/live'],
    ['https://site.test/present/', 'HTTPS://media.example/live', 'wss://media.example/live'],
    ['http://site.test/present/', 'wss://media.example/live', 'wss://media.example/live'],
    ['http://localhost/present/', 'wss://media.example/live', 'wss://media.example/live'],
    ['http://localhost/present/', 'ws://localhost:7880/live', 'ws://localhost:7880/live'],
    ['http://localhost/present/', 'http://localhost:7880/live', 'ws://localhost:7880/live'],
    ['http://localhost/present/', 'ws://127.0.0.1:7880/live', 'ws://127.0.0.1:7880/live'],
    ['http://127.0.0.1/present/', 'ws://127.0.0.1:7880/live', 'ws://127.0.0.1:7880/live'],
    ['http://127.0.0.1/present/', 'http://[::1]:7880/live', 'ws://[::1]:7880/live'],
    ['http://[::1]/present/', 'ws://[::1]:7880/live', 'ws://[::1]:7880/live'],
  ];
  for (let i = 0; i < cases.length; i++) {
    const [pageUrl, livekit, roomUrl] = cases[i];
    const label = livekit + ' on ' + pageUrl;
    joins = [];
    joinHandler = (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: presenterBody({ livekit_url: livekit }),
    });
    await page.goto(pageUrl + '?n=' + i + '#' + CODE);
    await share(page);
    if (roomUrl) {
      await expect(page.locator('#present-status'), label).toHaveText(ON_AIR);
      const room = await page.evaluate(() => {
        const live = window.__presentRooms[0];
        return { url: live.url, opts: live.opts };
      });
      expect(room, label).toEqual({ url: roomUrl, opts: { autoSubscribe: false } });
    } else {
      await expect(page.locator('#present-status'), label).toHaveText('The call could not be joined.');
      expect(await page.evaluate(() => window.__presentRooms || []), label).toEqual([]);
      expect(await page.evaluate(() => window.__tracks[0].stopped), label).toBe(true);
    }
    const html = await page.locator('body').innerHTML();
    expect(html, label).not.toContain(CODE);
    expect(html, label).not.toContain(IDENTITY);
  }
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
      body: presenterBody(),
    });
  };
  await page.goto('http://site.test/present/#' + CODE);
  await share(page);
  await expect(page.locator('#present-status')).toHaveText('The call has not started. Waiting.');
  await expect(page.locator('#present-on-air')).toBeHidden();
  await expect(page.locator('#present-stop')).toBeVisible();
  expect(joins).toHaveLength(1);
  expect(await page.evaluate(() => window.__tracks[0].stopped)).toBe(false);
  await jump(page, 4000);
  expect(joins).toHaveLength(1);
  await page.clock.fastForward(10000);
  await expect.poll(() => joins.length).toBe(2);
  expect(postedBodies()[0].device).toBe(postedBodies()[1].device);
  expect(postedBodies()[0].code).toBe(CODE);
  expect(postedBodies()[1].code).toBe(CODE);
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
  await expect(page.locator('#present-status')).toHaveText(ON_AIR);
  expect(joins).toHaveLength(3);
  expect(await page.evaluate(() => window.__captures.length)).toBe(1);
  expectNoSecretLeak(nonces);
});

test('Stop during a not-started wait cancels the retry and the capture', async ({ page }) => {
  await page.clock.install();
  joinHandler = (route) => route.fulfill({
    status: 409,
    contentType: 'application/json',
    body: JSON.stringify({ error: 'the call has not started' }),
  });
  await page.goto('http://site.test/present/#' + CODE);
  await share(page);
  await expect(page.locator('#present-status')).toHaveText('The call has not started. Waiting.');
  await page.getByRole('button', { name: 'Stop' }).click();
  await expect(page.locator('#present-status')).toHaveText('Sharing stopped.');
  await expect(page.locator('#present-on-air')).toBeHidden();
  expect(await page.evaluate(() => window.__tracks[0].stopped)).toBe(true);
  await jump(page, 10000);
  expect(joins).toHaveLength(1);
  expect(new URL(page.url()).hash).toBe('#' + CODE);
  expectNoSecretLeak();
});

test('Stop during an in-flight join does not connect when the answer arrives', async ({ page }) => {
  let release;
  joinHandler = (route) => new Promise((resolve) => {
    release = () => resolve(route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: presenterBody(),
    }));
  });
  await page.goto('http://site.test/present/#' + CODE);
  await share(page);
  await expect(page.locator('#present-status')).toHaveText('Joining the call...');
  await page.getByRole('button', { name: 'Stop' }).click();
  await expect(page.locator('#present-status')).toHaveText('Sharing stopped.');
  expect(await page.evaluate(() => window.__tracks[0].stopped)).toBe(true);
  if (release) {
    try { await release(); } catch (err) { /* the aborted request may already be closed */ }
  }
  await page.waitForTimeout(200);
  await expect(page.locator('#present-status')).toHaveText('Sharing stopped.');
  await expect(page.locator('#present-on-air')).toBeHidden();
  expect(await page.evaluate(() => (window.__presentRooms || []).length)).toBe(0);
  expectNoSecretLeak();
});

test('Stop leaves the room and the browser stop ends the share', async ({ page }) => {
  joinHandler = (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: presenterBody(),
  });
  await page.goto('http://site.test/present/#' + CODE);
  await share(page);
  await expect(page.locator('#present-on-air')).toBeVisible();
  await page.getByRole('button', { name: 'Stop' }).click();
  await expect(page.locator('#present-status')).toHaveText('Sharing stopped.');
  await expect(page.locator('#present-on-air')).toBeHidden();
  await expect(page.locator('#present-share')).toBeVisible();
  expect(await page.evaluate(() => window.__presentRooms[0].disconnected)).toBe(true);
  expect(await page.evaluate(() => window.__tracks[0].stopped)).toBe(true);
  expect(new URL(page.url()).hash).toBe('#' + CODE);

  joins = [];
  await share(page);
  await expect(page.locator('#present-status')).toHaveText(ON_AIR);
  await page.evaluate(() => window.__tracks[1].listeners.ended());
  await expect(page.locator('#present-status')).toHaveText('Sharing stopped.');
  await expect(page.locator('#present-on-air')).toBeHidden();
  expect(await page.evaluate(() => window.__presentRooms[1].disconnected)).toBe(true);
  expectNoSecretLeak();
});

test('a dropped call stops the screen and does not retry', async ({ page }) => {
  await page.clock.install();
  joinHandler = (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: presenterBody(),
  });
  await page.goto('http://site.test/present/#' + CODE);
  await share(page);
  await expect(page.locator('#present-status')).toHaveText(ON_AIR);
  await page.evaluate(() => window.__presentRooms[0].emit('disconnected'));
  await expect(page.locator('#present-status')).toHaveText('The call ended, or this screen was replaced.');
  await expect(page.locator('#present-on-air')).toBeHidden();
  expect(await page.evaluate(() => window.__tracks[0].stopped)).toBe(true);
  await jump(page, 10000);
  expect(joins).toHaveLength(1);
  expectNoSecretLeak();
});

for (const refusal of [
  { status: 409, body: { error: 'the call is full' }, text: 'The call is full.' },
  { status: 409, body: { error: 'call_not_started' }, text: 'The call could not be joined.' },
  { status: 403, body: { error: 'this invite is not valid' }, text: 'This invite is not valid.' },
  { status: 429, body: { error: 'too many tries; wait a minute' }, text: 'Too many tries. Wait a minute.' },
  { status: 429, body: { error: 'too many invalid codes; wait ten minutes' }, text: 'Too many invalid codes. Wait ten minutes.' },
  { status: 503, body: { error: 'the call could not be reached; try again' }, text: 'The call could not be reached.' },
]) {
  test(`HTTP ${refusal.status} ${refusal.body.error} does not retry and stops the screen`, async ({ page }) => {
    await page.clock.install();
    joinHandler = (route) => route.fulfill({
      status: refusal.status,
      contentType: 'application/json',
      body: JSON.stringify(refusal.body),
    });
    await page.goto('http://site.test/present/#' + CODE);
    await share(page);
    await expect(page.locator('#present-status')).toHaveText(refusal.text);
    expect(await page.evaluate(() => window.__tracks[0].stopped)).toBe(true);
    await expect(page.locator('#present-on-air')).toBeHidden();
    await jump(page, 10000);
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
      body: presenterBody(),
    });
  };
  await page.goto('http://site.test/present/?code=' + QUERY_CODE);
  await page.getByLabel('Enter your code').fill(typed);
  await page.getByLabel('Enter your code').press('Enter');
  await expect(page.locator('#present-status')).toHaveText('The call has not started. Waiting.');
  await expect(page.locator('#present-enter')).toBeHidden();
  expect(await page.locator('#present-code').inputValue()).toBe('');
  expect(postedBodies()[0].code).toBe(typed);
  expect(postedBodies()[0].device).toMatch(ID_OK);
  expect(postedBodies()[0].join_nonce).toMatch(ID_OK);
  expect(page.url()).not.toContain('Ab');
  expect(new URL(page.url()).hash).toBe('');
  expect(new URL(page.url()).search).toBe('?code=' + QUERY_CODE);
  const pageText = await page.evaluate(() => document.body.innerText);
  expect(pageText).not.toContain(typed);
  expect(pageText).not.toContain('FGHIJ');
  await jump(page, 10000);
  await expect(page.locator('#present-status')).toHaveText(ON_AIR);
  expect(joins).toHaveLength(2);
  expect(postedBodies()[1].code).toBe(typed);
  expect(postedBodies()[1].device).toBe(postedBodies()[0].device);
  expect(postedBodies()[1].join_nonce).not.toBe(postedBodies()[0].join_nonce);
  const stored = await page.evaluate(() => JSON.stringify(sessionStorage));
  expect(stored).not.toContain(typed);
  expect(logs.join('\n')).not.toContain(typed);
  const html = await page.locator('body').innerHTML();
  expect(html).not.toContain(typed);
  expectNoSecretLeak([typed]);
});

test('a refused typed code does not retry, and the box comes back empty', async ({ page }) => {
  await page.clock.install();
  const typed = 'zzzzz-zzzzz';
  joinHandler = (route) => route.fulfill({
    status: 403,
    contentType: 'application/json',
    body: JSON.stringify({ error: 'this invite is not valid' }),
  });
  await page.goto('http://site.test/present/');
  await page.getByLabel('Enter your code').fill(typed);
  await share(page);
  await expect(page.locator('#present-status')).toHaveText('This invite is not valid.');
  await expect(page.locator('#present-enter')).toBeVisible();
  expect(await page.locator('#present-code').inputValue()).toBe('');
  await jump(page, 10000);
  expect(joins).toHaveLength(1);
  expect(postedBodies()[0].code).toBe(typed);
  expect(new URL(page.url()).hash).toBe('');
  const pageText = await page.evaluate(() => document.body.innerText);
  expect(pageText).not.toContain(typed);
  expectNoSecretLeak([typed]);
});

test('a cancelled picker does not join', async ({ page }) => {
  await page.goto('http://site.test/present/#' + CODE);
  await page.evaluate(() => {
    navigator.mediaDevices.getDisplayMedia = () => Promise.reject(new DOMException('no', 'NotAllowedError'));
  });
  await share(page);
  await expect(page.locator('#present-status')).toHaveText('No screen was picked.');
  expect(joins).toEqual([]);
  await expect(page.locator('#present-share')).toBeEnabled();
  expectNoSecretLeak();
});

test('adding a hash on the open page stays bookmarkable and does not join by itself', async ({ page }) => {
  joinHandler = (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: presenterBody(),
  });
  await page.goto('http://site.test/present/');
  await expect(page.locator('#present-enter')).toBeVisible();
  await page.evaluate((code) => { location.hash = code; }, CODE);
  await expect(page.locator('#present-enter')).toBeHidden();
  expect(joins).toEqual([]);
  await share(page);
  await expect(page.locator('#present-status')).toHaveText(ON_AIR);
  expect(postedBodies()[0].code).toBe(CODE);
  expect(new URL(page.url()).hash).toBe('#' + CODE);
  expect(new URL(page.url()).search).toBe('');
  const html = await page.locator('body').innerHTML();
  expect(html).not.toContain(CODE);
  expectNoSecretLeak();
});

test('a percent-encoded hash is posted whole', async ({ page }) => {
  joinHandler = (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: presenterBody(),
  });
  await page.goto('http://site.test/present/?code=' + QUERY_CODE + '#ada%2Dkept');
  await share(page);
  await expect(page.locator('#present-status')).toHaveText(ON_AIR);
  expect(postedBodies()[0].code).toBe('ada-kept');
  expect(postedBodies()[0].code).not.toBe(QUERY_CODE);
  expectNoSecretLeak(['ada-kept']);
});

test('a whitespace hash is an empty code, same as a missing hash', async ({ page }) => {
  joinHandler = (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: presenterBody(),
  });
  const blanks = ['#%20', '#%20%20', '#%09', '#%0A%20'];
  for (const hash of blanks) {
    joins = [];
    await page.goto('http://site.test/present/' + hash);
    await expect(page.locator('#present-enter'), hash).toBeVisible();
    await expect(page.locator('#present-share'), hash).toBeVisible();
    await expect(page.locator('#present-stop'), hash).toBeHidden();
    await expect(page.locator('#present-status'), hash).toHaveText(READY);
    await share(page);
    expect(await page.evaluate(() => (window.__captures || []).length), hash).toBe(0);
    expect(joins, hash).toEqual([]);
    expect(await page.locator('#present-code').inputValue(), hash).toBe('');
  }
  await page.getByLabel('Enter your code').fill(CODE);
  await share(page);
  await expect(page.locator('#present-status')).toHaveText(ON_AIR);
  expect(postedBodies()[0].code).toBe(CODE);
  expect(new URL(page.url()).hash).not.toContain(CODE);
});

test('a hash that trims to a code hides the box and posts the trimmed code', async ({ page }) => {
  joinHandler = (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: presenterBody(),
  });
  await page.goto('http://site.test/present/#%20' + CODE + '%20');
  await expect(page.locator('#present-enter')).toBeHidden();
  await share(page);
  await expect(page.locator('#present-status')).toHaveText(ON_AIR);
  expect(postedBodies()[0].code).toBe(CODE);
});

test('Stop is shown as soon as the screen is captured, while config is still loading', async ({ page }) => {
  let release;
  await page.route('**/data/present-join.json', (route) => new Promise((resolve) => {
    release = () => resolve(route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ serviceUrl: SERVICE }),
    }));
  }));
  joinHandler = (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: presenterBody(),
  });
  await page.goto('http://site.test/present/#' + CODE, { waitUntil: 'domcontentloaded' });
  await share(page);
  await expect(page.locator('#present-stop')).toBeVisible();
  await expect(page.locator('#present-share')).toBeHidden();
  await expect(page.locator('#present-on-air')).toBeHidden();
  await expect(page.locator('#present-status')).toHaveText('Joining the call...');
  expect(await page.evaluate(() => ({
    stopped: window.__tracks[0].stopped,
    live: window.__tracks[0].readyState,
  }))).toEqual({ stopped: false, live: 'live' });
  expect(joins).toEqual([]);
  release();
  await expect(page.locator('#present-status')).toHaveText(ON_AIR);
  expect(joins).toHaveLength(1);
  expect(await page.evaluate(() => window.__tracks[0].stopped)).toBe(false);
});

test('Stop during a config wait releases the capture and does not join', async ({ page }) => {
  let release;
  await page.route('**/data/present-join.json', (route) => new Promise((resolve) => {
    release = () => resolve(route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ serviceUrl: SERVICE }),
    }));
  }));
  joinHandler = (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: presenterBody(),
  });
  await page.goto('http://site.test/present/#' + CODE, { waitUntil: 'domcontentloaded' });
  await share(page);
  await expect(page.locator('#present-stop')).toBeVisible();
  await page.getByRole('button', { name: 'Stop' }).click();
  await expect(page.locator('#present-status')).toHaveText('Sharing stopped.');
  expect(await page.evaluate(() => window.__tracks[0].stopped)).toBe(true);
  const configDone = page.waitForResponse((res) => res.url().includes('/data/present-join.json'));
  release();
  await configDone;
  await page.evaluate(() => Promise.resolve());
  expect(joins).toEqual([]);
  await expect(page.locator('#present-status')).toHaveText('Sharing stopped.');
  await expect(page.locator('#present-stop')).toBeHidden();
});

test('a config failure after capture stops the screen and does not join', async ({ page }) => {
  let release;
  await page.route('**/data/present-join.json', (route) => new Promise((resolve) => {
    release = () => resolve(route.fulfill({ status: 404, body: '' }));
  }));
  await page.goto('http://site.test/present/#' + CODE, { waitUntil: 'domcontentloaded' });
  await share(page);
  await expect(page.locator('#present-stop')).toBeVisible();
  expect(await page.evaluate(() => window.__tracks[0].stopped)).toBe(false);
  release();
  await expect(page.locator('#present-status')).toHaveText('The call could not be reached.');
  await expect(page.locator('#present-stop')).toBeHidden();
  expect(await page.evaluate(() => window.__tracks[0].stopped)).toBe(true);
  expect(joins).toEqual([]);
});

test('without crypto.getRandomValues the share stops and does not join', async ({ page }) => {
  const blocks = [
    () => {
      const proto = Object.getPrototypeOf(window.crypto);
      Object.defineProperty(proto, 'getRandomValues', {
        configurable: true,
        writable: true,
        value: undefined,
      });
    },
    () => {
      const proto = Object.getPrototypeOf(window.crypto);
      Object.defineProperty(proto, 'getRandomValues', {
        configurable: true,
        writable: true,
        value: function () { throw new Error('blocked'); },
      });
    },
  ];
  for (let i = 0; i < blocks.length; i++) {
    joins = [];
    await page.goto('http://site.test/present/?n=' + i + '#' + CODE);
    await page.evaluate(blocks[i]);
    await share(page);
    await expect(page.locator('#present-status'), String(i)).toHaveText('The call could not be joined.');
    await expect(page.locator('#present-stop'), String(i)).toBeHidden();
    await expect(page.locator('#present-on-air'), String(i)).toBeHidden();
    expect(await page.evaluate(() => window.__tracks[0].stopped), String(i)).toBe(true);
    expect(joins, String(i)).toEqual([]);
    expect(await page.evaluate(() => (window.__presentRooms || []).length), String(i)).toBe(0);
  }
});

async function stubDeviceStorage(page, mode) {
  await page.evaluate((mode) => {
    const proto = Object.getPrototypeOf(window.sessionStorage);
    const origGet = proto.getItem;
    const origSet = proto.setItem;
    let reads = 0;
    Object.defineProperty(proto, 'getItem', {
      configurable: true,
      writable: true,
      value: function (key) {
        if (key !== 'sfdc24-present-device') return origGet.call(this, key);
        reads += 1;
        if (mode === 'seed-then-empty') return reads === 1 ? 'stored-device-id-0001' : '';
        return '';
      },
    });
    Object.defineProperty(proto, 'setItem', {
      configurable: true,
      writable: true,
      value: function (key, value) {
        if (key === 'sfdc24-present-device') throw new Error('quota');
        return origSet.call(this, key, value);
      },
    });
  }, mode);
}

test('a stored device id stays stable when a later read is empty', async ({ page }) => {
  await page.clock.install();
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
      body: presenterBody(),
    });
  };
  await page.goto('http://site.test/present/#' + CODE);
  await stubDeviceStorage(page, 'seed-then-empty');
  await share(page);
  await expect(page.locator('#present-status')).toHaveText('The call has not started. Waiting.');
  expect(postedBodies()[0].device).toBe('stored-device-id-0001');
  await page.clock.fastForward(10000);
  await expect.poll(() => joins.length).toBe(2);
  expect(postedBodies()[1].device).toBe('stored-device-id-0001');
  expect(postedBodies()[1].join_nonce).not.toBe(postedBodies()[0].join_nonce);
});

test('a device id stays stable when storage writes fail', async ({ page }) => {
  await page.clock.install();
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
      body: presenterBody(),
    });
  };
  await page.goto('http://site.test/present/#' + CODE);
  await stubDeviceStorage(page, 'write-fails');
  await share(page);
  await expect(page.locator('#present-status')).toHaveText('The call has not started. Waiting.');
  expect(postedBodies()[0].device).toMatch(ID_OK);
  await page.clock.fastForward(10000);
  await expect.poll(() => joins.length).toBe(2);
  expect(postedBodies()[1].device).toBe(postedBodies()[0].device);
  expect(postedBodies()[1].join_nonce).not.toBe(postedBodies()[0].join_nonce);
});

test('the real media client is on the page and stays quiet without a share', async ({ page }) => {
  mockMedia = false;
  await page.goto('http://site.test/present/?code=' + QUERY_CODE);
  await expect(page.locator('#present-enter')).toBeVisible();
  await expect(page.locator('#present-status')).toHaveText(READY);
  const ready = await page.evaluate(() => ({
    room: typeof window.LivekitClient.Room,
    silence: typeof window.LivekitClient.setLogLevel,
    level: window.LivekitClient.LogLevel.silent,
  }));
  expect(ready).toEqual({ room: 'function', silence: 'function', level: 5 });
  expect(joins).toEqual([]);
  expect(await page.evaluate(() => window.__captures.length)).toBe(0);
  expectNoSecretLeak();
});
