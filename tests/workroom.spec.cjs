// Actual /workroom/ document and unchanged production components. Every HTTP
// request is intercepted; RTC, microphone and audio are fakes. Never contacts
// the controller, sends a real code/email, or invokes a voice/model provider.
const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const ORIGIN = 'https://workroom.test';
const CTRL = 'https://sfdc24-studio-controller-96522051727.us-central1.run.app';
const CORS = {
  'access-control-allow-origin': ORIGIN,
  'access-control-allow-headers': 'authorization, content-type, accept, last-event-id',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
};
const READY = { features: { voice: true, talk: true, agents: ['claude'], summary_email: true } };
const envelope = (seq, type, payload, version = 1, extra = {}) => ({
  session_id: 's-1', generation: 1, seq, type, op_id: `op-${seq}`,
  task_id: 'task-1', task_revision: 1, artifact_version: version, turn_id: 'turn-1', payload, ...extra,
});
const snapshot = (label = 'Blank canvas', extra = {}) => envelope(1, 'artifact.snapshot', {
  root: { id: 'screen', kind: 'screen', label, children: [] },
}, 1, extra);
const patch = (seq, label, version = 2, extra = {}) => envelope(seq, 'artifact.patch', {
  ops: [{ op: 'set_label', node_id: 'screen', value: label },
    { op: 'insert_child', node_id: 'screen', node: { id: `heading-${seq}`, kind: 'heading', label } }],
}, version, extra);

