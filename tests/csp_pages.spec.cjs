// Every page carries a Content-Security-Policy meta tag (tools/site_csp.py).
// This loads each page in Chromium and fails on any CSP violation, then drives
// the flows that reach another origin, so a policy that is too narrow shows up
// here and not on the live site:
//   the homepage ask (Apps Script JSONP, and its redirect to googleusercontent),
//   the stream page microphone (relay session, the pcm worklet, the wss stream),
//   the voice page ask (JSONP, a data: audio reply),
//   the guest and presenter join (join service, then the LiveKit signal socket),
//   the conference room pane and canvas, the Web-to-Lead form post.
// Every third-party request is answered here, so no visitor budget is spent and
// nothing is posted. CSP_REAL_NETWORK=1 lets the public font, CDN and GitHub
// requests through, which also exercises what those scripts load next.
const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
// A real local server on 127.0.0.1, not a routed made-up host: the microphone
// and screen flows need a secure context, and an AudioWorklet module request is
// not routed by Playwright, so it must reach a server.
let SITE = '';
let server = null;
const REAL = process.env.CSP_REAL_NETWORK === '1';
const REPORT = process.env.CSP_REPORT_FILE || '';
const PUBLIC_CDN = new Set([
  'https://fonts.googleapis.com', 'https://fonts.gstatic.com', 'https://cdn.jsdelivr.net',
  'https://api.github.com', 'https://raw.githubusercontent.com',
]);
const LIVEKIT = 'wss://csp-check.livekit.cloud';

test.use({
  permissions: ['microphone'],
  launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--auto-select-desktop-capture-source=Entire screen'] },
});
test.setTimeout(30000);

const pages = execFileSync('git', ['ls-files', '*.html'], { cwd: root, encoding: 'utf8' })
  .split('\n').map((f) => f.trim())
  .filter((f) => f && !f.startsWith('tests/') && !f.endsWith('.fragment.html'));

const TYPES = {
  '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json',
  '.jsonl': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.mmd': 'text/plain',
  '.webp': 'image/webp', '.txt': 'text/plain', '.xml': 'application/xml', '.woff2': 'font/woff2',
};

test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    let rel = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    let file = path.resolve(root, '.' + rel);
    if (file.startsWith(root + path.sep) && fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404); res.end(); return;
    }
    res.setHeader('content-type', TYPES[path.extname(file)] || 'application/octet-stream');
    res.end(fs.readFileSync(file));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  SITE = `http://127.0.0.1:${server.address().port}`;
});
test.afterAll(async () => { if (server) await new Promise((resolve) => server.close(resolve)); });

function jsonp(url, body) {
  const cb = url.searchParams.get('cb');
  if (cb && /^[A-Za-z_$][\w$]*$/.test(cb)) {
    return { status: 200, contentType: 'application/javascript', body: `if(typeof ${cb}==='function') ${cb}(${JSON.stringify(body)});` };
  }
  return { status: 200, contentType: 'application/json', body: JSON.stringify(body) };
}

