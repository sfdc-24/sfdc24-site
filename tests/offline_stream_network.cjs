'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { installOfflineStreamNetwork, isLocal } = require('./helpers/offline-stream-network.cjs');

test('only exact loopback server origins are allowed', () => {
  for (const url of ['http://127.0.0.1:4173/stream/', 'http://127.0.0.1:8765/healthz']) assert.equal(isLocal(url), true);
  for (const url of ['https://script.google.com/exec', 'http://127.0.0.1:9999/',
    'http://127.0.0.1.evil.test:4173/', 'http://user@127.0.0.1:4173/', 'file:///tmp/a',
    'https://www.sfdc24.com/', 'https://127.0.0.1:4173/', 'not a URL']) assert.equal(isLocal(url), false, url);
});

test('production-shaped say requests are fulfilled locally and all other external requests abort', async () => {
  let handler;
  const context = { route: async (_, fn) => { handler = fn; }, routeWebSocket: async () => {} };
  const evidence = await installOfflineStreamNetwork(context);
  for (const q of ['please call back about automation', 'alpha words', 'beta words']) {
    const url = 'https://script.google.com/macros/s/test/exec?action=say&cb=test_cb&q=' + encodeURIComponent(q);
    let result;
    await handler({ request: () => ({ url: () => url }),
      continue: () => assert.fail('External request reached transport'),
      abort: () => assert.fail('Expected explicit synthetic answer'), fulfill: (r) => { result = r; } });
    assert.match(result.body, /Synthetic offline test answer/);
  }
  assert.equal(evidence.mockedQuestions.length, 3);
  for (const url of ['https://script.google.com/macros/s/test/exec?action=say&cb=bad.name',
    'https://script.googleusercontent.com/anything', 'https://provider.invalid/v1/audio']) {
    let refused = false;
    await handler({ request: () => ({ url: () => url }),
      continue: () => assert.fail('External request reached transport'),
      fulfill: () => assert.fail('Unexpected mock'), abort: () => { refused = true; } });
    assert.equal(refused, true);
  }
});

test('external sockets never connect; the exact fake relay can connect', async () => {
  let handler;
  await installOfflineStreamNetwork({ route: async () => {}, routeWebSocket: async (_, fn) => { handler = fn; } });
  let connected = false;
  handler({ url: () => 'ws://127.0.0.1:8765/v1/stream', connectToServer: () => { connected = true; } });
  assert.equal(connected, true);
  let closed = false;
  handler({ url: () => 'wss://provider.invalid/audio', connectToServer: () => assert.fail('External socket connected'), close: () => { closed = true; } });
  assert.equal(closed, true);
});