async function load(page, { health = READY, signedIn = true, handle } = {}) {
  const calls = [], blocked = [], errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin === ORIGIN) {
      const pathname = url.pathname === '/workroom/' ? '/workroom/index.html' : url.pathname;
      // Explicit local-only allowlist. A missing local dependency fails visibly.
      if (!['/workroom/index.html', '/assets/chrome.css', '/assets/prototype-canvas.js',
        '/assets/voice-conversation.js', '/assets/chrome.js', '/assets/visitor-stats.js',
        '/assets/favicon.ico', '/assets/icon-32.png', '/assets/apple-touch-icon.png'].includes(pathname)) {
        blocked.push(request.url()); return route.abort();
      }
      const local = path.join(ROOT, pathname);
      if (!fs.existsSync(local)) {
        if (/\.(ico|png)$/.test(pathname)) return route.fulfill({ status: 204, body: '' });
        blocked.push(request.url()); return route.abort();
      }
      const type = pathname.endsWith('.js') ? 'application/javascript' : pathname.endsWith('.css') ? 'text/css' : 'text/html';
      return route.fulfill({ status: 200, contentType: type, body: fs.readFileSync(local) });
    }
    if (url.origin !== CTRL) { blocked.push(request.url()); return route.abort(); }
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    const p = url.pathname, body = request.postData() ? JSON.parse(request.postData()) : null;
    calls.push({ path: p, body, auth: request.headers().authorization || '', lastEventId: request.headers()['last-event-id'] });
    const json = out => route.fulfill({ status: out.status || 200, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify(out.json || {}) });
    const custom = handle && await handle(p, body, calls);
    if (custom) return custom.abort ? route.abort() : json(custom);
    const now = Math.floor(Date.now() / 1000);
    if (p === '/health') return json({ json: health });
    if (p === '/v1/auth/start') return json({ json: { challenge_id: 'challenge-test', expires_in: 600 } });
    if (p === '/v1/auth/verify') return json({ json: { token: 'op-token', scope: 'operator', expires_at: now + 3600 } });
    if (p === '/v1/session') return json({ json: { session_id: 's-1', token: 'session-token', generation: 1, artifact_version: 1, expires_at: now + 600 } });
    if (p === '/v1/session/s-1/voice') return json({ json: { sdp: 'v=0 answer', voice_id: 'voice-test', ends_at: now + 600 } });
    if (p === '/v1/session/s-1/talk') return json({ json: { reply: 'Reply to ' + body.text, speaker: 'claude', turn: body.turn } });
    if (p === '/v1/session/s-1/commands') return json({ json: { session_id: 's-1', command_id: body.command_id, artifact_version: body.expected_version, events: [], problems: [] } });
    if (p === '/v1/session/s-1/summary') return json({ json: { sent: true, to: 'v***@example.com' } });
    if (p === '/v1/session/s-1/events') {
      const first = !request.headers()['last-event-id'] || request.headers()['last-event-id'] === '0';
      return route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'text/event-stream' },
        body: first ? 'id: 1\nevent: artifact.snapshot\ndata: ' + JSON.stringify(snapshot()) + '\n\n' : ': keep-alive\n\n' });
    }
    blocked.push(request.url()); return route.abort();
  });
  await page.addInitScript(signed => {
    if (signed) sessionStorage.setItem('studio.operator', JSON.stringify({ token: 'op-token', expires_at: '' }));
    window.vcSent = []; window.vcStopped = 0; window.vcClosed = 0; window.vcResp = 0;
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
      getUserMedia: async () => ({ getTracks: () => [{ stop() { window.vcStopped++; } }] }),
    } });
    window.RTCPeerConnection = class {
      constructor() { this.iceGatheringState = 'complete'; window.vcPc = this; }
      addTrack() {}
      createDataChannel() {
        const channel = { readyState: 'open', close() {}, send(raw) {
          const message = JSON.parse(raw); window.vcSent.push(message);
          if (message.type === 'response.create') {
            const id = 'response-' + ++window.vcResp;
            setTimeout(() => window.vcEmit({ type: 'response.created', response: { id, metadata: message.response.metadata } }), 0);
          }
        } };
        window.vcChannel = channel;
        setTimeout(() => channel.onopen && channel.onopen(), 0);
        return channel;
      }
      async createOffer() { return { type: 'offer', sdp: 'v=0 offer' }; }
      async setLocalDescription(d) { this.localDescription = d; }
      async setRemoteDescription(d) { this.remote = d; }
      addEventListener() {}
      close() { window.vcClosed++; }
    };
    window.vcEmit = message => {
      if (message.type === 'response.created') window.vcRid = message.response.id;
      window.vcChannel.onmessage({ data: JSON.stringify(message) });
    };
    window.vcHeard = (item_id, transcript) => window.vcEmit({ type: 'conversation.item.input_audio_transcription.completed', item_id, transcript });
    window.vcSaid = () => {
      window.vcEmit({ type: 'response.done', response: { id: window.vcRid } });
      window.vcEmit({ type: 'output_audio_buffer.stopped', response_id: window.vcRid });
    };
    window.Audio = class { play() { return Promise.resolve(); } pause() {} };
  }, signedIn);
  await page.goto(ORIGIN + '/workroom/');
  return { calls, blocked, errors };
}
async function loadWithDelayedHealth(page) {
  let releaseHealth;
  const healthGate = new Promise(resolve => { releaseHealth = resolve; });
  const result = await load(page, { handle: async path => {
    if (path !== '/health') return;
    await healthGate;
    return { json: READY };
  } });
  await expect.poll(() => result.calls.filter(call => call.path === '/health').length).toBe(1);
  return { ...result, releaseHealth };
}

async function start(page, calls) {
  await page.locator('[data-vc-start]').click();
  await expect.poll(() => calls.filter(c => c.path.endsWith('/voice')).length).toBe(1);
  await expect.poll(() => page.evaluate(() => window.vcPc && window.vcPc.remote && window.vcPc.remote.sdp)).toBe('v=0 answer');
}
const commands = calls => calls.filter(c => c.path.endsWith('/commands') && c.body.type !== 'stop');
const spoken = page => page.evaluate(() => vcSent.filter(m => m.type === 'conversation.item.create').map(m => m.item.content[0].text));

