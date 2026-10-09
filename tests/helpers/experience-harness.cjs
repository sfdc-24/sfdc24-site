// Shared harness for the /experience/ browser tests: the page served from the
// repository, a mocked studio controller (session, voice, commands, an event
// stream the test scripts), a stubbed microphone and RTCPeerConnection, and
// optionally a stub Mermaid. No real network, provider or microphone is used.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..', '..');
const CTRL = 'https://sfdc24-studio-controller-96522051727.us-central1.run.app';
const MERMAID = 'https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.min.js';
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, content-type, accept, last-event-id',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
};
const HEALTH = { features: { voice: true, talk: true, topics: true, agents: ['claude'], voices: ['host', 'architect'] } };

// The REAL Mermaid the page pins, for tests that must see what Mermaid draws
// (a stub never puts a label into the SVG). Taken from MERMAID_FILE, a temp
// cache, or the pinned URL, and used only when its bytes match the page's SRI.
async function realMermaidFile() {
  const crypto = require('node:crypto');
  const os = require('node:os');
  const page = fs.readFileSync(path.join(root, 'experience', 'index.html'), 'utf8');
  const pin = (page.match(/mermaid@11\.4\.1\/dist\/mermaid\.min\.js" integrity="(sha384-[^"]+)"/) || [])[1];
  if (!pin) throw new Error('experience/index.html no longer pins mermaid@11.4.1 with an integrity hash');
  const ok = buf => 'sha384-' + crypto.createHash('sha384').update(buf).digest('base64') === pin;
  const cached = process.env.MERMAID_FILE || path.join(os.tmpdir(), 'sfdc24-mermaid-11.4.1.min.js');
  if (fs.existsSync(cached) && ok(fs.readFileSync(cached))) return cached;
  const res = await fetch(MERMAID);
  if (!res.ok) throw new Error('could not fetch ' + MERMAID + ': ' + res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  if (!ok(buf)) throw new Error('the fetched Mermaid does not match the page SRI pin');
  const out = path.join(os.tmpdir(), 'sfdc24-mermaid-11.4.1.min.js');
  fs.writeFileSync(out, buf);
  return out;
}

function sse(events) {
  return events.map(e => 'id: ' + e.seq + '\nevent: ' + e.type + '\ndata: ' + JSON.stringify(e) + '\n\n').join('');
}

// A stub Mermaid that records the source it is asked to draw and answers with
// one <g class="node"> per step, ids shaped like Mermaid 11's.
function stubMermaid() {
  window.__mermaidSources = [];
  window.mermaid = {
    initialize(config) { window.__mermaidConfig = config; },
    render: async (id, src) => {
      window.__mermaidSources.push(src);
      const n = (src.match(/^\s+s\d+\["/mg) || []).length;
      let g = '';
      for (let i = 0; i < n; i++) g += '<g class="node default" id="' + id + '-flowchart-s' + i + '-' + i + '"><rect x="' + (i * 120) + '" y="10" width="80" height="30" fill="#eee"></rect></g>';
      return { svg: '<svg xmlns="http://www.w3.org/2000/svg" data-stub="1" viewBox="0 0 400 100">' + g + '</svg>' };
    },
  };
}

async function load(page, url, { events = [], health = HEALTH, mermaid = 'stub', realMermaidFile, handle } = {}) {
  const calls = [];
  await page.route('**/*', async route => {
    const u = new URL(route.request().url());
    const req = route.request();
    if (u.href === MERMAID && realMermaidFile) {
      return route.fulfill({ body: fs.readFileSync(realMermaidFile), contentType: 'application/javascript',
                             headers: { 'access-control-allow-origin': '*' } });
    }
    if (u.origin === CTRL) {
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
      const body = req.postData() ? JSON.parse(req.postData()) : null;
      calls.push({ path: u.pathname, body });
      const now = Math.floor(Date.now() / 1000);
      const json = out => route.fulfill({ status: out.status || 200, headers: { ...CORS, 'content-type': 'application/json' },
                                          body: JSON.stringify(out.json || {}) });
      const custom = handle && (await handle(u.pathname, body, calls));
      if (custom) return json(custom);
      if (u.pathname === '/health') return json({ json: health });
      if (u.pathname === '/v1/session') return json({ json: { session_id: 's-1', token: 'sess-token', generation: 1, artifact_version: 1 } });
      if (u.pathname === '/v1/session/s-1/voice') return json({ json: { sdp: 'v=0 answer', ends_at: now + 600 } });
      if (u.pathname === '/v1/session/s-1/events') {
        const first = (req.headers()['last-event-id'] || '0') === '0';
        return route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'text/event-stream' },
                               body: first ? sse(events) : ': keep-alive\n\n' });
      }
      if (u.pathname === '/v1/session/s-1/commands') return json({ json: { artifact_version: body.expected_version, events: [], problems: [] } });
      return json({ status: 404, json: { detail: 'not mocked' } });
    }
    if (u.origin !== 'http://site.test') return route.abort();
    let rel = decodeURIComponent(u.pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.resolve(root, '.' + rel);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
    const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json' };
    return route.fulfill({ body: fs.readFileSync(file), contentType: types[path.extname(file)] || 'text/plain' });
  });
  if (mermaid === 'stub') await page.addInitScript(stubMermaid);
  await page.addInitScript(() => {
    sessionStorage.setItem('studio.operator', JSON.stringify({ token: 'op-token', expires_at: '' }));
    window.vcSent = [];
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
      getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }),
    } });
    window.RTCPeerConnection = class {
      constructor() { this.iceGatheringState = 'complete'; }
      addTrack() {}
      createDataChannel(label) {
        const ch = { label, readyState: 'open', close() {}, send: m => { window.vcSent.push(JSON.parse(m)); } };
        setTimeout(() => ch.onopen && ch.onopen(), 0);
        return ch;
      }
      async createOffer() { return { type: 'offer', sdp: 'v=0 offer' }; }
      async setLocalDescription(d) { this.localDescription = d; }
      async setRemoteDescription(d) { this.remote = d; }
      addEventListener() {}
      close() {}
    };
  });
  await page.goto('http://site.test' + url);
  return calls;
}

