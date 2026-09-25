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
const MUSE = { line: 'What should a customer feel in the first three seconds?', directions: [
  { id: 'a', title: 'Warm Craft', see: { palette: ['#7A4A1E', '#F6EBDD', '#C98A3E'], motif: 'hand-drawn wheat, soft grain', type: 'serif' },
    read: { headline: 'Baked at dawn', line: 'Small batches, big smiles.' }, hear: { tone: 'warm and unhurried' },
    work: 'A logo first, then a one-page site.' },
  { id: 'b', title: 'Night Market', see: { palette: ['#111827', '#F59E0B', '#EF4444', '#F9FAFB'], motif: 'neon signage, bold blocks', type: 'display' },
    read: { headline: 'Open late. Fresh always.', line: 'The bakery that never sleeps.' }, hear: { tone: 'punchy and bright' },
    work: 'A bold landing page with a live order counter.' },
  { id: 'c', title: 'Clean Lab', see: { palette: ['#0B1F3A', '#00A1E0', '#FFFFFF'], motif: 'grid lines, precise icons', type: 'mono' },
    read: { headline: 'Bread, engineered.', line: 'Every loaf, the same perfect crumb.' }, hear: { tone: 'calm and exact' },
    work: 'A product dashboard first, brand second.' }] };
const SNAPSHOT = { seq: 1, type: 'artifact.snapshot', artifact_version: 1,
                   payload: { root: { id: 'screen', kind: 'screen', label: 'Blank canvas', children: [] } } };

function ev(seq, type, payload, version, extra) {
  return Object.assign({ seq, type, artifact_version: version, payload }, extra || {});
}
function insert(parent, id, kind, label, detail) {
  return { op: 'insert_child', node_id: parent, node: detail ? { id, kind, label, detail } : { id, kind, label } };
}

async function load(page, { build, analyst, snapshot, hangEvents, voices, speakStatus = 200, recap, speakAbort, playFails, noTalk,
                             rating, summary, summaryReply, muse } = {}) {
  const calls = [];
  const pending = [];
  let eventOpens = 0;
  calls.release = () => pending.splice(0).forEach((fn) => { try { fn(); } catch (e) { /* aborted */ } });
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
    if (p === '/health') return json({ json: { features: { voice: true, talk: true, agents: ['claude'], analyst: !!analyst,
                                                      voices: voices || [], rating: !!rating, summary_email: !!summary,
                                                      muse: !!muse } } });
    if (p === '/v1/session/s-1/inspire') {
      const out = typeof muse === 'function' ? await muse(body, calls) : null;
      return json(out || { json: { turn: body.turn, muse: MUSE } });
    }
    if (p === '/v1/session/s-1/rating') return json({ json: { ok: true } });
    if (p === '/v1/session/s-1/summary') return json(summaryReply || { json: { sent: true, to: 'p***@example.com' } });
    if (p === '/v1/session/s-1/speak') {
      if (speakAbort) return route.abort();
      if (speakStatus !== 200) return json({ status: speakStatus, json: { detail: 'the architect voice is unavailable right now' } });
      return route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'audio/mpeg' }, body: Buffer.from('ID3fake-mp3') });
    }
    if (p === '/v1/session/s-1/recap') return json(recap ? await recap(body) : { json: { recap: 'You wanted a bakery logo; it is on the canvas.', speaker: 'claude' } });
    if (p === '/v1/session') return json({ json: { session_id: 's-1', token: 'sess-token', artifact_version: 1, expires_at: now + 600 } });
    if (p === '/v1/session/s-1/voice') return json({ json: { sdp: 'v=0 answer', voice_id: 'voice-1', ends_at: now + 600 } });
    if (p === '/v1/session/s-1/talk') {
      // noTalk: the talk lane stays quiet, so an architect line never queues behind an unfinished reply.
      if (noTalk) return json({ status: 503, json: { detail: 'talk is unavailable right now' } });
      return json({ json: { reply: 'On it.', speaker: 'claude', turn: body.turn } });
    }
    if (p === '/v1/session/s-1/events') {
      eventOpens += 1;
      if (hangEvents && eventOpens > 1) {
        return new Promise((resolve) => {
          pending.push(() => {
            route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'text/event-stream' }, body: ': keep-alive\n\n' });
            resolve();
          });
        });
      }
      const first = (req.headers()['last-event-id'] || '0') === '0';
      const text = first ? 'id: 1\nevent: artifact.snapshot\ndata: ' + JSON.stringify(snapshot || SNAPSHOT) + '\n\n' : ': keep-alive\n\n';
      return route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'text/event-stream' }, body: text });
    }
    if (p === '/v1/session/s-1/commands') {
      if (body.type === 'stop') return json({ json: { ok: true } });
      const out = build ? await build(body, calls) : null;
      return json(out || { json: { artifact_version: body.expected_version, events: [], problems: [] } });
    }
    if (p === '/v1/session/s-1/analyze') {
      const out = analyst ? await analyst(body, calls) : null;
      return json(out || { status: 503, json: { detail: 'the analyst is not available' } });
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
    // A realtime line ends when generation is done AND its audio has played.
    window.vcSaid = id => { window.vcEmit({ type: 'response.done', response: { id } });
                            window.vcEmit({ type: 'output_audio_buffer.stopped' }); };
    window.vcAudios = [];
    window.Audio = class {
      constructor(src) { this.src = src; this.paused = false; this.playing = false; window.vcAudios.push(this); }
      play() { if (window.vcPlayFails) return Promise.reject(new Error('decode')); this.playing = true; return Promise.resolve(); }
      pause() { this.paused = true; }
    };
    window.vcHeard = (id, transcript) => window.vcEmit({
      type: 'conversation.item.input_audio_transcription.completed', item_id: id, transcript });
  });
  if (playFails) await page.addInitScript(() => { window.vcPlayFails = true; });
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
  const calls = await load(page, { noTalk: true, build: body => {
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
  await page.evaluate(() => vcSaid('r-any'));
  await page.evaluate(() => vcSaid('r-any'));
  await page.evaluate(() => vcSaid('r-any'));
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
    ev(2, 'confirm', { text: 'Built it.', artifact_ids: ['screen'] }, 1)] } }) });
  await page.evaluate(() => vcHeard('it-1', 'build it'));
  await expect.poll(async () => (await spoken(page)).some(t => t.includes('Built it.'))).toBe(true);
  releaseTalk();
  await page.evaluate(() => vcSaid('r-any'));
  await page.waitForTimeout(400);
  expect((await spoken(page)).filter(t => t.includes('On it.'))).toEqual([]);
});

