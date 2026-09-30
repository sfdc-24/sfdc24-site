// Delivery claims and refresh behavior, using the shipped asset with no browser/network.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const gantt = require('../assets/ops-gantt.js');
const NOW = Date.parse('2026-09-27T12:00:00Z');
const clone = value => JSON.parse(JSON.stringify(value));

function fixture() {
  return {schema_version:1, observed_at:'2026-09-27T12:00:00Z', items:[
    {id:'build',title:'Build feature',project:'Website',owner:'Codex',assignment:'Implementation',
      stage:'dev',status:'recorded',next:'Complete independent review',evidence:'Source change only',
      observed_at:'2026-09-27T12:00:00Z',source:'https://github.com/sfdc-24/sfdc24-site/pull/200',
      periods:[{stage:'dev',kind:'actual',start:'2026-09-27T10:00:00Z',end:'2026-09-27T11:00:00Z'},
        {stage:'test',kind:'planned',start:'2026-09-28T10:00:00Z',end:'2026-09-28T11:00:00Z'}]},
    {id:'parked',title:'Parked integration',project:'Integration',owner:'Unassigned',assignment:'Unassigned',
      stage:'backlog',status:'pending',next:'Assign an owner and date',evidence:'No dated evidence',
      observed_at:'2026-09-27T11:00:00Z',source:'https://www.sfdc24.com/ops/',periods:[]}
  ]};
}

test('recorded and planned intervals remain distinct, and undated work receives no invented bar', () => {
  const snap = gantt.validate(fixture(), NOW);
  const config = gantt.chartConfig(snap.items);
  assert.equal(config.data.datasets.length, 2);
  const actual = config.data.datasets.find(x => /recorded/.test(x.label));
  const planned = config.data.datasets.find(x => /planned/.test(x.label));
  assert.notEqual(actual.backgroundColor, planned.backgroundColor);
  assert.deepEqual(actual.data[0].x, [Date.parse('2026-09-27T10:00:00Z'),Date.parse('2026-09-27T11:00:00Z')]);
  assert.equal(config.options.scales.y.type, 'category');
  assert.deepEqual(config.data.labels, ['build', 'parked']);
  assert.equal(config.options.scales.y.ticks.callback(0), 'Build feature · Codex');
  assert.equal(config.options.scales.y.ticks.callback(1), 'Parked integration · Unassigned');
  assert.ok(config.data.datasets.every(x => x.data.every(p => p.y === 'build' && p.row === 0)));
  assert.equal(config.options.plugins.tooltip.callbacks.title([{raw:actual.data[0]}]), 'Build feature');
  const rows = gantt.renderRows(snap.items, NOW);
  assert.match(rows, /Recorded Development/);
  assert.match(rows, /Planned Test/);
  assert.match(rows, /Dates not scheduled \/ not evidenced/);
  assert.match(rows, /Unassigned/);
});

test('five stages and combined owner/project/stage filters preserve exact matches', () => {
  assert.deepEqual(gantt.STAGES, ['backlog','dev','staging','test','production']);
  const items = gantt.validate(fixture(), NOW).items;
  assert.equal(gantt.select(items, {}).length, 2);
  assert.deepEqual(gantt.select(items, {owner:'Codex',project:'Website',stage:'dev'}).map(x=>x.id), ['build']);
  assert.equal(gantt.select(items, {owner:'Codex',project:'Integration'}).length, 0);
  assert.match(gantt.renderRows(gantt.select(items, {stage:'production'}), NOW), /No work items match/);
});

test('same title and owner in distinct projects retain separate categorical rows',()=>{
  const raw=fixture();
  const third=clone(raw.items[0]);
  third.id='second-build';third.project='Another project';
  third.periods=[{stage:'staging',kind:'actual',start:'2026-09-27T10:00:00Z',end:'2026-09-27T11:00:00Z'}];
  raw.items.push(third);
  const config=gantt.chartConfig(gantt.validate(raw,NOW).items);
  const point=config.data.datasets.find(x=>/Staging/.test(x.label)).data[0];
  assert.equal(config.data.labels.length,new Set(config.data.labels).size);
  assert.equal(config.data.labels.indexOf(point.y),2);
  assert.equal(point.row,2);
  assert.equal(config.options.scales.y.ticks.callback(2),'Build feature · Codex');
});

test('merge flags and unknown payload fields cannot manufacture production evidence', () => {
  const raw = fixture();
  Object.assign(raw.items[0], {merged:true,deployed:true,token:'should-not-survive',body:'private-body'});
  const snap = gantt.validate(raw, NOW);
  assert.equal(snap.items[0].stage, 'dev');
  assert.equal(snap.items[0].periods.some(x=>x.stage === 'production'), false);
  assert.doesNotMatch(JSON.stringify(snap), /should-not-survive|private-body|merged|deployed/);
  assert.doesNotMatch(gantt.renderRows(snap.items, NOW), /Production/);
});

