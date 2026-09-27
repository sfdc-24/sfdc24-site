const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.join(__dirname,'..');
const html=fs.readFileSync(path.join(root,'ops/index.html'),'utf8');
const roster=html.split('<section id="agent-lanes"')[1].split('</section>')[0];
const css=fs.readFileSync(path.join(root,'assets/ops-agent-roster.css'),'utf8');
test('all six current agents appear once in the primary roster',()=>{
  const ids=[...roster.matchAll(/data-agent="([^"]+)"/g)].map(m=>m[1]);
  assert.deepEqual(ids.sort(),['claude-code-cli','codex','copilot','cursor','gemini','grok']);
});
test('current roles are explicit, with no retired labels',()=>{
  const roles={'claude-code-cli':'Implementation &amp; release',codex:'PM &amp; test lead',gemini:'Adversarial reasoning',cursor:'Independent exact-head review',copilot:'PR review &amp; living docs',grok:'Strategy'};
  const cards=[...roster.matchAll(/<li\b[^>]*data-agent="([^"]+)"[^>]*>([\s\S]*?)<\/li>/g)];
  for(const [id,role] of Object.entries(roles)){
    const card=cards.find(m=>m[1]===id);
    assert.ok(card, id+' card');
    assert.ok(card[2].includes('<span class="agent-lane-idle">'+role+'</span>'), id+' role');
  }
  for(const role of ['MCP gatekeeper','Dev lead','GCP infra']) assert.ok(!roster.includes(role));
});
test('missing working-time telemetry is not presented as zero or invented percent',()=>{
  assert.ok(roster.includes('Utilization: not measured'));
  assert.ok(roster.includes('message counts and open tasks are not utilization'));
  assert.doesNotMatch(roster,/\d+(?:\.\d+)?%/);
});
test('legacy message heat cannot hide roles or assert current execution in roster',()=>{
  assert.ok(css.includes('.agent-lane.is-working .agent-lane-idle{display:block'));
  assert.ok(css.includes('.agent-lane.is-working .agent-lane-chip{display:none}'));
  assert.ok(css.includes('.agent-sprite{animation:none}'));
  assert.ok(html.includes('href="/assets/ops-agent-roster.css"'));
});
