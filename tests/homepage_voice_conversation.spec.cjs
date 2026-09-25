// Real homepage DOM with the voice module; a mocked studio controller and a
// stubbed RTCPeerConnection, so no microphone, provider or network is used.
const { test, expect } = require('@playwright/test');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const HOME = pathToFileURL(path.join(__dirname, '..', 'index.html')).href;
const ASSET = path.join(__dirname, '..', 'assets', 'voice-conversation.js');
const CTRL = 'https://sfdc24-studio-controller-96522051727.us-central1.run.app';
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, content-type, accept',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
};

function defaults(p, body, health) {
  const now = Math.floor(Date.now() / 1000);
  if (p === '/health') return { json: health };
  if (p === '/v1/auth/start') return { json: { challenge_id: 'ch-1', expires_in: 600 } };
  if (p === '/v1/auth/verify') return { json: { token: 'op-token', expires_at: now + 3600, scope: 'operator' } };
  if (p === '/v1/session') return { json: { session_id: 's-1', token: 'sess-token', generation: 1, artifact_version: 1, expires_at: now + 600 } };
  if (p === '/v1/session/s-1/voice') return { json: { sdp: 'v=0 answer', voice_id: 'voice-1', ends_at: now + 600 } };
  if (p === '/v1/session/s-1/talk') return { json: { reply: 'Reply to ' + body.text, speaker: body.agent, turn: body.turn } };
  if (p === '/v1/session/s-1/commands') return { json: { ok: true } };
  return { status: 404, json: { detail: 'not mocked' } };
}

async function load(page, { signedIn = true, health, handle } = {}) {
  health = health || { features: { voice: true, talk: true, agents: ['claude'] } };
  const calls = [];
  await page.route(/^https?:/, route => route.abort());
  await page.route(CTRL + '/**', async route => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    const p = new URL(req.url()).pathname;
    const body = req.postData() ? JSON.parse(req.postData()) : null;
    calls.push({ path: p, body, auth: req.headers().authorization || '' });
    const out = (handle && (await handle(p, body))) || defaults(p, body, health);
    return route.fulfill({ status: out.status || 200, headers: { ...CORS, 'content-type': 'application/json' },
                           body: JSON.stringify(out.json || {}) });
  });
  await page.addInitScript(signed => {
    if (signed) sessionStorage.setItem('studio.operator', JSON.stringify({ token: 'op-token', expires_at: '' }));
    window.vcSent = []; window.vcStopped = 0; window.vcClosed = 0;
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
      getUserMedia: async () => ({ getTracks: () => [{ stop() { window.vcStopped++; } }] }),
    } });
    window.RTCPeerConnection = class {
      constructor() { this.iceGatheringState = 'complete'; window.vcPc = this; }
      addTrack() {}
      createDataChannel(label) {
        const ch = { label, readyState: 'open', send: m => window.vcSent.push(JSON.parse(m)), close() {} };
        window.vcChannel = ch;
        setTimeout(() => ch.onopen && ch.onopen(), 0);
        return ch;
      }
      async createOffer() { return { type: 'offer', sdp: 'v=0 offer' }; }
      async setLocalDescription(d) { this.localDescription = d; }
      async setRemoteDescription(d) { this.remote = d; }
      addEventListener() {}
      close() { window.vcClosed++; }
    };
    window.vcEmit = msg => window.vcChannel.onmessage({ data: JSON.stringify(msg) });
    window.vcHeard = (id, transcript) => window.vcEmit({
      type: 'conversation.item.input_audio_transcription.completed', item_id: id, transcript });
  }, signedIn);
  await page.goto(HOME);
  await page.addScriptTag({ path: ASSET });
  return calls;
}

const spoken = page => page.evaluate(() => vcSent
  .filter(m => m.type === 'conversation.item.create').map(m => m.item.content[0].text));

async function started(page, calls) {
  await page.locator('[data-vc-start]').click();
  await expect.poll(() => calls.filter(c => c.path === '/v1/session/s-1/voice').length).toBe(1);
  await expect.poll(() => page.evaluate(() => window.vcPc && window.vcPc.remote && window.vcPc.remote.sdp)).toBe('v=0 answer');
}

test('the conversation control stays hidden until the controller has voice and talk', async ({ page }) => {
  await load(page, { health: { features: { voice: false, talk: true, agents: ['claude'] } } });
  await page.waitForTimeout(300);
  await expect(page.locator('#voice-conversation')).toBeHidden();
});

