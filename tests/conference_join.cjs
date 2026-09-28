const {test} = require('node:test');
const assert = require('node:assert/strict');
const join = require('../assets/conference-join.js');

test('a missing or fake token stays missing', () => {
  for (const raw of ['', 'invite', 'fake-invite-token', 'demo', 'x'.repeat(19), 'invite.invite.invite']) {
    assert.equal(join.classifyToken(raw), 'missing', raw);
  }
});

test('a long opaque token or jwt counts as present', () => {
  assert.equal(join.classifyToken('a'.repeat(24)), 'present');
  assert.equal(join.classifyToken('eyJhbGciOiJIUzI1NiJ9.eyJyb29tIjoiYSJ9.signaturevalue'), 'present');
});

test('address input drops digits and markup', () => {
  assert.equal(join.sanitizeAddress("  Ada <b>1</b>  "), "Ada bb");
});

test('a feedback note stays in this tab and carries no token', () => {
  const text = join.note('heard');
  assert.match(text, /^Noted in this tab: heard\./);
  assert.match(text, /does not add a log/);
  assert.match(text, /already keeps the room log/);
  assert.equal(text.includes('token'), false);
});

test('join href is the gateway with no token attached', () => {
  assert.equal(join.joinHref(), 'https://conference-gateway-96522051727.us-central1.run.app/');
  assert.equal(join.joinHref().includes('token'), false);
});

test('a beacon hook keeps room, ice, tracks, and viewport, and drops secrets', () => {
  const body = join.beaconPayload('ice', {
    room: 'absent',
    ice: {state: 'checking', pairs: 2, address: '203.0.113.8', candidate: 'a=candidate 203.0.113.9'},
    tracks: {audio: 1, video: 0},
    viewport: {w: 390, h: 844},
    token: 'eyJhbGciOiJIUzI1NiJ9.eyJyb29tIjoiYSJ9.signaturevalue',
    error: 'failed eyJhbGciOiJIUzI1NiJ9.eyJyb29tIjoiYSJ9.signaturevalue',
    consent: 'on'
  });
  assert.equal(body.kind, 'ice');
  assert.equal(body.room, 'absent');
  assert.equal(body.ice.state, 'checking');
  assert.equal(body.ice.pairs, 2);
  assert.equal('address' in body.ice, false);
  assert.equal(body.tracks.audio, 1);
  assert.equal(body.tracks.video, 0);
  assert.deepEqual(body.viewport, {w: 390, h: 844});
  assert.equal(body.consent, 'on');
  assert.equal(body.upload, 'unsigned');
  const json = JSON.stringify(body);
  assert.equal(json.includes('eyJ'), false);
  assert.equal(json.includes('203.0.113'), false);
  assert.equal(join.deliverBeacon(body), false);
});

test('recording consent does not claim the microphone is on', () => {
  assert.match(join.recordingLine('on'), /Recording: off\./);
  assert.match(join.recordingLine('on'), /Consent is on/);
  assert.match(join.recordingLine('off'), /microphone stays off/);
});

test('hash and query tokens are read, then not required on the href', () => {
  assert.equal(join.readRaw({hash: '#t=abcdefghij0123456789', search: ''}), 'abcdefghij0123456789');
  assert.equal(join.readRaw({hash: '', search: '?token=abcdefghij0123456789'}), 'abcdefghij0123456789');
});
