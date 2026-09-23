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

test('a cap during flush does not end the next session', async ({ page }) => {
  test.setTimeout(20000);
  const leads = [];
  await page.addInitScript(() => {
    window.__sockets = [];
    window.__releaseFlush = null;
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
    function WorkletNode() {
      var port = {
        onmessage: null,
        postMessage: function (data) {
          if (data && data.type === 'flush') {
            var handler = port.onmessage;
            window.__releaseFlush = function () {
              if (!handler) return;
              handler({ data: new ArrayBuffer(1600) });
              handler({ data: { type: 'flushed' } });
            };
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
      navigator.mediaDevices = devices;
    }
    function FakeSocket() {
      this.readyState = 0;
      this.bufferedAmount = 0;
      this.binarySends = 0;
      this.onopen = null;
      this.onmessage = null;
      this.onerror = null;
      this.onclose = null;
      var self = this;
      window.__sockets.push(self);
      this.send = function (data) {
        if (typeof data !== 'string') {
          self.binarySends += 1;
          return;
        }
        if (data.indexOf('"auth"') >= 0) {
          setTimeout(function () {
            if (self.onmessage) {
              self.onmessage({
                data: JSON.stringify({ type: 'ready', max_seconds: 180, warn_seconds: 30 }),
              });
            }
          }, 0);
        }
      };
      this.close = function () {
        if (self.readyState === 3) return;
        self.readyState = 3;
        if (self.onclose) self.onclose({});
      };
      setTimeout(function () {
        self.readyState = 1;
        if (self.onopen) self.onopen({});
      }, 0);
    }
    window.WebSocket = FakeSocket;
    window.SFDC24_STT_CONFIG = { relayUrl: 'http://127.0.0.1:8765' };
  });
  await page.route('**/v1/leads', async (route) => {
    leads.push(route.request().postDataJSON());
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, durable: false, sink: 'staged' }),
    });
  });
  await page.goto(SITE + '/stream/');
  await page.locator('#start').click();
  await expect(page.locator('#status')).toHaveText('Listening.', { timeout: 8000 });
  await page.locator('#start').click();
  await expect(page.locator('#status')).toContainText('Thank you. That is enough for a call back.');
  await page.evaluate(() => {
    window.__sockets[0].onmessage({
      data: JSON.stringify({ type: 'cap', reason: 'elapsed', receipt: 'receipt-a', remaining_s: 0 }),
    });
  });
  await expect(page.locator('#clock')).toHaveText('3:00', { timeout: 8000 });
  await page.locator('#start').click();
  await expect(page.locator('#status')).toHaveText('Listening.', { timeout: 8000 });
  await page.evaluate(() => { if (window.__releaseFlush) window.__releaseFlush(); });
  await page.waitForTimeout(3200);
  await expect(page.locator('#status')).toHaveText('Listening.');
  expect(leads).toHaveLength(1);
  expect(leads[0].receipt).toBe('receipt-a');
  const open = await page.evaluate(() => window.__sockets.map((sock) => ({
    readyState: sock.readyState,
    binarySends: sock.binarySends,
  })));
  expect(open[open.length - 1].readyState).toBe(1);
  expect(open[open.length - 1].binarySends).toBe(0);
  expect(open[0].binarySends).toBe(0);
});

