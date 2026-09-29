const {test, expect} = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');

test.beforeEach(async ({page}) => {
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
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
      '.json': 'application/json',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.ico': 'image/x-icon'
    };
    return route.fulfill({
      body: fs.readFileSync(file),
      contentType: types[path.extname(file)] || 'application/octet-stream'
    });
  });
});

test('no token is honest and does not pretend an invite exists', async ({page}) => {
  await page.addInitScript(() => {
    window.__micCalls = 0;
    window.__beacons = 0;
    const devices = navigator.mediaDevices || {};
    devices.getUserMedia = function () {
      window.__micCalls += 1;
      return Promise.reject(new Error('blocked'));
    };
    navigator.mediaDevices = devices;
    navigator.sendBeacon = function (url) {
      window.__beacons += 1;
      window.__beaconUrl = String(url);
      return true;
    };
  });
  const invented = [];
  page.on('request', (req) => {
    const u = req.url();
    if (u.includes('conference-gateway') || u.includes('/conference/feedback') || u.includes('/conference/telemetry')) invented.push(u);
  });
  await page.setViewportSize({width: 390, height: 844});
  await page.goto('http://site.test/conference/');
  const status = page.locator('#join-status');
  await expect(status).toContainText('No join token on this link.');
  await expect(status).toContainText('does not send an invite');
  await expect(status).toContainText('already issues the room token');
  await expect(page.locator('#join')).toHaveAttribute('href', 'https://conference-gateway-96522051727.us-central1.run.app/');
  await expect(page.locator('#record')).toBeEnabled();
  await expect(page.locator('#recording-state')).toContainText('Recording: off.');
  await expect(page.locator('#join-status')).toContainText('No join token on this link.');
  const joined = await page.evaluate(() => ({beacons: window.__beacons, url: window.__beaconUrl}));
  expect(joined.beacons).toBeGreaterThan(0);
  expect(joined.url).toBe('https://conference-gateway-96522051727.us-central1.run.app/feedback');
  await expect(page.locator('#beacon-status')).toContainText('Beacon sent.');
  await expect(page.locator('#beacon-status')).not.toHaveClass(/chalk/);
  const beforeHeard = await page.evaluate(() => window.__beacons);
  await page.locator('[data-feedback="heard"]').click();
  await expect(page.locator('#beacon-status')).toContainText('Noted in this tab: heard.');
  await expect(page.locator('[data-feedback="heard"]')).toHaveAttribute('aria-pressed', 'true');
  const beforeWait = await page.evaluate(() => window.__beacons);
  await page.locator('[data-wait="tap"]').click();
  await expect(page.locator('#wait-line')).toContainText('Taps in this tab: 1');
  expect(await page.evaluate(() => window.__beacons)).toBe(beforeWait);
  const waitBox = await page.locator('#wait-play').boundingBox();
  expect(waitBox.height).toBeLessThan(120);
  const beforeChat = await page.evaluate(() => window.__beacons);
  await page.locator('#chat-text').fill('Hello room');
  await page.locator('#chat-form').locator('button').click();
  await expect(page.locator('#chat-log')).toContainText('Hello room');
  await expect(page.locator('#chat-log')).not.toContainText('<b>');
  expect(await page.evaluate(() => window.__beacons)).toBe(beforeChat);
  const chatBox = await page.locator('#room-chat').boundingBox();
  expect(chatBox.height).toBeLessThan(150);
  const afterHeard = await page.evaluate(() => window.__beacons);
  expect(afterHeard).toBeGreaterThan(beforeHeard);
  await expect(page.locator('#beacon-status')).toHaveClass(/chalk/);
  const written = await page.locator('#beacon-status').evaluate((el) => getComputedStyle(el).animationName);
  expect(written).toBe('chalk-write');
  const sideways = await page.evaluate(() => {
    const el = document.scrollingElement || document.documentElement;
    return el.scrollWidth - el.clientWidth;
  });
  expect(sideways).toBeLessThanOrEqual(0);
  expect(invented).toEqual([]);
  const box = await page.locator('#join').boundingBox();
  expect(box.y + box.height).toBeLessThan(844);
  const board = page.locator('#claude-board');
  await expect(board).toContainText('Key issues');
  await expect(board).toContainText('Discussion notes');
  await expect(board).toContainText('Action items');
  await expect(board).toContainText('Next steps');
  await expect(board).toContainText('Delay, and answers cut off.');
  await expect(board).toContainText('Four voices, one floor.');
  await expect(board).toContainText('Measure both next call.');
  await expect(board).toContainText('Sign in to join.');
  await expect(board.locator('.board-rail')).toBeVisible();
  const tone = await board.evaluate((el) => {
    const css = getComputedStyle(el);
    return {bg: css.backgroundColor, border: css.borderTopWidth, overflow: el.scrollWidth - el.clientWidth};
  });
  expect(tone.bg).toBe('rgb(255, 255, 255)');
  expect(tone.border).toBe('1px');
  expect(tone.overflow).toBeLessThanOrEqual(1);
  const boardBox = await board.boundingBox();
  expect(boardBox.height).toBeLessThan(160);
  expect(boardBox.y).toBeGreaterThan(box.y + box.height);
});