test('bodies land on solid platforms, and attached parts move with their object', async ({ page }) => {
  await load(page, { build: () => ({ json: { artifact_version: 2, events: [ev(2, 'artifact.patch', { ops: [
    insert('screen', 'shop', 'scene', 'Shop', '800x400 bg=#2B1B12 gravity=900'),
    insert('shop', 'counter', 'entity', 'Counter', 'rect x=0 y=250 width=800 height=40 fill=#3A2417 solid=1'),
    insert('shop', 'loaf', 'entity', 'Loaf', 'ellipse cx=200 cy=60 rx=60 ry=30 fill=#D9A05B body=1'),
    insert('shop', 'mark', 'entity', 'Crust mark', 'line x1=190 y1=50 x2=210 y2=40 stroke=#8A5A2B attach=loaf'),
    insert('shop', 'cart', 'entity', 'Cart', 'rect x=500 y=100 width=60 height=30 fill=#4CC9F0 vx=150'),
    insert('shop', 'wheel', 'entity', 'Wheel', 'circle cx=515 cy=135 r=8 fill=#111111 attach=cart')] }, 2)] } }) });
  await page.evaluate(() => vcHeard('it-1', 'a loaf on a counter'));
  const scene = page.locator('[data-pc-scene=shop]');
  await scene.scrollIntoViewIfNeeded();
  await page.waitForTimeout(1800);
  const s = await snap(page, 'shop');
  const loaf = s.find(e => e.id === 'loaf'), mark = s.find(e => e.id === 'mark');
  expect(loaf.y + loaf.h).toBeGreaterThan(240);                               // it fell...
  expect(loaf.y + loaf.h).toBeLessThanOrEqual(251);                           // ...and stopped on the counter
  expect(Math.abs((mark.y - 40) - (loaf.y - 30))).toBeLessThan(2);            // the mark came with it
  const cart = s.find(e => e.id === 'cart'), wheel = s.find(e => e.id === 'wheel');
  expect(cart.x).toBeGreaterThan(560);
  expect(Math.abs((wheel.x - 507) - (cart.x - 500))).toBeLessThan(2);         // the wheel rides the cart
});

test('the analyst works beside the builder: a live data model and its findings appear', async ({ page }) => {
  const MODEL = { domain: 'Bakery ordering', findings: ['Bakeries usually take pre-orders a day ahead.'],
    objects: [{ id: 'contact', name: 'Contact', standard: true, fields: [{ name: 'Email', type: 'Email' }] },
              { id: 'order', name: 'Order', standard: true, fields: [{ name: 'Pickup date', type: 'Date' }] },
              { id: 'slot', name: 'Pickup Slot', standard: false, fields: [{ name: 'Capacity', type: 'Number' }] }],
    relationships: [{ from: 'order', to: 'contact', kind: 'lookup', label: 'Ordered by' },
                    { from: 'order', to: 'slot', kind: 'lookup', label: 'Collected in' }] };
  const calls = await load(page, {
    build: () => ({ json: { artifact_version: 2, events: [
      ev(2, 'artifact.patch', { ops: [insert('screen', 'hero', 'heading', 'Order ahead')] }, 2)] } }),
    analyst: () => ({ json: { turn: 0, events: [
      ev(3, 'model.updated', { model: MODEL }, 2),
      ev(4, 'question.asked', { question: { question_id: 'qa-1', prompt: 'Pay when ordering or at pickup?',
        options: [{ option_id: 'now', label: 'When ordering', consequence: 'Adds payment' },
                  { option_id: 'later', label: 'At pickup', consequence: 'No payment step' }] } }, 2)] } }),
  });
  await page.evaluate(() => vcHeard('it-1', 'pre-orders for my bakery'));
  await expect.poll(() => calls.filter(c => c.path === '/v1/session/s-1/analyze').length).toBe(1);
  expect(calls.find(c => c.path === '/v1/session/s-1/analyze').body).toEqual({ text: 'pre-orders for my bakery', turn: 0 });
  await expect(page.locator('[data-pc-model]')).toHaveAttribute('data-pc-objects', '3');
  await expect(page.locator('.pc-model-title')).toHaveText('Data model - Bakery ordering');
  await expect(page.locator('[data-pc-findings] li')).toHaveText(['Bakeries usually take pre-orders a day ahead.']);
  await expect(page.locator('[data-pc-kind=heading]')).toHaveText('Order ahead');
  await expect(page.locator('[data-pc-question=qa-1]')).toBeVisible();
  await expect(page.locator('[data-pc-agent=analyst]')).toBeVisible();
  const model = page.locator('[data-pc-model]');
  await model.scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  const nodes = await page.evaluate(() => document.querySelector('[data-pc-model]').__pc.snapshot());
  expect(nodes.map(n => n.id).sort()).toEqual(['contact', 'order', 'slot']);
});

test('events from different lanes are applied in sequence, never skipped', async ({ page }) => {
  let releaseBuild;
  const gate = new Promise(r => { releaseBuild = r; });
  await load(page, {
    build: async () => { await gate; return { json: { artifact_version: 2, events: [
      ev(2, 'artifact.patch', { ops: [insert('screen', 'hero', 'heading', 'First')] }, 2)] } }; },
    analyst: () => ({ json: { turn: 0, events: [ev(3, 'model.updated', { model: { domain: 'X', findings: [],
      objects: [{ id: 'a', name: 'A', standard: false, fields: [] }], relationships: [] } }, 2)] } }),
  });
  await page.evaluate(() => vcHeard('it-1', 'go'));
  await page.waitForTimeout(400);                          // the analysis (seq 3) is back first
  await expect(page.locator('[data-pc-model-pane]')).toBeHidden();
  releaseBuild();                                           // the build (seq 2) lands: both apply, in order
  await expect(page.locator('[data-pc-kind=heading]')).toHaveText('First');
  await expect(page.locator('[data-pc-model]')).toHaveAttribute('data-pc-objects', '1');
});

test('the page applies the builder grammar again: geometry, sizes and exact statements', async ({ page }) => {
  const bad = ['circle', 'polygon', 'path d=M', 'text fill=#fff', 'rect solid=1', 'rect x=0 y=0 width=10',
               'circle cx=1 cy=1 r=-5', 'rect x=0 y=0 width=-10 height=5', ' circle cx=1 cy=1 r=1',
               'circle cx=1 cy=1 r=1 ', 'circle  cx=1 cy=1 r=1', 'circle\u00a0cx=1 cy=1 r=1', 'text x=1 y=1 weight=450'];
  const ops = [insert('screen', 'stage', 'scene', 'Stage', '400x300 bg=none'),
               insert('stage', 'ok', 'entity', 'Fine', 'circle cx=100 cy=100 r=20 fill=#E8B04B')];
  bad.forEach((d, i) => ops.push(insert('stage', 'bad' + i, 'entity', 'Bad', d)));
  await load(page, { build: () => ({ json: { artifact_version: 2, events: [ev(2, 'artifact.patch', { ops }, 2)] } }) });
  await page.evaluate(() => vcHeard('it-1', 'a stage'));
  const scene = page.locator('[data-pc-scene=stage]');
  await expect(scene).toHaveAttribute('data-pc-entities', '1');
  const rejected = await page.evaluate(list => list.filter(d => window.SFDC24Canvas.parseEntity(d)), bad);
  expect(rejected).toEqual([]);
  expect(await page.evaluate(() => window.SFDC24Canvas.parseScene(' 400x300'))).toBeNull();
  expect(await page.evaluate(() => window.SFDC24Canvas.parseScene('400x300 bg=none'))).toMatchObject({ bg: 'none' });
});

const BOTH = ['host', 'architect'];
const realtimeLines = page => page.evaluate(() => vcSent.filter(m => m.type === 'conversation.item.create')
  .map(m => m.item.content[0].text.replace('Say exactly this to the visitor, word for word, and nothing else: ', '')));
const HOST_INTRO = "Hi, and welcome to SFDC24! I'm your host. I'll keep the notes while we talk, " +
                   "and when you're done I'll wrap it all up with a quick recap.";
const ARCHITECT_INTRO = "And I'm your architect. Tell me what's on your mind: a logo, a website, an app, " +
                        "a problem to solve. I'll build it on the canvas while you talk. So, what are we making today?";
const spokenByArchitect = calls => calls.filter(c => c.path === '/v1/session/s-1/speak').map(c => c.body.text);

/* Both intros said: the host's through the call, then the architect's in its
   own voice (or the host's, when that voice fails). */
