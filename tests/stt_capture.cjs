/*
  THE STREAMING CAPTURE PATH, TESTED WITHOUT A BROWSER.

  WHAT THIS SUITE CAN HONESTLY CLAIM
    The arithmetic and the state machine. Those are where the bugs that ruin a
    live demo actually live: audio that clicks because a sample wrapped, a
    transcript that never advances because the rate was wrong, and a Stop that
    stops the transcript while leaving the microphone indicator burning in the
    tab.

  WHAT IT CANNOT
    A real microphone, a real AudioWorklet and a real socket. Those need a
    person to click once, and that click will be reported as a click - not as a
    passing test. Asserting otherwise here would be the exact dishonesty the
    honesty suites exist to catch.
*/
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const REPO = path.resolve(__dirname, '..');

function load() {
  const window = {};
  vm.runInNewContext(
    fs.readFileSync(path.join(REPO, 'assets/stt-capture.js'), 'utf8'),
    { window },
  );
  assert.ok(window.__STT, 'assets/stt-capture.js did not expose __STT');
  return window.__STT;
}

const STT = load();

/* ------------------------------------------------------------ the maths -- */

test('capture targets 16 kHz, which is what transcription wants', () => {
  assert.equal(STT.TARGET_RATE, 16000);
});

test('48 kHz in gives one third of the samples out', () => {
  const input = new Float32Array(4800);
  const out = STT.downsample(input, 48000, 16000);
  assert.equal(out.length, 1600);
});

test('a rate that already matches is passed through untouched', () => {
  const input = new Float32Array([0.1, -0.2, 0.3]);
  assert.equal(STT.downsample(input, 16000, 16000), input);
});

test('it never upsamples, because that invents audio that was not spoken', () => {
  const input = new Float32Array(160);
  const out = STT.downsample(input, 8000, 16000);
  assert.equal(out.length, 160, 'an 8 kHz source must not be stretched to 16');
});

test('empty in, empty out, no throw', () => {
  assert.equal(STT.downsample(new Float32Array(0), 48000).length, 0);
  assert.equal(STT.downsample(null, 48000).length, 0);
});

test('PCM conversion clamps, because a wrapped sample arrives as a click', () => {
  // 1.5 truncates to a large NEGATIVE if it is not clamped first, and that
  // sounds like a hardware fault down the line. This is the whole reason the
  // clamp is there.
  const out = STT.toPcm16(new Float32Array([1.5, -1.5, 0, 1, -1]));
  assert.equal(out[0], 32767);
  assert.equal(out[1], -32768);
  assert.equal(out[2], 0);
  assert.equal(out[3], 32767);
  assert.equal(out[4], -32768);
  for (const v of out) assert.ok(v >= -32768 && v <= 32767, `${v} is out of range`);
});

test('encode is downsample then PCM, and yields two bytes a sample', () => {
  const pcm = STT.encode(new Float32Array(4800), 48000);
  // NOT instanceof: the module runs in its own vm context, so its Int16Array is
  // a different realm's constructor and instanceof is false for a correct
  // value. Check the shape instead of the identity.
  assert.equal(pcm.constructor.name, 'Int16Array');
  assert.equal(pcm.BYTES_PER_ELEMENT, 2);
  assert.equal(pcm.length, 1600);
  assert.equal(pcm.byteLength, 3200);
});

/* --------------------------------------------------- the state machine --- */

test('the happy path walks idle to listening', () => {
  const m = STT.machine();
  assert.equal(m.get(), 'idle');
  assert.equal(m.send('start'), 'permission');
  assert.equal(m.send('granted'), 'connecting');
  assert.equal(m.send('open'), 'listening');
  assert.ok(m.isLive());
});

test('STOP IS REACHABLE FROM EVERY LIVE STATE', () => {
  // The failure everyone ships is a Stop that only works once listening has
  // started, so a click during "connecting" leaves the microphone open.
  for (const path of [['start'], ['start', 'granted'], ['start', 'granted', 'open']]) {
    const m = STT.machine();
    for (const e of path) m.send(e);
    assert.ok(m.isLive(), `${path.join('>')} should be live`);
    assert.equal(m.send('stop'), 'stopping', `stop unreachable from ${m.get()}`);
    assert.equal(m.send('done'), 'idle');
    assert.ok(!m.isLive());
  }
});

