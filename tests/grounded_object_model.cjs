/*
  THE GROUNDED SERIALIZED-INVENTORY FACTS, AND WHAT THEY STEAL.

  WHY THIS SUITE EXISTS
    PR129's local answer and this suite both denied ProductItem.SerialNumber.
    That was independently reproduced and contradicted by the documented
    standard field. The old seven-question score was withdrawn, and generic
    questions do not establish a particular client's Flow root cause.
    Official reference URLs and the verification date are in triage.py.

  WHY THE SECOND HALF OF THIS FILE IS THE IMPORTANT HALF
    A local answer can be the wrong answer. #124 shipped a page that answered
    questions nobody asked because a keyword anywhere in a sentence fired a
    rule, and of 30 realistic decision questions 11 were intercepted by a
    canned answer. So this suite does not only assert that the new rules FIRE.
    It asserts what they must NOT touch - because the failure mode of a fact
    table is not silence, it is a confident answer to a different question.
*/
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const REPO = path.resolve(__dirname, '..');

function triage() {
  const window = {};
  vm.runInNewContext(
    fs.readFileSync(path.join(REPO, 'assets/triage.js'), 'utf8'),
    { window },
  );
  assert.ok(window.__TRIAGE && typeof window.__TRIAGE.ask === 'function',
    'triage.js did not expose __TRIAGE.ask - was it regenerated?');
  return window.__TRIAGE;
}

const T = triage();
const ask = (q) => T.ask(q);
const idOf = (q) => { const r = ask(q); return r ? r.id : null; };

/* ------------------------------------------------- the facts themselves --- */

test('the generic object comparison names the conditions, not a universal choice', () => {
  const r = ask('Asset or SerializedProduct for a serial number lookup on a Work Order?');
  assert.ok(r, 'no local answer - this question reaches the model again');
  assert.equal(r.id, 'fact-serial-object');
  assert.match(r.answer, /V1.*ProductItem\.SerialNumber/);
  assert.match(r.answer, /V2.*SerializedProduct\.SerialNumber/);
  assert.match(r.answer, /Asset\.SerialNumber/);
  assert.match(r.answer, /does not establish/);
  assert.doesNotMatch(r.answer, /^(?:Asset|SerializedProduct)\./);
  assert.equal(r.by, 'python');
  assert.equal(r.handTo, '');
});

test('a particular Flow fault is not diagnosed by a generic inventory fact', () => {
  const r = ask('Our Visual Flow on Work Order cannot pull the serial number. Where should it be looking?');
  assert.equal(r.id, 'route');
  assert.equal(r.answer, '');
  assert.ok(r.routeTo);
});

test('the bounded standard-object definitions are answered locally', () => {
  const cases = [
    ['Asset or SerializedProduct for a serial number lookup on a Work Order?', 'fact-serial-object'],
    ['What object holds on-hand serial numbers?', 'fact-serial-object'],
    ['Does ProductItem have a SerialNumber field?', 'fact-productitem-serial'],
    ['What is the difference between Product2 and SerializedProduct?', 'fact-product2-serialized'],
    ['Product Requisition line or the product transfer for choosing which serial goes out?', 'fact-serial-transfer'],
  ];
  for (const [q, want] of cases) {
    assert.equal(idOf(q), want, `"${q}" should be answered by ${want}`);
  }
});

test('ProductItem has the documented serial field and quantity-one restriction', () => {
  for (const q of [
    'Does ProductItem have a SerialNumber field?',
    'Does Product Item have a standard Serial Number field?',
    'Is SerialNumber a standard field on ProductItem?',
    'What field on ProductItem holds the serial number?',
  ]) {
    const r = ask(q);
    assert.equal(r.id, 'fact-productitem-serial', q);
    assert.match(r.answer, /^Yes\./);
    assert.match(r.answer, /standard SerialNumber field/);
    assert.match(r.answer, /QuantityOnHand must be 1/);
    assert.match(r.answer, /V2.*SerializedProduct/);
    assert.match(r.answer, /does not remove ProductItem\.SerialNumber/);
    assert.match(r.answer, /Reference: Product Item and Inventory Fields/);
  }
});

test('V2 transfers allow multiple units, rather than exactly one', () => {
  const r = ask('Requisition line or product transfer for which serial goes out?');
  assert.match(r.answer, /V2/);
  assert.match(r.answer, /Product Transfer State/);
  assert.match(r.answer, /multiple serialized units of the same product/);
  assert.doesNotMatch(r.answer, /one specific/);
});