test('schema, calendar dates, duplicate IDs, and dishonest actual intervals are refused', () => {
  const mutations = [
    x => { x.schema_version = 2; },
    x => { x.observed_at = '2026-02-30T00:00:00Z'; x.items = []; },
    x => { x.observed_at = '2026-09-27T13:00:00Z'; },
    x => { x.items[1].id = x.items[0].id; },
    x => { x.items[0].stage = 'merged'; },
    x => { x.items[0].observed_at = '2026-09-27T12:00:01Z'; },
    x => { x.items[0].periods[0].start = '2026-09-27T11:00:01Z'; },
    x => { x.items[0].periods[0].end = '2026-09-28T11:00:00Z'; },
    x => { x.items[0].periods[0].kind = 'estimated-actual'; },
    x => { x.items[0].periods[0].start = '2026-02-30T10:00:00Z'; },
  ];
  mutations.forEach((mutate,i)=>{ const raw=fixture(); mutate(raw); assert.throws(()=>gantt.validate(raw,NOW), undefined, 'mutation '+i); });
});

test('links reject executable, deceptive, credentialed and nonstandard origins', () => {
  for (const url of ['javascript:alert(1)','data:text/html,hello','//github.com/sfdc-24/x',
    'http://github.com/sfdc-24/x','https://github.com.evil.invalid/sfdc-24/x',
    'https://github.com@evil.invalid/sfdc-24/x','https://user:pass@github.com/sfdc-24/x',
    'https://github.com/another-org/repo','https://github.com:444/sfdc-24/x',
    'https://www.sfdc24.com:444/ops/','https://evil.invalid/ops/']) {
    assert.equal(gantt.safeLink(url), null, url);
    const raw=fixture(); raw.items[0].source=url;
    assert.throws(()=>gantt.validate(raw,NOW), undefined, url);
  }
  assert.equal(gantt.safeLink('https://github.com/sfdc-24/sfdc24-site/pull/200'), fixture().items[0].source);
});

test('every free-text field is escaped at the HTML boundary', () => {
  const raw=fixture(), attack='<img src=x onerror="alert(1)"> & \'quoted\'';
  for (const field of ['title','project','owner','assignment','next','evidence']) raw.items[0][field]=attack;
  const rows=gantt.renderRows(gantt.validate(raw,NOW).items,NOW);
  assert.doesNotMatch(rows, /<img|<script/);
  assert.equal((rows.match(/&lt;img/g)||[]).length,6);
  assert.match(rows, /&quot;alert\(1\)&quot;/);
  assert.match(rows, /rel="noopener noreferrer"/);
});

test('failed, malformed and backdated refreshes preserve last data and visible failure; newer data recovers', () => {
  const initial=gantt.accept({},fixture(),NOW);
  const older=fixture(); older.observed_at='2026-09-27T11:59:00Z'; older.items=[];
  for (const state of [gantt.fail(initial),gantt.accept(initial,null,NOW),gantt.accept(initial,older,NOW)]) {
    assert.strictEqual(state.snapshot,initial.snapshot);
    assert.equal(state.failed,true);
    assert.match(gantt.freshness(state.snapshot,NOW,state.failed),/Refresh failed.*retained snapshot/);
  }
  const newer=fixture(); newer.observed_at='2026-09-27T12:01:00Z';
  const recovered=gantt.accept(gantt.fail(initial),newer,NOW+60000);
  assert.equal(recovered.failed,false);
  assert.equal(recovered.snapshot.observed_at,newer.observed_at);
  assert.match(gantt.freshness(null,NOW,true),/unavailable.*No progress inferred/);
});

test('snapshot and individual observation age come from evidence time', () => {
  const snap=gantt.validate(fixture(),NOW);
  assert.doesNotMatch(gantt.freshness(snap,NOW+gantt.STALE_MS-1,false),/STALE/);
  assert.match(gantt.freshness(snap,NOW+gantt.STALE_MS,false),/STALE.*30m old/);
  assert.match(gantt.renderRows(snap.items,NOW),/stale observation/);
});

