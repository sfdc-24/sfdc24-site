// Real homepage DOM with the voice module and the live canvas; a mocked
// studio controller (session, voice, talk, commands, event stream) and a
// stubbed RTCPeerConnection. What is under test is the page: that what the
// visitor says reaches the builder, that the builder events render as live,
// usable parts and running scenes, and that nothing it sends becomes markup.
const { test, expect } = require('@playwright/test');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const HOME = pathToFileURL(path.join(__dirname, '..', 'index.html')).href;
const VOICE = path.join(__dirname, '..', 'assets', 'voice-conversation.js');
const CANVAS = path.join(__dirname, '..', 'assets', 'prototype-canvas.js');
const CTRL = 'https://sfdc24-studio-controller-96522051727.us-central1.run.app';
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, content-type, accept, last-event-id',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
};
const SNAPSHOT = { seq: 1, type: 'artifact.snapshot', artifact_version: 1,
                   payload: { root: { id: 'screen', kind: 'screen', label: 'Blank canvas', children: [] } } };

function ev(seq, type, payload, version) {
  return { seq, type, artifact_version: version, payload };
}
function insert(parent, id, kind, label, detail) {
  return { op: 'insert_child', node_id: parent, node: detail ? { id, kind, label, detail } : { id, kind, label } };
}

async function load(page, { build } = {}) {
  const calls = [];
  await page.route(/^https?:/, route => route.abort());
  await page.route(CTRL + '/**', async route => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    const p = new URL(req.url()).pathname;
    const body = req.postData() ? JSON.parse(req.postData()) : null;
    calls.push({ path: p, body, lastEventId: req.headers()['last-event-id'] });
    const json = out => route.fulfill({ status: out.status || 200, headers: { ...CORS, 'content-type': 'application/json' },
                                        body: JSON.stringify(out.json || {}) });
    const now = Math.floor(Date.now() / 1000);
    if (p === '/health') return json({ json: { features: { voice: true, talk: true, agents: ['claude'] } } });
    if (p === '/v1/session') return json({ json: { session_id: 's-1', token: 'sess-token', artifact_version: 1, expires_at: now + 600 } });
    if (p === '/v1/session/s-1/voice') return json({ json: { sdp: 'v=0 answer', voice_id: 'voice-1', ends_at: now + 600 } });
    if (p === '/v1/session/s-1/talk') return json({ json: { reply: 'On it.', speaker: 'claude', turn: body.turn } });
    if (p === '/v1/session/s-1/events') {
      const first = (req.headers()['last-event-id'] || '0') === '0';
      const text = first ? 'id: 1\nevent: artifact.snapshot\ndata: ' + JSON.stringify(SNAPSHOT) + '\n\n' : ': keep-alive\n\n';
      return route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'text/event-stream' }, body: text });
    }
    if (p === '/v1/session/s-1/commands') {
      if (body.type === 'stop') return json({ json: { ok: true } });
      const out = build ? await build(body, calls) : null;
      return json(out || { json: { artifact_version: body.expected_version, events: [], problems: [] } });
    }
    return json({ status: 404, json: { detail: 'not mocked' } });
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
        const ch = { label, readyState: 'open', send: m => window.vcSent.push(JSON.parse(m)), close() {} };
        window.vcChannel = ch;
        setTimeout(() => ch.onopen && ch.onopen(), 0);
        return ch;
      }
      async createOffer() { return { type: 'offer', sdp: 'v=0 offer' }; }
      async setLocalDescription(d) { this.localDescription = d; }
      async setRemoteDescription(d) { this.remote = d; }
      addEventListener() {}
      close() {}
    };
    window.vcEmit = msg => window.vcChannel.onmessage({ data: JSON.stringify(msg) });
    window.vcHeard = (id, transcript) => window.vcEmit({
      type: 'conversation.item.input_audio_transcription.completed', item_id: id, transcript });
  });
  await page.goto(HOME);
  await page.addScriptTag({ path: CANVAS });
  await page.addScriptTag({ path: VOICE });
  await page.locator('[data-vc-start]').click();
  await expect.poll(() => page.evaluate(() => window.vcPc && window.vcPc.remote && window.vcPc.remote.sdp)).toBe('v=0 answer');
  return calls;
}

