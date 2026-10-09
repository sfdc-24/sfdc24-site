// /experience/ opens the homepage studio on the conference line (owner, 2026-10-09
// call), through new, optional mount() options. The homepage still mounts with {}
// and must behave exactly as before: same topics, nothing preselected, no retry.
// Pages are served from the repository; the studio controller is mocked and
// RTCPeerConnection is stubbed, so no microphone, provider or network is used.
const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const CTRL = 'https://sfdc24-studio-controller-96522051727.us-central1.run.app';
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, content-type, accept',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
};
const DEFAULT_TOPICS = ['logo', 'website', 'app', 'salesforce_admin', 'salesforce_data', 'other'];
const HEALTH = { features: { voice: true, talk: true, topics: true, agents: ['claude'], voices: ['host', 'architect'] } };

async function load(page, url, { handle } = {}) {
  const calls = [];
  await page.route('**/*', async route => {
    const u = new URL(route.request().url());
    if (u.origin === CTRL) {
      const req = route.request();
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
      const body = req.postData() ? JSON.parse(req.postData()) : null;
      calls.push({ path: u.pathname, body });
      const now = Math.floor(Date.now() / 1000);
      let out = handle && (await handle(u.pathname, body, calls));
      if (!out) {
        if (u.pathname === '/health') out = { json: HEALTH };
        else if (u.pathname === '/v1/session') out = { json: { session_id: 's-1', token: 'sess-token', generation: 1, artifact_version: 1 } };
        else if (u.pathname === '/v1/session/s-1/voice') out = { json: { sdp: 'v=0 answer', ends_at: now + 600 } };
        else out = { status: 404, json: { detail: 'not mocked' } };
      }
      return route.fulfill({ status: out.status || 200, headers: { ...CORS, 'content-type': 'application/json' },
                             body: JSON.stringify(out.json || {}) });
    }
    if (u.origin !== 'http://site.test') return route.abort();
    let rel = decodeURIComponent(u.pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.resolve(root, '.' + rel);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
    const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json' };
    return route.fulfill({ body: fs.readFileSync(file), contentType: types[path.extname(file)] || 'text/plain' });
  });
  await page.addInitScript(() => {
    sessionStorage.setItem('studio.operator', JSON.stringify({ token: 'op-token', expires_at: '' }));
    window.vcSent = [];
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
      getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }),
    } });
    window.RTCPeerConnection = class {
      constructor() { this.iceGatheringState = 'complete'; window.vcPc = this; }
      addTrack() {}
      createDataChannel(label) {
        const ch = { label, readyState: 'open', close() {}, send: m => { window.vcSent.push(JSON.parse(m)); } };
        setTimeout(() => ch.onopen && ch.onopen(), 0);
        return ch;
      }
      async createOffer() { return { type: 'offer', sdp: 'v=0 offer' }; }
      async setLocalDescription(d) { this.localDescription = d; }
      async setRemoteDescription(d) { this.remote = d; }
      addEventListener() {}
      close() {}
    };
  });
  await page.goto('http://site.test' + url);
  return calls;
}

const topicIds = page => page.locator('[data-vc-topic]').evaluateAll(els => els.map(e => e.getAttribute('data-vc-topic')));
const checked = page => page.locator('[data-vc-topic][aria-checked="true"]').evaluateAll(els => els.map(e => e.getAttribute('data-vc-topic')));

test('the homepage keeps its default topics, with nothing preselected', async ({ page }) => {
  await load(page, '/');
  await expect(page.locator('#voice-conversation [data-vc-start]')).toBeVisible();
  expect(await topicIds(page)).toEqual(DEFAULT_TOPICS);
  expect(await checked(page)).toEqual([]);
  await expect(page.locator('#voice-conversation [data-vc-deliverables]')).toBeHidden();
});