function b64url(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

// An unsigned token in the shape the seats read: the presenter seat checks it
// grants screen share only. Nothing verifies the signature in the page.
function seatToken(identity, presenter) {
  const video = presenter
    ? { room: 'csp-room', roomJoin: true, canSubscribe: false, canPublish: true, canPublishData: false, canPublishSources: ['screen_share'] }
    : { room: 'csp-room', roomJoin: true, canSubscribe: true, canPublish: true, canPublishData: false, canPublishSources: ['microphone'] };
  return b64url({ alg: 'HS256', typ: 'JWT' }) + '.' + b64url({ sub: identity, video }) + '.csp-check';
}

function joinBody(presenter) {
  const identity = presenter ? 'prs_0123456789abcdef' : 'gst_0123456789abcdef';
  return JSON.stringify({
    livekit_url: LIVEKIT, room: 'csp-room', identity, join_token: seatToken(identity, presenter),
    join_expires_at: Math.floor(Date.now() / 1000) + 600, name: 'Visitor', deadline: Math.floor(Date.now() / 1000) + 600,
    role: presenter ? 'presenter' : 'guest',
  });
}

// A short silent MP3 frame, so the voice page has a data: reply to play.
const SILENT_MP3 = '//uQZAAAAAAAAAAAAAAAAAAAAAAAWGluZwAAAA8AAAACAAACcQCAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA';

async function watch(page, opts = {}) {
  const seen = { violations: [], requests: [], sockets: [], logs: [] };
  page.on('pageerror', (err) => seen.logs.push('pageerror: ' + String(err).slice(0, 300)));
  await page.addInitScript(() => {
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => {
      window.__csp.push({ directive: e.effectiveDirective || e.violatedDirective, blocked: e.blockedURI, source: e.sourceFile, line: e.lineNumber });
    }, true);
  });
  page.on('console', (msg) => {
    const text = msg.text();
    seen.logs.push(msg.type() + ': ' + text.slice(0, 300));
    if (/Content Security Policy/i.test(text)) seen.violations.push({ console: text.slice(0, 400) });
  });
  await page.routeWebSocket(/.*/, (ws) => { seen.sockets.push(ws.url()); ws.close(); });
  await page.context().route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === SITE) return route.continue();
    seen.requests.push(url.origin + url.pathname);
    if (REAL && PUBLIC_CDN.has(url.origin)) return route.continue();
    if (url.origin === 'https://script.google.com') {
      // Answered directly. The live endpoint answers with a 302 to
      // script.googleusercontent.com; a redirected request is not routed
      // here, so that hop has its own test below.
      return route.fulfill(jsonp(url, { ok: true, reply: 'Synthetic reply.', by: 'claude', ct: 'csp-check', rows: [], b64: SILENT_MP3, mime: 'audio/mpeg' }));
    }
    if (url.hostname.endsWith('.run.app')) {
      const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS' };
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors, body: '' });
      if (/\/api\/(guest|present)\/join$/.test(url.pathname)) return route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: joinBody(!!opts.presenter) });
      if (url.pathname === '/v1/session' && url.hostname.startsWith('sfdc24-stt-relay')) {
        return route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify({ token: 'csp-token', stream_path: '/v1/stream' }) });
      }
      if (url.pathname === '/health') return route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: '{"ok":true}' });
      return route.fulfill({ status: 503, headers: cors, contentType: 'application/json', body: '{"error":"csp-check"}' });
    }
    if (url.origin === 'https://room.sfdc24.com') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>room</title><p>room fixture</p>' });
    if (url.hostname.endsWith('.livekit.cloud')) return route.fulfill({ status: 404, body: '' });
    if (url.origin === 'https://webto.salesforce.com') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>thanks</title>' });
    if (url.origin === 'https://fonts.googleapis.com') return route.fulfill({ contentType: 'text/css', body: '' });
    if (url.origin === 'https://cdn.jsdelivr.net') return route.fulfill({ contentType: 'application/javascript', body: '' });
    if (url.origin === 'https://api.github.com' || url.origin === 'https://raw.githubusercontent.com') {
      return route.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
    }
    return route.abort();
  });
  return seen;
}

async function settle(page, ms) {
  await page.waitForTimeout(ms || 1500);
}

async function violations(page, seen) {
  let fromPage = [];
  try { fromPage = await page.evaluate(() => window.__csp || []); } catch (e) { /* navigated */ }
  const all = fromPage.concat(seen.violations);
  const keys = new Set();
  return all.filter((v) => {
    const key = JSON.stringify(v);
    if (keys.has(key)) return false;
    keys.add(key);
    return true;
  });
}

let last = null;
test.afterEach(async ({}, info) => {
  if (last && info.status !== info.expectedStatus) {
    report({ page: last.file, flow: last.flow + ' (FAILED)', violations: last.seen.violations, requests: [...new Set(last.seen.requests)], sockets: last.seen.sockets, logs: last.seen.logs.slice(-12), text: last.page ? (await last.page.locator('body').innerText().catch(() => '')).slice(0, 600) : '' });
  }
  last = null;
});

function track(page, seen, file, flow) {
  last = { page, seen, file, flow };
}

function report(entry) {
  if (REPORT) fs.appendFileSync(REPORT, JSON.stringify(entry) + '\n');
}

test('the page list is read from the repository', () => {
  expect(pages.length).toBeGreaterThanOrEqual(30);
  expect(pages).toContain('conference/index.html');
});