const commands = calls => calls.filter(c => c.path === '/v1/session/s-1/commands' && c.body.type !== 'stop');
const spoken = page => page.evaluate(() => vcSent
  .filter(m => m.type === 'conversation.item.create').map(m => m.item.content[0].text));
const snap = (page, id) => page.evaluate(sceneId =>
  document.querySelector('[data-pc-scene="' + sceneId + '"]').__pc.snapshot(), id);

test('what the visitor says is built live on the homepage, and a question can be answered with a tap', async ({ page }) => {
  const calls = await load(page, { build: body => {
    if (body.type === 'answer') return { json: { artifact_version: 3, events: [
      ev(5, 'question.answered', { question_id: 'q-cta' }, 3),
      ev(6, 'artifact.patch', { ops: [{ op: 'set_label', node_id: 'cta', value: 'Order ahead' }] }, 3)] } };
    return { json: { artifact_version: 2, events: [
      ev(2, 'artifact.patch', { ops: [
        { op: 'set_label', node_id: 'screen', value: 'Bakery landing page' },
        insert('screen', 'hero', 'section', 'Hero'),
        insert('hero', 'h', 'heading', 'Fresh bread, every morning'),
        insert('hero', 'cta', 'button', 'Visit us'),
        insert('screen', 'signup', 'form', 'Weekly specials'),
        insert('signup', 'email', 'field', 'Email', 'name@example.com')] }, 2),
      ev(3, 'confirm', { text: 'Built the landing page.', artifact_ids: ['hero'] }, 2),
      ev(4, 'question.asked', { question: { question_id: 'q-cta', prompt: 'What should the main button do?',
        options: [{ option_id: 'order', label: 'Order ahead', consequence: 'Opens ordering' },
                  { option_id: 'visit', label: 'Visit us', consequence: 'Opens the map' }] } }, 2)] } };
  } });
  await expect(page.locator('#prototype-canvas')).toBeVisible();
  await page.evaluate(() => vcHeard('it-1', 'Build a landing page for my bakery'));
  await expect(page.locator('[data-pc-title]')).toHaveText('Bakery landing page');
  const sent = commands(calls)[0].body;
  expect(sent).toMatchObject({ type: 'utterance', transcript: 'Build a landing page for my bakery', item_id: 'it-1',
                               session_id: 's-1', expected_version: 1 });
  await expect(page.locator('[data-pc-kind=heading]')).toHaveText('Fresh bread, every morning');
  await expect(page.locator('[data-pc-kind=button]')).toHaveText('Visit us');
  await page.locator('[data-pc-kind=field] input').fill('someone@example.com');
  await expect.poll(() => spoken(page)).toContain(
    'Say exactly this to the visitor, word for word, and nothing else: Built the landing page.');
  await page.evaluate(() => vcEmit({ type: 'response.done', response: { id: 'r-any' } }));
  await page.evaluate(() => vcEmit({ type: 'response.done', response: { id: 'r-any' } }));
  await page.evaluate(() => vcEmit({ type: 'response.done', response: { id: 'r-any' } }));
  await expect.poll(async () => (await spoken(page)).some(t => t.includes('What should the main button do?'))).toBe(true);
  await page.locator('[data-pc-option=order]').click();
  await expect.poll(() => commands(calls).length).toBe(2);
  expect(commands(calls)[1].body).toMatchObject({ type: 'answer', question_id: 'q-cta', option_id: 'order',
                                                  answer_source: 'tap', expected_version: 2 });
  await expect(page.locator('[data-pc-kind=button]')).toHaveText('Order ahead');
  await expect(page.locator('[data-pc-ask]')).toBeHidden();
  await expect(page.locator('[data-pc-kind=field] input')).toHaveValue('someone@example.com');
});

