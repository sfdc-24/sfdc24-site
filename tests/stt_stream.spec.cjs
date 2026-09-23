const { test, expect } = require('@playwright/test');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const REPO = path.join(__dirname, '..');
const SITE = 'http://127.0.0.1:4173';
const RELAY = 'http://127.0.0.1:8765';
const SECRET = 'browser-test-secret';
const ADMIN = 'browser-test-admin';
const SINK = path.join(os.tmpdir(), 'stt-leads-browser.jsonl');

test.describe.configure({ mode: 'serial' });

let siteProc;
let relayProc;
let relayLog = '';

async function waitOk(url) {
  let last = '';
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
      last = String(res.status);
    } catch (err) {
      last = err && err.message ? err.message : String(err);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${url} did not come up (${last})\n${relayLog}`);
}

function stubMedia() {
  function AudioCtx() {
    this.sampleRate = 48000;
    this.resume = function () { return Promise.resolve(); };
    this.close = function () { return Promise.resolve(); };
    this.destination = {};
    this.audioWorklet = { addModule: function () { return Promise.resolve(); } };
    this.createGain = function () {
      return { gain: { value: 1 }, connect: function () {}, disconnect: function () {} };
    };
    this.createMediaStreamSource = function () {
      return { connect: function () {} };
    };
  }
  window.AudioContext = AudioCtx;
  window.webkitAudioContext = AudioCtx;
  function WorkletNode() {
    var port = {
      onmessage: null,
      postMessage: function (data) {
        if (data && data.type === "flush" && port.onmessage) {
          port.onmessage({ data: { type: "flushed" } });
        }
      },
    };
    this.port = port;
    this.connect = function () {};
    this.disconnect = function () {};
  }
  window.AudioWorkletNode = WorkletNode;
  const devices = {
    getUserMedia: function () {
      return Promise.resolve({
        getTracks: function () { return [{ stop: function () {} }]; },
      });
    },
  };
  try {
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: devices });
  } catch (err) {
    navigator.mediaDevices.getUserMedia = devices.getUserMedia;
  }
}

test.beforeAll(async () => {
  try { fs.unlinkSync(SINK); } catch (err) {}
  siteProc = spawn('python3', ['-m', 'http.server', '4173', '--bind', '127.0.0.1'], {
    cwd: REPO,
    stdio: 'ignore',
  });
  relayProc = spawn('python3', ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', '8765'], {
    cwd: path.join(REPO, 'services/stt-relay'),
    env: Object.assign({}, process.env, {
      STT_FAKE_UPSTREAM: '1',
      STT_RUNTIME: 'development',
      K_SERVICE: '',
      DEEPGRAM_API_KEY: '',
      RELAY_AUTH_SECRET: SECRET,
      RELAY_ADMIN_SECRET: ADMIN,
      LEAD_SINK_PATH: SINK,
      ALLOWED_ORIGINS: 'http://127.0.0.1:4173',
    }),
  });
  relayProc.stderr.on('data', (chunk) => { relayLog += chunk.toString(); });
  relayProc.stdout.on('data', (chunk) => { relayLog += chunk.toString(); });
  await waitOk(SITE + '/stream/');
  await waitOk(RELAY + '/healthz');
});

test.afterAll(async () => {
  if (siteProc) siteProc.kill('SIGTERM');
  if (relayProc) relayProc.kill('SIGTERM');
});

test('the page shows 3:00 and does not start without a relay', async ({ page }) => {
  await page.goto(SITE + '/stream/');
  await expect(page.locator('#clock')).toHaveText('3:00');
  await page.locator('#start').click();
  await expect(page.locator('#status')).toHaveText('Streaming relay is not set on this host yet.');
  await expect(page.locator('#clock')).toHaveText('3:00');
});

test('a session counts down, warns, stops, thanks, resets, and stores a lead', async ({ page }) => {
  test.setTimeout(30000);
  await page.clock.install({ time: new Date('2026-09-23T16:00:00Z') });
  await page.addInitScript(stubMedia);
  await page.addInitScript(() => {
    window.SFDC24_STT_CONFIG = { relayUrl: 'http://127.0.0.1:8765' };
  });
  await page.goto(SITE + '/stream/');
  await expect(page.locator('#clock')).toHaveText('3:00');
  await page.locator('#name').fill('Ada Lovelace');
  await page.locator('#phone').fill('4165550199');
  await page.locator('#need').fill('automation at the close');
  await page.locator('#start').click();
  await expect(page.locator('#status')).toHaveText('Listening.', { timeout: 8000 });
  await expect(page.locator('#transcript')).toContainText('automation');
  await expect(page.locator('#start')).toHaveText('Stop');

  await page.clock.fastForward(150000);
  await expect(page.locator('#warn')).toHaveText('Thirty seconds left.');
  await expect(page.locator('#clock')).toHaveClass(/warn/);
  await expect(page.locator('#clock')).toHaveText('0:30');

  await page.clock.fastForward(30000);
  await expect(page.locator('#clock')).toHaveText('0:00');
  await expect(page.locator('#status')).toContainText('Thank you. That is enough for a call back.');

  await expect(page.locator('#status')).toContainText('Held for this session only.');
  await expect(page.locator('#status')).not.toContainText('Saved for a call back.');

  await expect.poll(async () => {
    const res = await fetch(RELAY + '/v1/leads', { headers: { 'X-Relay-Admin': ADMIN } });
    if (!res.ok) return '';
    const body = await res.json();
    const lead = (body.leads || []).find((row) => row.visitor && row.visitor.phone === '4165550199');
    return lead ? lead.transcript : '';
  }, { timeout: 8000 }).toContain('automation');

  await page.clock.fastForward(700);
  await expect(page.locator('#clock')).toHaveText('3:00');
  await expect(page.locator('#start')).toHaveText('Start');
  await expect(page.locator('#start')).toBeEnabled();
  await expect(page.locator('#transcript')).toHaveText('');
});

test('the clock and start control fit a phone width', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto(SITE + '/stream/');
  const clockBox = await page.locator('#clock').boundingBox();
  const startBox = await page.locator('#start').boundingBox();
  expect(clockBox).toBeTruthy();
  expect(startBox).toBeTruthy();
  expect(clockBox.x).toBeGreaterThanOrEqual(0);
  expect(clockBox.x + clockBox.width).toBeLessThanOrEqual(390);
  expect(startBox.x + startBox.width).toBeLessThanOrEqual(390);
  expect(startBox.width).toBeGreaterThanOrEqual(44);
  expect(startBox.height).toBeGreaterThanOrEqual(44);
  await expect(page.locator('#clock')).toHaveText('3:00');
});

test('stopping early still thanks the visitor and resets the clock', async ({ page }) => {
  test.setTimeout(20000);
  await page.clock.install({ time: new Date('2026-09-23T16:00:00Z') });
  await page.addInitScript(stubMedia);
  await page.addInitScript(() => {
    window.SFDC24_STT_CONFIG = { relayUrl: 'http://127.0.0.1:8765' };
  });
  await page.goto(SITE + '/stream/');
  await page.locator('#start').click();
  await expect(page.locator('#status')).toHaveText('Listening.', { timeout: 8000 });
  await page.locator('#start').click();
  await expect(page.locator('#status')).toContainText('Thank you. That is enough for a call back.');
  await expect(page.locator('#clock')).toHaveText('0:00');
  await page.clock.fastForward(700);
  await expect(page.locator('#clock')).toHaveText('3:00');
  await expect(page.locator('#start')).toHaveText('Start');
});

test('stopping during a hung session releases the microphone and ignores a late reply', async ({ page }) => {
  await page.addInitScript(() => {
    window.__micStopped = false;
    window.__releaseSession = null;
    function AudioCtx() {
      this.sampleRate = 48000;
      this.resume = function () { return Promise.resolve(); };
      this.close = function () { return Promise.resolve(); };
      this.destination = {};
      this.audioWorklet = { addModule: function () { return Promise.resolve(); } };
      this.createGain = function () {
        return { gain: { value: 1 }, connect: function () {}, disconnect: function () {} };
      };
      this.createMediaStreamSource = function () { return { connect: function () {} }; };
    }
    window.AudioContext = AudioCtx;
    window.webkitAudioContext = AudioCtx;
    window.AudioWorkletNode = function () {
      this.port = { onmessage: null, postMessage: function () {} };
      this.connect = function () {};
      this.disconnect = function () {};
    };
    const devices = {
      getUserMedia: function () {
        return Promise.resolve({
          getTracks: function () {
            return [{ stop: function () { window.__micStopped = true; } }];
          },
        });
      },
    };
    try {
      Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: devices });
    } catch (err) {
      navigator.mediaDevices = devices;
    }
    const orig = window.fetch.bind(window);
    window.fetch = function (url, opts) {
      if (String(url).indexOf('/v1/session') >= 0) {
        return new Promise(function (resolve) { window.__releaseSession = resolve; });
      }
      return orig(url, opts);
    };
    window.SFDC24_STT_CONFIG = { relayUrl: 'http://127.0.0.1:8765' };
  });
  await page.goto(SITE + '/stream/');
  await page.locator('#start').click();
  await expect(page.locator('#status')).toHaveText('Connecting.');
  await expect(page.locator('#start')).toHaveText('Stop');
  await expect(page.locator('#start')).toBeEnabled();
  await expect.poll(() => page.evaluate(() => typeof window.__releaseSession)).toBe('function');
  await page.locator('#start').click();
  await expect(page.locator('#status')).toHaveText('Stopped before the relay connected.');
  await expect.poll(() => page.evaluate(() => window.__micStopped)).toBe(true);
  await expect(page.locator('#clock')).toHaveText('3:00');
  await page.evaluate(() => {
    window.__releaseSession(new Response(JSON.stringify({
      token: 'late-token',
      stream_path: '/v1/stream',
      max_seconds: 180,
      warn_seconds: 30,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  });
  await page.waitForTimeout(250);
  await expect(page.locator('#status')).toHaveText('Stopped before the relay connected.');
  await expect(page.locator('#start')).toHaveText('Start');
});

test('a delayed microphone grant after cancel does not start listening', async ({ page }) => {
  await page.addInitScript(() => {
    window.__lateStopped = false;
    window.__grantMic = null;
    function AudioCtx() {
      this.sampleRate = 48000;
      this.resume = function () { return Promise.resolve(); };
      this.close = function () { return Promise.resolve(); };
      this.destination = {};
      this.audioWorklet = { addModule: function () { return Promise.resolve(); } };
      this.createGain = function () {
        return { gain: { value: 1 }, connect: function () {}, disconnect: function () {} };
      };
      this.createMediaStreamSource = function () { return { connect: function () {} }; };
    }
    window.AudioContext = AudioCtx;
    window.webkitAudioContext = AudioCtx;
    window.AudioWorkletNode = function () {
      this.port = { onmessage: null, postMessage: function () {} };
      this.connect = function () {};
      this.disconnect = function () {};
    };
    const devices = {
      getUserMedia: function () {
        return new Promise(function (resolve) {
          window.__grantMic = function () {
            resolve({
              getTracks: function () {
                return [{ stop: function () { window.__lateStopped = true; } }];
              },
            });
          };
        });
      },
    };
    try {
      Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: devices });
    } catch (err) {
      navigator.mediaDevices = devices;
    }
    window.SFDC24_STT_CONFIG = { relayUrl: 'http://127.0.0.1:8765' };
  });
  await page.goto(SITE + '/stream/');
  await page.locator('#start').click();
  await expect(page.locator('#status')).toHaveText('Connecting.');
  await page.locator('#start').click();
  await expect(page.locator('#status')).toHaveText('Stopped before the relay connected.');
  await page.evaluate(() => window.__grantMic());
  await page.waitForTimeout(200);
  await expect.poll(() => page.evaluate(() => window.__lateStopped)).toBe(true);
  await expect(page.locator('#status')).toHaveText('Stopped before the relay connected.');
});

test('a startup that never connects releases the microphone at the time limit', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-09-23T16:00:00Z') });
  await page.addInitScript(() => {
    window.__micStopped = false;
    function AudioCtx() {
      this.sampleRate = 48000;
      this.resume = function () { return Promise.resolve(); };
      this.close = function () { return Promise.resolve(); };
      this.destination = {};
      this.audioWorklet = { addModule: function () { return Promise.resolve(); } };
      this.createGain = function () {
        return { gain: { value: 1 }, connect: function () {}, disconnect: function () {} };
      };
      this.createMediaStreamSource = function () { return { connect: function () {} }; };
    }
    window.AudioContext = AudioCtx;
    window.webkitAudioContext = AudioCtx;
    window.AudioWorkletNode = function () {
      this.port = { onmessage: null, postMessage: function () {} };
      this.connect = function () {};
      this.disconnect = function () {};
    };
    const devices = {
      getUserMedia: function () {
        return Promise.resolve({
          getTracks: function () {
            return [{ stop: function () { window.__micStopped = true; } }];
          },
        });
      },
    };
    try {
      Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: devices });
    } catch (err) {
      navigator.mediaDevices = devices;
    }
    const orig = window.fetch.bind(window);
    window.fetch = function (url, opts) {
      if (String(url).indexOf('/v1/session') >= 0) return new Promise(function () {});
      return orig(url, opts);
    };
    window.SFDC24_STT_CONFIG = { relayUrl: 'http://127.0.0.1:8765' };
  });
  await page.goto(SITE + '/stream/');
  await page.locator('#start').click();
  await expect(page.locator('#status')).toHaveText('Connecting.');
  await page.clock.fastForward(12000);
  await expect(page.locator('#status')).toHaveText('The speech relay did not start.');
  await expect.poll(() => page.evaluate(() => window.__micStopped)).toBe(true);
  await expect(page.locator('#start')).toHaveText('Start');
});

async function settlePreviousLead(page, status, body) {
  await page.addInitScript(stubMedia);
  await page.addInitScript(() => {
    window.SFDC24_STT_CONFIG = { relayUrl: 'http://127.0.0.1:8765' };
  });
  const queued = [];
  await page.route('**/v1/leads', async (route) => {
    await new Promise((resolve) => queued.push({ route, resolve }));
  });
  await page.goto(SITE + '/stream/');
  await page.locator('#start').click();
  await expect(page.locator('#status')).toHaveText('Listening.', { timeout: 8000 });
  await page.locator('#start').click();
  await expect(page.locator('#clock')).toHaveText('3:00', { timeout: 8000 });
  await page.locator('#start').click();
  await expect(page.locator('#status')).toHaveText('Listening.', { timeout: 8000 });
  expect(queued.length).toBeGreaterThan(0);
  await queued[0].route.fulfill({
    status: status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
  queued[0].resolve();
  await page.waitForTimeout(200);
  await expect(page.locator('#status')).toHaveText('Listening.');
}

test('a late saved lead does not replace the next session status', async ({ page }) => {
  test.setTimeout(20000);
  await settlePreviousLead(page, 200, { ok: true, durable: true, sink: 'forwarded' });
});

test('a late failed lead does not replace the next session status', async ({ page }) => {
  test.setTimeout(20000);
  await settlePreviousLead(page, 500, { ok: false, durable: false });
});