test('a denied microphone is its own state, not an error', () => {
  // They are different for the visitor: denied is fixable by them, error is not.
  const m = STT.machine();
  m.send('start');
  assert.equal(m.send('denied'), 'blocked');
  assert.ok(!m.isLive());
  assert.equal(m.send('start'), 'permission', 'a blocked visitor must be able to retry');
});

test('a socket that fails while listening is recoverable', () => {
  const m = STT.machine();
  m.send('start'); m.send('granted'); m.send('open');
  assert.equal(m.send('failed'), 'error');
  assert.equal(m.send('start'), 'permission');
});

test('a remote close tears down rather than stranding the state', () => {
  const m = STT.machine();
  m.send('start'); m.send('granted'); m.send('open');
  assert.equal(m.send('closed'), 'stopping');
  assert.equal(m.send('done'), 'idle');
});

test('an unknown event does not move and does not throw', () => {
  const m = STT.machine();
  assert.equal(m.send('nonsense'), 'idle');
  assert.equal(STT.next('idle', 'nonsense'), null);
  assert.equal(STT.next('nowhere', 'start'), null);
});

test('the machine reports every transition it makes', () => {
  const seen = [];
  const m = STT.machine((to, from, ev) => seen.push(`${from}-${ev}->${to}`));
  m.send('start'); m.send('granted'); m.send('open'); m.send('stop'); m.send('done');
  assert.deepEqual(seen, [
    'idle-start->permission',
    'permission-granted->connecting',
    'connecting-open->listening',
    'listening-stop->stopping',
    'stopping-done->idle',
  ]);
});

/* ------------------------------------------------------------- the relay - */

test('the relay is chosen at runtime, so one page serves echo and cloud', () => {
  assert.equal(STT.relayUrl('?relay=ws%3A%2F%2F127.0.0.1%3A8787'), 'ws://127.0.0.1:8787');
  assert.equal(STT.relayUrl('', 'wss://relay.example/stream'), 'wss://relay.example/stream');
});

test('a relay that is not a websocket URL is refused', () => {
  // An http:// here would silently never connect; a javascript: one would be
  // worse. The scheme is checked rather than trusted.
  assert.equal(STT.relayUrl('?relay=https%3A%2F%2Fevil.example'), '');
  assert.equal(STT.relayUrl('?relay=javascript%3Aalert(1)'), '');
  assert.equal(STT.relayUrl('?relay='), '');
});

/* ------------------------------------------------ contracts, not behaviour */

