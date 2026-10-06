const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const coord = require('../assets/coord-report.js');

const REPO = path.join(__dirname, '..');
const NOW = '2026-09-30T10:40:26Z';

function row(over) {
  return Object.assign({
    id: 'hear-contributors',
    title: 'Hear all conference contributors',
    project: 'Conference',
    owner: 'Claude',
    next: 'Verify the receiver.',
    stage: 'staging',
    status: 'pending',
    source: 'https://github.com/sfdc-24/conference/pull/28'
  }, over);
}

test('a production verified row is landed and a pending production row is not', () => {
  assert.equal(coord.isLanded(row({stage:'production', status:'verified'})), true);
  assert.equal(coord.isLanded(row({stage:'production', status:'pending'})), false);
  assert.equal(coord.isLanded(row({stage:'test', status:'verified'})), false);
});

test('the rollup groups projects and keeps a bare number out of the snapshot', () => {
  const snap = coord.validateSnapshot({
    schema_version: 1,
    observed_at: NOW,
    items: [
      row(),
      row({id:'landed-gate', title:'Delivery Gantt at the top of Ops', project:'SFDC24', stage:'production', status:'verified', owner:'Grok'}),
      row({id:'ops-repair', title:'Ops refresh, roles and mobile repair', project:'SFDC24', stage:'test', status:'blocked', owner:'Grok'})
    ]
  });
  const rolled = coord.rollup(snap.items);
  assert.equal(rolled.projects.length, 2);
  const sfdc = rolled.projects.find(p => p.project === 'SFDC24');
  assert.equal(sfdc.in_progress.length, 1);
  assert.equal(sfdc.landed.length, 1);
  assert.equal(rolled.blockers[0].title, 'Ops refresh, roles and mobile repair');
  assert.equal(coord.validateSnapshot({schema_version:1, observed_at:NOW, items:[row({title:'#272'})]}), null);
});

test('the flag fails closed and never lets Redis answer', () => {
  assert.equal(coord.parseFlag(null).dual_run, 'off');
  assert.equal(coord.parseFlag({schema:'sfdc24.coord.flag.v1', dual_run:'live', redis_answers:true, api:'https://evil.example/api/coord'}).api, '');
  assert.equal(coord.parseFlag({schema:'sfdc24.coord.flag.v1', dual_run:'live', redis_answers:true, api:'https://evil.example/api/coord'}).redis_answers, false);
  const on = coord.parseFlag({schema:'sfdc24.coord.flag.v1', dual_run:'shadow', api:'/api/coord', site_snapshot:'/data/ops-delivery.json'});
  assert.equal(coord.flagAllowsShadow(on), true);
  assert.deepEqual(coord.endpointsFor(on), {snapshot:'/data/ops-delivery.json', shadow:'/api/coord', control:'/api/coord/controls'});
  assert.deepEqual(coord.endpointsFor(coord.DEFAULT_FLAG), {snapshot:'/data/ops-delivery.json', shadow:'', control:''});
  assert.equal(coord.safeApi('/api/coord?x=1'), '');
  assert.equal(coord.safeDataPath('/etc/passwd', '/data/ops-delivery.json'), '/data/ops-delivery.json');
});

test('a shadow that claims to be authoritative is ignored', () => {
  assert.equal(coord.shadowVerdict({schema:'sfdc24.coord.read.v1', authoritative:true, projects:[], blockers:[]}).state, 'unread');
  assert.equal(coord.shadowVerdict({schema:'sfdc24.coord.read.v1', authoritative:false, projects:[{}], blockers:[]}).state, 'read');
});

test('process rendering names the work and the gate, not a bare number', () => {
  const snap = coord.validateSnapshot({schema_version:1, observed_at:NOW, items:[
    row({id:'ops-repair', title:'Ops refresh, roles and mobile repair', project:'SFDC24', stage:'test', status:'blocked'})
  ]});
  const model = coord.buildModel(snap, coord.DEFAULT_FLAG);
  const html = coord.render(model, 'process', {shadowEnabled:false, controlEnabled:false});
  assert.match(html, /Ops refresh, roles and mobile repair/);
  assert.match(html, /Test · blocked · Claude/);
  assert.match(html, /Redis off/);
  assert.match(html, /Mark a blocker seen/);
  assert.match(html, /disabled/);
  assert.match(html, /Cursor/);
  assert.match(html, /Exact-head review support/);
  assert.doesNotMatch(html, /<p class="coord-title">#\d+</);
  assert.doesNotMatch(html, /REDIS_AUTH|password|Authorization|redis:\/\//i);
  assert.equal(model.redis.attempted, false);
  assert.equal(model.okf.included, false);
});

test('the checked-in snapshot and flag match the adapter', () => {
  const flag = coord.parseFlag(JSON.parse(fs.readFileSync(path.join(REPO, 'data/coord-redis.json'), 'utf8')));
  const snap = coord.validateSnapshot(JSON.parse(fs.readFileSync(path.join(REPO, 'data/ops-delivery.json'), 'utf8')));
  assert.equal(flag.dual_run, 'off');
  assert.equal(flag.api, '');
  assert.ok(snap);
  const model = coord.buildModel(snap, flag);
  const n = coord.counts(model);
  assert.equal(n.in_progress + n.landed, snap.items.length);
  assert.equal(n.blockers, 1);
  assert.ok(n.landed > 0);
  const page = coord.render(model, 'ops', {});
  assert.match(page, /Site snapshot authoritative/);
  assert.match(page, new RegExp(n.in_progress + ' in progress'));
});