test('the facts are facts: no question mark, no invite, no handoff', () => {
  // Doctrine for the python gate: one short answer, no "what decision are you
  // facing?" after it, no fleet. A fact that asks a question back is a
  // conversation, and conversations belong to the model.
  for (const id of ['fact-serial-object', 'fact-productitem-serial',
                    'fact-product2-serialized', 'fact-serial-transfer']) {
    const q = {
      'fact-serial-object': 'What object holds on-hand serial numbers?',
      'fact-productitem-serial': 'Does ProductItem have a SerialNumber field?',
      'fact-product2-serialized': 'What is the difference between Product2 and SerializedProduct?',
      'fact-serial-transfer': 'Requisition line or product transfer for which serial goes out?',
    }[id];
    const r = ask(q);
    assert.equal(r.id, id);
    assert.doesNotMatch(r.answer, /\?/, `${id} asks a question back`);
    assert.equal(r.handTo, '', `${id} hands off`);
    assert.ok(r.answer.length > 40, `${id} is too short to be useful`);
    assert.match(r.answer, /References?: /, `${id} has no named reference`);
  }
});

test('nothing asserts a Status picklist value, because none was verified', () => {
  // The definitions were confirmed against published reference material. The
  // picklist members were NOT, and an unverified picklist value is the same
  // class of error this block exists to stop.
  const all = ['What object holds on-hand serial numbers?',
               'Does ProductItem have a SerialNumber field?',
               'What is the difference between Product2 and SerializedProduct?',
               'Requisition line or product transfer for which serial goes out?']
    .map((q) => ask(q).answer).join(' ');
  assert.doesNotMatch(all, /\bAssigned\b/);
  assert.doesNotMatch(all, /\bConsumed\b/);
  assert.doesNotMatch(all, /Status\s*=\s*Available/);
});

/* ------------------------------------------ what they must NOT steal ------ */

test('WHAT IT STEALS: none of these reach a canned answer', () => {
  // Every one of these is a real question a Salesforce visitor could type, and
  // every one of them deserves an agent rather than a fact about inventory.
  // A miss here means the fact table has started intercepting the work.
  const mustNotHitTheNewFacts = [
    'What assets do you have?',
    'Should we buy a digital asset management tool or build one?',
    'Asset or Contract as the parent for our subscriptions?',
    'How do we serialize JSON in Apex?',
    'Our asset hierarchy is four levels deep and reporting is slow.',
    'Should we split the org or keep one?',
    'Which is better for lead assignment, Apex trigger or Flow?',
    'Person accounts or standard accounts for our members?',
    'What does a validation rule do?',
    'Our Flow is hitting governor limits on a bulk update.',
    'Can you show me something you have actually built?',
    'How much does the first piece of work cost?',
    'Asset management or preventive maintenance first?',
    'Should we hire an admin or use a partner?',
    'The serial number field is a text field. Should we index it?',
  ];
  const ours = new Set(['fact-serial-object', 'fact-productitem-serial',
                        'fact-product2-serialized', 'fact-serial-transfer']);
  const stolen = [];
  for (const q of mustNotHitTheNewFacts) {
    const id = idOf(q);
    if (id && ours.has(id)) stolen.push(`${q}  ->  ${id}`);
  }
  assert.deepEqual(stolen, [],
    'the new facts intercepted questions that are not about serialized inventory:\n  '
    + stolen.join('\n  '));
});

test('WHAT IT STEALS: the trivia gate and the converter are untouched', () => {
  assert.equal(idOf('how far is the moon?'), 'fact-moon');
  assert.equal(idOf('how many km in a mile'), 'convert');
  assert.equal(idOf('what is the speed of light?'), 'fact-light');
});

