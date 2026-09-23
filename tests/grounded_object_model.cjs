/*
  THE GROUNDED SERIALIZED-INVENTORY FACTS, AND WHAT THEY STEAL.

  WHY THIS SUITE EXISTS
    On 2026-09-22 seven questions from a live client case (Access Haiti: a
    Visual Flow on Work Order that cannot pull a serial number) were put to the
    live page. Six came back wrong, confidently, each with a reason attached -
    including "the Asset object, on the field SerialNumber", which is the
    client's actual bug. Mr Salam's ruling was "ground it": answer the bounded
    set of checkable facts locally, before any model call.

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

test('the question that started this answers SerializedProduct, not Asset', () => {
  const r = ask('Asset or SerializedProduct for a serial number lookup on a Work Order?');
  assert.ok(r, 'no local answer - this question reaches the model again');
  assert.equal(r.id, 'fact-serial-object');
  assert.match(r.answer, /^SerializedProduct\./);
  assert.equal(r.by, 'python');
  assert.equal(r.handTo, '');
});

test('the client\'s own phrasing lands on the same fact', () => {
  // Verbatim shape of what the Flow question looked like on the call.
  const r = ask('Our Visual Flow on Work Order cannot pull the serial number. Where should it be looking?');
  assert.ok(r, 'the client question still reaches the model');
  assert.equal(r.id, 'fact-serial-object');
  assert.doesNotMatch(r.answer, /^Asset\b/,
    'the page must not open with Asset - that is the defect it was asked about');
});

test('every wrong answer measured on 2026-09-22 is now answered locally', () => {
  const cases = [
    ['Asset or SerializedProduct for a serial number lookup on a Work Order?', 'fact-serial-object'],
    ['What object holds on-hand serial numbers?', 'fact-serial-object'],
    ['Where does Status = Available live for a serialized unit?', 'fact-serial-object'],
    ['Does ProductItem have a SerialNumber field?', 'fact-productitem-serial'],
    ['What is the difference between Product2 and SerializedProduct?', 'fact-product2-serialized'],
    ['Product Requisition line or the product transfer for choosing which serial goes out?', 'fact-serial-transfer'],
  ];
  for (const [q, want] of cases) {
    assert.equal(idOf(q), want, `"${q}" should be answered by ${want}`);
  }
});

test('ProductItem does not hold the serial, and the answer says so first', () => {
  const r = ask('Does ProductItem have a SerialNumber field?');
  assert.match(r.answer, /^No\./);
  assert.match(r.answer, /SerializedProduct/);
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
