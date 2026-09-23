const { test, expect } = require('@playwright/test');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const REPO = path.join(__dirname, '..');
const SITE = 'http://127.0.0.1:4173';
const RELAY = 'http://127.0.0.1:8765';
const SECRET = 'browser-test-secret';
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
    this.createMediaStreamSource = function () {
      return { connect: function () {} };
    };
  }
  window.AudioContext = AudioCtx;
  window.webkitAudioContext = AudioCtx;
  function WorkletNode() {
    this.port = { onmessage: null };
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
      DEEPGRAM_API_KEY: '',
      RELAY_AUTH_SECRET: SECRET,
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

  await expect.poll(async () => {
    const res = await fetch(RELAY + '/v1/leads', { headers: { 'X-Relay-Admin': SECRET } });
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