test('a token is held, not shown, and not redeemed here', async ({page}) => {
  const token = 'eyJhbGciOiJIUzI1NiJ9.eyJyb29tIjoiYSJ9.signaturevalue';
  await page.addInitScript(() => {
    window.__beaconBodies = [];
    navigator.sendBeacon = function (url, data) {
      window.__beaconBodies.push(String(url) + ' ' + String(data || ''));
      return true;
    };
  });
  await page.setViewportSize({width: 320, height: 700});
  await page.goto('http://site.test/conference/#t=' + token);
  await expect(page.locator('#join-status')).toContainText('A token is on this link.');
  await expect(page.locator('#join-status')).toContainText('does not store it or redeem it');
  await expect(page.locator('body')).not.toContainText(token);
  expect(page.url()).not.toContain(token);
  const href = await page.locator('#join').getAttribute('href');
  expect(href).toBe('https://conference-gateway-96522051727.us-central1.run.app/');
  expect(href).not.toContain(token);
  const stored = await page.evaluate(() => sessionStorage.getItem('sfdc24_conf_token') || localStorage.getItem('sfdc24_conf_token') || '');
  expect(stored).toBe('');
  const sideways = await page.evaluate(() => {
    const el = document.scrollingElement || document.documentElement;
    return el.scrollWidth - el.clientWidth;
  });
  expect(sideways).toBeLessThanOrEqual(0);
  const bodies = await page.evaluate(() => window.__beaconBodies.join('\n'));
  expect(bodies).toContain('/feedback');
  expect(bodies).not.toContain(token);
});

test('opt-in starts the recorder and exit sends another beacon', async ({page}) => {
  await page.addInitScript(() => {
    window.__beacons = 0;
    window.__started = 0;
    window.__stopped = 0;
    const track = {kind: 'audio', stop() { window.__stopped += 1; }};
    const devices = navigator.mediaDevices || {};
    devices.getUserMedia = function () {
      return Promise.resolve({
        getAudioTracks: () => [track],
        getVideoTracks: () => [],
        getTracks: () => [track]
      });
    };
    navigator.mediaDevices = devices;
    window.MediaRecorder = function () {
      this.state = 'inactive';
      this.start = () => { this.state = 'recording'; window.__started += 1; };
      this.stop = () => { this.state = 'inactive'; track.stop(); };
      this.addEventListener = () => {};
    };
    navigator.sendBeacon = function (url, data) {
      window.__beacons += 1;
      window.__lastBeacon = String(data || '');
      window.__beaconUrl = String(url);
      return true;
    };
  });
  await page.setViewportSize({width: 390, height: 844});
  await page.goto('http://site.test/conference/');
  const before = await page.evaluate(() => window.__beacons);
  await page.locator('#record').check();
  await expect(page.locator('#recording-state')).toContainText('Recording: on.');
  await expect(page.locator('#recording-state')).toContainText('Audio is not uploaded.');
  const started = await page.evaluate(() => ({started: window.__started, last: window.__lastBeacon, url: window.__beaconUrl}));
  expect(started.started).toBe(1);
  expect(started.url).toBe('https://conference-gateway-96522051727.us-central1.run.app/feedback');
  expect(started.last).toContain('"audio":1');
  expect(started.last).not.toContain('eyJ');
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  const after = await page.evaluate(() => ({beacons: window.__beacons, stopped: window.__stopped, last: window.__lastBeacon}));
  expect(after.beacons).toBeGreaterThan(before);
  expect(after.stopped).toBeGreaterThan(0);
  expect(after.last).toContain('"phase":"exit"');
});

test('address text is not copied into the beacon status', async ({page}) => {
  await page.goto('http://site.test/conference/');
  await page.locator('#address').fill('Guest label');
  await page.locator('#address').dispatchEvent('change');
  await expect(page.locator('#beacon-status')).toContainText('Address saved in this tab. It is not sent.');
  await expect(page.locator('#beacon-status')).not.toContainText('Guest label');
});
