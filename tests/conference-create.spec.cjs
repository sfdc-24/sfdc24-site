const {test, expect} = require('@playwright/test');

test.describe.configure({timeout: 30000});
const fs = require('node:fs');
const path = require('node:path');
const {spawn} = require('node:child_process');

const root = path.resolve(__dirname, '..');
const artifacts = '/opt/cursor/artifacts';
const port = 8791;
const gateOrigin = `http://127.0.0.1:${port}`;
const hostCode = `host-${Math.random().toString(36).slice(2, 10)}`;
let gateProc;

async function serveSite(route) {
  const url = new URL(route.request().url());
  if (url.origin === 'http://site.test' && (url.pathname.startsWith('/v1/') || url.pathname === '/healthz')) {
    const method = route.request().method();
    const res = await fetch(gateOrigin + url.pathname, {
      method,
      headers: {'content-type': 'application/json', 'authorization': route.request().headers()['authorization'] || ''},
      body: method === 'GET' || method === 'HEAD' ? undefined : route.request().postDataBuffer()
    });
    return route.fulfill({
      status: res.status,
      contentType: 'application/json',
      body: Buffer.from(await res.arrayBuffer())
    });
  }
  if (url.origin !== 'http://site.test') return route.abort();
  let rel = decodeURIComponent(url.pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.resolve(root, '.' + rel);
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) {
    return route.fulfill({status: 404, body: ''});
  }
  const types = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon'
  };
  return route.fulfill({
    body: fs.readFileSync(file),
    contentType: types[path.extname(file)] || 'application/octet-stream'
  });
}

async function waitHealth() {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`${gateOrigin}/healthz`);
      if (res.ok) return;
    } catch (e) {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('conference gate did not start');
}

test.beforeAll(async () => {
  fs.mkdirSync(artifacts, {recursive: true});
  gateProc = spawn('python3', ['services/conference_gate/serve.py'], {
    cwd: root,
    env: {
      ...process.env,
      HOST_CONFERENCE_CODE: hostCode,
      GATE_AUTH_SECRET: 'gate-test-secret',
      PORT: String(port)
    },
    stdio: 'ignore'
  });
  await waitHealth();
});

test.afterAll(() => {
  if (gateProc) gateProc.kill('SIGTERM');
});

test.beforeEach(async ({page}) => {
  await page.route('**/*', serveSite);
});

test('host unlock mints one code and a join link', async ({page}) => {
  await page.addInitScript(() => {
    window.SFDC24_CONF_GATE = {url: 'http://site.test'};
  });
  await page.setViewportSize({width: 390, height: 844});
  await page.goto('http://site.test/conference/create/');
  await expect(page.locator('#guest-form')).toBeHidden();
  await expect(page.locator('#create-status')).toContainText('does not keep it');
  await page.screenshot({path: path.join(artifacts, 'conference-create-gate.png'), fullPage: true});

  await page.locator('#host-code').fill('not-the-host-code');
  await page.locator('#host-form').locator('button[type="submit"]').click();
  await expect(page.locator('#create-status')).toContainText('not accepted');
  await expect(page.locator('#guest-form')).toBeHidden();
  await expect(page.locator('#host-code')).toHaveValue('');

  await page.locator('#host-code').fill(hostCode);
  await page.locator('#host-form').locator('button[type="submit"]').click();
  await expect(page.locator('#guest-form')).toBeVisible();
  await expect(page.locator('#create-status')).toContainText('abdus@sfdc24.com');
  await expect(page.locator('body')).not.toContainText(hostCode);
  await page.screenshot({path: path.join(artifacts, 'conference-create-form.png'), fullPage: true});

  await page.locator('#guest-name').fill('Ada Lovelace');
  await page.locator('#guest-email').fill('ada@example.com');
  await page.locator('#guest-objective').fill('Hear the floor once');
  await page.locator('#guest-form').locator('button[type="submit"]').click();
  await expect(page.locator('#minted-code')).not.toBeEmpty();
  await expect(page.locator('#join-link')).toContainText('/conference/#c=');
  await expect(page.locator('#create-status')).toContainText('One joiner');
  const code = await page.locator('#minted-code').innerText();
  expect(code).not.toContain(hostCode);
  await page.screenshot({path: path.join(artifacts, 'conference-create-code.png'), fullPage: true});

  const sideways = await page.evaluate(() => {
    const el = document.scrollingElement || document.documentElement;
    return el.scrollWidth - el.clientWidth;
  });
  expect(sideways).toBeLessThanOrEqual(0);

  const first = await fetch(`${gateOrigin}/v1/join`, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({code})
  });
  expect(first.status).toBe(200);
  const second = await fetch(`${gateOrigin}/v1/join`, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({code})
  });
  expect(second.status).toBe(409);
});

