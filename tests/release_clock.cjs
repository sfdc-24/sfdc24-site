// Countdown decisions, without a browser. The chip counts down only while
// data/next-release.json (or an explicit ISO) is still in the future. A past
// instant must become "to be announced", never a frozen 00:00:00 or a +elapsed clock.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const clock = require('../assets/next-deploy.js');

const PAST = '2026-09-29T13:00:00Z';
const NOW = Date.parse('2026-10-09T12:20:00Z');

test('a future release ticks, labels Eastern Time, and rolls over the minute', () => {
  const start = Date.parse('2026-09-21T04:00:00Z');
  const at = '2026-09-21T04:01:00.000Z';
  const first = clock.releaseView(start, at, 'Minute boundary');
  const next = clock.releaseView(start + 1000, at, 'Minute boundary');
  assert.equal(first.phase, 'countdown');
  assert.equal(first.remaining, '00:01:00');
  assert.equal(next.remaining, '00:00:59');
  assert.notEqual(next.remaining, first.remaining);
  assert.equal(first.when, 'Sep 21, 12:01 AM ET');
  assert.match(first.when, / ET$/);
  assert.equal(first.label, 'Time remaining until Sep 21, 12:01 AM ET');
  assert.equal(clock.formatEt(Date.parse(PAST)), 'Sep 29, 9:00 AM ET');
});

test('crossing the release instant announces instead of freezing at 00:00:00', () => {
  const at = '2026-09-21T04:01:00.000Z';
  const end = Date.parse(at);
  const last = clock.releaseView(end - 1000, at, 'Minute boundary');
  const rolled = clock.releaseView(end, at, 'Minute boundary');
  const later = clock.releaseView(end + 5000, at, 'Minute boundary');
  assert.equal(last.remaining, '00:00:01');
  assert.equal(rolled.phase, 'unset');
  assert.equal(rolled.remaining, '--:--');
  assert.equal(rolled.sentence, clock.TBA);
  assert.equal(rolled.when, '');
  assert.equal(later.remaining, '--:--');
  assert.doesNotMatch(rolled.remaining, /00:00:00/);
  assert.doesNotMatch(rolled.sentence, /Sep 21|12:01|\+/);
});

test('the Sep 29 morning checkpoint is not left on the chip', () => {
  const view = clock.releaseView(NOW, PAST, 'Next: morning checkpoint');
  assert.equal(view.phase, 'unset');
  assert.equal(view.sentence, 'Next release: to be announced');
  assert.equal(view.remaining, '--:--');
  assert.equal(view.when, '');
  assert.doesNotMatch(view.sentence + view.when + view.remaining, /Sep 29|9:00|13:00|\+240|00:00:00/);
  const still = clock.releaseView(NOW + 5000, PAST, 'Next: morning checkpoint');
  assert.equal(still.remaining, '--:--');
  assert.equal(still.sentence, view.sentence);
});

test('no scheduled instant stays announced and does not invent a time', () => {
  const view = clock.releaseView(NOW, '', '');
  assert.equal(view.sentence, 'Next release: to be announced');
  assert.equal(view.remaining, '--:--');
  assert.equal(view.when, '');
  const noted = clock.releaseView(NOW, null, 'Studio sign-in pending');
  assert.equal(noted.sentence, 'Studio sign-in pending');
  assert.equal(noted.remaining, '--:--');
});

test('committed next-release data is not a past instant', () => {
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/next-release.json'), 'utf8'));
  assert.equal(typeof data.note, 'string');
  assert.ok(data.note.split(/\s+/).filter(Boolean).length < 10);
  if (data.at == null) {
    assert.equal(data.note, 'Next release: to be announced');
  } else {
    assert.equal(typeof data.at, 'string');
    assert.ok(Number.isFinite(Date.parse(data.at)));
    assert.ok(Date.parse(data.at) > Date.now(), 'data/next-release.json at is already past');
  }
});