test('actual page mounts once, loads one health probe, and makes no unmocked requests', async ({ page }) => {
  const { calls, blocked, errors } = await load(page);
  await expect(page.locator('[data-vc-start]')).toHaveCount(1);
  await expect(page.locator('[data-pc-stage]')).toHaveCount(1);
  await expect(page.locator('[data-vc-start]')).toBeVisible();
  expect(calls.filter(c => c.path === '/health')).toHaveLength(1);
  expect(calls.filter(c => c.path !== '/health')).toHaveLength(0);
  expect(blocked).toEqual([]); expect(errors).toEqual([]);
});

for (const width of [390, 1280]) {
  test('untouched workroom remains at the introduction after delayed health at ' + width + 'px', async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const { releaseHealth, blocked, errors } = await loadWithDelayedHealth(page);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    releaseHealth();
    await expect(page.locator('[data-vc-start]')).toBeVisible();
    await page.waitForTimeout(850); // Catch the shared guide's smooth initial scroll.
    const state = await page.evaluate(() => ({
      scrollY: window.scrollY,
      focus: document.activeElement.tagName,
      headerY: document.querySelector('header.masthead').getBoundingClientRect().y,
      titleY: document.querySelector('#page-title').getBoundingClientRect().y,
      docWidth: document.documentElement.scrollWidth,
      topicsOverride: Object.prototype.hasOwnProperty.call(document.querySelector('[data-vc-topics]'), 'scrollIntoView'),
    }));
    expect(state.scrollY).toBe(0);
    expect(state.focus).toBe('BODY');
    expect(state.headerY).toBe(0);
    expect(state.titleY).toBeGreaterThan(0);
    expect(state.titleY).toBeLessThan(900);
    expect(state.docWidth).toBeLessThanOrEqual(width);
    expect(state.topicsOverride).toBe(false);
    expect(blocked).toEqual([]); expect(errors).toEqual([]);
  });

  test('deliberate workroom navigation survives delayed health at ' + width + 'px', async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const { releaseHealth, blocked, errors } = await loadWithDelayedHealth(page);
    await page.getByRole('navigation', { name: 'Page navigation' }).getByRole('link', { name: 'Start here' }).click();
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(100);
    await page.waitForTimeout(850);
    const chosenY = await page.evaluate(() => window.scrollY);
    releaseHealth();
    await expect(page.locator('[data-vc-start]')).toBeVisible();
    await page.waitForTimeout(850);
    const after = await page.evaluate(() => ({ scrollY: window.scrollY, hash: location.hash,
      topicsOverride: Object.prototype.hasOwnProperty.call(document.querySelector('[data-vc-topics]'), 'scrollIntoView') }));
    expect(after.hash).toBe('#room');
    expect(Math.abs(after.scrollY - chosenY)).toBeLessThan(2);
    expect(after.topicsOverride).toBe(false);
    await page.locator('[data-vc-topic="logo"]').click();
    await expect(page.locator('[data-vc-topic="logo"]')).toHaveAttribute('aria-checked', 'true');
    expect(blocked).toEqual([]); expect(errors).toEqual([]);
  });
}

test('health disabled or unavailable leaves an honest visible fallback', async ({ page }) => {
  await load(page, { health: { features: { voice: false, talk: true } } });
  await expect(page.locator('#voice-conversation')).toBeHidden();
  await expect(page.locator('body')).toContainText(/unavailable|not available|cannot connect|not ready/i);
  await expect(page.locator('#prototype-canvas')).toBeHidden();
});

test('blank session and consecutive transcripts use the real session-scoped contracts', async ({ page }) => {
  const { calls, blocked } = await load(page);
  await start(page, calls);
  expect(calls.find(c => c.path === '/v1/session')).toMatchObject({ auth: 'Bearer op-token', body: { start: 'blank' } });
  await page.evaluate(() => vcHeard('item-1', 'Build an intake screen for a repair shop'));
  await expect.poll(() => commands(calls).length).toBe(1);
  await page.evaluate(() => vcHeard('item-2', 'Include the repair description'));
  await expect.poll(() => commands(calls).length).toBe(2);
  expect(commands(calls)[0]).toMatchObject({ auth: 'Bearer session-token', body: { session_id: 's-1', type: 'utterance', expected_version: 1 } });
  await expect.poll(() => calls.filter(c => c.path.endsWith('/talk')).length).toBe(2);
  expect(blocked).toEqual([]);
});