test('a final pcm frame is sent on the ending socket before stop', async ({ page }) => {
  test.setTimeout(20000);
  await page.addInitScript(() => {
    window.__sockets = [];
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
    function WorkletNode() {
      var port = {
        onmessage: null,
        postMessage: function (data) {
          if (data && data.type === 'flush' && port.onmessage) {
            port.onmessage({ data: new ArrayBuffer(1600) });
            port.onmessage({ data: { type: 'flushed' } });
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
      navigator.mediaDevices = devices;
    }
    function FakeSocket() {
      this.readyState = 0;
      this.bufferedAmount = 0;
      this.sends = [];
      this.onopen = null;
      this.onmessage = null;
      this.onerror = null;
      this.onclose = null;
      var self = this;
      window.__sockets.push(self);
      this.send = function (data) {
        if (typeof data === 'string') self.sends.push(data);
        else self.sends.push('binary:' + (data.byteLength || data.length || 0));
        if (typeof data === 'string' && data.indexOf('"auth"') >= 0) {
          setTimeout(function () {
            if (self.onmessage) {
              self.onmessage({
                data: JSON.stringify({ type: 'ready', max_seconds: 180, warn_seconds: 30 }),
              });
            }
          }, 0);
        }
      };
      this.close = function () {
        if (self.readyState === 3) return;
        self.readyState = 3;
        if (self.onclose) self.onclose({});
      };
      setTimeout(function () {
        self.readyState = 1;
        if (self.onopen) self.onopen({});
      }, 0);
    }
    window.WebSocket = FakeSocket;
    window.SFDC24_STT_CONFIG = { relayUrl: 'http://127.0.0.1:8765' };
  });
  await page.goto(SITE + '/stream/');
  await page.locator('#start').click();
  await expect(page.locator('#status')).toHaveText('Listening.', { timeout: 8000 });
  await page.locator('#start').click();
  await expect(page.locator('#status')).toContainText('Thank you. That is enough for a call back.');
  const sends = await page.evaluate(() => window.__sockets[0].sends);
  const frameAt = sends.indexOf('binary:1600');
  const stopAt = sends.findIndex((item) => item.indexOf('"stop"') >= 0);
  expect(frameAt).toBeGreaterThanOrEqual(0);
  expect(stopAt).toBeGreaterThan(frameAt);
});

const THANK_YOU = 'Thank you. That is enough for a call back.';
const HELD_LINE = THANK_YOU + ' Held for this session only.';
const FAILED_LINE = THANK_YOU + ' The transcript did not reach the desk. Write to abdus@sfdc24.com.';

function recoveryMedia() {
  window.__sockets = [];
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
  function WorkletNode() {
    var port = {
      onmessage: null,
      postMessage: function (data) {
        if (data && data.type === 'flush' && port.onmessage) {
          port.onmessage({ data: { type: 'flushed' } });
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
    navigator.mediaDevices = devices;
  }
  function FakeSocket() {
    this.readyState = 0;
    this.bufferedAmount = 0;
    this.onopen = null;
    this.onmessage = null;
    this.onerror = null;
    this.onclose = null;
    var self = this;
    window.__sockets.push(self);
    this.send = function (data) {
      if (typeof data === 'string' && data.indexOf('"auth"') >= 0) {
        setTimeout(function () {
          if (self.onmessage) {
            self.onmessage({
              data: JSON.stringify({ type: 'ready', max_seconds: 180, warn_seconds: 30 }),
            });
          }
        }, 0);
      }
    };
    this.close = function () {
      if (self.readyState === 3) return;
      self.readyState = 3;
      if (self.onclose) self.onclose({});
    };
    setTimeout(function () {
      self.readyState = 1;
      if (self.onopen) self.onopen({});
    }, 0);
  }
  window.WebSocket = FakeSocket;
  window.SFDC24_STT_CONFIG = { relayUrl: 'http://127.0.0.1:8765' };
}

async function listenOnFakeSocket(page) {
  await page.addInitScript(recoveryMedia);
  await page.goto(SITE + '/stream/');
  await page.locator('#start').click();
  await expect(page.locator('#status')).toHaveText('Listening.', { timeout: 8000 });
}

async function dropLiveSocket(page, kind) {
  await page.evaluate((which) => {
    const sock = window.__sockets[0];
    if (which === 'error') sock.onerror({});
    else sock.onclose({});
  }, kind);
}

async function recoverableDisconnect(page, kind) {
  const leads = [];
  await page.route('**/v1/leads', async (route) => {
    leads.push(route.request().postDataJSON());
    const first = leads.length === 1;
    await route.fulfill({
      status: first ? 409 : 200,
      contentType: 'application/json',
      body: JSON.stringify(first
        ? { ok: false, error: 'session_not_retained', durable: false }
        : { ok: true, durable: false, sink: 'staged' }),
    });
  });
  await listenOnFakeSocket(page);
  await dropLiveSocket(page, kind);
  await expect(page.locator('#status')).toHaveText(THANK_YOU);
  await expect(page.locator('#clock')).toHaveText('0:00');
  await expect(page.locator('#start')).toHaveText('Start');
  await expect.poll(() => leads.length, { timeout: 8000 }).toBe(1);
  expect(leads[0].receipt).toBe('');
  expect(leads[0].transcript).toBeUndefined();
  await expect(page.locator('#status')).toHaveText(THANK_YOU);
  await expect(page.locator('#clock')).toHaveText('0:00');
  await expect.poll(() => leads.length, { timeout: 8000 }).toBe(2);
  expect(leads[1].receipt).toBe('');
  await expect(page.locator('#status')).toHaveText(HELD_LINE);
  await expect(page.locator('#clock')).toHaveText('3:00', { timeout: 8000 });
  expect(leads).toHaveLength(2);
}

test('a socket close during finalization retries once and then holds the lead', async ({ page }) => {
  test.setTimeout(20000);
  await recoverableDisconnect(page, 'close');
});

test('a socket error during finalization retries once and then holds the lead', async ({ page }) => {
  test.setTimeout(20000);
  await recoverableDisconnect(page, 'error');
});

test('a second session_not_retained is a terminal failure', async ({ page }) => {
  test.setTimeout(20000);
  const leads = [];
  await page.route('**/v1/leads', async (route) => {
    leads.push(route.request().postDataJSON());
    await route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({ ok: false, error: 'session_not_retained', durable: false }),
    });
  });
  await listenOnFakeSocket(page);
  await dropLiveSocket(page, 'close');
  await expect(page.locator('#status')).toHaveText(THANK_YOU);
  await expect.poll(() => leads.length, { timeout: 12000 }).toBe(2);
  await expect(page.locator('#status')).toHaveText(FAILED_LINE);
  await expect(page.locator('#clock')).toHaveText('3:00', { timeout: 8000 });
  await page.waitForTimeout(1500);
  expect(leads).toHaveLength(2);
  expect(leads[0].receipt).toBe('');
  expect(leads[1].receipt).toBe('');
});

test('a cap during disconnect recovery posts that receipt once', async ({ page }) => {
  test.setTimeout(20000);
  const leads = [];
  await page.route('**/v1/leads', async (route) => {
    leads.push(route.request().postDataJSON());
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, durable: false, sink: 'staged' }),
    });
  });
  await listenOnFakeSocket(page);
  await dropLiveSocket(page, 'close');
  await expect(page.locator('#status')).toHaveText(THANK_YOU);
  await page.evaluate(() => {
    window.__sockets[0].onmessage({
      data: JSON.stringify({ type: 'cap', reason: 'disconnect', receipt: 'receipt-late', remaining_s: 0 }),
    });
  });
  await expect.poll(() => leads.length, { timeout: 4000 }).toBe(1);
  expect(leads[0].receipt).toBe('receipt-late');
  expect(leads[0].transcript).toBeUndefined();
  await expect(page.locator('#status')).toHaveText(HELD_LINE);
  await page.waitForTimeout(3000);
  expect(leads).toHaveLength(1);
});

