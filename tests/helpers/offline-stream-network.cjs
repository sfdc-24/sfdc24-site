'use strict';

// The local stream page still contains the production Governor URL. A fake
// microphone/relay alone does NOT make this an offline test. Deny network
// egress before creating pages; only these two loopback servers may be used.
const LOCAL_ORIGINS = new Set(['http://127.0.0.1:4173', 'http://127.0.0.1:8765']);
function isLocal(raw) {
  try {
    const url = new URL(raw);
    return !url.username && !url.password && LOCAL_ORIGINS.has(url.origin);
  } catch { return false; }
}

async function installOfflineStreamNetwork(context) {
  const evidence = { blocked: [], mockedQuestions: [], local: [] };
  await context.route('**/*', async (route) => {
    const raw = route.request().url();
    const url = new URL(raw);
    if (isLocal(raw)) {
      evidence.local.push(url.pathname);
      return route.continue();
    }
    // Generic answer for relay lifecycle cases. Tests asserting actual routing
    // or late callbacks install their own page-level, fully mocked responses.
    const cb = url.searchParams.get('cb') || '';
    if (url.origin === 'https://script.google.com' &&
        /^\/macros\/s\/[^/]+\/exec$/.test(url.pathname) &&
        url.searchParams.get('action') === 'say' && /^[A-Za-z_$][\w$]*$/.test(cb)) {
      evidence.mockedQuestions.push(url.searchParams.get('q'));
      return route.fulfill({ status: 200, contentType: 'application/javascript',
        body: `if(typeof ${cb}==="function")${cb}(${JSON.stringify({ ok: true,
          reply: 'Synthetic offline test answer.', by: 'fixture', ct: 'offline-test-only' })});` });
    }
    evidence.blocked.push(url.origin + url.pathname);
    return route.abort('blockedbyclient');
  });
  await context.routeWebSocket('**/*', (socket) => {
    const raw = socket.url();
    if (isLocal(raw.replace(/^ws:/, 'http:'))) return socket.connectToServer();
    evidence.blocked.push(new URL(raw).origin);
    return socket.close({ code: 1008, reason: 'Offline test network only' });
  });
  return evidence;
}

module.exports = { installOfflineStreamNetwork, isLocal };