async function introduced(page) {
  await expect.poll(async () => (await realtimeLines(page))[0]).toBe(HOST_INTRO);
  await page.evaluate(() => vcSaid('host-intro'));
  const intro = "I'm your architect";
  await expect.poll(() => page.evaluate(intro => (vcAudios.length > 0 && vcAudios[0].playing)
    || vcSent.some(m => m.type === 'conversation.item.create' && m.item.content[0].text.includes(intro)), intro)).toBe(true);
  await page.evaluate(() => {
    if (vcAudios.length && vcAudios[0].playing) vcAudios[0].onended();
    else vcSaid('architect-intro');
  });
  await expect(page.locator('[data-vc-status]')).toHaveText('Listening');
}

test('both agents introduce themselves when the call opens, each in its own voice', async ({ page }) => {
  const calls = await load(page, { voices: BOTH });
  await expect.poll(() => realtimeLines(page)).toEqual([HOST_INTRO]);
  expect(spokenByArchitect(calls)).toEqual([]);                  // the architect waits for the host
  await page.evaluate(() => vcSaid('host-intro'));
  await expect.poll(() => spokenByArchitect(calls)).toEqual([ARCHITECT_INTRO]);
  expect(calls.find(c => c.path === '/v1/session/s-1/speak').body.voice).toBe('architect');
  await expect.poll(() => page.evaluate(() => vcAudios.length && vcAudios[0].playing)).toBe(true);
  expect(await realtimeLines(page)).toEqual([HOST_INTRO]);
  await expect(page.locator('[data-vc-notes]')).toBeHidden();     // introductions are not meeting notes
  await expect(page.locator('#mic')).toBeHidden();
  await expect(page.locator('#mic')).toHaveAttribute('data-retired', 'openai-voice');
});

test('a visitor who starts talking during the introductions has the floor', async ({ page }) => {
  const calls = await load(page, { voices: BOTH, noTalk: true });
  await expect.poll(() => realtimeLines(page)).toEqual([HOST_INTRO]);
  await page.evaluate(() => vcEmit({ type: 'input_audio_buffer.speech_started' }));
  await page.evaluate(() => vcSaid('host-intro'));
  await page.waitForTimeout(300);
  expect(spokenByArchitect(calls)).toEqual([]);                  // the architect's intro is dropped
});

test('the architect says what the builder reports, in its own voice, and it goes in the notes', async ({ page }) => {
  const calls = await load(page, { voices: BOTH, noTalk: true, build: () => ({ json: { artifact_version: 2, events: [
    ev(2, 'artifact.patch', { ops: [insert('screen', 'h', 'heading', 'Fresh bread')] }, 2),
    ev(3, 'confirm', { text: 'Built the bakery page.', artifact_ids: ['h'] }, 2)] } }) });
  await introduced(page);
  await page.evaluate(() => vcHeard('it-1', 'a bakery page'));
  await expect.poll(() => spokenByArchitect(calls)).toEqual([ARCHITECT_INTRO, 'Built the bakery page.']);
  expect(calls.filter(c => c.path === '/v1/session/s-1/speak')[1].body).toEqual({ text: 'Built the bakery page.', voice: 'architect' });
  await expect.poll(() => page.evaluate(() => vcAudios.length === 2 && vcAudios[1].playing)).toBe(true);
  expect((await realtimeLines(page)).filter(t => t.includes('Built the bakery page.'))).toEqual([]);
  await expect(page.locator('[data-vc-notes]')).toContainText('Architect: Built the bakery page.');
  await expect(page.locator('[data-vc-notes]')).not.toContainText("I'm your architect");
  await page.evaluate(() => vcAudios[1].onended());
  await expect(page.locator('[data-vc-status]')).toHaveText('Listening');
});

test('a visitor who starts talking stops the architect mid-line, with no realtime cancel', async ({ page }) => {
  await load(page, { voices: BOTH, noTalk: true, build: () => ({ json: { artifact_version: 2, events: [
    ev(2, 'confirm', { text: 'Here is the plan.', artifact_ids: ['screen'] }, 1)] } }) });
  await introduced(page);
  await page.evaluate(() => vcHeard('it-1', 'plan it'));
  await expect.poll(() => page.evaluate(() => vcAudios.length === 2 && vcAudios[1].playing)).toBe(true);
  await page.evaluate(() => vcEmit({ type: 'input_audio_buffer.speech_started' }));
  expect(await page.evaluate(() => vcAudios[1].paused)).toBe(true);
  expect(await page.evaluate(() => vcSent.filter(m => m.type === 'response.cancel').length)).toBe(0);
});

test('if the architect voice fails, the host says the line instead', async ({ page }) => {
  await load(page, { voices: BOTH, noTalk: true, speakStatus: 503, build: () => ({ json: { artifact_version: 2, events: [
    ev(2, 'confirm', { text: 'Built it anyway.', artifact_ids: ['screen'] }, 1)] } }) });
  await introduced(page);
  await page.evaluate(() => vcHeard('it-1', 'build it'));
  await expect.poll(async () => (await realtimeLines(page)).some(t => t === 'Built it anyway.')).toBe(true);
});

test('End asks the host for a recap, says it, notes it, then hangs up', async ({ page }) => {
  const calls = await load(page, { voices: BOTH });
  await introduced(page);
  await page.evaluate(() => vcHeard('it-1', 'a bakery logo'));
  await expect.poll(() => calls.filter(c => c.path === '/v1/session/s-1/talk').length).toBe(1);
  await page.evaluate(() => vcSaid('reply'));
  await page.locator('[data-vc-end]').click();
  await expect(page.locator('[data-vc-end]')).toHaveText('End now');
  await expect.poll(() => calls.filter(c => c.path === '/v1/session/s-1/recap').length).toBe(1);
  await expect.poll(async () => (await realtimeLines(page)).at(-1)).toBe('You wanted a bakery logo; it is on the canvas.');
  await expect(page.locator('[data-vc-notes]')).toContainText('Recap: You wanted a bakery logo');
  expect(calls.filter(c => c.path === '/v1/session/s-1/commands' && c.body.type === 'stop').length).toBe(0);
  await page.evaluate(() => vcSaid('recap'));
  await expect.poll(() => calls.filter(c => c.path === '/v1/session/s-1/commands' && c.body.type === 'stop').length).toBe(1);
  await expect(page.locator('[data-vc-start]')).toBeVisible();
  await expect(page.locator('[data-vc-notes]')).toContainText('Recap:');                      // the notes stay on screen
});

test('a long recap that is being spoken is never cut off by the wrap-up timer', async ({ page }) => {
  const calls = await load(page, { voices: BOTH });
  await introduced(page);
  await page.evaluate(() => vcHeard('it-1', 'a bakery logo'));
  await expect.poll(async () => (await realtimeLines(page)).at(-1)).toBe('On it.');
  await page.evaluate(() => vcSaid('reply'));
  await page.clock.install();
  await page.locator('[data-vc-end]').click();
  await expect.poll(async () => (await realtimeLines(page)).at(-1)).toContain('You wanted a bakery logo');
  await page.evaluate(() => { vcEmit({ type: 'output_audio_buffer.started' });
                              vcEmit({ type: 'response.done', response: { id: 'recap' } }); });
  await page.clock.runFor(90000);                                   // a minute and a half of recap audio
  await page.waitForTimeout(300);
  expect(calls.filter(c => c.path === '/v1/session/s-1/commands' && c.body.type === 'stop')).toEqual([]);
  await page.evaluate(() => vcEmit({ type: 'output_audio_buffer.stopped' }));
  await page.clock.runFor(1000);
  await expect.poll(() => calls.filter(c => c.path === '/v1/session/s-1/commands' && c.body.type === 'stop').length).toBe(1);
});