test('a new session during recovery ignores the earlier lead response', async ({ page }) => {
  test.setTimeout(20000);
  const leads = [];
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  await page.route('**/v1/leads', async (route) => {
    leads.push(route.request().postDataJSON());
    await held;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, durable: true, sink: 'forwarded' }),
    });
  });
  await listenOnFakeSocket(page);
  await dropLiveSocket(page, 'close');
  await expect(page.locator('#status')).toHaveText(THANK_YOU);
  await expect.poll(() => leads.length, { timeout: 8000 }).toBe(1);
  const firstToken = leads[0].token;
  expect(leads[0].receipt).toBe('');
  expect(leads[0].transcript).toBeUndefined();
  await page.locator('#start').click();
  await expect(page.locator('#status')).toHaveText('Listening.', { timeout: 8000 });
  release();
  await page.waitForTimeout(500);
  await expect(page.locator('#status')).toHaveText('Listening.');
  expect(leads).toHaveLength(1);
  expect(leads[0].token).toBe(firstToken);
  const open = await page.evaluate(() => window.__sockets.map((sock) => sock.readyState));
  expect(open[open.length - 1]).toBe(1);
});

function countedRecoveryMedia() {
  window.__sockets = [];
  window.__capture = { tracks: {}, contexts: {}, worklets: {} };
  window.__mediaMode = 'ok';
  window.__releaseFlush = null;
  window.__releaseMedia = null;
  var seq = 0;
  function watch(bucket) {
    var id = bucket + (++seq);
    var gone = false;
    window.__capture[bucket][id] = true;
    return {
      id: id,
      retire: function () {
        if (gone) return;
        gone = true;
        delete window.__capture[bucket][id];
      },
    };
  }
  function makeStream() {
    var tracks = [{ stop: watch('tracks').retire }];
    return { getTracks: function () { return tracks; } };
  }
  function AudioCtx() {
    var item = watch('contexts');
    this.sampleRate = 48000;
    this.destination = {};
    this.resume = function () { return Promise.resolve(); };
    this.close = function () { item.retire(); return Promise.resolve(); };
    this.audioWorklet = { addModule: function () { return Promise.resolve(); } };
    this.createGain = function () {
      return { gain: { value: 1 }, connect: function () {}, disconnect: function () {} };
    };
    this.createMediaStreamSource = function () { return { connect: function () {} }; };
  }
  window.AudioContext = AudioCtx;
  window.webkitAudioContext = AudioCtx;
  function WorkletNode() {
    var item = watch('worklets');
    var port = {
      onmessage: null,
      postMessage: function (data) {
        if (data && data.type === 'flush') {
          var handler = port.onmessage;
          window.__releaseFlush = function () {
            if (handler) handler({ data: { type: 'flushed' } });
          };
        }
      },
    };
    this.port = port;
    this.connect = function () {};
    this.disconnect = item.retire;
  }
  window.AudioWorkletNode = WorkletNode;
  var mediaCalls = 0;
  const devices = {
    getUserMedia: function () {
      mediaCalls += 1;
      if (window.__mediaMode === 'reject' && mediaCalls > 1) {
        var denied = new Error('denied');
        denied.name = 'NotAllowedError';
        return Promise.reject(denied);
      }
      if (window.__mediaMode === 'hold' && mediaCalls > 1) {
        return new Promise(function (resolve) {
          window.__releaseMedia = function () {
            resolve(makeStream());
          };
        });
      }
      return Promise.resolve(makeStream());
    },
  };
  try {
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: devices });
  } catch (err) {
    navigator.mediaDevices = devices;
  }
  function FakeSocket() {
    this.readyState = 0;
    this.bufferedAmount = 0;
    this.onopen = null;
    this.onmessage = null;
    this.onerror = null;
    this.onclose = null;
    var self = this;
    window.__sockets.push(self);
    this.send = function (data) {
      if (typeof data === 'string' && data.indexOf('"auth"') >= 0) {
        setTimeout(function () {
          if (self.onmessage) {
            self.onmessage({
              data: JSON.stringify({ type: 'ready', max_seconds: 180, warn_seconds: 30 }),
            });
          }
        }, 0);
      }
    };
    this.close = function () {
      if (self.readyState === 3) return;
      self.readyState = 3;
      if (self.onclose) self.onclose({});
    };
    setTimeout(function () {
      self.readyState = 1;
      if (self.onopen) self.onopen({});
    }, 0);
  }
  window.WebSocket = FakeSocket;
  window.SFDC24_STT_CONFIG = { relayUrl: 'http://127.0.0.1:8765' };
}