test('one start opens a blank session and a realtime call through the controller', async ({ page }) => {
  const calls = await load(page);
  await expect(page.locator('[data-vc-start]')).toBeVisible();
  await expect(page.locator('[data-vc-agent]')).toBeHidden();
  await started(page, calls);
  const session = calls.find(c => c.path === '/v1/session');
  expect(session.auth).toBe('Bearer op-token');
  expect(session.body).toMatchObject({ title: 'Homepage conversation', start: 'blank' });
  const voice = calls.find(c => c.path === '/v1/session/s-1/voice');
  expect(voice.auth).toBe('Bearer sess-token');
  expect(voice.body).toEqual({ sdp: 'v=0 offer' });
  expect(await page.evaluate(() => vcChannel.label)).toBe('oai-events');
  await expect(page.locator('[data-vc-end]')).toBeVisible();
  await expect(page.locator('[data-vc-start]')).toBeHidden();
});

test('each thing the visitor says is answered by the agent and spoken back', async ({ page }) => {
  const calls = await load(page);
  await started(page, calls);
  await page.evaluate(() => vcHeard('it-1', 'Design a logo for a bakery'));
  await expect.poll(() => spoken(page)).toEqual([
    'Say exactly this to the visitor, word for word, and nothing else: Reply to Design a logo for a bakery']);
  const talk = calls.find(c => c.path === '/v1/session/s-1/talk');
  expect(talk.auth).toBe('Bearer sess-token');
  expect(talk.body).toEqual({ text: 'Design a logo for a bakery', history: [], agent: 'claude', turn: 1 });
  const create = await page.evaluate(() => vcSent.find(m => m.type === 'response.create'));
  expect(create.response.output_modalities).toEqual(['audio']);
  await expect(page.locator('[data-vc-log]')).toContainText('You: Design a logo for a bakery');
  await expect(page.locator('[data-vc-log]')).toContainText('Claude: Reply to Design a logo for a bakery');
  // The same transcript event delivered twice is one turn, not two.
  await page.evaluate(() => vcHeard('it-1', 'Design a logo for a bakery'));
  await page.waitForTimeout(200);
  expect(calls.filter(c => c.path === '/v1/session/s-1/talk').length).toBe(1);
});

test('a reply that arrives after the visitor has moved on is not spoken', async ({ page }) => {
  let release;
  const gate = new Promise(r => { release = r; });
  const calls = await load(page, { handle: async (p, body) => {
    if (p !== '/v1/session/s-1/talk') return null;
    if (body.turn === 1) await gate; else release();
    return { json: { reply: 'Reply to ' + body.text, speaker: body.agent, turn: body.turn } };
  } });
  await started(page, calls);
  await page.evaluate(() => vcHeard('it-1', 'first thought'));
  await expect.poll(() => calls.filter(c => c.path === '/v1/session/s-1/talk').length).toBe(1);
  await page.evaluate(() => vcHeard('it-2', 'actually, a banner'));
  await expect.poll(() => spoken(page)).toEqual([
    'Say exactly this to the visitor, word for word, and nothing else: Reply to actually, a banner']);
  await expect.poll(() => calls.filter(c => c.path === '/v1/session/s-1/talk').length).toBe(2);
  // The banner reply finishes playing; the stale reply must not follow it.
  await page.evaluate(() => vcEmit({ type: 'response.done', response: { id: 'r-any', status: 'completed' } }));
  await page.waitForTimeout(300);
  expect((await spoken(page)).length).toBe(1);
  await expect(page.locator('[data-vc-log]')).not.toContainText('Reply to first thought');
  const second = calls.filter(c => c.path === '/v1/session/s-1/talk')[1];
  expect(second.body.history).toEqual([{ who: 'you', text: 'first thought' }]);
});

test('talking over a reply lets the next answer through once the cut-off reply ends', async ({ page }) => {
  const calls = await load(page);
  await started(page, calls);
  await page.evaluate(() => vcHeard('it-1', 'one'));
  await expect.poll(async () => (await spoken(page)).length).toBe(1);
  const tag = await page.evaluate(() => vcSent.find(m => m.type === 'response.create').response.metadata.vc);
  await page.evaluate(t => vcEmit({ type: 'response.created', response: { id: 'r1', metadata: { vc: t } } }), tag);
  await page.evaluate(() => vcEmit({ type: 'input_audio_buffer.speech_started' }));
  await page.evaluate(() => vcHeard('it-2', 'two'));
  await expect.poll(() => calls.filter(c => c.path === '/v1/session/s-1/talk').length).toBe(2);
  await page.waitForTimeout(200);
  expect((await spoken(page)).length).toBe(1);          // still waiting on the first response
  await page.evaluate(() => vcEmit({ type: 'response.done', response: { id: 'r1', status: 'cancelled' } }));
  await expect.poll(async () => (await spoken(page)).at(-1)).toContain('Reply to two');
});

