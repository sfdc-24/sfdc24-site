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
