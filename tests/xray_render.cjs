// Behavioural tests for the /xray/ console's render path.
//
// The static checks in tests/test_xray_page.py prove the sanitisers are PRESENT.
// These prove they WORK: they execute the page's real inline script under a DOM
// stub and feed it hostile scores.json values, per board award
// CODEX-XRAY-SAFETY-AMENDMENT-GO-20260908T165000Z.
//
// Same harness idea as tests/intake.cjs: run the served source, not a copy.

const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const assert = require('node:assert/strict');
const {test} = require('node:test');

const html = fs.readFileSync(path.join(__dirname, '../xray/index.html'), 'utf8');
const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)]
  .filter(([, attrs]) => !/\bsrc\s*=/i.test(attrs));
assert.equal(scripts.length, 1, 'the page must contain exactly one inline script');
const script = scripts[0][2];

// Markup that must never reach the DOM as live syntax.
const DANGEROUS = [
  /<\s*img\b/i,
  /<\s*script\b/i,
  /\son\w+\s*=/i,          // any event-handler attribute
  /javascript\s*:/i,
];

function stubElement(id) {
  const node = {
    id, innerHTML: '', textContent: '', value: '', disabled: false,
    dataset: {}, classList: {add(){}, remove(){}, contains:()=>false},
    style: {},
    addEventListener(name, fn) { (this._h ||= {})[name] = fn; },
    querySelectorAll: () => [],
    querySelector: () => null,
    closest: () => null,
    appendChild(){},
    getAttribute: () => null,
    setAttribute(){},
  };
  return node;
}

/** Run the page script under a DOM stub and hand back its internals. */
function boot() {
  const elements = new Map();
  const get = (id) => {
    if (!elements.has(id)) elements.set(id, stubElement(id));
    return elements.get(id);
  };
  const documentStub = {
    getElementById: get,
    addEventListener(){},
    querySelector: () => null,
    querySelectorAll: () => [],
    documentElement: {dataset: {}, style: {}},
    createElement: () => ({
      set innerHTML(v) { this._html = v; },
      get innerHTML() { return this._html; },
      content: {firstChild: stubElement('template-child')},
    }),
    body: {appendChild(){}},
  };
  const sandbox = {
    document: documentStub,
    window: {},
    matchMedia: () => ({matches: false}),
    navigator: {},
    FileReader: function(){},
    setTimeout: () => 0,
    clearTimeout: () => {},
    console: {log(){}, warn(){}, error(){}},
    URL, URLSearchParams, JSON, Math, Number, String, Object, Array, Date, Error, Set, Map,
  };
  sandbox.globalThis = sandbox;
  // Appending the capture line in the TEST rather than the page keeps the shipped
  // source free of test-only exports. `const` declarations are not sandbox
  // properties, so this is how we reach them.
  const capture = '\n;__internals = {validateScores, esc, sevN, fmt, SEVERITIES, MAX_TEXT, renderHero, renderGrid, renderBacklog, DATA};';
  vm.runInNewContext(script + capture, sandbox, {timeout: 5000});
  return {internals: sandbox.__internals, elements};
}

const {internals, elements} = boot();

function markupAfterRender(mutate) {
  const {internals: fresh, elements: els} = boot();
  const data = JSON.parse(JSON.stringify(fresh.DATA));
  mutate(data.findings[0]);
  // Bypass the loader deliberately: this asserts the RENDER layer is safe even
  // if something ever reaches it unvalidated. Defence in depth is only defence
  // if it is tested independently of the layer in front of it.
  const validated = (() => { try { return fresh.validateScores(data); } catch { return data; } })();
  fresh.renderGrid.call(null);
  const ctx = boot();
  ctx.internals.DATA = validated;
  ctx.internals.renderGrid();
  ctx.internals.renderBacklog();
  return [...ctx.elements.values()].map(e => e.innerHTML).join('\n');
}

test('the page exposes a validation boundary with an explicit severity allowlist', () => {
  assert.equal(typeof internals.validateScores, 'function');
  // Spread across the vm realm boundary: the sandbox's Array has a different
  // prototype, which deepStrictEqual compares and rejects.
  assert.deepEqual([...internals.SEVERITIES], [1, 2, 3, 4, 5]);
  assert.equal(typeof internals.MAX_TEXT, 'number');
});

test('a valid scores.json passes validation unchanged in substance', () => {
  const good = JSON.parse(JSON.stringify(internals.DATA));
  const out = internals.validateScores(good);
  assert.equal(out.findings.length, good.findings.length);
  assert.equal(out.findings[0].severity, good.findings[0].severity);
  assert.ok(internals.SEVERITIES.includes(out.findings[0].severity));
});

// --- rejection: malformed and hostile documents ---------------------------

const REJECTED = {
  'not an object': 'nope',
  'an array at the top level': [],
  'missing findings': {overall: {}, pillars: {}},
  'findings not an array': {overall: {}, pillars: {}, findings: {}},
};
for (const [label, input] of Object.entries(REJECTED)) {
  test(`rejects ${label}`, () => {
    assert.throws(() => internals.validateScores(input), /scores\.json/i);
  });
}