test('the homepage does not retry a rejected topic', async ({ page }) => {
  const calls = await load(page, '/', {
    handle: p => p === '/v1/session' ? { status: 400, json: { detail: 'topic must be one of: other' } } : null,
  });
  await page.locator('[data-vc-topic="logo"]').click();
  await page.locator('#voice-conversation [data-vc-start]').click();
  await expect(page.locator('#voice-conversation [data-vc-status]')).toHaveText('The conversation could not start.');
  const sessions = calls.filter(c => c.path === '/v1/session');
  expect(sessions.length).toBe(1);
  expect(sessions[0].body).toMatchObject({ title: 'Homepage conversation', topic: 'logo' });
});

test('the experience page opens the studio on the conference line', async ({ page }) => {
  const calls = await load(page, '/experience/');
  await expect(page.locator('h1')).toHaveText('Conference experience');
  await expect(page.locator('#xp-opening')).toHaveText('What are we working on today?');
  await expect(page.locator('#experience-voice [data-vc-start]')).toBeVisible();
  expect(await topicIds(page)).toEqual(['conference']);
  expect(await checked(page)).toEqual(['conference']);
  await expect(page.locator('[data-vc-topic="conference"]')).toHaveText('Work on the conference line');
  await expect(page.locator('[data-vc-deliverable]')).toHaveText(
    ['Architecture diagram', 'Data model', 'Process flow', 'Decisions and next steps']);
  const room = page.locator('#experience-voice-room');
  await expect(room).toHaveAttribute('href', 'https://conference-gateway-yzet4vuplq-uc.a.run.app/');
  await page.locator('#experience-voice [data-vc-start]').click();
  await expect.poll(() => calls.filter(c => c.path === '/v1/session/s-1/voice').length).toBe(1);
  // One microphone at a time: the voice-room link is off while the studio is live.
  await expect(room).not.toHaveAttribute('href', /.*/);
  await expect(room).toHaveAttribute('aria-disabled', 'true');
  await expect(page.locator('#experience-handoff-status')).toContainText('End conversation');
  const sessions = calls.filter(c => c.path === '/v1/session');
  expect(sessions.length).toBe(1);
  expect(sessions[0].body).toMatchObject({ title: 'Conference experience', start: 'blank', topic: 'conference' });
  // The host opens with the page's line, not the homepage welcome.
  await expect.poll(async () => (await page.evaluate(() => vcSent
    .filter(m => m.type === 'conversation.item.create').map(m => m.item.content[0].text)))[0] || '')
    .toContain('What are we working on today?');
});

test('a controller that does not know the conference topic yet falls back to other', async ({ page }) => {
  const calls = await load(page, '/experience/', {
    handle: (p, body) => (p === '/v1/session' && body && body.topic === 'conference')
      ? { status: 400, json: { detail: 'topic must be one of: app, logo, other' } } : null,
  });
  await page.locator('#experience-voice [data-vc-start]').click();
  await expect.poll(() => calls.filter(c => c.path === '/v1/session/s-1/voice').length).toBe(1);
  const sessions = calls.filter(c => c.path === '/v1/session');
  expect(sessions.map(c => c.body.topic)).toEqual(['conference', 'other']);
  expect(sessions[1].body.creation_id).not.toBe(sessions[0].body.creation_id);
  await expect(page.locator('#experience-voice [data-vc-end]')).toBeVisible();
  await page.locator('#experience-voice [data-vc-end]').click();
  await expect(page.locator('#experience-voice-room')).toHaveAttribute('href', 'https://conference-gateway-yzet4vuplq-uc.a.run.app/');
  await expect(page.locator('#experience-voice-room')).not.toHaveAttribute('aria-disabled', 'true');
});

test('the experience page links the voice room once, owner-labelled, in a new tab', async ({ page }) => {
  await load(page, '/experience/');
  const link = page.locator('a[href^="https://conference-gateway-yzet4vuplq-uc.a.run.app"]');
  await expect(link).toHaveCount(1);
  await expect(link).toHaveText('Join the voice room (owner sign-in)');
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
});