for (const file of pages) {
  const route = '/' + file.replace(/index\.html$/, '');
  test(`${file} loads with no Content-Security-Policy violation`, async ({ page }) => {
    const seen = await watch(page);
    track(page, seen, test.info().title, "flow");
    await page.goto(SITE + route, { waitUntil: 'load' });
    await settle(page, 2000);
    const found = await violations(page, seen);
    report({ page: file, flow: 'load', violations: found, requests: [...new Set(seen.requests)], sockets: seen.sockets });
    expect(found, JSON.stringify(found, null, 1)).toEqual([]);
  });
}

// The live Apps Script answers a JSONP request with a 302 to
// script.googleusercontent.com, and the browser checks the redirected URL
// against script-src too. Playwright does not route a redirected request, so
// the second hop goes to the network and fails there (no network, or Google
// refuses the made-up key); only the policy outcome is asserted. The control
// page, without googleusercontent in script-src, must report the violation.
for (const [label, csp, expectBlocked] of [
  ['the homepage policy allows', null, false],
  ['a policy without script.googleusercontent.com blocks', "default-src 'self'; script-src 'self' 'unsafe-inline' https://script.google.com", true],
]) {
  test(`Apps Script redirect: ${label} the googleusercontent hop`, async ({ page }) => {
    const seen = { blocked: [] };
    page.on('console', (msg) => { if (/Content Security Policy/i.test(msg.text())) seen.blocked.push(msg.text().slice(0, 300)); });
    const home = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
    const policy = csp || home.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)[1];
    await page.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (url.origin === SITE) {
        return route.fulfill({ contentType: 'text/html', body: `<!doctype html><meta http-equiv="Content-Security-Policy" content="${policy}"><title>redirect</title>` });
      }
      if (url.origin === 'https://script.google.com') {
        return route.fulfill({ status: 302, headers: { location: 'https://script.googleusercontent.com/macros/echo?user_content_key=csp-check&cb=cspcb' }, body: '' });
      }
      return route.abort();
    });
    await page.goto(SITE + '/redirect-check');
    const events = await page.evaluate(() => new Promise((resolve) => {
      const out = [];
      document.addEventListener('securitypolicyviolation', (e) => out.push(e.blockedURI));
      const s = document.createElement('script');
      s.onerror = s.onload = () => setTimeout(() => resolve(out), 300);
      s.src = 'https://script.google.com/macros/s/csp-check/exec?cb=cspcb';
      document.head.appendChild(s);
    }));
    const blocked = events.concat(seen.blocked).some((v) => String(v).includes('script.googleusercontent.com'));
    expect(blocked, JSON.stringify(events.concat(seen.blocked))).toBe(expectBlocked);
  });
}

// The homepage ask path. The homepage's own ask field is hidden; a question
// typed in the header ask on any other page is handed to the homepage, which
// sends it to Apps Script as JSONP.
test('homepage ask: a question from /method/ reaches Apps Script JSONP inside the homepage policy', async ({ page }) => {
  const seen = await watch(page);
  track(page, seen, test.info().title, "flow");
  await page.goto(SITE + '/method/', { waitUntil: 'load' });
  await page.locator('#chrome-box').fill('Should our Salesforce team choose Flow or Apex for lead assignment?');
  await page.locator('#chrome-box').press('Enter');
  await expect(page.locator('#tape')).toContainText('Synthetic reply.', { timeout: 15000 });
  const found = await violations(page, seen);
  report({ page: 'index.html', flow: 'ask: /method/ header ask -> homepage -> Apps Script JSONP', violations: found, requests: [...new Set(seen.requests)], sockets: seen.sockets });
  expect(seen.requests.some((u) => u.startsWith('https://script.google.com/macros/'))).toBe(true);
  expect(found, JSON.stringify(found, null, 1)).toEqual([]);
});