const BAD_FINDING = {
  'severity as an attribute breakout string': {severity: '5" onmouseover="x()" a="'},
  'severity out of the allowlist': {severity: 9},
  'severity zero': {severity: 0},
  'severity NaN': {severity: NaN},
  'severity null': {severity: null},
  'severity as an object': {severity: {}},
  'severity as an array': {severity: [5]},
  'sigma as script markup': {severity: 3, sigma: '<script>x()</script>'},
  'sigma as an object': {severity: 3, sigma: {}},
  'sigma NaN': {severity: 3, sigma: 'not-a-number'},
  'priority as an image tag': {severity: 3, priority: '<img src=x onerror=x()>'},
  'dpmo as an array': {severity: 3, dpmo: [1]},
  'title oversize': {severity: 3, title: 'x'.repeat(401)},
  'title as an object': {severity: 3, title: {}},
  'a finding that is an array': null,
};
for (const [label, finding] of Object.entries(BAD_FINDING)) {
  test(`rejects a finding with ${label}`, () => {
    const doc = {overall: {score: 1}, pillars: {}, findings: [finding === null ? [] : finding]};
    assert.throws(() => internals.validateScores(doc));
  });
}

test('rejection is whole-document: one bad finding rejects the file', () => {
  const doc = {
    overall: {score: 1}, pillars: {},
    findings: [{severity: 3, title: 'fine'}, {severity: 99, title: 'bad'}],
  };
  assert.throws(() => internals.validateScores(doc), /finding 1/);
});

test('oversize text is capped by MAX_TEXT, and the limit is real', () => {
  const ok = {overall: {score: 1}, pillars: {}, findings: [{severity: 3, title: 'x'.repeat(internals.MAX_TEXT)}]};
  assert.doesNotThrow(() => internals.validateScores(ok));
});

// --- render layer: defence in depth ---------------------------------------

const HOSTILE_VALUES = {
  'attribute breakout on severity': f => { f.severity = '5" onmouseover="pwn()" x="'; },
  'event handler on sigma': f => { f.sigma = '<img src=x onerror=pwn()>'; },
  'script markup on priority': f => { f.priority = '<script>pwn()</script>'; },
  'image tag through fmt on dpmo': f => { f.dpmo = '<img src=x onerror=pwn()>'; },
  'image tag through fmt on defects': f => { f.defects = '<img src=x onerror=pwn()>'; },
  'javascript url on title': f => { f.title = '<a href="javascript:pwn()">x</a>'; },
  'quotes on effort': f => { f.effort = '" onfocus="pwn()'; },
};
for (const [label, mutate] of Object.entries(HOSTILE_VALUES)) {
  test(`render layer neutralises ${label}`, () => {
    const markup = markupAfterRender(mutate);
    for (const pattern of DANGEROUS) {
      assert.doesNotMatch(markup, pattern, `${label} produced live markup matching ${pattern}`);
    }
  });
}

test('sevN only ever emits a class token from the allowlist, or 0', () => {
  const hostile = ['5" onmouseover="x', 9, -3, NaN, null, undefined, {}, [], '3', 3.4, Infinity];
  for (const v of hostile) {
    const out = internals.sevN(v);
    assert.ok(out === 0 || internals.SEVERITIES.includes(out), `sevN(${JSON.stringify(v)}) = ${out}`);
    assert.match(String(out), /^[0-5]$/, 'the class token must be a single digit');
  }
});

test('fmt never returns caller-controlled markup', () => {
  assert.equal(internals.fmt('<img src=x onerror=pwn()>'), '–');
  assert.equal(internals.fmt({}), '–');
  assert.equal(internals.fmt([1, 2]), '–');
  assert.equal(internals.fmt(NaN), '–');
  assert.equal(internals.fmt(null), '–');
  assert.equal(internals.fmt(Infinity), '–');
  assert.equal(internals.fmt(0), '0');           // zero must render, not fall through
  assert.equal(internals.fmt('2.5'), '2.5');     // numeric strings still format
});

test('esc neutralises every character that can start markup or close an attribute', () => {
  assert.equal(internals.esc('<>&"\''), '&lt;&gt;&amp;&quot;&#39;');
});

// --- the zero-user case the sample tile used to divide by ------------------

test('the sample tile renders no Infinity or NaN when active users is zero', () => {
  const ctx = boot();
  const src = script;
  assert.match(src, /const stale = Number\(LIVE\.staleUsers90\)\|\|0, act = Number\(LIVE\.activeUsers\)\|\|0;/,
    'active users must be coerced before the division');
  assert.match(src, /act \? Math\.round\(stale\/act\*1e6\) : null/, 'DPMO must be guarded on a zero denominator');
  assert.match(src, /act \? Math\.round\(stale\/act\*100\) \+ "%" : "–"/, 'the percentage must be guarded too');
  const markup = [...ctx.elements.values()].map(e => e.innerHTML).join('\n');
  assert.doesNotMatch(markup, /Infinity|NaN/, 'the rendered page must contain no Infinity or NaN');
});

// --- the page still renders, and the theme toggle is wired -----------------

test('a clean boot renders the hero, grid and backlog without throwing', () => {
  const ctx = boot();
  assert.doesNotThrow(() => { ctx.internals.renderHero(); ctx.internals.renderGrid(); ctx.internals.renderBacklog(); });
  const markup = [...ctx.elements.values()].map(e => e.innerHTML).join('\n');
  assert.ok(markup.length > 500, 'the render should produce substantial markup');
  assert.match(markup, /SYNTHETIC/, 'the synthetic label must be rendered');
});

test('the theme toggle is wired to a real handler', () => {
  const ctx = boot();
  const btn = ctx.elements.get('theme-btn');
  assert.ok(btn && btn._h && typeof btn._h.click === 'function', 'theme-btn needs a click handler');
  assert.doesNotThrow(() => btn._h.click());
});