async function captureIds(page) {
  return page.evaluate(() => ({
    tracks: Object.keys(window.__capture.tracks),
    contexts: Object.keys(window.__capture.contexts),
    worklets: Object.keys(window.__capture.worklets),
  }));
}

async function listenCounted(page) {
  await page.addInitScript(countedRecoveryMedia);
  await page.goto(SITE + '/stream/');
  await page.locator('#start').click();
  await expect(page.locator('#status')).toHaveText('Listening.', { timeout: 8000 });
}

async function restartDuringRecovery(page, kind) {
  await page.route('**/v1/leads', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, durable: false, sink: 'staged' }),
    });
  });
  await listenCounted(page);
  const first = await captureIds(page);
  expect(first.tracks).toHaveLength(1);
  expect(first.contexts).toHaveLength(1);
  expect(first.worklets).toHaveLength(1);
  await dropLiveSocket(page, kind);
  await expect(page.locator('#start')).toHaveText('Start');
  const pending = await captureIds(page);
  expect(pending).toEqual(first);
  await page.locator('#start').click();
  await expect(page.locator('#status')).toHaveText('Listening.', { timeout: 8000 });
  const second = await captureIds(page);
  expect(second.tracks).toHaveLength(1);
  expect(second.contexts).toHaveLength(1);
  expect(second.worklets).toHaveLength(1);
  expect(second.tracks[0]).not.toBe(first.tracks[0]);
  expect(second.contexts[0]).not.toBe(first.contexts[0]);
  expect(second.worklets[0]).not.toBe(first.worklets[0]);
  await page.evaluate(() => { if (window.__releaseFlush) window.__releaseFlush(); });
  await page.waitForTimeout(300);
  expect(await captureIds(page)).toEqual(second);
  await page.locator('#start').click();
  await page.waitForTimeout(400);
  const stopped = await captureIds(page);
  expect(stopped.tracks).toEqual([]);
  expect(stopped.contexts).toEqual([]);
  expect(stopped.worklets).toEqual([]);
}