test('typed artifact renders before its build acknowledgement and labels stay text', async ({ page }) => {
  const label = '<img src=x onerror=alert(1)> Repair intake';
  const { calls } = await load(page, { handle: (p, body) => p.endsWith('/commands') && body.type !== 'stop' ? { json: {
    artifact_version: 2, events: [patch(2, label), envelope(3, 'confirm', { text: 'The intake is on the canvas.', artifact_ids: ['heading-2'] }, 2)],
  } } : p.endsWith('/talk') ? { status: 503, json: { detail: 'mock talk unavailable' } } : null });
  await start(page, calls);
  await page.evaluate(() => vcHeard('item-1', 'Build an intake screen'));
  await expect(page.locator('[data-pc-kind=heading]')).toHaveText(label);
  await expect(page.locator('#prototype-canvas img')).toHaveCount(0);
  await expect(page.locator('[data-pc-status]')).toHaveText('The intake is on the canvas.');
  await expect.poll(async () => (await spoken(page)).some(s => s.includes('The intake is on the canvas.'))).toBe(true);
});

test('build failure never invents a completed artifact', async ({ page }) => {
  const { calls } = await load(page, { handle: (p, body) => p.endsWith('/commands') && body.type !== 'stop'
    ? { status: 502, json: { detail: 'builder unavailable' } } : null });
  await start(page, calls);
  await page.evaluate(() => vcHeard('item-1', 'Build an intake screen'));
  await expect.poll(() => commands(calls).length).toBe(1);
  await expect(page.locator('[data-pc-kind=heading]')).toHaveCount(0);
  await expect(page.locator('[data-pc-title]')).toHaveText('Blank canvas');
  await expect(page.locator('[data-vc-deliverables] [data-done=true]')).toHaveCount(0);
});

test('expired or wrong OTP cannot create a session and retains code entry', async ({ page }) => {
  const { calls } = await load(page, { signedIn: false, handle: p => p === '/v1/auth/verify'
    ? { status: 401, json: { detail: 'expired or invalid code' } } : null });
  await page.locator('[data-vc-start]').click();
  await page.locator('[data-vc-email]').fill('visitor@example.com');
  await page.locator('[data-vc-signin] button').click();
  await page.locator('[data-vc-code]').fill('000000');
  await page.locator('[data-vc-signin] button').click();
  await expect(page.locator('[data-vc-status]')).toHaveText('That code was not accepted.');
  await expect(page.locator('[data-vc-code]')).toBeVisible();
  expect(calls.filter(c => c.path === '/v1/session')).toHaveLength(0);
});

test('foreign session, old generation and duplicate sequence events do not change the artifact', async ({ page }) => {
  const { calls } = await load(page, { handle: (p, body) => p.endsWith('/commands') && body.type !== 'stop' ? { json: {
    artifact_version: 3, events: [snapshot('Current generation', { generation: 2 }),
      patch(2, 'Accepted', 2, { generation: 2 }), patch(3, 'Foreign', 3, { session_id: 'another-session', generation: 2 }),
      patch(3, 'Old generation', 3, { generation: 1 }), patch(2, 'Duplicate sequence', 3, { generation: 2 })],
  } } : null });
  await start(page, calls);
  await page.evaluate(() => vcHeard('item-1', 'Build a screen'));
  await expect(page.locator('[data-pc-title]')).toHaveText('Accepted');
  await expect(page.locator('[data-pc-kind=heading]')).toHaveText('Accepted');
});

