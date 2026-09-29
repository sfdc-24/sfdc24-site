const {test} = require('node:test');
const assert = require('node:assert/strict');
const create = require('../assets/conference-create.js');
const gate = require('../assets/conference-gate.js');

test('a join link is a conference hash and nothing else', () => {
  assert.equal(
    create.joinLink('https://www.sfdc24.com', 'abcDEF_123'),
    'https://www.sfdc24.com/conference/#c=abcDEF_123'
  );
  assert.equal(create.joinLink('https://www.sfdc24.com', '<b>'), '');
  assert.equal(create.emailOk('guest@example.com'), true);
  assert.equal(create.emailOk('not an email'), false);
});

test('gate messages do not echo a code', () => {
  assert.match(gate.messageFor(401, 'rejected'), /not accepted/);
  assert.match(gate.messageFor(409, 'used'), /already used/);
  assert.match(gate.messageFor(503, 'gate_unconfigured'), /not configured/);
  assert.match(gate.messageFor(503, 'room_token_unconfigured'), /not used/);
  const text = gate.messageFor(401, 'rejected');
  assert.equal(text.includes('token'), false);
});

test('an invite stays a draft until the host confirms a configured hook', () => {
  assert.match(create.inviteSentence({sent: false, status: 'draft'}), /Nothing was sent/);
  assert.match(create.inviteSentence({sent: false, reason: 'send_unconfigured'}), /not configured/);
  assert.match(create.inviteSentence({sent: false, reason: 'time_unset'}), /no start time/);
  assert.match(
    create.inviteSentence({sent: false, reason: 'time_unset', mail: {durable: true}}),
    /mail hook accepted/
  );
  assert.match(create.inviteSentence({sent: true}), /calendar invite/);
});

test('an unconfigured gate does not invent a base url', () => {
  assert.equal(gate.gateBase(), '');
});
