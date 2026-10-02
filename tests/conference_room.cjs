const {test} = require('node:test');
const assert = require('node:assert/strict');
const room = require('../assets/conference-room.js');

function jwt(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `eyJhbGciOiJIUzI1NiJ9.${body}.sig`;
}

test('audio constraints ask for echo cancellation and 48 kHz', () => {
  const audio = room.audioConstraints();
  assert.equal(audio.echoCancellation, true);
  assert.equal(audio.sampleRate, 48000);
  assert.equal(room.SAMPLE_RATE, 48000);
});

test('idle is five minutes and filler waits past 700 ms', () => {
  assert.equal(room.IDLE_MS, 300000);
  assert.equal(room.idleDue(0, 299999), false);
  assert.equal(room.idleDue(0, 300000), true);
  assert.equal(room.fillerDue(1000, 1700), false);
  assert.equal(room.fillerDue(1000, 1701), true);
  assert.equal(room.FILLER_MS, 700);
});

test('one floor lets the user barge in and then publish', () => {
  const floor = room.createFloor();
  assert.equal(floor.apply('speaking'), true);
  assert.equal(floor.canPublish(), false);
  assert.equal(floor.userTalk(), 'barge-in');
  assert.equal(floor.canPublish(), true);
  assert.equal(floor.apply('nope'), false);
});

test('vad, loss, and queue drop stay small', () => {
  assert.equal(room.vadOpen(0.019), false);
  assert.equal(room.vadOpen(0.02), true);
  assert.equal(room.lossHigh(room.lossRatio(1, 100)), false);
  assert.equal(room.lossHigh(room.lossRatio(3, 10)), true);
  const queue = [{type: 'audio'}];
  assert.deepEqual(room.dropQueue(queue), []);
  assert.equal(queue.length, 0);
});

test('cards move idle, heard, room open, agent', () => {
  assert.equal(room.nextCard('idle', 'heard'), 'heard');
  assert.equal(room.nextCard('heard', 'room'), 'room-open');
  assert.equal(room.nextCard('room-open', 'agent'), 'agent-in-room');
  assert.equal(room.nextCard('agent-in-room', 'disconnect'), 'idle');
});

test('svg and mermaid stay in a safe subset', () => {
  assert.equal(room.sanitizeSvg('<svg><script>alert(1)</script></svg>'), '');
  assert.equal(room.sanitizeSvg('<svg onclick="alert(1)"></svg>'), '');
  assert.equal(room.sanitizeSvg('<svg><rect width="4" height="4"/></svg>'), '<svg><rect width="4" height="4"/></svg>');
  const cleaned = room.sanitizeMermaid('<script>stateDiagram-v2\nidle --> heard</script>');
  assert.equal(cleaned.includes('script'), false);
  assert.match(cleaned, /^stateDiagram/);
  assert.equal(room.sanitizeMermaid('stateDiagram-v2\nidle --> javascript:alert(1)'), '');
  const drawn = room.renderStateDiagram('stateDiagram-v2\nidle --> heard');
  assert.equal(drawn.includes('<script'), false);
  assert.equal(drawn.includes('idle'), true);
  assert.equal(room.penpotSrc('https://design.penpot.app/view/abc'), 'https://design.penpot.app/view/abc');
  assert.equal(room.penpotSrc('https://evil.example/view'), '');
  assert.equal(room.penpotSrc('javascript:alert(1)'), '');
});

test('room tokens are short lived and urls carry no token', () => {
  const now = 1_700_000_000_000;
  assert.equal(room.tokenOk(jwt({exp: 1700000000 + 900}), now), true);
  assert.equal(room.tokenOk(jwt({exp: 1700000000 + 901}), now), false);
  assert.equal(room.tokenOk('not-a-jwt', now), false);
  assert.equal(room.livekitUrlOk('wss://rooms.example/live'), true);
  assert.equal(room.livekitUrlOk('wss://rooms.example/live?token=abc'), false);
  assert.equal(room.livekitUrlOk('https://rooms.example/live'), false);
  assert.equal(room.speechText('<b>Hello floor</b>'), 'Hello floor');
});