test('End during a long host line: the wrap-up waits for that line and the whole recap', async ({ page }) => {
  const calls = await load(page, { voices: BOTH });
  await introduced(page);
  await page.evaluate(() => vcHeard('it-1', 'a bakery logo'));
  await expect.poll(async () => (await realtimeLines(page)).at(-1)).toBe('On it.');
  await page.clock.install();
  await page.evaluate(() => { vcEmit({ type: 'output_audio_buffer.started' });           // the reply is playing...
                              vcEmit({ type: 'response.done', response: { id: 'reply' } }); });
  await page.locator('[data-vc-end]').click();                                          // ...when End is pressed
  await expect.poll(() => calls.filter(c => c.path === '/v1/session/s-1/recap').length).toBe(1);
  await page.clock.runFor(60000);                                                      // the reply runs on
  await page.waitForTimeout(300);
  const stops = () => calls.filter(c => c.path === '/v1/session/s-1/commands' && c.body.type === 'stop').length;
  expect(stops()).toBe(0);
  await page.evaluate(() => vcEmit({ type: 'output_audio_buffer.stopped' }));           // the reply ends
  await expect.poll(async () => (await realtimeLines(page)).at(-1)).toContain('You wanted a bakery logo');
  await page.evaluate(() => { vcEmit({ type: 'output_audio_buffer.started' });
                              vcEmit({ type: 'response.done', response: { id: 'recap' } }); });
  await page.clock.runFor(60000);                                                      // a long recap
  await page.waitForTimeout(300);
  expect(stops()).toBe(0);
  await page.evaluate(() => vcEmit({ type: 'output_audio_buffer.stopped' }));
  await page.clock.runFor(1000);
  await expect.poll(stops).toBe(1);
});

test('a recap that never starts still ends the conversation after 45 seconds', async ({ page }) => {
  const calls = await load(page, { voices: BOTH });
  await introduced(page);
  await page.evaluate(() => vcHeard('it-1', 'a bakery logo'));
  await expect.poll(async () => (await realtimeLines(page)).at(-1)).toBe('On it.');
  await page.evaluate(() => vcSaid('reply'));
  await page.clock.install();
  await page.locator('[data-vc-end]').click();
  await expect.poll(async () => (await realtimeLines(page)).at(-1)).toContain('You wanted a bakery logo');
  await page.clock.runFor(46000);                                   // no audio ever reported
  await expect.poll(() => calls.filter(c => c.path === '/v1/session/s-1/commands' && c.body.type === 'stop').length).toBe(1);
});

test('talking during the recap keeps the meeting going', async ({ page }) => {
  const calls = await load(page, { voices: BOTH });
  await introduced(page);
  await page.evaluate(() => vcHeard('it-1', 'a logo'));
  await expect.poll(async () => (await realtimeLines(page)).at(-1)).toBe('On it.');
  await page.evaluate(() => vcSaid('reply'));
  await page.locator('[data-vc-end]').click();
  await expect.poll(async () => (await realtimeLines(page)).at(-1)).toContain('You wanted a bakery logo');
  await page.evaluate(() => vcEmit({ type: 'input_audio_buffer.speech_started' }));
  await expect(page.locator('[data-vc-end]')).toHaveText('End conversation');
  await page.evaluate(() => vcSaid('recap'));
  await page.waitForTimeout(900);
  expect(calls.filter(c => c.path === '/v1/session/s-1/commands' && c.body.type === 'stop').length).toBe(0);
  await expect(page.locator('[data-vc-end]')).toBeVisible();
});

test('one voice listed is no voices: no welcome, no architect, no notes', async ({ page }) => {
  for (const voices of [['host'], ['architect'], []]) {
    const p2 = await page.context().newPage();
    const calls = await load(p2, { voices, noTalk: true, build: () => ({ json: { artifact_version: 2, events: [
      ev(2, 'confirm', { text: 'Built it.', artifact_ids: ['screen'] }, 1)] } }) });
    await p2.evaluate(() => vcHeard('it-1', 'build it'));
    await expect.poll(async () => (await realtimeLines(p2)).some(t => t === 'Built it.')).toBe(true);
    expect((await realtimeLines(p2)).some(t => /welcome to SFDC24|I'm your architect/.test(t))).toBe(false);
    expect(calls.filter(c => c.path === '/v1/session/s-1/speak').length).toBe(0);
    await expect(p2.locator('[data-vc-notes]')).toBeHidden();
    await p2.close();
  }
});

test('talking in the moment after the recap ends still keeps the meeting going', async ({ page }) => {
  const calls = await load(page, { voices: BOTH });
  await introduced(page);
  await page.evaluate(() => vcHeard('it-1', 'a logo'));
  await expect.poll(async () => (await realtimeLines(page)).at(-1)).toBe('On it.');
  await page.evaluate(() => vcSaid('reply'));
  await page.locator('[data-vc-end]').click();
  await expect.poll(async () => (await realtimeLines(page)).at(-1)).toContain('You wanted a bakery logo');
  await page.evaluate(() => vcSaid('recap'));   // recap finished...
  await page.evaluate(() => vcEmit({ type: 'input_audio_buffer.speech_started' }));        // ...and they speak
  await page.waitForTimeout(900);
  expect(calls.filter(c => c.path === '/v1/session/s-1/commands' && c.body.type === 'stop').length).toBe(0);
  await expect(page.locator('[data-vc-end]')).toHaveText('End conversation');
});

for (const [name, opts] of [['a network failure', { speakAbort: true }], ['a playback failure', { playFails: true }]]) {
  test(`after ${name} of the architect voice, the host says the line`, async ({ page }) => {
    await load(page, { voices: BOTH, noTalk: true, ...opts, build: () => ({ json: { artifact_version: 2, events: [
      ev(2, 'confirm', { text: 'Built it regardless.', artifact_ids: ['screen'] }, 1)] } }) });
    await introduced(page);
    await page.evaluate(() => vcHeard('it-1', 'build it'));
    await expect.poll(async () => (await realtimeLines(page)).some(t => t === 'Built it regardless.')).toBe(true);
  });
}

test('End before anything was said ends at once, and a second End never waits', async ({ page }) => {
  const calls = await load(page, { voices: BOTH });
  await page.locator('[data-vc-end]').click();
  await expect.poll(() => calls.filter(c => c.path === '/v1/session/s-1/commands' && c.body.type === 'stop').length).toBe(1);
  expect(calls.filter(c => c.path === '/v1/session/s-1/recap').length).toBe(0);
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
    ev(2, 'confirm', { text: 'Added the banner.', artifact_ids: ['screen'] }, 1)] } }) });
  // Realtime order: speech starts, stops, then the transcript. The visitor
  // starts again before the builder line can play, so it waits for the pause.
  await page.evaluate(() => {
    vcEmit({ type: 'input_audio_buffer.speech_started' });
    vcEmit({ type: 'input_audio_buffer.speech_stopped' });
    vcHeard('it-1', 'add a banner');
    vcEmit({ type: 'input_audio_buffer.speech_started' });
  });
  await page.waitForTimeout(400);
  expect((await spoken(page)).filter(t => t.includes('Added the banner.'))).toEqual([]);
  await page.evaluate(() => vcEmit({ type: 'input_audio_buffer.speech_stopped' }));
  await expect.poll(async () => (await spoken(page)).some(t => t.includes('Added the banner.'))).toBe(true);
});