test('a scene runs as a live engine: motion, spin, bounce, and unsafe entities are never drawn', async ({ page }) => {
  await load(page, { build: () => ({ json: { artifact_version: 2, events: [ev(2, 'artifact.patch', { ops: [
    insert('screen', 'stage', 'scene', 'Playground', '800x400 bg=#101820'),
    insert('stage', 'ball', 'entity', 'Ball', 'circle cx=100 cy=200 r=20 fill=#F25C54 vx=300 bounce=1'),
    insert('stage', 'star', 'entity', 'Star', 'polygon points=400,100;420,140;380,140 fill=#FFE9A8 spin=180'),
    insert('stage', 'snow', 'entity', 'Snow', 'particles x=400 y=0 rate=60 size=3 speed=50 angle=90 spread=120 life=4'),
    insert('stage', 'bad', 'entity', 'Bad', 'rect x=0 onclick=alert(1)'),
    insert('stage', 'bad2', 'entity', 'Bad too', 'image href=https://evil.example/x.png')] }, 2)] } }) });
  await page.evaluate(() => vcHeard('it-1', 'a bouncing ball'));
  const scene = page.locator('[data-pc-scene=stage]');
  await expect(scene).toBeVisible();
  await scene.scrollIntoViewIfNeeded();
  await expect(scene).toHaveAttribute('data-pc-entities', '3');
  await expect(scene).toHaveAttribute('aria-label', 'Playground: Ball, Star, Snow');
  const a = await snap(page, 'stage');
  await page.waitForTimeout(700);
  const b = await snap(page, 'stage');
  const ballA = a.find(e => e.id === 'ball'), ballB = b.find(e => e.id === 'ball');
  expect(Math.abs(ballB.x - ballA.x)).toBeGreaterThan(60);                   // it moves
  expect(b.find(e => e.id === 'star').angle).toBeGreaterThan(a.find(e => e.id === 'star').angle);
  expect(b.find(e => e.id === 'snow').parts).toBeGreaterThan(0);
  await page.waitForTimeout(2200);                                          // long enough to reach a wall
  const c = await snap(page, 'stage');
  const ballC = c.find(e => e.id === 'ball');
  expect(ballC.x).toBeGreaterThanOrEqual(-0.5);
  expect(ballC.x + ballC.w).toBeLessThanOrEqual(800.5);
  expect(b.map(e => e.id)).not.toContain('bad');
});

test('an edit glides to its new position and colour instead of jumping', async ({ page }) => {
  let turn = 0;
  await load(page, { build: () => {
    turn += 1;
    if (turn === 1) return { json: { artifact_version: 2, events: [ev(2, 'artifact.patch', { ops: [
      insert('screen', 'logo', 'scene', 'Logo', '600x300 bg=#FFFFFF'),
      insert('logo', 'mark', 'entity', 'Mark', 'circle cx=100 cy=150 r=40 fill=#000000')] }, 2)] } };
    return { json: { artifact_version: 3, events: [ev(3, 'artifact.patch', { ops: [
      { op: 'set_detail', node_id: 'mark', value: 'circle cx=500 cy=150 r=40 fill=#FF0000' }] }, 3)] } };
  } });
  await page.evaluate(() => vcHeard('it-1', 'a logo'));
  await page.locator('[data-pc-scene=logo]').scrollIntoViewIfNeeded();
  await expect.poll(async () => (await snap(page, 'logo')).length).toBe(1);
  await page.waitForTimeout(600);
  await page.evaluate(() => vcHeard('it-2', 'move it right and make it red'));
  await expect.poll(async () => (await snap(page, 'logo'))[0].cur.cx, { timeout: 3000 })
    .toBeGreaterThan(100);
  const mid = (await snap(page, 'logo'))[0].cur;
  expect(mid.cx).toBeLessThan(500);                                           // caught in flight
  await page.waitForTimeout(700);
  const done = (await snap(page, 'logo'))[0].cur;
  expect(done.cx).toBe(500);
  expect(done.fill.map(Math.round)).toEqual([255, 0, 0]);
});

test('an entity can be picked up and thrown, and a tap reacts', async ({ page }) => {
  await load(page, { build: () => ({ json: { artifact_version: 2, events: [ev(2, 'artifact.patch', { ops: [
    insert('screen', 'game', 'scene', 'Game', '800x400 bg=#101820 gravity=0'),
    insert('game', 'puck', 'entity', 'Puck', 'circle cx=200 cy=200 r=30 fill=#4CC9F0 drag=1 bounce=1'),
    insert('game', 'gem', 'entity', 'Gem', 'rect x=600 y=180 width=40 height=40 fill=#F72585 tap=burst')] }, 2)] } }) });
  await page.evaluate(() => vcHeard('it-1', 'a puck I can throw'));
  const scene = page.locator('[data-pc-scene=game]');
  await scene.scrollIntoViewIfNeeded();
  await page.waitForTimeout(600);
  const box = await scene.boundingBox();
  const at = (x, y) => [box.x + x * box.width / 800, box.y + y * box.height / 400];
  await page.mouse.move(...at(200, 200));
  await page.mouse.down();
  await page.mouse.move(...at(300, 220), { steps: 5 });
  await page.mouse.move(...at(400, 240), { steps: 5 });
  await page.mouse.up();
  const puck = (await snap(page, 'game')).find(e => e.id === 'puck');
  expect(puck.x).toBeGreaterThan(300);                                        // it went where it was dragged
  await page.mouse.click(...at(620, 200));
  await expect.poll(async () => ((await snap(page, 'game')).find(e => e.id === '(bursts)') || {}).parts || 0)
    .toBeGreaterThan(0);
});

