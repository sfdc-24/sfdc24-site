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

test('hash and query tokens are read, then not required on the href', () => {
  assert.equal(join.readRaw({hash: '#t=abcdefghij0123456789', search: ''}), 'abcdefghij0123456789');
  assert.equal(join.readRaw({hash: '', search: '?token=abcdefghij0123456789'}), 'abcdefghij0123456789');
});
