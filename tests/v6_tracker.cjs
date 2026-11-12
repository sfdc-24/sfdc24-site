const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const tracker = require('../assets/v6-tracker.js');

const doc = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data/v6-tracker.json'), 'utf8'));

test('counters are the rows, and the public text keeps task ids only', () => {
  const tally = tracker.counts(doc);
  assert.equal(tally['Done'], 1);
  assert.equal(tally['Built, not merged'], 24);
  assert.equal(tally['In progress'], 2);
  assert.equal(tally.Waiting, 4);
  assert.equal(tally.Rework, 1);
  assert.equal(tally['Not started'], 25);
  assert.equal(tally.total, 57);
  assert.equal(doc.as_of, 'Status at 12:20 am ET, Thu Nov 12 2026');
  const raw = JSON.stringify(doc);
  assert.equal(/\bYou\b/.test(raw), false);
  assert.equal(/Case\s*0+\d+/i.test(raw), false);
  assert.equal(/#\d+/.test(raw), false);
  assert.equal(/\b[0-9a-f]{40}\b/.test(raw), false);
  assert.match(raw, /G30/);
  assert.equal(tracker.sanitize('See You about Case 00001024 and #428 and abcdef0123456789abcdef0123456789abcdef01'),
    'See Owner about and and');
});

test('due times land on the Toronto day named in the row', () => {
  assert.equal(new Date(tracker.parseDue('~12:45 am Thu')).toISOString(), '2026-11-12T05:45:00.000Z');
  assert.equal(new Date(tracker.parseDue('Wed 23:30')).toISOString(), '2026-11-12T04:30:00.000Z');
  assert.equal(new Date(tracker.parseDue('Sat 06:30')).toISOString(), '2026-11-14T11:30:00.000Z');
  assert.equal(tracker.burndown(doc).length > 1, true);
});