test('a transcript that lands before speech_stopped does not clear the pause', async ({ page }) => {
  await load(page, { noTalk: true, build: () => ({ json: { artifact_version: 9, events: [
    ev(2, 'confirm', { text: 'Added the banner.', artifact_ids: ['screen'] }, 1)] } }) });
  await page.evaluate(() => {
    vcEmit({ type: 'input_audio_buffer.speech_started' });
    vcHeard('it-1', 'add a banner');
  });
  await page.waitForTimeout(400);
  expect((await spoken(page)).filter(t => t.includes('Added the banner.'))).toEqual([]);
  await page.evaluate(() => vcEmit({ type: 'input_audio_buffer.speech_stopped' }));
  await expect.poll(async () => (await spoken(page)).some(t => t.includes('Added the banner.'))).toBe(true);
});

test('a patch applies only on the next version, a confirm only on the current one, and a command body does not move the version', async ({ page }) => {
  let turn = 0;
  const calls = await load(page, { build: (body) => {
    turn += 1;
    if (turn === 1) return { json: { artifact_version: 40, events: [
      ev(2, 'artifact.patch', { ops: [insert('screen', 'h', 'heading', 'Skipped')] }, 5),
      ev(3, 'confirm', { text: 'Too soon.', artifact_ids: ['screen'] }, 5)] } };
    if (body.transcript === 'now') return { json: { artifact_version: 40, events: [
      ev(2, 'artifact.patch', { ops: [insert('screen', 'h', 'heading', 'Ready')] }, 2),
      ev(3, 'confirm', { text: 'Ready now.', artifact_ids: ['h'] }, 2)] } };
    return { json: { artifact_version: 40, events: [] } };
  } });
  await page.evaluate(() => vcHeard('it-1', 'skip ahead'));
  await expect.poll(() => commands(calls).length).toBe(1);
  await page.waitForTimeout(300);
  await expect(page.locator('[data-pc-kind=heading]')).toHaveCount(0);
  expect((await spoken(page)).filter(t => t.includes('Too soon.'))).toEqual([]);
  await page.evaluate(() => vcHeard('it-2', 'now'));
  await expect(page.locator('[data-pc-kind=heading]')).toHaveText('Ready');
  await expect(page.locator('[data-pc-status]')).toHaveText('Ready now.');
  await page.evaluate(() => vcHeard('it-3', 'again'));
  await expect.poll(() => commands(calls).length).toBe(3);
  expect(commands(calls)[2].body.expected_version).toBe(2);
});

test('a foreign session is ignored, and a snapshot rewinds only for a higher generation', async ({ page }) => {
  const base = { seq: 1, type: 'artifact.snapshot', artifact_version: 1, generation: 1, session_id: 's-1',
    payload: { root: { id: 'screen', kind: 'screen', label: 'Blank canvas', children: [] } } };
  let turn = 0;
  await load(page, { snapshot: base, build: () => {
    turn += 1;
    if (turn === 1) return { json: { artifact_version: 2, events: [
      ev(2, 'artifact.patch', { ops: [
        { op: 'set_label', node_id: 'screen', value: 'Kept' },
        insert('screen', 'h', 'heading', 'Mine')] }, 2, { generation: 1, session_id: 's-1' }),
      ev(3, 'artifact.patch', { ops: [insert('screen', 'x', 'heading', 'Stolen')] }, 3,
        { generation: 1, session_id: 'someone-else' })] } };
    if (turn === 2) return { json: { artifact_version: 1, events: [
      { seq: 1, type: 'artifact.snapshot', artifact_version: 1, generation: 1, session_id: 's-1',
        payload: { root: { id: 'screen', kind: 'screen', label: 'Wiped', children: [] } } }] } };
    return { json: { artifact_version: 1, events: [
      { seq: 1, type: 'artifact.snapshot', artifact_version: 1, generation: 2, session_id: 's-1',
        payload: { root: { id: 'screen', kind: 'screen', label: 'Fresh', children: [] } } }] } };
  } });
  await page.evaluate(() => vcHeard('it-1', 'build'));
  await expect(page.locator('[data-pc-title]')).toHaveText('Kept');
  await expect(page.locator('[data-pc-kind=heading]')).toHaveText(['Mine']);
  await page.evaluate(() => vcHeard('it-2', 'same generation'));
  await page.waitForTimeout(200);
  await expect(page.locator('[data-pc-title]')).toHaveText('Kept');
  await page.evaluate(() => vcHeard('it-3', 'new generation'));
  await expect(page.locator('[data-pc-title]')).toHaveText('Fresh');
  await expect(page.locator('[data-pc-kind=heading]')).toHaveCount(0);
});

test('a scene whose detail fails the grammar is not drawn', async ({ page }) => {
  await load(page, { build: () => ({ json: { artifact_version: 2, events: [ev(2, 'artifact.patch', { ops: [
    insert('screen', 'bad', 'scene', 'Bad', 'not a size'),
    insert('screen', 'ok', 'heading', 'Still here'),
    insert('screen', 'good', 'scene', 'Good', '400x200 bg=#101820')] }, 2)] } }) });
  await page.evaluate(() => vcHeard('it-1', 'a scene'));
  await expect(page.locator('[data-pc-kind=heading]')).toHaveText('Still here');
  await expect(page.locator('[data-pc-scene=bad]')).toHaveCount(0);
  await expect(page.locator('[data-pc-scene=good]')).toBeVisible();
});

test('a seq gap held for 2s reconnects the event stream from the last applied seq', async ({ page }) => {
  const calls = await load(page, { hangEvents: true, build: () => ({ json: { artifact_version: 4, events: [
    ev(3, 'artifact.patch', { ops: [insert('screen', 'h', 'heading', 'Early')] }, 2)] } }) });
  try {
    await page.evaluate(() => vcHeard('it-1', 'gap'));
    await expect.poll(() => commands(calls).length).toBe(1);
    await expect(page.locator('[data-pc-kind=heading]')).toHaveCount(0);
    const before = calls.filter(c => c.path === '/v1/session/s-1/events').length;
    await page.waitForTimeout(2300);
    const events = calls.filter(c => c.path === '/v1/session/s-1/events');
    expect(events.length).toBeGreaterThan(before);
    expect(events[events.length - 1].lastEventId).toBe('1');
    await expect(page.locator('[data-pc-kind=heading]')).toHaveCount(0);
  } finally {
    calls.release();
  }
});

