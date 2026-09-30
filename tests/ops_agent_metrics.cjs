// /ops agent repository work, HITL gates and delivery mechanisms (assets/ops-agent-metrics.js).
// Run: node --test tests/ops_agent_metrics.cjs
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.join(__dirname,'..');
const html=fs.readFileSync(path.join(root,'ops/index.html'),'utf8');
const {rows,pct,hours}=require(path.join(root,'assets/ops-agent-metrics.js'));
const snap=JSON.parse(fs.readFileSync(path.join(root,'data/ops-agent-metrics.json'),'utf8'));

test('a measured agent shows its counts beside each rate',()=>{
  const [r]=rows({agents:[{agent:'Codex',pull_requests:5,merged:4,utilization:0.25,active_hours:42,window_hours:168,
    verdicts:8,nogo:2,error_rate:0.25,median_hours_to_merge:1.24,did:[{repo:'site',number:9,title:'Fix'}]}]});
  assert.deepEqual(r,{agent:'Codex',prs:'5 (4 merged)',utilization:'25% (42 of 168 h)',errors:'25% (2 NO-GO of 8)',
    efficiency:'1.2 h',did:['Fix (site #9)']});
});

test('no record is a dash and a reason, never a zero',()=>{
  const [r]=rows({agents:[{agent:'Gemini',pull_requests:0,merged:0,utilization:null,active_hours:0,window_hours:168,
    verdicts:0,nogo:0,error_rate:null,median_hours_to_merge:null,did:[],note:'Works on the board.'}]});
  assert.deepEqual([r.prs,r.utilization,r.errors,r.efficiency,r.did],['—','—','—','—',['Works on the board.']]);
  assert.equal(pct(undefined),'—');
  assert.equal(hours(NaN),'—');
  const [none]=rows({agents:[{agent:'Copilot',pull_requests:2,merged:0,utilization:0.01,active_hours:2,window_hours:168,
    verdicts:0,nogo:0,error_rate:null,median_hours_to_merge:null,did:[]}]});
  assert.equal(none.errors,'—');
  assert.deepEqual(none.did,['No merged pull request in the window.']);
});

test('who did what shows at most three public titles, and the private repositories as counts',()=>{
  const did=[1,2,3,4,5].map(n=>({repo:'sfdc24-site',number:n,title:'T'+n}));
  const [r]=rows({private_repos:['sfdc-24/Blackboard','sfdc-24/conference'],
    agents:[{agent:'Claude',pull_requests:30,merged:30,did,merged_by_repo:{'sfdc24-site':5,Blackboard:12,conference:13}}]});
  assert.deepEqual(r.did,['T1 (sfdc24-site #1)','T2 (sfdc24-site #2)','T3 (sfdc24-site #3)',
    '12 merged in the board repository, 13 merged in the conference repository (private: titles not shown).']);
});

test('the committed snapshot carries no private repository title',()=>{
  const priv=(snap.private_repos||[]).map(r=>r.split('/')[1]);
  assert.ok(priv.includes('conference'));                         // GitHub's own visibility decides
  for(const a of snap.agents) for(const d of a.did) assert.ok(!priv.includes(d.repo),a.agent+' '+d.repo+' #'+d.number);
  assert.ok(!/motherboard|salam|yasmine/i.test(JSON.stringify(snap.agents.map(a=>a.did))));
});

test('the committed snapshot is well formed, and every agent is attributed by branch prefix',()=>{
  assert.match(snap.observed_at,/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.equal(snap.window_days,7);
  assert.deepEqual(snap.agents.map(a=>a.agent),['Claude','Codex','Cursor','Copilot','Grok','Gemini']);
  for(const key of ['utilization','error_rate','efficiency','attribution']) assert.ok(snap.definitions[key],key);
  for(const a of snap.agents){
    assert.ok(a.merged<=a.pull_requests,a.agent);
    assert.ok(a.nogo<=a.verdicts,a.agent);
    assert.ok(a.active_hours<=a.window_hours,a.agent);
    if(!a.pull_requests) assert.equal(a.utilization,null,a.agent+' has no record: no utilization');
  }
});

test('the page carries the table, the five HITL fields and M1 to M8, with no personal name',()=>{
  const metrics=html.split('<section id="agent-metrics"')[1].split('</section>')[0];
  assert.ok(metrics.includes('id="agent-metrics-table"'));
  assert.ok(metrics.includes('Repository work only'));
  const hitl=html.split('<section id="hitl-legend"')[1].split('</section>')[0];
  for(const field of ['Who','What','When','How','Timeout']) assert.ok(hitl.includes('<b>'+field+'</b>'),field);
  const mech=html.split('<section id="mechanisms"')[1].split('</section>')[0];
  for(let m=1;m<=8;m+=1) assert.ok(mech.includes('<b>M'+m+' '),'M'+m);
  assert.ok(html.includes('<script src="/assets/ops-agent-metrics.js" defer></script>'));
  assert.ok(html.includes('href="/assets/ops-agent-metrics.css"'));
  assert.ok(!/Mr\.? Salam/.test(html));
});
