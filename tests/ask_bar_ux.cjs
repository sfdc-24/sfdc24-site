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
    assert.match(got.answer, /Release \(top right\)/);
    assert.match(got.answer, /History/);
    assert.match(got.answer, /Method/);
    assert.match(got.answer, /challenge prep/);
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

test('Salesforce-ish asks hand to the /org/ demo after local rules miss', () => {
  const window = loadTriage();
  loadWithBoot(window);
  const pipeline = window.__TRIAGE.ask('show me the salesforce pipeline');
  assert.equal(pipeline.id, 'sf-desk');
  assert.equal(pipeline.handTo, 'demo');
  assert.equal(pipeline.answer, '');

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
  assert.ok(start >= 0 && nullReturn >= 0 && end >= 0 && sizing, 'could not lift estimator + sizing gate');
  const sandbox = {};
  vm.createContext(sandbox);
  new vm.Script(src.slice(start, end + 1) + '\n' + sizing[0] + '\n;({estimate:estimate,isSizingAsk:isSizingAsk})')
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

test('Grok engage rewrites a Salesforce-default reply on a product comment', () => {
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
    'much better, whats next?',
    'What Salesforce problem are you dealing with?',
    'grok',
  );
  assert.match(out, /Release \(top right\)/);
  assert.doesNotMatch(out, /Salesforce problem/i);
  assert.doesNotMatch(out, /Name the process/);
});