test('an acknowledgement that lands after the builder has reported is not spoken', async ({ page }) => {
  let releaseTalk;
  const talkGate = new Promise(r => { releaseTalk = r; });
  await page.route(CTRL + '/v1/session/s-1/talk', async route => {
    await talkGate;
    const body = JSON.parse(route.request().postData());
    return route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/json' },
                           body: JSON.stringify({ reply: 'On it.', speaker: 'claude', turn: body.turn }) });
  });
  await load(page, { build: () => ({ json: { artifact_version: 2, events: [
    ev(2, 'confirm', { text: 'Built it.', artifact_ids: ['screen'] }, 2)] } }) });
  await page.evaluate(() => vcHeard('it-1', 'build it'));
  await expect.poll(async () => (await spoken(page)).some(t => t.includes('Built it.'))).toBe(true);
  releaseTalk();
  await page.evaluate(() => vcEmit({ type: 'response.done', response: { id: 'r-any' } }));
  await page.waitForTimeout(400);
  expect((await spoken(page)).filter(t => t.includes('On it.'))).toEqual([]);
});

test('labels from the builder are text, never markup', async ({ page }) => {
  await load(page, { build: () => ({ json: { artifact_version: 2, events: [ev(2, 'artifact.patch', { ops: [
    insert('screen', 'x', 'heading', '<img src=x onerror="window.pwned=1">'),
    insert('screen', 'y', 'field', 'Name', '"><script>window.pwned=2</script>')] }, 2)] } }) });
  await page.evaluate(() => vcHeard('it-1', 'anything'));
  await expect(page.locator('[data-pc-kind=heading]')).toHaveText('<img src=x onerror="window.pwned=1">');
  expect(await page.locator('#prototype-canvas img, #prototype-canvas script').count()).toBe(0);
  expect(await page.evaluate(() => window.pwned)).toBeUndefined();
});

test('what is said while a build runs waits, then goes to the builder together', async ({ page }) => {
  let release;
  const gate = new Promise(r => { release = r; });
  const calls = await load(page, { build: async body => {
    if (body.transcript === 'first') await gate;
    return { json: { artifact_version: body.expected_version, events: [] } };
  } });
  await page.evaluate(() => vcHeard('it-1', 'first'));
  await expect.poll(() => commands(calls).length).toBe(1);
  await page.evaluate(() => { vcHeard('it-2', 'second'); vcHeard('it-3', 'third'); });
  await page.waitForTimeout(300);
  expect(commands(calls).length).toBe(1);
  release();
  await expect.poll(() => commands(calls).length).toBe(2);
  expect(commands(calls)[1].body).toMatchObject({ type: 'utterance', transcript: 'second third', item_id: 'it-3' });
});

test('what the builder reports waits until the visitor pauses', async ({ page }) => {
  await load(page, { build: () => ({ json: { artifact_version: 2, events: [
    ev(2, 'confirm', { text: 'Added the banner.', artifact_ids: ['screen'] }, 2)] } }) });
  // The builder answers while the visitor is still talking: nothing is said yet.
  await page.evaluate(() => vcHeard('it-1', 'add a banner'));
  await page.evaluate(() => vcEmit({ type: 'input_audio_buffer.speech_started' }));
  await page.waitForTimeout(400);
  expect((await spoken(page)).filter(t => t.includes('Added the banner.'))).toEqual([]);
  await page.evaluate(() => vcEmit({ type: 'input_audio_buffer.speech_stopped' }));
  await expect.poll(async () => (await spoken(page)).some(t => t.includes('Added the banner.'))).toBe(true);
});