test('a newer-generation snapshot repairs the artifact without accepting stale replay', async ({ page }) => {
  let turn = 0;
  const { calls } = await load(page, { handle: (p, body) => {
    if (!p.endsWith('/commands') || body.type === 'stop') return null;
    return { json: { events: ++turn === 1 ? [patch(2, 'Initial')] : [snapshot('Repaired', { generation: 2 }), patch(2, 'Stale', 2, { generation: 1 })] } };
  } });
  await start(page, calls);
  await page.evaluate(() => vcHeard('item-1', 'Build a screen'));
  await expect(page.locator('[data-pc-title]')).toHaveText('Initial');
  await page.evaluate(() => vcHeard('item-2', 'Repair the session'));
  await expect(page.locator('[data-pc-title]')).toHaveText('Repaired');
  await expect(page.locator('[data-pc-kind=heading]')).toHaveCount(0);
});

test('End closes microphone and peer connection and sends the stop command', async ({ page }) => {
  const { calls } = await load(page);
  await start(page, calls);
  await page.locator('[data-vc-end]').click();
  await expect(page.locator('[data-vc-start]')).toBeVisible();
  await expect.poll(() => calls.filter(c => c.path.endsWith('/commands') && c.body.type === 'stop').length).toBeGreaterThan(0);
  expect(await page.evaluate(() => vcStopped)).toBe(1);
  expect(await page.evaluate(() => vcClosed)).toBe(1);
});

test('an ambiguous PDF receipt stays disabled and does not send an arbitrary recipient', async ({ page }) => {
  const { calls } = await load(page, { handle: p => p.endsWith('/summary')
    ? { status: 409, json: { detail: 'may already have been sent' } } : null });
  await start(page, calls);
  await page.evaluate(() => vcHeard('item-1', 'Build a repair intake screen'));
  await expect.poll(() => calls.filter(c => c.path.endsWith('/talk')).length).toBe(1);
  await page.locator('[data-vc-end]').click();
  await page.locator('[data-vc-pdf]').click();
  await expect(page.locator('[data-vc-pdf]')).toBeDisabled();
  await expect(page.locator('[data-vc-endnote]')).toContainText('may already be on its way');
  const sent = calls.filter(c => c.path.endsWith('/summary'));
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ auth: 'Bearer session-token', body: {} });
  expect(sent[0].body).not.toHaveProperty('email');
});

test('owner handoff stays on Home and is explicitly a separate session', async ({ page }) => {
  const { calls } = await load(page);
  const link = page.locator('a[href="/#owner-conference-start"]');
  const count = await link.count();
  expect(count).toBeGreaterThan(0);
  expect(await link.evaluateAll(links => links.every(a => !a.target || a.target === '_self'))).toBe(true);
  await expect(page.locator('body')).toContainText(/separate.*session/i);
  await expect(page.locator('a[href*="conference-gateway"]')).toHaveCount(0);
  await expect(page.locator('iframe')).toHaveCount(0);
  await start(page, calls);
  await expect(link).toHaveCount(0);
  await expect(page.locator('a[aria-disabled="true"]')).toHaveCount(count);
  await expect(page.locator('#handoff-status')).toContainText('End conversation');
  await page.locator('[data-vc-end]').click();
  await expect(link).toHaveCount(count);
  await expect(page.locator('a[aria-disabled="true"]')).toHaveCount(0);
});

test('phone and reduced-motion layout keeps the canvas and End within the viewport', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const { calls } = await load(page, { handle: (p, body) => p.endsWith('/commands') && body.type !== 'stop'
    ? { json: { events: [patch(2, 'Repair request')] } } : null });
  await start(page, calls);
  await page.evaluate(() => vcHeard('item-1', 'Create a repair request'));
  await expect(page.locator('[data-pc-kind=heading]')).toHaveText('Repair request');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  const button = await page.locator('[data-vc-end]').boundingBox();
  expect(button.x).toBeGreaterThanOrEqual(0); expect(button.x + button.width).toBeLessThanOrEqual(390);
  expect(button.y + button.height).toBeLessThanOrEqual(844);
  const motion = await page.locator('.vc-live-status').evaluate(el => getComputedStyle(el, '::before').animationName);
  expect(motion).toBe('none');
  await page.screenshot({ path: testInfo.outputPath('workroom-phone-offline.png'), fullPage: true });
});