test('restart before a close-recovery flush retires the previous microphone', async ({ page }) => {
  test.setTimeout(20000);
  await restartDuringRecovery(page, 'close');
});

test('restart before an error-recovery flush retires the previous microphone', async ({ page }) => {
  test.setTimeout(20000);
  await restartDuringRecovery(page, 'error');
});

test('a refused microphone during recovery leaves no previous capture', async ({ page }) => {
  test.setTimeout(20000);
  await listenCounted(page);
  const first = await captureIds(page);
  expect(first.tracks).toHaveLength(1);
  await dropLiveSocket(page, 'close');
  await page.evaluate(() => { window.__mediaMode = 'reject'; });
  await page.locator('#start').click();
  await expect(page.locator('#status')).toHaveText('Microphone permission was refused.');
  await page.evaluate(() => { if (window.__releaseFlush) window.__releaseFlush(); });
  await page.waitForTimeout(300);
  const left = await captureIds(page);
  expect(left.tracks).toEqual([]);
  expect(left.contexts).toEqual([]);
  expect(left.worklets).toEqual([]);
});

test('cancelling the next session during recovery leaves no capture open', async ({ page }) => {
  test.setTimeout(20000);
  await listenCounted(page);
  await dropLiveSocket(page, 'error');
  await page.evaluate(() => { window.__mediaMode = 'hold'; });
  await page.locator('#start').click();
  await expect(page.locator('#status')).toHaveText('Connecting.');
  const mid = await captureIds(page);
  expect(mid.tracks).toEqual([]);
  expect(mid.contexts).toHaveLength(1);
  expect(mid.worklets).toEqual([]);
  await page.locator('#start').click();
  await expect(page.locator('#status')).toHaveText('Stopped before the relay connected.');
  await page.evaluate(() => { if (window.__releaseMedia) window.__releaseMedia(); });
  await page.evaluate(() => { if (window.__releaseFlush) window.__releaseFlush(); });
  await page.waitForTimeout(300);
  const left = await captureIds(page);
  expect(left.tracks).toEqual([]);
  expect(left.contexts).toEqual([]);
  expect(left.worklets).toEqual([]);
});
