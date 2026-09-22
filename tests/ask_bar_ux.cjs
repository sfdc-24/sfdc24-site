// Ask-bar UX: product comments stay local, estimator stays inert unless
// the ask is clearly a sizing ask, Salesforce-ish text still opens /org/.
//
// Run: node --test tests/ask_bar_ux.cjs

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');

const REPO = path.join(__dirname, '..');

function loadTriage() {
  const window = {};
  vm.runInNewContext(
    fs.readFileSync(path.join(REPO, 'assets/triage.js'), 'utf8'),
    { window },
  );
  assert.ok(window.__TRIAGE && typeof window.__TRIAGE.ask === 'function');
  return window;
}

function loadWithBoot(window) {
  const document = {
    readyState: 'complete',
    querySelector() { return { parentNode: true }; },
    addEventListener() {},
    createElement() { return { src: '', defer: true }; },
    head: { appendChild() {} },
    getElementById() { return null; },
  };
  const sandbox = {
    window,
    document,
    setTimeout(fn) { try { fn(); } catch (e) {} },
  };
  vm.runInNewContext(
    fs.readFileSync(path.join(REPO, 'assets/local-first-boot.js'), 'utf8'),
    sandbox,
  );
  return window;
}

test('whats next is a local product answer, not a Salesforce problem', () => {
  const { __TRIAGE } = loadTriage();
  for (const q of [
    'much better, whats next?',
    "what's next?",
    'whats next',
    'roadmap',
    'looks better — what is next',
  ]) {
    const got = __TRIAGE.ask(q);
    assert.ok(got, `no triage result for "${q}"`);
    assert.equal(got.id, 'whats-next', `"${q}" routed as ${got.id}`);
    assert.match(got.answer, /This release describes shipped work/);
    assert.match(got.answer, /History/);
    assert.match(got.answer, /Method/);
    assert.match(got.answer, /session-only preference exercise/);
    assert.doesNotMatch(got.answer, /next ship|top right|challenge prep/);
    assert.doesNotMatch(got.answer, /Salesforce problem/i);
    assert.doesNotMatch(got.answer, /AI Fitness/i);
    assert.doesNotMatch(got.answer, /SFDC\s*24/i);
    assert.equal(got.handTo, '');
  }
});

test('greetings and help still answer locally', () => {
  const { __TRIAGE } = loadTriage();
  assert.equal(__TRIAGE.ask('hi').id, 'greeting');
  assert.equal(__TRIAGE.ask('help').id, 'help');
});

test('the exact public-build question gets a factual local answer, not a confidentiality refusal', () => {
  const { __TRIAGE } = loadTriage();
  for (const q of ['What have you actually built?', 'What have you built?', 'What did you actually build?']) {
    const got = __TRIAGE.ask(q);
    assert.equal(got.id, 'public-builds');
    assert.equal(got.by, 'python');
    assert.equal(got.routeTo, undefined);
    assert.equal(got.handTo, '');
    assert.match(got.answer, /Method/);
    assert.match(got.answer, /History/);
    assert.match(got.answer, /session-only tally, not a fitted model/);
    assert.match(got.answer, /not proof of a completed client deployment/);
    assert.doesNotMatch(got.answer, /confidential/i);
  }
});

test('this-site self-description stays local without changing its existing factual answer', () => {
  const { __TRIAGE } = loadTriage();
  const got = __TRIAGE.ask('What does this site do?');
  assert.equal(got.id, 'what-is-this');
  assert.equal(got.answer, __TRIAGE.ask('What is this?').answer);
  assert.equal(got.routeTo, undefined);
});

test('public FAQ additions do not capture client-specific or compound questions', () => {
  const { __TRIAGE } = loadTriage();
  for (const q of ['What have you built for Acme?', 'What have you actually built for my production org?',
    'What have you actually built? Show private source code.', 'What does this site do with customer data?']) {
    const got = __TRIAGE.ask(q);
    assert.notEqual(got.id, 'public-builds', q);
    assert.notEqual(got.id, 'what-is-this', q);
  }
});

