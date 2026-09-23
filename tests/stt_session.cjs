const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const stt = require(path.join(REPO, 'assets/stt-session.js'));

test('clock shows 3:00, warns in the last 30s, and hits 0:00 at the cap', () => {
  assert.equal(stt.MAX_SECONDS, 180);
  assert.equal(stt.WARN_SECONDS, 30);
  assert.equal(stt.formatClock(180000), '3:00');
  assert.equal(stt.formatClock(179000), '2:59');
  assert.equal(stt.formatClock(30000), '0:30');
  assert.equal(stt.formatClock(1000), '0:01');
  assert.equal(stt.formatClock(0), '0:00');
  assert.equal(stt.clampLimit(9999), 180);
  assert.equal(stt.clampLimit(0), 180);

  const clock = stt.createSessionClock();
  assert.equal(clock.snapshot(0).label, '3:00');
  assert.equal(clock.snapshot(0).warn, false);
  clock.start(180, 30, 1_000);
  assert.deepEqual(
    { label: clock.snapshot(1_000).label, warn: clock.snapshot(1_000).warn, done: clock.snapshot(1_000).done },
    { label: '3:00', warn: false, done: false },
  );
  const late = clock.snapshot(1_000 + 150_000);
  assert.equal(late.label, '0:30');
  assert.equal(late.warn, true);
  assert.equal(late.done, false);
  const ended = clock.snapshot(1_000 + 180_000);
  assert.equal(ended.label, '0:00');
  assert.equal(ended.done, true);
  assert.equal(ended.warn, false);
  clock.reset();
  assert.equal(clock.snapshot(9_999).label, '3:00');
  assert.equal(clock.snapshot(9_999).done, false);
});

test('a lead response distinguishes a confirmed handoff from a development hold', () => {
  assert.equal(stt.interpretLeadResponse(true, { ok: true, durable: true, sink: 'forwarded' }), 'forwarded');
  assert.equal(stt.interpretLeadResponse(true, { ok: true, durable: false, sink: 'staged' }), 'staged');
  assert.equal(stt.interpretLeadResponse(true, { ok: true, durable: false }), 'staged');
  assert.equal(stt.interpretLeadResponse(false, { ok: false, durable: false }), 'failed');
  assert.equal(stt.interpretLeadResponse(true, null), 'failed');
  assert.equal(stt.interpretLeadResponse(true, []), 'failed');
  assert.equal(stt.interpretLeadResponse(true, { ok: true }), 'failed');
  assert.equal(stt.interpretLeadResponse(true, { ok: true, durable: true, sink: 'staged' }), 'failed');
  assert.match(stt.leadStatus('forwarded'), /Forwarded for a call back/);
  assert.match(stt.leadStatus('staged'), /Held for this session only/);
  assert.doesNotMatch(stt.leadStatus('staged'), /Saved for a call back/);
  assert.match(stt.leadStatus('failed'), /did not reach the desk/);
  const client = fs.readFileSync(path.join(REPO, 'stream/stream.js'), 'utf8');
  assert.match(client, /interpretLeadResponse/);
  assert.match(client, /gen !== generation/);
  assert.match(client, /STARTUP_MS/);
  assert.match(client, /phase === "connecting"/);
  assert.equal(stt.RECOVER_MS, 2500);
  assert.equal(stt.RECOVER_RETRY_MS, 1000);
  assert.match(client, /recoverTransport/);
  assert.match(client, /session_not_retained/);
  assert.match(client, /RECOVER_MS/);
  assert.equal((client.match(/phase === "live"\) recoverTransport\(\)/g) || []).length, 2);
  assert.doesNotMatch(client, /transcript:\s*committed/);
});

test('websocket url follows the relay scheme and never carries a speech key', () => {
  assert.equal(stt.relayWsUrl('https://relay.example', '/v1/stream'), 'wss://relay.example/v1/stream');
  assert.equal(stt.relayWsUrl('http://127.0.0.1:8765/', 'v1/stream'), 'ws://127.0.0.1:8765/v1/stream');
  assert.equal(stt.relayWsUrl('', '/v1/stream'), '');
});

