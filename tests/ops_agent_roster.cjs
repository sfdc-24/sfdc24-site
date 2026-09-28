const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.join(__dirname,'..');
const html=fs.readFileSync(path.join(root,'ops/index.html'),'utf8');
const roster=html.split('<section id="agent-lanes"')[1].split('</section>')[0];
const css=fs.readFileSync(path.join(root,'assets/ops-agent-roster.css'),'utf8');
test('primary, rendered fallback, Python seed and synthetic sample share one roster',()=>{
  const expected=['claude-code-cli','codex','copilot','cursor','gemini','grok'];
  const js=fs.readFileSync(path.join(root,'assets/board-ops.part-a.js'),'utf8').match(/ROLES=\[([^;]+)\];/)[1];
  assert.deepEqual([...js.matchAll(/id:"([^"]+)"/g)].map(m=>m[1]).sort(),expected);
  const py=fs.readFileSync(path.join(root,'tools/board_ops_snap.py'),'utf8').match(/^ROSTER = \((.+)\)$/m)[1];
  assert.deepEqual([...py.matchAll(/"([^"]+)"/g)].map(m=>m[1]).sort(),expected);
  const sample=JSON.parse(fs.readFileSync(path.join(root,'data/board-ops-snap.json'),'utf8'));
  assert.deepEqual(sample.agents.map(x=>x.id).sort(),expected);
  const rendered=require('../assets/board-ops.js').paint(sample,Date.parse(sample.baked_at)).engine;
  assert.doesNotMatch(rendered,/MCP gatekeeper|Dev lead|GCP VM infra|WhatsApp notify/);
});
test('all six current agents appear once in the primary roster',()=>{
  const ids=[...roster.matchAll(/data-agent="([^"]+)"/g)].map(m=>m[1]);
  assert.deepEqual(ids.sort(),['claude-code-cli','codex','copilot','cursor','gemini','grok']);
});
test('current roles are explicit, with no retired labels',()=>{
  const roles={'claude-code-cli':'Data and security engineer',codex:'Quality and test lead',gemini:'Admin and analyst',cursor:'Heavy PM and Build and PR execution',copilot:'GitHub DevOps and repo reviewer',grok:'Delivery and strategy lead'};
  const cards=[...roster.matchAll(/<li\b[^>]*data-agent="([^"]+)"[^>]*>([\s\S]*?)<\/li>/g)];
  for(const [id,role] of Object.entries(roles)){
    const card=cards.find(m=>m[1]===id);
    assert.ok(card, id+' card');
    assert.ok(card[2].includes('<span class="agent-lane-idle">'+role+'</span>'), id+' role');
  }
  for(const role of ['MCP gatekeeper','Dev lead','GCP infra']) assert.ok(!roster.includes(role));
});
test('baked write share is shown per agent and is not a live-presence claim',()=>{
  assert.ok(roster.includes('Baked write share of this snapshot hour'));
  assert.ok(roster.includes('Not a live bus'));
  assert.ok(!roster.includes('Utilization: not measured'));
  const shown={grok:'31%',codex:'19%','claude-code-cli':'38%',cursor:'13%',gemini:'0%',copilot:'0%'};
  const cards=[...roster.matchAll(/<li\b[^>]*data-agent="([^"]+)"[^>]*>([\s\S]*?)<\/li>/g)];
  for(const [id,pct] of Object.entries(shown)){
    const card=cards.find(m=>m[1]===id);
    assert.ok(card,id);
    assert.ok(card[2].includes('<span class="agent-util">'+pct+'</span>'),id+' util');
  }
  const sample=JSON.parse(fs.readFileSync(path.join(root,'data/board-ops-snap.json'),'utf8'));
  const baked=require('../assets/board-ops.js').bakedUtil(sample);
  assert.equal(baked.grok,31);
  assert.equal(baked.codex,19);
  assert.equal(baked['claude-code-cli'],38);
  assert.equal(baked.cursor,13);
  assert.equal(baked.gemini,0);
  assert.equal(baked.copilot,0);
  assert.deepEqual(require('../assets/board-ops.js').bakedUtil({agents:[{id:'grok',writes_1h:0},{id:'codex',writes_1h:0}]}),{grok:0,codex:0});
});
test('legacy message heat cannot hide roles or assert current execution in roster',()=>{
  assert.ok(css.includes('.agent-lane.is-working .agent-lane-idle{display:block'));
  assert.ok(css.includes('.agent-lane.is-working .agent-lane-chip{display:none}'));
  assert.ok(css.includes('.agent-sprite{animation:none}'));
  assert.ok(html.includes('href="/assets/ops-agent-roster.css"'));
});