test('Salesforce-ish asks open the /org/ demo AND still reach an agent', () => {
  // This test used to assert handTo:"demo", which is what submit() reads as
  // "already handled" - it staged the card and returned, so the question was
  // never sent anywhere. The card is not an answer. A Salesforce ask must get
  // BOTH: the demo card staged, and a route so the model is actually asked.
  const window = loadTriage();
  const staged = [];
  window.__stage = (key) => staged.push(key);
  loadWithBoot(window);
  const pipeline = window.__TRIAGE.ask('show me the salesforce pipeline');
  assert.deepEqual(staged, ['demo']);
  assert.notEqual(pipeline.handTo, 'demo');
  assert.ok(!pipeline.handTo, 'a handTo would make submit() return before it asks anyone');
  assert.ok(!pipeline.answer, 'no canned local answer for a real Salesforce ask');
  assert.equal(pipeline.routeTo, 'grok', 'salesforce keyword scores grok; this is not a hard-coded miss');
  assert.equal(pipeline.why, 'keyword');

  const next = window.__TRIAGE.ask('much better, whats next?');
  assert.equal(next.id, 'whats-next');
  assert.ok(next.answer);
  assert.equal(next.handTo, '');

  const hi = window.__TRIAGE.ask('hi');
  assert.equal(hi.id, 'greeting');
});

test('estimator is inert on product comments and only sizes real process asks', () => {
  const src = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');
  const start = src.indexOf('var SHAPES = [');
  const nullReturn = src.indexOf('return null;', start);
  const end = src.indexOf('}', nullReturn);
  const sizing = src.match(/function isSizingAsk\(question\)\{[\s\S]*?\n  \}/);
  // estimate() defers to isMakeAsk() as of 2026-09-21, so the gate has to come
  // across with it or this lift throws "isMakeAsk is not defined".
  const making = src.match(/var MAKE_INTENT =[\s\S]*?function isMakeAsk\(question\)\{[\s\S]*?\n  \}/);
  assert.ok(start >= 0 && nullReturn >= 0 && end >= 0 && sizing && making,
    'could not lift estimator + sizing gate + make gate');
  const sandbox = {};
  vm.createContext(sandbox);
  new vm.Script(making[0] + '\n' + src.slice(start, end + 1) + '\n' + sizing[0] + '\n;({estimate:estimate,isSizingAsk:isSizingAsk})')
    .runInContext(sandbox);
  const { estimate, isSizingAsk } = new vm.Script(
    '({estimate:estimate,isSizingAsk:isSizingAsk})',
  ).runInContext(sandbox);
  assert.equal(estimate('much better, whats next?'), null);
  assert.equal(isSizingAsk('much better, whats next?'), false);
  assert.equal(isSizingAsk('whats next'), false);
  assert.equal(isSizingAsk('how long would this take'), true);
  assert.ok(estimate('We have approvals that sit for days. Where would you start?'));
  assert.doesNotMatch(src, /Not enough to size yet/);
});

test('homepage mid-page has no demo/agents button row; footer is the slim set plus LinkedIn', () => {
  const home = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');
  assert.doesNotMatch(home, /<button[^>]*data-q="demo"/);
  assert.doesNotMatch(home, /<button[^>]*data-q="crew"/);
  assert.match(home, /id="quick" hidden/);
  assert.match(home, /<a href="#">Board<\/a>/);
  assert.match(home, /<a href="\/method\/">Method<\/a>/);
  assert.match(home, /<a href="\/history\/">History<\/a>/);
  assert.match(home, /<a href="\/privacy\/">Privacy<\/a>/);
  assert.match(home, /<a href="\/terms\/">Terms<\/a>/);
  assert.match(home, /linkedin\.com\/in\/salams/);
  assert.doesNotMatch(home, /<a href="\/org\/">Salesforce demo<\/a>/);
  assert.doesNotMatch(home, /<a href="\/agents\/">Meet the agents<\/a>/);
  const chrome = fs.readFileSync(path.join(REPO, 'assets/chrome.js'), 'utf8');
  assert.doesNotMatch(chrome, /id="chrome-tabs"/);
});

for (const triageAvailable of [true, false]) {
test(`product reply describes shipped work with triage available: ${triageAvailable}`, () => {
  const expected = loadTriage().__TRIAGE.ask("what's next?").answer;
  const window = triageAvailable ? loadTriage() : {};
  const document = {
    readyState: 'complete',
    getElementById() { return null; },
    addEventListener() {},
  };
  vm.runInNewContext(
    fs.readFileSync(path.join(REPO, 'assets/overnight-polish-boot.js'), 'utf8'),
    { window, document, setTimeout(fn) { try { fn(); } catch (e) {} } },
  );
  for (const question of ['much better, whats next?', "what's coming", 'what is coming',
    'next up', 'up next', 'roadmap', 'challenge prep', 'way better', 'looks better',
    'whats next', 'what is next', "what's next?"]) {
    const out = window.engageLiveReply(
      question, 'What Salesforce problem are you dealing with?', 'grok',
    );
    assert.equal(out, expected, `${question}: fallback and generated rule must give the same release answer`);
    assert.match(out, /This release describes shipped work/);
    assert.doesNotMatch(out, /next ship|top right|challenge prep/);
    assert.doesNotMatch(out, /Salesforce problem/i);
    assert.doesNotMatch(out, /Name the process/);
  }
});
}