// The conference canvas as the builder makes it: one section per diagram, a
// heading first, then step, edge, step... and a decision card.
function conferenceTree() {
  return {
    id: 'screen', kind: 'screen', label: "Conference line - today's work", children: [
      { id: 'arch', kind: 'section', label: 'Architecture: the call path', children: [
        { id: 'arch-h', kind: 'heading', label: 'Architecture: the call path' },
        { id: 'gw', kind: 'process-step', label: 'Gateway', detail: 'Admits the owner and opens the room.' },
        { id: 'e1', kind: 'edge', label: 'Turn request', detail: 'Gateway -> Message bus, on every turn' },
        { id: 'bus', kind: 'process-step', label: 'Message bus', detail: 'Carries every turn between the parts.' },
        { id: 'e2', kind: 'edge', label: 'Next speaker', detail: 'Message bus -> Chair' },
        { id: 'chair', kind: 'process-step', label: 'Chair', detail: 'Picks who speaks next.' },
        { id: 'risk', kind: 'card', label: 'Risk: a stuck turn', detail: 'A watchdog ends a turn after 30 seconds.' },
      ] },
      { id: 'proc', kind: 'section', label: 'Process: one turn on the line', children: [
        { id: 'proc-h', kind: 'heading', label: 'Process: one turn on the line' },
        { id: 'p1', kind: 'process-step', label: 'Owner speaks', detail: 'The microphone sends the audio.' },
        { id: 'p2', kind: 'process-step', label: 'Chair picks', detail: 'The chair chooses the agent.' },
        { id: 'p3', kind: 'process-step', label: 'Agent answers', detail: 'The answer is spoken back.' },
      ] },
    ],
  };
}
function snapshot(tree, seq = 1) {
  return { seq, type: 'artifact.snapshot', artifact_version: 1, generation: 1, session_id: 's-1', payload: { root: tree } };
}

async function startStudio(page, calls) {
  const { expect } = require('@playwright/test');
  await expect(page.locator('#experience-voice [data-vc-start]')).toBeVisible();
  await page.locator('#experience-voice [data-vc-start]').click();
  await expect.poll(() => calls.filter(c => c.path === '/v1/session/s-1/voice').length).toBe(1);
}

module.exports = { load, startStudio, conferenceTree, snapshot, realMermaidFile, CTRL, MERMAID };