test('when the visitor starts talking, a queued line is dropped instead of played', async ({ page }) => {
  const calls = await load(page);
  await started(page, calls);
  await page.evaluate(() => vcHeard('it-1', 'one'));
  await expect.poll(async () => (await spoken(page)).length).toBe(1);
  const tag = await page.evaluate(() => vcSent.find(m => m.type === 'response.create').response.metadata.vc);
  await page.evaluate(t => vcEmit({ type: 'response.created', response: { id: 'r1', metadata: { vc: t } } }), tag);
  await page.evaluate(() => vcHeard('it-2', 'two'));
  await expect(page.locator('[data-vc-log]')).toContainText('Claude: Reply to two');   // queued behind r1
  await page.evaluate(() => vcEmit({ type: 'input_audio_buffer.speech_started' }));
  await page.evaluate(() => vcEmit({ type: 'response.done', response: { id: 'r1', status: 'cancelled' } }));
  await page.waitForTimeout(300);
  expect((await spoken(page)).length).toBe(1);
});

test('end stops the session, the microphone and the call', async ({ page }) => {
  const calls = await load(page);
  await started(page, calls);
  await page.locator('[data-vc-end]').click();
  await expect.poll(() => calls.filter(c => c.path === '/v1/session/s-1/commands').length).toBe(1);
  const stop = calls.find(c => c.path === '/v1/session/s-1/commands');
  expect(stop.auth).toBe('Bearer sess-token');
  expect(stop.body).toMatchObject({ session_id: 's-1', type: 'stop', expected_version: 1 });
  expect(await page.evaluate(() => [vcStopped, vcClosed])).toEqual([1, 1]);
  await expect(page.locator('[data-vc-start]')).toBeVisible();
  await expect(page.locator('[data-vc-end]')).toBeHidden();
});

test('with two agents configured the visitor picks who answers', async ({ page }) => {
  const calls = await load(page, { health: { features: { voice: true, talk: true, agents: ['claude', 'openai'] } } });
  await expect(page.locator('[data-vc-agent]')).toBeVisible();
  await page.locator('[data-vc-agent]').selectOption('openai');
  await started(page, calls);
  await page.evaluate(() => vcHeard('it-1', 'hello'));
  await expect(page.locator('[data-vc-log]')).toContainText('OpenAI: Reply to hello');
  expect(calls.find(c => c.path === '/v1/session/s-1/talk').body.agent).toBe('openai');
});

test('a visitor who is not signed in gets the email code, then the conversation starts', async ({ page }) => {
  const calls = await load(page, { signedIn: false });
  await page.locator('[data-vc-start]').click();
  await expect(page.locator('[data-vc-signin]')).toBeVisible();
  expect(calls.some(c => c.path === '/v1/session')).toBe(false);
  await page.locator('[data-vc-email]').fill('Person@Example.com');
  await page.locator('[data-vc-signin] button').click();
  await expect(page.locator('[data-vc-code]')).toBeVisible();
  const begin = calls.find(c => c.path === '/v1/auth/start');
  expect(begin.body.email).toBe('person@example.com');
  expect(begin.body.client_key).toMatch(/^[0-9a-f]{32}$/);
  await page.locator('[data-vc-code]').fill('123456');
  await page.locator('[data-vc-signin] button').click();
  await expect.poll(() => calls.filter(c => c.path === '/v1/session/s-1/voice').length).toBe(1);
  const verify = calls.find(c => c.path === '/v1/auth/verify');
  expect(verify.body).toEqual({ challenge_id: 'ch-1', email: 'person@example.com', code: '123456',
                                client_key: begin.body.client_key });
  expect(calls.find(c => c.path === '/v1/session').auth).toBe('Bearer op-token');
  await expect(page.locator('[data-vc-signin]')).toBeHidden();
  expect(JSON.parse(await page.evaluate(() => sessionStorage.getItem('studio.operator'))).token).toBe('op-token');
});