// The mount uses only element lookup, HTML/text writes, listeners and timers.
// Unknown IDs fail loudly so the fake DOM cannot silently hide wiring errors.
function harness(responses, withChart=false) {
  const nodes=new Map(), intervals=new Map(), timeouts=new Map(), events={};
  let now=NOW, nextTimer=0, calls=0, charts=0, destroys=0;
  function node(id) {
    const result={id,style:{},hidden:false,disabled:false,value:'',textWrites:0,listeners:{},
      addEventListener(name,fn){this.listeners[name]=fn;}};
    Object.defineProperty(result,'textContent',{get(){return this.text||'';},set(text){this.text=text;this.textWrites++;}});
    Object.defineProperty(result,'innerHTML',{get(){return this.html||'';},set(html){
      this.html=html;
      for(const m of html.matchAll(/\bid="([^"]+)"/g)) nodes.set(m[1],node(m[1]));
    }});
    return result;
  }
  nodes.set('delivery-gantt',node('delivery-gantt'));
  const doc={hidden:false,getElementById(id){assert.ok(nodes.has(id),'Unknown DOM ID '+id);return nodes.get(id);}};
  const win={document:doc,
    setTimeout(fn,ms){const id=++nextTimer;timeouts.set(id,{fn,ms});return id;},clearTimeout(id){timeouts.delete(id);},
    setInterval(fn,ms){const id=++nextTimer;intervals.set(id,{fn,ms});return id;},clearInterval(id){intervals.delete(id);},
    addEventListener(name,fn){events[name]=fn;},
    async fetch(url,options){
      assert.ok([gantt.SNAPSHOT_URL,'/data/ops-delivery.json'].includes(url)); assert.equal(options.cache,'no-store');
      assert.equal(options.credentials,'omit'); calls++;
      const response=responses.shift();
      if(response==='pending') return new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(Error('aborted'))));
      if(response==='network') throw Error('offline');
      return {ok:response!=='http',text:async()=>typeof response==='string'?response:JSON.stringify(response)};
    }};
  if(withChart) win.Chart=function(canvas,config){charts++;this.destroy=()=>{destroys++;};};
  class FakeDate extends Date {static now(){return now;}}
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../assets/ops-gantt.js'),'utf8'),
    {window:win,Date:FakeDate,URL,AbortController}, {filename:'ops-gantt.js'});
  return {nodes,intervals,timeouts,events,doc,
    setNow(value){now=value;},get calls(){return calls;},get charts(){return charts;},get destroys(){return destroys;},
    async flush(){for(let i=0;i<24;i++) await Promise.resolve();},
    refresh(){return nodes.get('og-refresh').listeners.click();},
    tickAge(){[...intervals.values()].find(x=>x.ms===1000).fn();},
    poll(){[...intervals.values()].find(x=>x.ms===120000).fn();}};
}

test('mount keeps accessible evidence when Chart is unavailable and safely builds filters',async()=>{
  const raw=fixture(); raw.items[0].owner='<img src=x onerror=alert(1)>';
  const h=harness([raw]);await h.flush();
  assert.match(h.nodes.get('og-chart-note').textContent,/Chart library unavailable/);
  assert.equal(h.nodes.get('og-chart-box').hidden,true);
  assert.match(h.nodes.get('og-rows').innerHTML,/Recorded Development/);
  assert.doesNotMatch(h.nodes.get('og-filters').innerHTML,/<img/);
  assert.match(h.nodes.get('og-filters').innerHTML,/&lt;img/);
  for(const label of ['Backlog','Development','Staging','Test','Production']) assert.ok(h.nodes.get('og-stages').innerHTML.includes(label));
  h.nodes.get('og-owner').value='Unassigned';h.nodes.get('og-owner').listeners.change();
  assert.doesNotMatch(h.nodes.get('og-rows').innerHTML,/Build feature/);
  assert.match(h.nodes.get('og-chart-note').textContent,/No evidenced or planned dates/);
});

test('age timer marks a retained snapshot stale while refresh hangs, and timeout reveals failure',async()=>{
  const h=harness([fixture(),'pending']);await h.flush();
  const rows=h.nodes.get('og-rows').innerHTML;
  const pending=h.refresh();await h.flush();
  assert.equal(h.nodes.get('og-refresh').disabled,true);
  h.setNow(NOW+gantt.STALE_MS);h.tickAge();
  assert.match(h.nodes.get('og-freshness').textContent,/STALE.*30m old/);
  assert.equal(h.calls,2);
  [...h.timeouts.values()].find(x=>x.ms===10000).fn();await pending;
  assert.match(h.nodes.get('og-freshness').textContent,/Refresh failed.*STALE/);
  assert.match(h.nodes.get('og-rows').innerHTML,/Build feature/);
  assert.equal(h.nodes.get('og-refresh').disabled,false);
  assert.ok(rows.includes('Parked integration'));
});

test('live freshness status changes only when its message changes',async()=>{
  const h=harness([fixture(),'network']);await h.flush();
  const status=h.nodes.get('og-freshness'),initialWrites=status.textWrites;
  assert.ok(initialWrites>0);
  for(let seconds=1;seconds<60;seconds++) {
    h.setNow(NOW+seconds*1000);h.tickAge();
  }
  assert.equal(status.textWrites,initialWrites,'Same-minute ticks must not repeat a live announcement');
  h.setNow(NOW+60000);h.tickAge();
  assert.equal(status.textWrites,initialWrites+1);
  assert.match(status.textContent,/1m old/);
  await h.refresh();
  assert.equal(status.textWrites,initialWrites+2);
  assert.match(status.textContent,/Refresh failed/);
  h.tickAge();assert.equal(status.textWrites,initialWrites+2,'Unchanged failure message stays quiet');
});

