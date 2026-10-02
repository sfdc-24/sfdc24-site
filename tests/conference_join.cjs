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

test('a feedback note says the beacon was sent and carries no token', () => {
  const text = join.note('heard');
  assert.match(text, /^Noted in this tab: heard\./);
  assert.match(text, /Beacon sent/);
  assert.match(text, /has not confirmed storage/);
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
  assert.equal(body.phase, 'join');
});

test('deliverBeacon posts the payload with sendBeacon and refuses a token', () => {
  const calls = [];
  const nav = globalThis.navigator;
  const prev = nav.sendBeacon;
  nav.sendBeacon = (url, data) => {
    calls.push({url, data});
    return true;
  };
  try {
    const body = join.beaconPayload('room', {
      room: 'absent',
      viewport: {w: 390, h: 844},
      phase: 'exit',
      ice: {state: 'absent', pairs: 0},
      tracks: {audio: 0, video: 0}
    });
    assert.equal(join.deliverBeacon(body), true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://conference-gateway-96522051727.us-central1.run.app/feedback');
    assert.equal(String(calls[0].data).includes('eyJ'), false);
    assert.equal(join.deliverBeacon({error: 'eyJhbGciOiJIUzI1NiJ9.eyJyb29tIjoiYSJ9.signaturevalue'}), false);
    assert.equal(calls.length, 1);
  } finally {
    if (prev) nav.sendBeacon = prev;
    else delete nav.sendBeacon;
  }
});

test('recording copy matches the microphone state', () => {
  assert.match(join.recordingLine('on', 'on'), /Recording: on\./);
  assert.match(join.recordingLine('on', 'on'), /Audio is not uploaded/);
  assert.match(join.recordingLine('off'), /Consent is off/);
  assert.match(join.recordingLine('off', 'denied'), /permission was not granted/);
});

test('a chat line drops markup', () => {
  assert.equal(join.chatLine('  <b>Hello room</b>  '), 'Hello room');
  assert.equal(join.chatLine(''), '');
});

test('the handoff post is four short public lines', () => {
  assert.equal(join.POST.key_issues, 'Delay, and answers cut off.');
  assert.equal(join.POST.discussion_notes, 'Four voices, one floor.');
  assert.equal(join.POST.action_items, 'Measure both next call.');
  assert.equal(join.POST.next_steps, 'Sign in to join.');
  const blob = JSON.stringify(join.POST).toLowerCase();
  assert.equal(blob.includes('okf'), false);
  assert.equal(blob.includes('livekit'), false);
  const written = {};
  const doc = {
    querySelector(sel) {
      const slot = sel.split('"')[1];
      return {set textContent(value) { written[slot] = value; }};
    }
  };
  join.applyPost(doc, {key_issues: ' Heard. ', discussion_notes: 'eyJhbGciOiJIUzI1NiJ9.eyJyb29tIjoiYSJ9.x'});
  assert.equal(written.key_issues, 'Heard.');
  assert.equal(written.discussion_notes, undefined);
});

test('hash and query tokens are read, then not required on the href', () => {
  assert.equal(join.readRaw({hash: '#t=abcdefghij0123456789', search: ''}), 'abcdefghij0123456789');
  assert.equal(join.readRaw({hash: '', search: '?token=abcdefghij0123456789'}), 'abcdefghij0123456789');
  assert.equal(join.readRaw({hash: '#t=%', search: ''}), '');
});

test('a conference code hash is not a gateway token', () => {
  assert.equal(join.readCode({hash: '#c=abcDEF_123-zz'}), 'abcDEF_123-zz');
  assert.equal(join.readCode({hash: '#t=abcdefghij0123456789'}), '');
  assert.equal(join.readCode({hash: '#c=%'}), '');
});

test('a join link keeps the code and drops a token', () => {
  assert.equal(
    join.cleanHref({pathname: '/conference/', hash: '#c=ABCD2345', search: ''}),
    '/conference/#c=ABCD2345'
  );
  assert.equal(
    join.cleanHref({pathname: '/conference/', hash: '#token=abcdefghij0123456789', search: ''}),
    '/conference/'
  );
  assert.equal(
    join.cleanHref({pathname: '/conference/', hash: '#c=ABCD2345', search: '?token=abcdefghij0123456789'}),
    '/conference/#c=ABCD2345'
  );
});

test('a beacon body drops a conference code and accepts only 204', () => {
  const body = join.beaconPayload('room', {
    code: 'abcDEF_123-zz',
    room: 'absent',
    feedback: 'heard',
    phase: 'live'
  });
  assert.equal('code' in body, false);
  assert.equal(body.feedback, 'heard');
  assert.equal(join.beaconAccepted(204), true);
  assert.equal(join.beaconAccepted(401), false);
  assert.match(join.statusNote('heard'), /Gateway answered 204/);
});

test('a missing sendBeacon reads a 204', async () => {
  const nav = globalThis.navigator;
  const prev = nav.sendBeacon;
  const prevFetch = globalThis.fetch;
  delete nav.sendBeacon;
  let seen = '';
  globalThis.fetch = async (url, opts) => {
    seen = String(url) + '\n' + String(opts.body || '');
    return {status: 204};
  };
  try {
    const body = join.beaconPayload('room', {
      room: 'absent',
      feedback: 'heard',
      phase: 'live',
      viewport: {w: 390, h: 844}
    });
    assert.equal(join.deliverBeacon(body), true);
    assert.equal(await globalThis.__conferenceBeacon, 204);
    assert.equal(seen.includes('eyJ'), false);
    assert.equal(seen.includes('/feedback'), true);
  } finally {
    if (prev) nav.sendBeacon = prev;
    else delete nav.sendBeacon;
    globalThis.fetch = prevFetch;
  }
});
