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

test('feedback beacon is an enum and still has no token', () => {
  const body = join.beaconPayload('feedback', 'present', 320, 700, 'heard');
  assert.equal(body.feedback, 'heard');
  assert.equal(join.beaconPayload('feedback', 'missing', 1, 1, 'postal address').feedback, undefined);
});

test('beacon payload never carries the token, a name, or a recording', () => {
  const body = join.beaconPayload('page_open', 'present', 390, 844);
  assert.equal(body.token, 'present');
  assert.equal(body.recording, 'off');
  assert.equal(body.path, '/conference/');
  assert.equal(JSON.stringify(body).includes('eyJ'), false);
  assert.equal('address' in body, false);
});

test('join href is the gateway with no token attached', () => {
  assert.equal(join.joinHref(), 'https://conference-gateway-96522051727.us-central1.run.app/');
  assert.equal(join.joinHref().includes('token'), false);
});

test('hash and query tokens are read, then not required on the href', () => {
  assert.equal(join.readRaw({hash: '#t=abcdefghij0123456789', search: ''}), 'abcdefghij0123456789');
  assert.equal(join.readRaw({hash: '', search: '?token=abcdefghij0123456789'}), 'abcdefghij0123456789');
});