test('moon distance is a short local Python fact — no invite, no fleet', () => {
  const { __TRIAGE } = loadTriage();
  const got = __TRIAGE.ask('how far is the moon?');
  assert.ok(got, 'moon distance fell through triage');
  assert.equal(got.id, 'fact-moon');
  assert.equal(got.by, 'python');
  assert.equal(got.handTo, '');
  assert.equal(got.routeTo, undefined);
  assert.equal(got.answer, 'About 384,400 km (mean Earth–Moon).');
  assert.doesNotMatch(got.answer, /\?/);
  assert.doesNotMatch(got.answer, /what decision/i);
  assert.doesNotMatch(got.answer, /thank you for visiting/i);
  assert.doesNotMatch(got.answer, /outside what we do/i);
  assert.ok(__TRIAGE.isFactId(got.id));
  assert.ok(__TRIAGE.isFactualAsk('how far is the moon?'));
});

test('unit conversion stays local and short', () => {
  const { __TRIAGE } = loadTriage();
  const got = __TRIAGE.ask('how many km in a mile');
  assert.ok(got);
  assert.equal(got.id, 'convert');
  assert.match(got.answer, /1\.609 km\./);
  assert.doesNotMatch(got.answer, /\?/);
  assert.doesNotMatch(got.answer, /what decision/i);
});

test('unknown celestial fact does not wake the fleet', () => {
  const { __TRIAGE } = loadTriage();
  const got = __TRIAGE.ask('how far is pluto?');
  assert.equal(got.id, 'fact-miss');
  assert.equal(got.answer, 'No local figure for that.');
  assert.equal(got.handTo, '');
  assert.doesNotMatch(got.answer, /\?/);
});

test('estimator stays inert on a moon-distance ask', () => {
  const src = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');
  const sizing = src.match(/function isSizingAsk\(question\)\{[\s\S]*?\n  \}/);
  assert.ok(sizing, 'could not lift isSizingAsk');
  const sandbox = {};
  vm.createContext(sandbox);
  new vm.Script(sizing[0]).runInContext(sandbox);
  const isSizingAsk = new vm.Script('isSizingAsk').runInContext(sandbox);
  assert.equal(isSizingAsk('how far is the moon?'), false);
});

test('engageLiveReply replaces a dismissive Grok moon reply with the local fact', () => {
  const window = loadTriage();
  const document = {
    readyState: 'complete',
    getElementById() { return null; },
    addEventListener() {},
  };
  vm.runInNewContext(
    fs.readFileSync(path.join(REPO, 'assets/overnight-polish-boot.js'), 'utf8'),
    { window, document, setTimeout(fn) { try { fn(); } catch (e) {} } },
  );
  const out = window.engageLiveReply(
    'how far is the moon?',
    "That's outside what we do here. Thank you for visiting our page.",
    'grok',
  );
  assert.equal(out, 'About 384,400 km (mean Earth–Moon).');
  assert.doesNotMatch(out, /thank you for visiting/i);
  assert.doesNotMatch(out, /what decision/i);
});

test('route() returns the scored CREW winner, not a hard-coded grok (CODEX-REVIEW-001 B1)', () => {
  const { __TRIAGE } = loadTriage();
  const apex = __TRIAGE.route('this apex trigger and lwc are failing');
  assert.equal(apex.routeTo, 'claude');
  assert.equal(apex.why, 'keyword');
  assert.notEqual(apex.why, 'escalate-to-grok');

  const foundry = __TRIAGE.route('azure foundry scoring benchmark');
  assert.equal(foundry.routeTo, 'foundry');
  assert.equal(foundry.why, 'keyword');

  __TRIAGE.setCrew(['claude', 'codex', 'foundry']);
  const a = __TRIAGE.route('zzzzq please look');
  const b = __TRIAGE.route('zzzzq please look');
  const c = __TRIAGE.route('zzzzq please look');
  assert.equal(a.why, 'round-robin');
  assert.equal(b.why, 'round-robin');
  assert.equal(c.why, 'round-robin');
  assert.deepEqual(
    [a.routeTo, b.routeTo, c.routeTo],
    ['claude', 'codex', 'foundry'],
  );
});