test('tab cycles interactive entities, arrows move a draggable one, and enter taps', async ({ page }) => {
  await load(page, { build: () => ({ json: { artifact_version: 2, events: [ev(2, 'artifact.patch', { ops: [
    insert('screen', 'game', 'scene', 'Game', '800x400 bg=#101820 gravity=0'),
    insert('game', 'puck', 'entity', 'Puck', 'circle cx=200 cy=200 r=30 fill=#4CC9F0 drag=1'),
    insert('game', 'gem', 'entity', 'Gem', 'rect x=600 y=180 width=40 height=40 fill=#F72585 tap=burst')] }, 2)] } }) });
  await page.evaluate(() => vcHeard('it-1', 'a puck and a gem'));
  const scene = page.locator('[data-pc-scene=game]');
  await scene.scrollIntoViewIfNeeded();
  await expect(scene).toHaveAttribute('tabindex', '0');
  await scene.focus();
  await expect(scene).toHaveAttribute('data-pc-focus', 'puck');
  await expect.poll(() => scene.evaluate((c) => getComputedStyle(c).outlineStyle)).not.toBe('none');
  const before = (await snap(page, 'game')).find(e => e.id === 'puck').x;
  await page.keyboard.press('ArrowRight');
  await expect.poll(async () => Math.round(((await snap(page, 'game')).find(e => e.id === 'puck').x - before))).toBe(10);
  await page.keyboard.press('Tab');
  await expect(scene).toHaveAttribute('data-pc-focus', 'gem');
  await expect.poll(() => page.evaluate(() => {
    const c = document.querySelector('[data-pc-scene=game]');
    const img = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    for (let i = 0; i < img.length; i += 4) if (img[i] > 240 && img[i + 1] > 200 && img[i + 2] < 90) return true;
    return false;
  })).toBe(true);
  await page.keyboard.press('Shift+Tab');
  await expect(scene).toHaveAttribute('data-pc-focus', 'puck');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await expect.poll(async () => ((await snap(page, 'game')).find(e => e.id === '(bursts)') || {}).parts || 0)
    .toBeGreaterThan(0);
});

test('scene and entity statements follow the builder grammar, and bg=none leaves the stage clear', async ({ page }) => {
  const rejectedEntities = [
    '<svg onload=alert(1)>', 'rect x=0 y=0 width=10 height=10 fill=url(#x)',
    'rect x=0 onclick=alert(1)', 'image href=https://evil.example/x.png',
    'path d=M0,0L10,10javascript:1', 'text x=1 y=1 font=Comic',
    'rect x=0 x=1', 'circle cx=1 cy=1 r=1 opacity=2', 'rect x=10px',
    'circle cx=1 cy=1 r=1 tap=eval', 'circle cx=1 cy=1 r=1 body=yes',
    'circle orbit=1,2,3', 'particles shape=script', 'rect solid=yes',
    'line attach=../../x', 'line attach=a;b',
    'circle', 'polygon', 'path d=M', 'text fill=#fff', 'rect solid=1', 'rect x=0 y=0 width=10',
    'circle cx=1 cy=1 r=-5', 'rect x=0 y=0 width=-10 height=5', 'ellipse cx=1 cy=1 rx=2',
    'particles x=1 y=1 rate=-3', ' circle cx=1 cy=1 r=1', 'circle cx=1 cy=1 r=1 ',
    'circle  cx=1 cy=1 r=1', 'circle\u00a0cx=1 cy=1 r=1', 'text x=1 y=1 weight=450',
    'circle fill=javascript:x',
  ];
  const rejectedScenes = [
    '', 'big', '4000x400', '1200x400 bg=red', '1200 x 400', '1200x400 gravity=9.8',
    '1200x400 bg=#000 bg=#fff', ' 400x400', '400x400 ', '400x400  bg=#fff',
  ];
  const acceptedEntities = [
    'rect x=0 y=300 width=1200 height=100 fill=#E8B04B',
    'text x=600 y=190 size=72 weight=700 anchor=middle font=display fill=#FFFFFF float=6 period=3',
    'path d=M0,300C300,250,900,350,1200,300Z fill=#14553F',
    'polygon points=10,0;20,20;0,20 fill=#FFF spin=40',
    'circle cx=100 cy=50 r=24 fill=#F25C54 body=1 bounce=1 drag=1 tap=jump vx=120',
    'particles x=600 y=0 rate=30 size=3 speed=40 angle=90 spread=160 life=6 shape=circle fill=#FFFFFF',
    'circle cx=0 cy=0 r=20 fill=#FFF orbit=600,200,150,30 glow=#FFE9A8',
    'rect x=0 y=330 width=1200 height=70 fill=#3A2417 solid=1',
    'line x1=90 y1=45 x2=110 y2=30 stroke=#8A5A2B attach=ball',
    'circle cx=200 cy=160 r=90 fill=#1B4D3E spin=20',
  ];
  await load(page, { build: () => ({ json: { artifact_version: 2, events: [ev(2, 'artifact.patch', { ops: [
    insert('screen', 'clear', 'scene', 'Clear', '400x200 bg=none'),
    insert('clear', 'dot', 'entity', 'Dot', 'circle cx=200 cy=100 r=20 fill=#111111')] }, 2)] } }) });
  await page.evaluate(() => vcHeard('it-1', 'a clear stage'));
  const grammar = await page.evaluate(({ rejectedEntities, rejectedScenes, acceptedEntities }) => {
    const P = window.SFDC24Canvas;
    return {
      badEntities: rejectedEntities.filter((d) => P.parseEntity(d)),
      badScenes: rejectedScenes.filter((d) => P.parseScene(d)),
      goodEntities: acceptedEntities.filter((d) => !P.parseEntity(d)),
      none: P.parseScene('400x400 bg=none'),
      painted: P.parseScene('1200x400 bg=#0B3D2E gravity=900'),
      plain: P.parseScene('600x600 gravity=400'),
    };
  }, { rejectedEntities, rejectedScenes, acceptedEntities });
  expect(grammar.badEntities).toEqual([]);
  expect(grammar.badScenes).toEqual([]);
  expect(grammar.goodEntities).toEqual([]);
  expect(grammar.none).toMatchObject({ w: 400, h: 400, bg: 'none', gravity: 0 });
  expect(grammar.painted).toMatchObject({ w: 1200, h: 400, bg: '#0B3D2E', gravity: 900 });
  expect(grammar.plain).toMatchObject({ w: 600, h: 600, bg: '#0f172a', gravity: 400 });
  const scene = page.locator('[data-pc-scene=clear]');
  await expect(scene).toBeVisible();
  await scene.scrollIntoViewIfNeeded();
  await expect.poll(() => scene.evaluate((c) => {
    const scale = c.width / 400;
    const x = Math.round(200 * scale), y = Math.round(100 * scale);
    const ctx = c.getContext('2d');
    const corner = ctx.getImageData(0, 0, 1, 1).data;
    const center = ctx.getImageData(Math.min(x, c.width - 1), Math.min(y, c.height - 1), 1, 1).data;
    return corner[3] === 0 && center[3] > 200 && c.__pc.bg === null &&
      getComputedStyle(c).backgroundColor === 'rgba(0, 0, 0, 0)';
  })).toBe(true);
});

test('tab cycles data-model cards and arrows move the focused card', async ({ page }) => {
  const MODEL = { domain: 'Bakery', findings: [],
    objects: [{ id: 'contact', name: 'Contact', standard: true, fields: [{ name: 'Email', type: 'Email' }] },
              { id: 'order', name: 'Order', standard: true, fields: [{ name: 'When', type: 'Date' }] }],
    relationships: [{ from: 'order', to: 'contact', kind: 'lookup', label: 'By' }] };
  await load(page, { analyst: () => ({ json: { turn: 0, events: [
    ev(2, 'model.updated', { model: MODEL }, 1)] } }) });
  await page.evaluate(() => vcHeard('it-1', 'orders'));
  const model = page.locator('[data-pc-model]');
  await expect(model).toHaveAttribute('data-pc-objects', '2');
  await model.scrollIntoViewIfNeeded();
  await expect(model).toHaveAttribute('tabindex', '0');
  await model.focus();
  await expect(model).toHaveAttribute('data-pc-focus', 'contact');
  const x0 = await page.evaluate(() => document.querySelector('[data-pc-model]').__pc.snapshot().find(n => n.id === 'contact').x);
  await page.keyboard.press('ArrowRight');
  const x1 = await page.evaluate(() => document.querySelector('[data-pc-model]').__pc.snapshot().find(n => n.id === 'contact').x);
  expect(Math.round(x1 - x0)).toBe(10);
  await page.keyboard.press('Tab');
  await expect(model).toHaveAttribute('data-pc-focus', 'order');
  await page.keyboard.press('Shift+Tab');
  await expect(model).toHaveAttribute('data-pc-focus', 'contact');
});