test('stream microphone: relay session, pcm worklet and the wss stream stay inside the policy', async ({ page }) => {
  const seen = await watch(page);
  track(page, seen, test.info().title, "flow");
  await page.goto(SITE + '/stream/', { waitUntil: 'load' });
  await page.locator('#start').click();
  await expect.poll(() => seen.sockets.length, { timeout: 10000 }).toBeGreaterThan(0);
  await settle(page, 1000);
  const found = await violations(page, seen);
  report({ page: 'stream/index.html', flow: 'microphone -> relay session -> wss stream', violations: found, requests: [...new Set(seen.requests)], sockets: seen.sockets });
  expect(seen.sockets.some((u) => u.startsWith('wss://sfdc24-stt-relay-yzet4vuplq-uc.a.run.app/'))).toBe(true);
  expect(found, JSON.stringify(found, null, 1)).toEqual([]);
});

test('voice ask: the JSONP reply plays as data: audio inside the policy', async ({ page }) => {
  const seen = await watch(page);
  track(page, seen, test.info().title, "flow");
  await page.goto(SITE + '/voice/', { waitUntil: 'load' });
  await page.locator('#box').fill('What does a Salesforce admin do?');
  await page.locator('#send').click();
  await expect.poll(() => seen.requests.filter((u) => u.startsWith('https://script.google.com/')).length, { timeout: 10000 }).toBeGreaterThan(0);
  await settle(page, 1500);
  const found = await violations(page, seen);
  report({ page: 'voice/index.html', flow: 'typed ask -> JSONP -> data: audio', violations: found, requests: [...new Set(seen.requests)], sockets: seen.sockets });
  expect(found, JSON.stringify(found, null, 1)).toEqual([]);
});

for (const [seat, file] of [['guest', 'guest/index.html'], ['present', 'present/index.html']]) {
  test(`${seat} join: the join service and the LiveKit signal socket stay inside the policy`, async ({ page }) => {
    const seen = await watch(page, { presenter: seat === 'present' });
    track(page, seen, test.info().title, "flow");
    await page.goto(SITE + '/' + seat + '/#csp-check-code-0123456789', { waitUntil: 'load' });
    if (seat === 'present') await page.getByRole('button', { name: 'Share this screen' }).first().click();
    await expect.poll(() => seen.requests.filter((u) => /\/api\/(guest|present)\/join$/.test(u)).length, { timeout: 10000 }).toBeGreaterThan(0);
    await expect.poll(() => seen.sockets.length + seen.requests.filter((u) => u.includes('.livekit.cloud')).length, { timeout: 10000 }).toBeGreaterThan(0);
    await settle(page, 1500);
    const found = await violations(page, seen);
    report({ page: file, flow: 'join -> LiveKit signal', violations: found, requests: [...new Set(seen.requests)], sockets: seen.sockets });
    expect(found, JSON.stringify(found, null, 1)).toEqual([]);
  });
}

test('conference: the room pane and the canvas stay inside the policy', async ({ page }) => {
  const seen = await watch(page);
  track(page, seen, test.info().title, "flow");
  await page.goto(SITE + '/conference/?room=workshop', { waitUntil: 'load' });
  await page.locator('#conf-room-toggle').click();
  await expect(page.locator('#conf-room-frame')).toHaveAttribute('src', /^https:\/\/room\.sfdc24\.com\//);
  await page.locator('#conf-canvas-toggle').click();
  await settle(page, 2500);
  const found = await violations(page, seen);
  report({ page: 'conference/index.html', flow: 'room pane + canvas', violations: found, requests: [...new Set(seen.requests)], sockets: seen.sockets });
  expect(seen.requests.some((u) => u.startsWith('https://room.sfdc24.com/'))).toBe(true);
  expect(found, JSON.stringify(found, null, 1)).toEqual([]);
});

test('intake: the Web-to-Lead form post is allowed by form-action', async ({ page }) => {
  const seen = await watch(page);
  track(page, seen, test.info().title, "flow");
  await page.goto(SITE + '/intake/', { waitUntil: 'load' });
  const before = await violations(page, seen);
  await Promise.all([
    page.waitForURL(/webto\.salesforce\.com/, { timeout: 10000 }),
    page.evaluate(() => document.getElementById('leadForm').submit()),
  ]);
  report({ page: 'intake/index.html', flow: 'Web-to-Lead form post', violations: before.concat(seen.violations), requests: [...new Set(seen.requests)], sockets: seen.sockets });
  expect(seen.requests.some((u) => u.startsWith('https://webto.salesforce.com/'))).toBe(true);
  expect(before.concat(seen.violations)).toEqual([]);
});