test('no provider credential is anywhere in the browser bundle', () => {
  // The relay exists BECAUSE the key must not be here. If this ever fails, the
  // page has become a free transcription service for anyone reading the source.
  const files = ['assets/stt-capture.js', 'assets/stt-worklet.js', 'listen/index.html'];
  for (const f of files) {
    const src = fs.readFileSync(path.join(REPO, f), 'utf8');
    assert.doesNotMatch(src, /\b(api[_-]?key|secret|token)\s*[:=]\s*['"][A-Za-z0-9_\-]{16,}/i,
      `${f} looks like it carries a credential`);
    assert.doesNotMatch(src, /\b(deepgram|assemblyai)\.com\b/i,
      `${f} talks to a provider directly - it must go through the relay`);
  }
});

test('the worklet posts a copy, not the audio thread\'s own buffer', () => {
  // The buffer handed to process() is reused on the next render quantum. Posting
  // the view delivers whatever happens to be in it by the time the page reads.
  const src = fs.readFileSync(path.join(REPO, 'assets/stt-worklet.js'), 'utf8');
  assert.match(src, /postMessage\(new Float32Array\(/);
});

test('the microphone is never routed back to the speakers', () => {
  const src = fs.readFileSync(path.join(REPO, 'assets/stt-capture.js'), 'utf8');
  assert.doesNotMatch(src, /connect\(\s*(this\.)?ctx\.destination/,
    'connecting capture to the destination produces feedback howl on a call');
});

test('the page is top level and says what the echo relay is', () => {
  const html = fs.readFileSync(path.join(REPO, 'listen/index.html'), 'utf8');
  assert.doesNotMatch(html, /<iframe/i, 'an iframed microphone can never work');
  assert.match(html, /echo/i, 'the page must be able to say a transcript is scripted');
});

/* ------------------------------------------------ the three-minute budget - */

function clock() {
  let t = 0;
  const fn = () => t;
  fn.advance = (ms) => { t += ms; };
  return fn;
}

test('the budget is three minutes, warned at thirty seconds left', () => {
  assert.equal(STT.BUDGET_MS, 180000);
  assert.equal(STT.WARN_MS, 30000);
});

test('an unstarted budget is not counting anything down', () => {
  const b = STT.budget({ now: clock() });
  assert.equal(b.started(), false);
  assert.equal(b.check(), null, 'a budget that never started must not expire');
  assert.equal(b.remaining(), 180000);
});

test('it warns once, then expires', () => {
  const now = clock();
  const b = STT.budget({ now });
  b.start();
  now.advance(100000);
  assert.equal(b.check(), null, 'too early to warn');
  now.advance(55000);                       // 155s in, 25s left
  assert.equal(b.check(), 'warn');
  assert.equal(b.check(), null, 'the warning must be said once, not every tick');
  now.advance(30000);                       // past three minutes
  assert.equal(b.check(), 'expired');
});

test('A REAL PROSPECT IS NEVER CUT OFF: satisfy stops the clock governing', () => {
  const now = clock();
  const b = STT.budget({ now });
  b.start();
  now.advance(120000);
  b.satisfy();
  now.advance(600000);                      // ten minutes past the limit
  assert.equal(b.check(), null, 'a workable problem was stated; do not cut them off');
  assert.equal(b.remaining(), Infinity);
  assert.equal(b.isSatisfied(), true);
});

test('declining ends it immediately rather than making them sit out a timer', () => {
  const now = clock();
  const b = STT.budget({ now });
  b.start();
  now.advance(5000);
  b.decline();
  assert.equal(b.check(), 'declined');
  assert.equal(b.check(), null, 'reported once, like the warning');
});

test('restarting clears a previous verdict', () => {
  const now = clock();
  const b = STT.budget({ now });
  b.start(); b.satisfy();
  b.start();
  assert.equal(b.isSatisfied(), false);
  now.advance(180001);
  assert.equal(b.check(), 'expired');
});

/* ------------------------------------------- what counts as workable ------ */

// A stand-in for the real triage layer, shaped the same way.
const fakeTriage = {
  ask(q) {
    if (/^\s*(hi|hello)\b/i.test(q)) return { id: 'greeting', answer: 'Hi.', handTo: '' };
    if (/moon/i.test(q)) return { id: 'fact-moon', answer: '384,400 km', handTo: '' };
    // A DOMAIN fact: our subject, answered correctly and instantly.
    if (/serial/i.test(q)) return { id: 'fact-serial-object', answer: 'SerializedProduct.', handTo: '', domain: true };
    if (/flow|apex|trigger|work order/i.test(q)) return { id: 'route', answer: '', handTo: 'claude' };
    return null;
  },
  isFactId(id) { return id === 'fact-miss' || id.indexOf('fact-') === 0; },
};

test('a greeting is not a workable problem, however long it is', () => {
  assert.equal(STT.isWorkable('hello there how are you doing today friend', fakeTriage), false);
});

test('a stock fact is not a workable problem', () => {
  assert.equal(STT.isWorkable('how far away is the moon from the earth exactly', fakeTriage), false);
});

test('a real problem that triage would route IS workable', () => {
  assert.equal(
    STT.isWorkable('our flow on the work order is failing after the last release',
                   fakeTriage),
    true);
});

test('THE ACCESS HAITI SENTENCE COUNTS AS WORK, not as time-wasting', () => {
  // This is the interaction between the two things built on 2026-09-23. The
  // grounded facts answer the client's own question locally and instantly -
  // which is the best outcome available - and a naive budget would have read
  // "triage answered it, so no agent was needed" as "this visitor is not real"
  // and cut off the exact prospect the demo exists for.
  const q = 'our flow on the work order cannot pull the serial number';
  const hit = fakeTriage.ask(q);
  assert.equal(hit.id, 'fact-serial-object', 'precondition: this IS answered locally');
  assert.equal(hit.handTo, '', 'precondition: no agent was needed');
  assert.equal(STT.isWorkable(q, fakeTriage), true);
});

test('a domain fact is work; a trivia fact is not', () => {
  assert.equal(STT.isWorkable('where do the serial numbers live for our stock', fakeTriage), true);
  assert.equal(STT.isWorkable('how far away is the moon from the earth exactly', fakeTriage), false);
});

test('something triage does not recognise at all counts as work', () => {
  // The cautious direction. An unrecognised sentence is far more likely to be a
  // real problem stated in the visitor's own words than it is to be abuse, and
  // cutting off a paying prospect costs more than three minutes of audio.
  assert.equal(
    STT.isWorkable('we cannot reconcile our monthly billing run against the ledger', fakeTriage),
    true);
});

test('too few words is never workable, whatever it says', () => {
  assert.equal(STT.isWorkable('apex trigger broken', fakeTriage), false);
  assert.equal(STT.isWorkable('', fakeTriage), false);
});

test('with no triage layer present it answers "not yet", not "yes"', () => {
  // Failing open here would make the budget unenforceable the moment the
  // triage bundle failed to load, which is exactly when it matters.
  assert.equal(STT.isWorkable('our flow on the work order cannot pull the serial', null), false);
});

/* ------------------------------------------- the page honours the budget -- */

test('the page starts the clock on listening and stops it when not live', () => {
  const html = fs.readFileSync(path.join(REPO, 'listen/index.html'), 'utf8');
  assert.match(html, /budget\.start\(\)/, 'the clock never starts');
  assert.match(html, /clearInterval\(ticker\)/, 'the ticker is never cleared');
  assert.match(html, /setInterval\(tick, 1000\)/,
    'a single setTimeout would silently stretch in a throttled background tab');
});

test('the page stops the microphone when the desk refuses, without waiting', () => {
  const html = fs.readFileSync(path.join(REPO, 'listen/index.html'), 'utf8');
  assert.match(html, /budget\.decline\(\)/,
    'an out-of-scope visitor is made to sit out the full timer');
  // A closed grammar, not a lone word: "scope" alone would fire on an answer
  // that merely mentions scope while being perfectly in it.
  assert.match(html, /outside what we do\|/,
    'the refusal test must match the phrases the desk actually produces');
});

test('the page tells the visitor about the timer before it acts', () => {
  const html = fs.readFileSync(path.join(REPO, 'listen/index.html'), 'utf8');
  assert.match(html, /three minutes/i, 'the budget is never stated on the page');
  assert.match(html, /Typing is never on a timer/i,
    'a cut-off visitor must be told what still works');
});

test('the page loads triage, or isWorkable can never say yes', () => {
  const html = fs.readFileSync(path.join(REPO, 'listen/index.html'), 'utf8');
  assert.match(html, /<script src="\/assets\/triage\.js">/,
    'without triage every visitor is judged unworkable and cut off at three minutes');
  const tAt = html.indexOf('/assets/triage.js');
  const sAt = html.indexOf('/assets/stt-capture.js');
  assert.ok(tAt > -1 && sAt > tAt, 'triage must load before the capture module uses it');
});

/* --------------------------------- the question path, which silently hung -- */

test('the JSONP callback parameter is cb, which is what the endpoint reads', () => {
  // MEASURED 2026-09-23: the page sent `callback=`. The endpoint reads `p.cb`,
  // so it answered with plain JSON, the callback never fired, and the bench sat
  // on "Asking" for ever with no error anywhere - not in the console, not in
  // the network tab, because a 200 had come back. The homepage has always sent
  // `cb=`. This assertion exists so the two can never drift again.
  const html = fs.readFileSync(path.join(REPO, 'listen/index.html'), 'utf8');
  assert.match(html, /\?action=say&cb=/, 'the endpoint will answer with plain JSON');
  assert.doesNotMatch(html, /action=say&callback=/, 'callback= is not read by /exec');
});

test('a callback that never fires says so instead of waiting for ever', () => {
  const html = fs.readFileSync(path.join(REPO, 'listen/index.html'), 'utf8');
  assert.match(html, /No answer came back within 45 seconds/,
    'there is no upper bound on the wait');
  assert.match(html, /s\.onerror = function/, 'a failed script load is silent');
});

test('THE BENCH ASKS TRIAGE FIRST, like the homepage does', () => {
  // Skipping the gate made the bench demonstrate the wrong path: it asked the
  // model a question the site already answers correctly and instantly from a
  // local table. "The same question path this site already uses" has to mean
  // the whole path, gate included.
  const html = fs.readFileSync(path.join(REPO, 'listen/index.html'), 'utf8');
  const triageAt = html.indexOf('window.__TRIAGE.ask(text)');
  const execAt = html.indexOf('EXEC + "?action=say');
  assert.ok(triageAt > -1, 'the bench never consults triage before asking the model');
  assert.ok(triageAt < execAt, 'triage must be consulted BEFORE the network call');
  assert.match(html, /with no model call/,
    'a locally answered question must say that it cost nothing');
});