async function builtThenEnded(page, calls, features) {
  await introduced(page);
  await page.evaluate(() => vcHeard('it-1', 'a bakery logo'));
  await expect.poll(() => calls.filter(c => c.path === '/v1/session/s-1/talk').length).toBe(1);
  await page.evaluate(() => vcSaid('reply'));
  await page.locator('[data-vc-end]').click();
  await expect.poll(async () => (await realtimeLines(page)).at(-1)).toContain('You wanted a bakery logo');
  await page.evaluate(() => vcSaid('recap'));
  await expect(page.locator('[data-vc-start]')).toBeVisible();
}

test('after a conversation the visitor marks how happy they are, and can change it', async ({ page }) => {
  const calls = await load(page, { voices: BOTH, rating: true });
  await builtThenEnded(page, calls);
  await expect(page.locator('[data-vc-endcard]')).toBeVisible();
  await expect(page.locator('[data-vc-endcard] h4')).toHaveText('How happy are you with what we built?');
  await expect(page.locator('[data-vc-pdf]')).toBeHidden();                  // no PDF unless the controller offers it
  await page.locator('[data-vc-rate="5"]').click();
  await expect(page.locator('[data-vc-endnote]')).toHaveText('Thank you. That helps us build the next one better.');
  await page.locator('[data-vc-rate="4"]').click();
  await expect.poll(() => calls.filter(c => c.path === '/v1/session/s-1/rating').map(c => c.body)).toEqual([{ score: 5 }, { score: 4 }]);
  await expect(page.locator('[data-vc-rate="4"]')).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('[data-vc-rate="5"]')).toHaveAttribute('aria-checked', 'false');
  await page.locator('[data-vc-start]').click();                              // a new conversation clears the card
  await expect(page.locator('[data-vc-endcard]')).toBeHidden();
});

test('the session and the design go out as a PDF, to the address the controller holds', async ({ page }) => {
  const calls = await load(page, { voices: BOTH, rating: true, summary: true, build: () => ({ json: { artifact_version: 2, events: [
    ev(2, 'artifact.patch', { ops: [insert('screen', 'logo', 'scene', 'Logo', '400x200 bg=#0B1F3A'),
                                    insert('logo', 'dot', 'entity', 'Dot', 'circle x=100 y=100 r=40 fill=#00A1E0')] }, 2)] } }) });
  await builtThenEnded(page, calls);
  await page.locator('[data-vc-pdf]').click();
  await expect(page.locator('[data-vc-endnote]')).toHaveText('Sent to p***@example.com.');
  const summary = calls.find(c => c.path === '/v1/session/s-1/summary');
  expect(Object.keys(summary.body)).toEqual(['design_png']);                  // no address ever leaves the page
  expect(summary.body.design_png).toMatch(/^data:image\/png;base64,/);
  await expect(page.locator('[data-vc-pdf]')).toBeDisabled();
});

test('a PDF the controller cannot be sure about is never offered again', async ({ page }) => {
  const calls = await load(page, { voices: BOTH, rating: true, summary: true,
    summaryReply: { status: 409, json: { detail: 'the summary may already have been sent; check your inbox' } } });
  await builtThenEnded(page, calls);
  await page.locator('[data-vc-pdf]').click();
  await expect(page.locator('[data-vc-endnote]')).toHaveText('Your PDF may already be on its way. Check your inbox.');
  await expect(page.locator('[data-vc-pdf]')).toBeDisabled();
});