test('conference cards move from idle to an agent on the floor', async ({page}) => {
  await page.addInitScript(() => {
    window.__micCalls = 0;
    const track = {kind: 'audio', enabled: true, stop() {}};
    const devices = navigator.mediaDevices || {};
    devices.getUserMedia = function () {
      window.__micCalls += 1;
      return Promise.resolve({
        getAudioTracks: () => [track],
        getVideoTracks: () => [],
        getTracks: () => [track]
      });
    };
    navigator.mediaDevices = devices;
    navigator.sendBeacon = function () { return true; };
    window.LivekitClient = {
      Room: function () {
        this.localParticipant = {
          publishTrack() { return Promise.resolve(); },
          publishData() { return Promise.resolve(); }
        };
        this.handlers = {};
        this.on = (ev, fn) => { this.handlers[ev] = fn; };
        this.connect = () => Promise.resolve();
        this.disconnect = () => Promise.resolve();
        window.__lkRoom = this;
      },
      RoomEvent: {
        DataReceived: 'dataReceived',
        ParticipantConnected: 'participantConnected',
        Disconnected: 'disconnected',
        Reconnecting: 'reconnecting',
        Reconnected: 'reconnected'
      }
    };
  });
  await page.setViewportSize({width: 390, height: 900});
  await page.goto('http://site.test/conference/');
  await expect(page.locator('#room-states')).toHaveAttribute('data-current', 'idle');
  await expect(page.locator('#consent-modal')).toBeHidden();
  expect(await page.evaluate(() => window.__micCalls)).toBe(0);
  await page.screenshot({path: path.join(artifacts, 'conference-idle.png'), fullPage: true});

  await page.locator('#record').check();
  await expect(page.locator('#consent-modal')).toBeVisible();
  expect(await page.evaluate(() => window.__micCalls)).toBe(0);
  await page.screenshot({path: path.join(artifacts, 'conference-consent.png'), fullPage: true});
  await page.locator('#consent-deny').click();
  await expect(page.locator('#consent-modal')).toBeHidden();
  expect(await page.evaluate(() => window.__micCalls)).toBe(0);

  await page.locator('[data-feedback="heard"]').click();
  await expect(page.locator('[data-state="heard"]')).toHaveAttribute('aria-current', 'true');

  await page.evaluate(() => {
    const exp = Math.floor(Date.now() / 1000) + 600;
    const nbf = Math.floor(Date.now() / 1000);
    const body = btoa(JSON.stringify({exp, nbf})).replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    const token = `eyJhbGciOiJIUzI1NiJ9.${body}.sig`;
    window.conferenceRoom.admit({
      ok: true,
      role: 'guest',
      room_token: token,
      url: 'wss://rooms.example/live'
    });
  });
  await page.locator('#consent-allow').click();
  await expect(page.locator('#room-states')).toHaveAttribute('data-current', 'room-open');
  expect(await page.evaluate(() => window.__micCalls)).toBe(1);
  await page.evaluate(() => {
    window.__lkRoom.handlers.participantConnected();
    window.__lkRoom.handlers.dataReceived(JSON.stringify({
      state: 'speaking',
      text: 'Hello from the floor.'
    }));
  });
  await expect(page.locator('#agent-speech')).toContainText('Hello from the floor.');
  await expect(page.locator('[data-state="agent-in-room"]')).toHaveAttribute('aria-current', 'true');
  await expect(page.locator('#floor-lock')).toContainText('Agent speaking');
  await page.screenshot({path: path.join(artifacts, 'conference-agent.png'), fullPage: true});
});
