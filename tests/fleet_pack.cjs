const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fleet = require('../assets/fleet-pack.js');
const charts = require('../assets/delivery-fleet.js');

const root = path.join(__dirname, '..');

test('week-over-week change is the difference of published counts', () => {
  const rows = [{ prs_merged_total: 0 }, { prs_merged_total: 90 }, { prs_merged_total: 126 }];
  assert.deepEqual(charts.delta(rows, 'prs_merged_total'), [null, 90, 36]);
});

test('the executive page names seats, and the pack source field is not rendered', () => {
  assert.equal(charts.seat('Claude'), 'Clay');
  assert.equal(charts.seat('Grok'), 'Greg');
  assert.equal(charts.repo('sfdc-24/Blackboard'), 'board');
  const raw = JSON.parse(fs.readFileSync(path.join(root, 'data/fleet-pack/milestones.json'), 'utf8'));
  const shown = fleet.strip(raw);
  assert.equal(JSON.stringify(shown).includes('source'), false);
  const totals = fleet.strip(JSON.parse(fs.readFileSync(path.join(root, 'data/fleet-pack/totals.json'), 'utf8')));
  assert.equal(totals.board_rows_by_phase, undefined);
  assert.equal(totals.board_rows_by_agent, undefined);
  assert.equal(typeof totals.prs_merged_total, 'number');
});