test('a conversation with nothing said shows no end card', async ({ page }) => {
  await load(page, { voices: BOTH, rating: true, summary: true });
  await page.locator('[data-vc-end]').click();
  await expect(page.locator('[data-vc-start]')).toBeVisible();
  await expect(page.locator('[data-vc-endcard]')).toBeHidden();
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test('the controls ride along at the bottom during a conversation, and leave with it', async ({ page }) => {
    await load(page, { voices: BOTH });
    await introduced(page);
    const bar = page.locator('#voice-conversation .vc-row');
    expect(await bar.evaluate(n => getComputedStyle(n).position)).toBe('fixed');
    const box = await bar.boundingBox();
    expect(box.y + box.height).toBeGreaterThan(844 - 40);
    await expect(page.locator('[data-vc-live]')).toHaveText('Listening');
    await expect(page.locator('[data-vc-end]')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.locator('[data-vc-end]').click();
    await expect(page.locator('[data-vc-start]')).toBeVisible();
    expect(await bar.evaluate(n => getComputedStyle(n).position)).not.toBe('fixed');
  });
});

test('the next voice waits until the host has finished SPEAKING, not just generating', async ({ page }) => {
  const calls = await load(page, { voices: BOTH });
  await expect.poll(() => realtimeLines(page)).toEqual([HOST_INTRO]);
  await page.evaluate(() => vcEmit({ type: 'response.done', response: { id: 'host-intro' } }));   // generated...
  await page.waitForTimeout(800);
  expect(spokenByArchitect(calls)).toEqual([]);                                                   // ...still playing
  await page.evaluate(() => vcEmit({ type: 'output_audio_buffer.stopped' }));                     // played
  await expect.poll(() => spokenByArchitect(calls)).toEqual([ARCHITECT_INTRO]);
});

test('a long host line whose audio has started is never cut off by a timer; only stopped ends it', async ({ page }) => {
  const calls = await load(page, { voices: BOTH });
  await expect.poll(() => realtimeLines(page)).toEqual([HOST_INTRO]);
  await page.clock.install();
  await page.evaluate(() => { vcEmit({ type: 'output_audio_buffer.started' });
                              vcEmit({ type: 'response.done', response: { id: 'host-intro' } }); });
  await page.clock.runFor(60000);                                  // a minute of host audio, still playing
  await page.waitForTimeout(500);                                  // (real time for any fetch to land)
  expect(spokenByArchitect(calls)).toEqual([]);
  await page.evaluate(() => vcEmit({ type: 'output_audio_buffer.stopped' }));
  await expect.poll(() => spokenByArchitect(calls)).toEqual([ARCHITECT_INTRO]);
});

test('if the audio-buffer event never comes, the line is released after the time its words take', async ({ page }) => {
  const calls = await load(page, { voices: BOTH });
  await expect.poll(() => realtimeLines(page)).toEqual([HOST_INTRO]);
  await page.clock.install();
  await page.evaluate(() => vcEmit({ type: 'response.done', response: { id: 'host-intro' } }));
  await page.clock.runFor(10000);                                  // 28 words at a slow pace is ~20s
  await page.waitForTimeout(500);
  expect(spokenByArchitect(calls)).toEqual([]);
  await page.clock.runFor(12000);
  await expect.poll(() => spokenByArchitect(calls)).toEqual([ARCHITECT_INTRO]);
});

// --- the Muse: a third agent with a spark, three directions, and templates ---
const WITH_MUSE = ['host', 'architect', 'muse'];
const inspireCalls = calls => calls.filter(c => c.path === '/v1/session/s-1/inspire');
const utterances = calls => calls.filter(c => c.path === '/v1/session/s-1/commands' && c.body.type === 'utterance')
  .map(c => c.body.transcript);

test('templates to start from are there before anything is said, and a tap starts the build', async ({ page }) => {
  const calls = await load(page, { voices: BOTH, muse: true, noTalk: true });
  await expect(page.locator('[data-pc-starters]')).toBeVisible();
  await expect(page.locator('[data-pc-starter]')).toHaveText(['A logo', 'A landing page', 'A mobile app screen',
                                                            'A sales dashboard', 'A pitch slide']);
  await page.locator('[data-pc-starter="A logo"]').click();
  await expect.poll(() => utterances(calls)).toEqual(['Start me a logo.']);
  await expect(page.locator('[data-pc-starters]')).toBeHidden();
  await expect.poll(() => inspireCalls(calls).map(c => c.body)).toEqual([{ text: 'Start me a logo.', turn: 1 }]);
});

test('the Muse sparks a question in its own voice and offers three directions to see, read, hear and work with', async ({ page }) => {
  const calls = await load(page, { voices: WITH_MUSE, muse: true, noTalk: true });
  await introduced(page);
  await page.evaluate(() => vcHeard('it-1', 'a logo for my bakery'));
  await expect.poll(() => inspireCalls(calls).map(c => c.body)).toEqual([{ text: 'a logo for my bakery', turn: 1 }]);
  await expect(page.locator('[data-pc-muse-line]')).toHaveText(MUSE.line);
  await expect(page.locator('[data-pc-direction]')).toHaveCount(3);
  const b = page.locator('[data-pc-direction="b"]');
  await expect(b.locator('h5')).toHaveText('Night Market');
  await expect(b.locator('.pc-swatch')).toHaveCount(4);
  await expect(b).toContainText('Open late. Fresh always.');
  await expect(b).toContainText('punchy and bright');
  await expect(b).toContainText('A bold landing page with a live order counter.');
  await expect(page.locator('[data-pc-agent="muse"]')).toBeVisible();
  await expect.poll(() => calls.filter(c => c.path === '/v1/session/s-1/speak').map(c => c.body))
    .toContainEqual({ voice: 'muse', text: MUSE.line });
  await expect(page.locator('[data-vc-notes]')).toContainText('Muse: ' + MUSE.line);
});

test('hear it plays the stored line in that direction\'s tone; the page sends only the direction id', async ({ page }) => {
  const calls = await load(page, { voices: WITH_MUSE, muse: true, noTalk: true });
  await introduced(page);
  await page.evaluate(() => vcHeard('it-1', 'a logo'));
  await expect(page.locator('[data-pc-hear="c"]')).toBeVisible();
  await expect.poll(() => page.evaluate(() => vcAudios.length === 2 && vcAudios[1].playing)).toBe(true);   // the spark
  await page.evaluate(() => vcAudios[1].onended());
  await page.locator('[data-pc-hear="c"]').click();
  await expect.poll(() => calls.filter(c => c.path === '/v1/session/s-1/speak').map(c => c.body))
    .toContainEqual({ voice: 'muse', direction: 'c' });
});

test('picking directions and building sends them to the architect as one brief', async ({ page }) => {
  const calls = await load(page, { voices: BOTH, muse: true, noTalk: true });
  await page.evaluate(() => vcHeard('it-1', 'a logo'));
  await expect(page.locator('[data-pc-direction]')).toHaveCount(3);
  await expect(page.locator('[data-pc-muse-build]')).toBeDisabled();
  await page.locator('[data-pc-like="a"]').click();
  await page.locator('[data-pc-like="b"]').click();
  await page.locator('[data-pc-like="b"]').click();                 // changed their mind
  await page.locator('[data-pc-like="c"]').click();
  await expect(page.locator('[data-pc-like="a"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('[data-pc-like="b"]')).toHaveAttribute('aria-pressed', 'false');
  await page.locator('[data-pc-muse-build]').click();
  await expect.poll(() => utterances(calls).length).toBe(2);
  const brief = utterances(calls)[1];
  expect(brief).toMatch(/^Blend these directions: "Warm Craft" \(palette #7A4A1E, #F6EBDD, #C98A3E; serif type; /);
  expect(brief).toContain('"Clean Lab"');
  expect(brief).not.toContain('Night Market');
  expect(inspireCalls(calls).length).toBe(1);                       // the brief does not wake the Muse again
});

test('the Muse\'s words are text, and a colour that is not a hex code is never applied', async ({ page }) => {
  const evil = JSON.parse(JSON.stringify(MUSE));
  evil.line = '<img src=x onerror="window.pwned=1">';
  evil.directions[0].title = '<script>window.pwned=2</script>';
  evil.directions[0].see.palette = ['red;background:url(x)', '#12345', '#ABCDEF'];
  evil.directions[0].see.type = 'serif;font-size:900px';
  const calls = await load(page, { muse: () => ({ json: { turn: 1, muse: evil } }) });
  await page.evaluate(() => vcHeard('it-1', 'anything'));
  await expect(page.locator('[data-pc-muse-line]')).toHaveText('<img src=x onerror="window.pwned=1">');
  await expect(page.locator('[data-pc-direction="a"] h5')).toHaveText('<script>window.pwned=2</script>');
  await expect(page.locator('[data-pc-direction="a"] .pc-swatch')).toHaveCount(1);
  expect(await page.locator('[data-pc-direction="a"] .pc-muse-read b').evaluate(n => n.style.fontFamily)).toBe('');
  expect(await page.locator('#prototype-canvas img, #prototype-canvas script').count()).toBe(0);
  expect(await page.evaluate(() => window.pwned)).toBeUndefined();
});

test('with the Muse off: no inspire calls, no Muse, no Inspire button; the templates still help', async ({ page }) => {
  const calls = await load(page, { voices: BOTH, noTalk: true });
  await expect(page.locator('[data-pc-starters]')).toBeVisible();
  await expect(page.locator('[data-pc-inspire]')).toBeHidden();
  await page.evaluate(() => vcHeard('it-1', 'a logo'));
  await page.waitForTimeout(400);
  expect(inspireCalls(calls)).toEqual([]);
  await expect(page.locator('[data-pc-agent="muse"]')).toBeHidden();
});

test('Inspire me asks again from the last thing said; a Muse that is not available hides the button', async ({ page }) => {
  let n = 0;
  const calls = await load(page, { muse: () => (++n === 1 ? null
    : { status: 503, json: { detail: 'the muse is not available' } }) });
  await page.evaluate(() => vcHeard('it-1', 'a pitch slide'));
  await expect(page.locator('[data-pc-direction]')).toHaveCount(3);
  await page.locator('[data-pc-inspire]').click();
  await expect.poll(() => inspireCalls(calls).map(c => c.body)).toEqual([{ text: 'a pitch slide', turn: 1 },
                                                                       { text: 'a pitch slide', turn: 2 }]);
  await expect(page.locator('[data-pc-inspire]')).toBeHidden();
});

test('without its own voice, the host says the Muse\'s spark and there is nothing to hear', async ({ page }) => {
  const calls = await load(page, { voices: BOTH, muse: true, noTalk: true });
  await introduced(page);
  await page.evaluate(() => vcHeard('it-1', 'a logo'));
  await expect(page.locator('[data-pc-direction]')).toHaveCount(3);
  await expect.poll(async () => (await realtimeLines(page)).includes(MUSE.line)).toBe(true);
  expect(calls.filter(c => c.path === '/v1/session/s-1/speak' && c.body.voice === 'muse')).toEqual([]);
  await expect(page.locator('[data-pc-hear]')).toHaveCount(0);
});
