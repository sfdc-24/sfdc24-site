const { test } = require('node:test');
const assert = require('node:assert/strict');
const milestones = require('../assets/release-milestones.js');
const fleet = require('../assets/fleet-pack.js');

test('the header selects the first milestone that has not passed', () => {
  const doc = { milestones: [
    { id: 'V3', label: 'V3 retest', at: '2026-11-12T10:00:00-05:00', status: 'passed' },
    { id: 'V6', label: 'V6', at: null, status: 'planned' },
  ] };
  assert.equal(milestones.selectCurrent(doc).id, 'V6');
  assert.equal(milestones.selectCurrent({ milestones: [] }), null);
});

test('a missing date is the label only, and zero says Releasing now without passing', () => {
  const row = { id: 'V3', label: 'V3 retest', at: null, status: 'planned' };
  assert.deepEqual(milestones.displayState(row, Date.parse('2026-11-12T15:00:00Z')).mode, 'label');
  const dated = { id: 'V3', label: 'V3 retest', at: '2026-11-12T10:00:00-05:00', status: 'planned' };
  const at = Date.parse(dated.at);
  assert.equal(milestones.displayState(dated, at - 1000).mode, 'countdown');
  const due = milestones.displayState(dated, at);
  assert.equal(due.mode, 'releasing');
  assert.equal(due.label, 'Releasing now');
  assert.equal(dated.status, 'planned');
  assert.equal(milestones.displayState(null, at).mode, 'none');
});

test('fleet pack publication drops source and board-row counts', () => {
  const cleaned = fleet.strip({
    milestones: [{ id: 'V3', label: 'V3 retest', source: 'internal thread' }],
    board_rows_by_phase: { build: 3 },
    agents: { clay: { board_rows: 4, opened: 2 } },
  });
  assert.equal(JSON.stringify(cleaned).includes('source'), false);
  assert.equal(JSON.stringify(cleaned).includes('board_rows'), false);
  assert.equal(cleaned.milestones[0].label, 'V3 retest');
  assert.equal(cleaned.agents.clay.opened, 2);
});