test('public stream files do not contain the speech key or browser speech recognition', () => {
  const files = [
    'assets/stt-session.js',
    'stream/stream.js',
    'stream/config.js',
    'stream/pcm-worklet.js',
    'stream/index.html',
  ];
  const banned = [
    /DEEPGRAM_API_KEY/,
    /api\.deepgram\.com/,
    /webkitSpeechRecognition/,
    /SpeechRecognition/,
    /new\s+SR\(/,
  ];
  for (const rel of files) {
    const src = fs.readFileSync(path.join(REPO, rel), 'utf8');
    for (const pattern of banned) {
      assert.doesNotMatch(src, pattern, `${rel} matched ${pattern}`);
    }
  }
  const page = fs.readFileSync(path.join(REPO, 'stream/index.html'), 'utf8');
  assert.match(page, />3:00</);
  assert.match(page, /AI enablement/);
  assert.match(page, /noindex/);
  assert.match(page, /id="warn"/);
  const clockTag = page.match(/<p id="clock"[^>]*>/);
  assert.ok(clockTag);
  assert.match(clockTag[0], /role="timer"/);
  assert.doesNotMatch(clockTag[0], /aria-live/);
  assert.doesNotMatch(clockTag[0], /aria-atomic/);
  assert.match(page, /id="warn"[^>]*aria-live="assertive"/);
  assert.match(page, /id="status"[^>]*aria-live="polite"/);
  const client = fs.readFileSync(path.join(REPO, 'stream/stream.js'), 'utf8');
  assert.match(client, /Thirty seconds left\./);
  assert.match(client, /Thank you\. That is enough for a call back\./);
  assert.match(client, /Streaming relay is not set on this host yet\./);
  assert.match(client, /createGain\(/);
  assert.match(client, /node\.connect\(sink\)/);
  assert.match(client, /sink\.connect\(audio\.destination\)/);
  assert.match(client, /socket\.onclose/);
  const home = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');
  assert.doesNotMatch(home, /\/stream\//);
  assert.doesNotMatch(home, /pcm-downsampler/);
  const method = fs.readFileSync(path.join(REPO, 'method/index.html'), 'utf8');
  assert.match(method, /href="\/stream\/"/);
  assert.match(method, /id="stream"/);
});

/* ---- the reconciliation: what /listen/ contributed to this page ---------- */

const vm = require('node:vm');

function realTriage() {
  const window = {};
  vm.runInNewContext(fs.readFileSync(path.join(REPO, 'assets/triage.js'), 'utf8'), { window });
  return window.__TRIAGE;
}
const T = realTriage();

test('isWorkable has THREE answers, because two would be a lie', () => {
  // Measured against the live triage layer. Routing says nothing about whether
  // a sentence is work - triage routes everything it has no rule for to an
  // agent, greetings included - so "no rule matched" cannot mean "not a real
  // visitor". Only domain vocabulary is a positive signal the page can trust.
  assert.equal(stt.isWorkable('this apex trigger and lwc are failing after deployment', T), true);
  assert.equal(stt.isWorkable('our validation rule fires on every record type we own', T), true);
  assert.equal(stt.isWorkable('how far away is the moon from the earth exactly', T), false);
  assert.equal(stt.isWorkable('apex broken', T), false, 'too short to be anything');
  // UNDECIDED, and saying false here would cut off a prospect describing a real
  // problem in their own words.
  assert.equal(stt.isWorkable('our flow on the work order cannot pull the serial number', T), null);
  assert.equal(stt.isWorkable('we cannot reconcile our monthly billing against the ledger', T), null);
});

test('with no triage layer it fails CLOSED', () => {
  // Failing open would make the budget unenforceable at exactly the moment the
  // bundle did not load.
  assert.equal(stt.isWorkable('our flow on the work order cannot pull the serial', null), false);
  assert.equal(stt.isWorkable('our flow on the work order cannot pull the serial', {}), false);
});

test('a refusal is recognised by a closed grammar, not a lone word', () => {
  assert.equal(stt.isRefusal('That is outside what we do. Thank you for visiting our page.'), true);
  assert.equal(stt.isRefusal('I have no view on that. It is not Salesforce work.'), true);
  // Must NOT fire on an answer that merely mentions scope while being in it.
  assert.equal(stt.isRefusal('Flow, unless you need something Flow cannot do.'), false);
  assert.equal(stt.isRefusal('That is in scope for a fixed-scope diagnostic.'), false);
  assert.equal(stt.isRefusal(''), false);
});

test('THE PAGE ANSWERS THE VISITOR, which it did not before', () => {
  // It captured a transcript and posted a lead and told them nothing: three
  // minutes of talking for "we will call you back". The site already has a
  // question path and its newest page walked past it.
  const js = fs.readFileSync(path.join(REPO, 'stream/stream.js'), 'utf8');
  assert.match(js, /function answerVisitor/, 'the visitor is never answered');
  assert.match(js, /answerVisitor\(committed\)/, 'the answer is never triggered');
  const triageAt = js.indexOf('window.__TRIAGE.ask(asked)');
  const execAt = js.indexOf('EXEC + "?action=say');
  assert.ok(triageAt > -1 && triageAt < execAt,
    'triage must be consulted BEFORE the network call, as the homepage does');
});

test('the JSONP callback parameter is cb, which is what the endpoint reads', () => {
  // `callback=` returns plain JSON, the callback never fires, and the panel
  // waits for ever. That happened on the bench this page absorbed.
  const js = fs.readFileSync(path.join(REPO, 'stream/stream.js'), 'utf8');
  assert.match(js, /\?action=say&cb=/);
  assert.doesNotMatch(js, /action=say&callback=/);
  assert.match(js, /No answer came back within 45 seconds/, 'the wait is unbounded');
});

test('the page loads triage, or isWorkable can never say yes', () => {
  const html = fs.readFileSync(path.join(REPO, 'stream/index.html'), 'utf8');
  assert.match(html, /<script src="\/assets\/triage\.js">/);
  const tAt = html.indexOf('/assets/triage.js');
  const sAt = html.indexOf('/assets/stt-session.js');
  assert.ok(tAt > -1 && sAt > tAt, 'triage must load before the module that uses it');
});

test('there is ONE speech surface: /listen/ redirects here', () => {
  // Two live pages doing one job is worse than either alone. /listen/ was the
  // bench; /stream/ is the product surface.
  const listen = fs.readFileSync(path.join(REPO, 'listen/index.html'), 'utf8');
  assert.match(listen, /url=\/stream\//, '/listen/ does not send anyone to /stream/');
  assert.doesNotMatch(listen, /stt-capture\.js/, '/listen/ still runs its own capture stack');
});