test('unrelated fields, serialization verbs, client configuration and compound work retain a route', () => {
  const questions = [
    'Does ProductItem have a LocationId field?',
    'Does ProductItem store QuantityOnHand?',
    'How do I serialize Product2 to JSON?',
    'How do I serialize Product2 to JSON in Apex?',
    'Should we use an Asset or serialize JSON in Apex?',
    'Asset or JSON serialization for an API?',
    'Which serial ports should our device use before it ships?',
    'What object holds serial numbers for installed customer equipment?',
    'Query Asset serial numbers for installed equipment',
    'Where should a custom serial number field be stored?',
    'Where does Status = Available live for a serialized unit?',
    'Does ProductItem have a SerialNumber field? Also explain Apex permissions.',
    'Does ProductItem have a SerialNumber field and should we migrate our data?',
    'What is the difference between Product2 and SerializedProduct? Build the migration.',
    'Asset or SerializedProduct for a serial number lookup on a Work Order? Diagnose our Flow.',
  ];
  for (const q of questions) {
    const r = ask(q);
    assert.equal(r.id, 'route', q);
    assert.equal(r.answer, '', q);
    assert.equal(r.handTo, '', q);
    assert.ok(r.routeTo, q);
  }
});

test('WHAT IT STEALS: a bare greeting is still a greeting', () => {
  assert.equal(idOf('hi'), 'greeting');
  assert.equal(idOf('thanks'), 'thanks');
});

/* ------------------------------------------------- wiring, not behaviour -- */

test('the generated file is in step with the rules that made it', () => {
  // The generator is the source of truth and triage.js is its output. A rule
  // edited without regenerating ships a page whose answers are a version
  // behind, and nothing else in this repo would notice.
  const py = fs.readFileSync(path.join(REPO, 'assets/triage.py'), 'utf8');
  const js = fs.readFileSync(path.join(REPO, 'assets/triage.js'), 'utf8');
  for (const id of ['fact-serial-object', 'fact-productitem-serial',
                    'fact-product2-serialized', 'fact-serial-transfer']) {
    assert.ok(py.includes(id), `${id} missing from triage.py`);
    assert.ok(js.includes(id),
      `${id} is in triage.py but not triage.js - run: python3 assets/triage.py`);
  }
});

/* ------------------------------- who takes a question, and who can answer -- */

test('Salesforce and CRM go to claude; other technical goes to codex', () => {
  // Mr Salam, 2026-09-23: "you should ideally be taking on any salesforce or CRM
  // related questions and Codex can perhaps take on other technical questions".
  for (const q of ['our validation rule fires on every record type we own',
                   'this apex trigger and lwc are failing after deployment',
                   'can you help with our crm migration']) {
    const r = T.route(q);
    assert.equal(r.routeTo, 'claude', `${q} -> ${r.routeTo}`);
    assert.equal(r.why, 'keyword');
  }
  for (const q of ['there is a bug in the typescript in our github repo',
                   'the playwright test suite is failing on the pull request']) {
    const r = T.route(q);
    assert.equal(r.routeTo, 'codex', `${q} -> ${r.routeTo}`);
    assert.equal(r.why, 'keyword');
  }
});

test('the production router exposes exactly Claude and Codex', () => {
  const seen = new Set();
  for (let i = 0; i < 40; i++) {
    seen.add(T.route('a sentence with no routable keyword in it at all ' + i).routeTo);
  }
  assert.deepEqual([...seen], ['codex']);
  for (const q of ['what should our pricing and positioning be',
                   'what is our product roadmap and market strategy']) {
    assert.equal(T.route(q).routeTo, 'codex', q);
  }
});

test('retired providers are absent from source and generated routing data', () => {
  const py = fs.readFileSync(path.join(REPO, 'assets/triage.py'), 'utf8');
  assert.match(py, /CREW_DEFAULT = \["claude", "codex"\]/);
  assert.doesNotMatch(py, /"(?:grok|foundry|gemini)":\s*\[/);
  const js = fs.readFileSync(path.join(REPO, 'assets/triage.js'), 'utf8');
  assert.match(js, /"crew":\s*\[\s*"claude",\s*"codex"\s*\]/);
  assert.match(js, /"unavailable":\s*\[\s*\]/);
});

test('only two agents can actually answer on this endpoint, and it says so', () => {
  // THE HONEST LIMIT. Routing names who a question is FOR. The /exec endpoint
  // holds exactly two provider credentials and the reply says `by`.
  const html = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');
  const m = html.match(/var SERVABLE = \{([^}]*)\}/);
  assert.ok(m, 'SERVABLE is gone - has the hint mapping moved?');
  const names = [...m[1].matchAll(/(\w+)\s*:/g)].map((x) => x[1]).sort();
  assert.deepEqual(names, ['claude', 'codex']);
  assert.match(html, /\|\| "claude"/,
    'an unservable route must fall back to claude, not to nothing');
});
