const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const counts = require('../assets/delivery-counts.js');

const REPO = path.join(__dirname, '..');
const SNAP = JSON.parse(fs.readFileSync(path.join(REPO, 'data/ops-delivery.json'), 'utf8'));

test('the published snapshot is older than 36 hours and must not paint counts', () => {
  const now = Date.parse('2026-10-07T21:00:00Z');
  const view = counts.render(SNAP, now);
  assert.equal(view.fresh, false);
  assert.equal(view.status, 'Not yet refreshed.');
  assert.equal(view.sheet, 'Not yet refreshed.');
  assert.equal(view.sheetOps, 'Not yet refreshed.');
  assert.deepEqual(view.projects, {});
  assert.equal(JSON.stringify(view).includes(SNAP.observed_at), false);
  assert.equal(/\d/.test(view.sheetOps), false);
});

test('a snapshot inside 36 hours renders Sheet counts from the file', () => {
  const observed = '2026-10-07T20:00:00Z';
  const raw = {
    schema_version: 1,
    observed_at: observed,
    items: [
      {project: 'Conference', stage: 'production', status: 'verified'},
      {project: 'Conference', stage: 'staging', status: 'pending'},
      {project: 'Conference', stage: 'test', status: 'blocked'},
      {project: 'SFDC24', stage: 'production', status: 'verified'},
    ],
  };
  const view = counts.render(raw, Date.parse('2026-10-07T21:00:00Z'));
  assert.equal(view.fresh, true);
  assert.equal(view.status, 'Observed 2026-10-07T20:00:00Z.');
  assert.equal(view.sheetOps, '4 delivery rows. 2 landed (production and verified). 2 not landed. 1 blocked.');
  assert.equal(
    view.sheet,
    '4 rows. 2 landed. 2 not landed. 1 blocked. Conference 2 in progress and 1 landed. SFDC24 0 in progress and 1 landed.'
  );
  assert.equal(view.projects.Conference, '2 in progress · 1 landed');
  assert.equal(view.projects.SFDC24, '0 in progress · 1 landed');
});

test('36 hours is the boundary', () => {
  const observed = '2026-10-06T00:00:00Z';
  const raw = {schema_version: 1, observed_at: observed, items: [{project: 'Platform', stage: 'production', status: 'verified'}]};
  const born = Date.parse(observed);
  assert.equal(counts.render(raw, born + counts.MAX_AGE_MS - 1).fresh, true);
  assert.equal(counts.render(raw, born + counts.MAX_AGE_MS).fresh, false);
  assert.equal(counts.MAX_AGE_MS, 36 * 60 * 60 * 1000);
});

test('missing or broken data is not yet refreshed', () => {
  assert.equal(counts.render(null, Date.now()).status, 'Not yet refreshed.');
  assert.equal(counts.render({schema_version: 1, observed_at: 'nope', items: []}, Date.now()).fresh, false);
  assert.equal(counts.render({schema_version: 2, observed_at: '2026-10-07T20:00:00Z', items: []}, Date.now()).fresh, false);
});

test('static pages do not freeze the snapshot date or the Sheet counts', () => {
  const pages = ['ops/index.html', 'process/index.html'].map(function (rel) {
    return fs.readFileSync(path.join(REPO, rel), 'utf8');
  });
  const script = fs.readFileSync(path.join(REPO, 'assets/delivery-counts.js'), 'utf8');
  for (const page of pages) {
    assert.equal(page.includes(SNAP.observed_at), false);
    assert.equal(page.includes('25 delivery rows'), false);
    assert.equal(page.includes('25 rows'), false);
    assert.equal(page.includes('13 landed'), false);
    assert.equal(page.includes('Not yet refreshed.'), true);
    assert.equal(page.includes('data-delivery-counts'), true);
    assert.equal(page.includes('/assets/delivery-counts.js'), true);
    assert.equal(page.includes('No Redis count'), true);
  }
  assert.equal(script.includes(SNAP.observed_at), false);
  assert.equal(script.includes('25 delivery rows'), false);
  assert.equal(script.includes('redis://'), false);
});