test('mount surfaces HTTP, JSON, schema, network and backdated failures then clears them on recovery',async()=>{
  const older=fixture();older.observed_at='2026-09-27T11:59:00Z';older.items=[];
  const newer=fixture();newer.observed_at='2026-09-27T12:01:00Z';newer.items[0].title='Reviewed feature';
  const h=harness([fixture(),'http','{broken',{schema_version:1},'network',older,newer]);await h.flush();
  for(let i=0;i<5;i++) {
    await h.refresh();
    assert.match(h.nodes.get('og-freshness').textContent,/Refresh failed.*retained snapshot/);
    assert.match(h.nodes.get('og-rows').innerHTML,/Build feature/);
  }
  h.setNow(NOW+60000);await h.refresh();
  assert.doesNotMatch(h.nodes.get('og-freshness').textContent,/Refresh failed/);
  assert.match(h.nodes.get('og-rows').innerHTML,/Reviewed feature/);
});

test('first failed load is visibly unavailable and periodic polling skips hidden pages',async()=>{
  const h=harness(['network','network',fixture()]);await h.flush();
  assert.match(h.nodes.get('og-freshness').textContent,/unavailable/);
  h.doc.hidden=true;h.poll();await h.flush();assert.equal(h.calls,2);
  h.doc.hidden=false;h.poll();await h.flush();assert.equal(h.calls,3);
  assert.match(h.nodes.get('og-rows').innerHTML,/Build feature/);
});

test('hosted bootstrap failure displays the checked-in fallback honestly and recovers',async()=>{
  const h=harness(['network',fixture(),fixture()]);await h.flush();
  assert.equal(h.calls,2);
  assert.match(h.nodes.get('og-freshness').textContent,/Refresh failed.*retained snapshot/);
  assert.match(h.nodes.get('og-rows').innerHTML,/Build feature/);
  await h.refresh();
  assert.equal(h.calls,3);
  assert.doesNotMatch(h.nodes.get('og-freshness').textContent,/Refresh failed/);
});

test('charts redraw after filters and pagehide cleans their timers',async()=>{
  const h=harness([fixture()],true);await h.flush();
  assert.equal(h.charts,1);
  h.nodes.get('og-project').value='Website';h.nodes.get('og-project').listeners.change();
  assert.equal(h.charts,2);assert.equal(h.destroys,1);
  h.events.pagehide({persisted:false});assert.equal(h.intervals.size,0);assert.equal(h.destroys,2);
});

test('back-forward cache restoration resumes age and fetch without destroying the retained chart',async()=>{
  const h=harness([fixture(),'pending'],true);await h.flush();
  h.events.pagehide({persisted:true});
  assert.equal(h.intervals.size,2);assert.equal(h.destroys,0);
  h.setNow(NOW+gantt.STALE_MS);
  h.events.pageshow({persisted:true});await h.flush();
  assert.match(h.nodes.get('og-freshness').textContent,/STALE.*30m old/);
  assert.equal(h.calls,2);
  h.setNow(NOW+gantt.STALE_MS+60000);h.tickAge();
  assert.match(h.nodes.get('og-freshness').textContent,/31m old/);
  [...h.timeouts.values()].find(x=>x.ms===10000).fn();await h.flush();
  assert.match(h.nodes.get('og-freshness').textContent,/Refresh failed.*STALE/);
});

test('delivery overview mounts in live execution, after the release funnel',()=>{
  const page=fs.readFileSync(path.join(__dirname,'../ops/index.html'),'utf8');
  const mount=page.indexOf('id="delivery-gantt"');
  const mandate=page.indexOf('id="conference-mandate"');
  const release=page.indexOf('id="release"');
  assert.ok(release>=0 && release<page.indexOf('id="live-execution"'));
  assert.ok(mandate>=0 && mandate<mount);
  assert.ok(mount>=0);
  assert.match(page,/\/assets\/ops-gantt\.js/);
});

test('checked-in delivery data satisfies the same strict public snapshot contract',()=>{
  const raw=JSON.parse(fs.readFileSync(path.join(__dirname,'../data/ops-delivery.json'),'utf8'));
  const snapshot=gantt.validate(raw,Math.max(Date.now(),Date.parse(raw.observed_at)));
  assert.ok(snapshot.items.length>0);
  assert.equal(snapshot.items.length,raw.items.length);
  assert.ok(snapshot.items.some(item=>item.periods.length===0),'Undated work remains represented');
  assert.ok(snapshot.items.every(item=>gantt.safeLink(item.source)));
});
