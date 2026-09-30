// /ops per-agent scorecard, measured from the repositories (assets/ops-agent-metrics.js,
// data/ops-agent-metrics.json). Run: node --test tests/ops_agent_metrics.cjs
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const root=path.join(__dirname,'..');
const html=fs.readFileSync(path.join(root,'ops/index.html'),'utf8');
const source=fs.readFileSync(path.join(root,'assets/ops-agent-metrics.js'),'utf8');
const snap=JSON.parse(fs.readFileSync(path.join(root,'data/ops-agent-metrics.json'),'utf8'));
const sandbox={OpsGantt:{},setTimeout(){},setInterval(){}};
vm.runInNewContext(source,sandbox);
const {measuredRows,renderAgentScorecard}=sandbox.OpsGantt;

test('a measured agent shows each rate beside the counts it comes from',()=>{
  const [r]=measuredRows({agents:[{agent:'Codex',pull_requests:5,merged:4,utilization:0.25,active_hours:42,window_hours:168,
    verdicts:8,nogo:2,error_rate:0.25,median_hours_to_merge:1.24,did:[{repo:'sfdc24-site',number:9,title:'Fix'}]}]});
  assert.deepEqual(JSON.parse(JSON.stringify(r)),{agent:'Codex',util:'25%',utilBasis:'42 of 168 h with repository work',
    error:'25%',errorBasis:'2 NO-GO of 8 review verdicts',efficiency:'1.2 h',
    efficiencyBasis:'median, opened to merged · 4 of 5 merged',did:['Fix (sfdc24-site #9)']});
});

test('no record is a dash and a reason, never a zero',()=>{
  const [r]=measuredRows({agents:[{agent:'Gemini',pull_requests:0,merged:0,utilization:null,active_hours:0,window_hours:168,
    verdicts:0,nogo:0,error_rate:null,median_hours_to_merge:null,did:[],note:'Works on the board.'}]});
  assert.deepEqual([r.util,r.error,r.efficiency,[...r.did]],['—','—','—',['Works on the board.']]);
});

test('the private repository shows counts only, never titles',()=>{
  const [r]=measuredRows({private_repos:['sfdc-24/conference'],agents:[{agent:'Claude',pull_requests:9,merged:9,
    did:[{repo:'sfdc24-site',number:1,title:'A'}],merged_by_repo:{'sfdc24-site':1,conference:8}}]});
  assert.deepEqual([...r.did],['A (sfdc24-site #1)','8 merged in the conference repository (private: titles not shown)']);
});

test('the scorecard is escaped and says what it measures, from the committed snapshot',()=>{
  const out=renderAgentScorecard({window_start:'2026-09-23T00:00:00Z',observed_at:'2026-09-30T00:00:00Z',
    agents:[{agent:'<b>x</b>',pull_requests:1,merged:1,utilization:0.1,active_hours:1,window_hours:168,verdicts:0,nogo:0,
      did:[{repo:'r',number:1,title:'<script>'}]}]});
  assert.ok(out.includes('&lt;b&gt;x&lt;/b&gt;')&&out.includes('&lt;script&gt;'));
  assert.ok(out.includes('Measured from pull requests and their review verdicts, 2026-09-23 00:00 to 2026-09-30 00:00 UTC'));
  const page=renderAgentScorecard(snap);
  for(const a of snap.agents) assert.ok(page.includes('<th scope="row">'+a.agent+'</th>'),a.agent);
  assert.ok(!/estimated/i.test(page));
});

test('the committed snapshot is well formed, and no private title is in it',()=>{
  assert.match(snap.observed_at,/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.equal(snap.window_days,7);
  for(const key of ['utilization','error_rate','efficiency','attribution']) assert.ok(snap.definitions[key],key);
  const priv=(snap.private_repos||[]).map(r=>r.split('/')[1]);
  assert.ok(priv.includes('conference'));
  for(const a of snap.agents){
    assert.ok(a.merged<=a.pull_requests&&a.nogo<=a.verdicts&&a.active_hours<=a.window_hours,a.agent);
    if(!a.pull_requests) assert.equal(a.utilization,null,a.agent);
    for(const d of a.did) assert.ok(!priv.includes(d.repo),a.agent+' '+d.repo);
  }
  assert.ok(!/motherboard|salam|yasmine/i.test(JSON.stringify(snap.agents.map(a=>a.did))));
});

test('the page says the figures are measured, and keeps the scorecard and its runway',()=>{
  const card=html.split('<h3>Per-agent utilization, error rate, efficiency</h3>')[1].split('</section>')[0];
  assert.ok(card.includes('Measured over the last 7 days'));
  assert.ok(!/estimated/i.test(card));
  assert.ok(card.includes('id="agent-scorecard"'));
  assert.ok(source.includes('14 * 24 * 60 * 60 * 1000'));                  // the 2-week Gantt runway is kept
  assert.ok(!/Mr\.? Salam/.test(html));
});
