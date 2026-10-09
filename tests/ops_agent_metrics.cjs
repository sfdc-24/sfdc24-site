// /ops per-agent scorecard. The page reads data/ops-agent-metrics-daily.json
// (one ET day) and falls back to data/ops-agent-metrics.json. Run:
// node --test tests/ops_agent_metrics.cjs
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const http=require('node:http');
const path=require('node:path');
const vm=require('node:vm');
const {spawn}=require('node:child_process');
const root=path.join(__dirname,'..');
const html=fs.readFileSync(path.join(root,'ops/index.html'),'utf8');
const source=fs.readFileSync(path.join(root,'assets/ops-agent-metrics.js'),'utf8');
const css=fs.readFileSync(path.join(root,'assets/ops-agent-metrics.css'),'utf8');
const snap=JSON.parse(fs.readFileSync(path.join(root,'data/ops-agent-metrics.json'),'utf8'));
const daily=JSON.parse(fs.readFileSync(path.join(root,'data/ops-agent-metrics-daily.json'),'utf8'));
const sandbox={OpsGantt:{},setTimeout(){},setInterval(){}};
vm.runInNewContext(source,sandbox);
const {measuredRows,renderAgentScorecard,readMetrics,personaName,formatET}=sandbox.OpsGantt;
const EMPTY_BOARD={asks:'—',results:'—',closedSameDay:'—',overdue:'—',repeatAsks:'—',cutoff:'—'};
const VENDORS=['Grok','Codex','Gemini','Cursor','Copilot'];
const PERSONAS=['Greg','Claude','Aya','Jenny','Cody','Paired review','Owner','Total'];

function vendorHits(text){
  const found={};
  for(const word of VENDORS){
    const n=(text.match(new RegExp('\\b'+word+'\\b','g'))||[]).length;
    if(n) found[word]=n;
  }
  return found;
}

test('a measured agent shows each rate beside the counts it comes from',()=>{
  const [r]=measuredRows({agents:[{agent:'Codex',pull_requests:5,merged:4,utilization:0.25,active_hours:42,window_hours:168,
    verdicts:8,nogo:2,error_rate:0.25,median_hours_to_merge:1.24,did:[{repo:'sfdc24-site',number:9,title:'Fix'}]}]});
  assert.deepEqual(JSON.parse(JSON.stringify(r)),{agent:'Aya',util:'25%',utilBasis:'42 of 168 h with repository work',
    error:'25%',errorBasis:'2 NO-GO of 8 review verdicts',efficiency:'1.2 h',
    efficiencyBasis:'median hours opened→merged · 4 of 5 merged',cost:'not reported',board:EMPTY_BOARD,
    did:['Fix (sfdc24-site #9)']});
});

test('no record is a dash and a reason, never a zero',()=>{
  const [r]=measuredRows({agents:[{agent:'Gemini',pull_requests:0,merged:0,utilization:null,active_hours:0,window_hours:168,
    verdicts:0,nogo:0,error_rate:null,median_hours_to_merge:null,did:[],note:'Works on the board.',cost:null}]});
  assert.equal(r.agent,'Jenny');
  assert.equal(r.cost,'not reported');
  assert.deepEqual([r.util,r.error,r.efficiency,[...r.did]],['—','—','—',['Works on the board.']]);
});

test('legacy vendor names become personas, including a reported cost',()=>{
  assert.equal(personaName('Cursor'),'Cody');
  assert.equal(personaName('Copilot'),'Paired review');
  assert.equal(personaName('Grok'),'Greg');
  assert.equal(personaName('Claude'),'Claude');
  const [r]=measuredRows({agents:[{agent:'Gemini',pull_requests:0,merged:0,verdicts:0,did:[],
    cost:'Gemini receipt 10 in',note:'Copilot Agents left a note about Codex.'}]});
  assert.equal(r.agent,'Jenny');
  assert.equal(r.cost,'Jenny receipt 10 in');
  assert.ok(r.did.some(d=>d.includes('Paired review')&&d.includes('Aya')));
  const [titled]=measuredRows({agents:[{agent:'Claude',pull_requests:1,merged:1,utilization:0.1,active_hours:1,window_hours:24,
    verdicts:0,nogo:0,median_hours_to_merge:1,did:[{repo:'Blackboard',number:343,title:'gemini: private conference repo'}]}]});
  assert.equal(titled.did[0],'Jenny: private conference repo (Blackboard #343)');
  assert.deepEqual(vendorHits(r.cost+' '+r.did.join(' ')),{});
});

test('the board section counts asks, results, same-day closes, overdue, repeats, and cut-offs',()=>{
  const [r]=measuredRows({agents:[{agent:'Aya',pull_requests:1,merged:1,utilization:0.08,active_hours:2,window_hours:24,
    verdicts:0,nogo:0,median_hours_to_merge:1.6,did:[],cost:null,
    board:{asks_in:11,resulted:1,closed_same_day:2,same_day_close_rate:0.182,overdue_eod:6,repeat_asks_sent:0,cutoff_rows:0}}]});
  assert.equal(r.cost,'not reported');
  assert.deepEqual(JSON.parse(JSON.stringify(r.board)),{asks:'11',results:'1',closedSameDay:'2 (18%)',overdue:'6',repeatAsks:'0',cutoff:'0'});
});

test('the private repository shows counts only, never titles',()=>{
  const [r]=measuredRows({private_repos:['sfdc-24/conference'],agents:[{agent:'Claude',pull_requests:9,merged:9,
    did:[{repo:'sfdc24-site',number:1,title:'A'}],merged_by_repo:{'sfdc24-site':1,conference:8}}]});
  assert.deepEqual([...r.did],['A (sfdc24-site #1)','8 merged in the conference repository (private: titles not shown)']);
});

test('a board-heavy agent keeps its undercount note even when it has pull requests',()=>{
  const [r]=measuredRows({agents:[{agent:'Grok',pull_requests:2,merged:1,utilization:0.05,active_hours:9,window_hours:168,
    verdicts:2,nogo:2,error_rate:1,median_hours_to_merge:0.1,did:[{repo:'sfdc24-site',number:1,title:'Ops'}],
    note:'Works mostly on the board (strategy and dispatch), not in pull requests.'}]});
  assert.equal(r.agent,'Greg');
  assert.equal(r.util,'5%');
  assert.ok(r.utilBasis.includes('board/chat work not counted'));
  assert.ok(r.did.some(d=>/board/i.test(d)));
});

test('the scorecard is escaped and says what it measures, from the committed snapshot',()=>{
  const out=renderAgentScorecard({window_start:'2026-09-23T00:00:00Z',observed_at:'2026-09-30T00:00:00Z',
    agents:[{agent:'<b>x</b>',pull_requests:1,merged:1,utilization:0.1,active_hours:1,window_hours:168,verdicts:0,nogo:0,
      did:[{repo:'r',number:1,title:'<script>'}]}]});
  assert.ok(out.includes('\u0026lt;b\u0026gt;x\u0026lt;/b\u0026gt;')&&out.includes('\u0026lt;script\u0026gt;'));
  assert.ok(out.includes('Measured from pull requests and review verdicts, 2026-09-22 20:00 ET to 2026-09-29 20:00 ET'));
  assert.ok(out.includes('Efficiency (median h)'));
  assert.ok(out.includes('data-label="Cost"'));
  assert.equal(formatET('2026-10-09T12:24:04Z'),'2026-10-09 08:24 ET');
  const page=renderAgentScorecard(snap);
  for(const a of snap.agents) assert.ok(page.includes('<th scope="row">'+personaName(a.agent)+'</th>'),a.agent);
  assert.deepEqual(vendorHits(page),{});
  assert.ok(!/estimated/i.test(page));
  assert.ok(page.includes('7-day trend is not in this snapshot.'));
});

test('window_days of 1 or 7 are both valid, and the daily file names personas only',()=>{
  assert.ok(snap.window_days===1||snap.window_days===7);
  assert.ok(daily.window_days===1||daily.window_days===7);
  assert.equal(daily.window_days,1);
  assert.equal(snap.window_days,7);
  assert.ok(Array.isArray(daily.days)&&daily.days.length>=1);
  for(const key of ['utilization','error_rate','efficiency','attribution','scope']) assert.ok(snap.definitions[key],key);
  for(const key of ['utilization','error_rate','efficiency','attribution','scope','board']) assert.ok(daily.definitions[key],key);
  const priv=(snap.private_repos||[]).map(r=>r.split('/')[1]);
  assert.ok(priv.includes('conference'));
  for(const a of snap.agents){
    assert.ok(a.merged<=a.pull_requests&&a.nogo<=a.verdicts&&a.active_hours<=a.window_hours,a.agent);
    if(!a.pull_requests) assert.equal(a.utilization,null,a.agent);
    for(const d of a.did) assert.ok(!priv.includes(d.repo),a.agent+' '+d.repo);
  }
  for(const day of daily.days){
    for(const a of day.agents) assert.ok(PERSONAS.includes(a.agent),a.agent+' '+day.date);
  }
  assert.ok(!/motherboard|salam|yasmine/i.test(JSON.stringify(snap.agents.map(a=>a.did))));
});

test('the latest day renders as Today (partial) in ET, with board, cost, and a 7-day trend',()=>{
  const out=renderAgentScorecard(daily);
  assert.ok(out.includes('Today (partial), observed 2026-10-09 08:24 ET'));
  assert.ok(out.includes('>Board<'));
  assert.ok(out.includes('Asks in')&&out.includes('Cut-off replies')&&out.includes('Repeat asks'));
  assert.ok(out.includes('7-day trend'));
  assert.ok(out.includes('Same-day close %')&&out.includes('CI fails'));
  assert.ok(out.includes('2026-10-07 · 2026-10-08 · 2026-10-09 partial'));
  assert.ok(out.includes('100% · 39% · 81%'));
  assert.ok(out.includes('6 · 8 · 7'));
  assert.ok(out.includes('11 · 10 · 0'));
  assert.ok(out.includes('0 · 2 · 13'));
  assert.ok(out.includes('not reported'));
  assert.ok(out.includes('class="spark"'));
  for(const name of PERSONAS) assert.ok(out.includes('<th scope="row">'+name+'</th>'),name);
  assert.deepEqual(vendorHits(out),{});
  assert.ok(!/last 7 days/i.test(out));
});

test('a missing daily file falls back to the snapshot, and a present one does not',async()=>{
  const seen=[];
  const fallen=await readMetrics(function(url){
    seen.push(url);
    if(url.endsWith('ops-agent-metrics-daily.json')) return Promise.resolve({ok:false});
    return Promise.resolve({ok:true,json:()=>Promise.resolve(snap)});
  });
  assert.deepEqual(seen,[sandbox.OpsGantt.DAILY_URL,sandbox.OpsGantt.SNAPSHOT_URL]);
  const fallback=renderAgentScorecard(fallen);
  assert.ok(fallback.includes('<th scope="row">Aya</th>'));
  assert.deepEqual(vendorHits(fallback),{});
  let calls=0;
  const used=await readMetrics(function(url){
    calls+=1;
    assert.equal(url,sandbox.OpsGantt.DAILY_URL);
    return Promise.resolve({ok:true,json:()=>Promise.resolve(daily)});
  });
  assert.equal(calls,1);
  assert.equal(used.window_days,1);
  assert.ok(renderAgentScorecard(used).includes('Today (partial)'));
});

test('the page says the figures are measured each day, and keeps the scorecard and its runway',()=>{
  const card=html.split('<h3>Per-agent utilization, error rate, efficiency</h3>')[1].split('</section>')[0];
  assert.ok(!/last 7 days/i.test(card));
  assert.ok(card.includes('Measured each Eastern Time day'));
  assert.ok(card.includes('Today (partial)'));
  assert.ok(card.includes('ops-agent-metrics-daily.json'));
  assert.ok(card.includes('hours, not a percent'));
  assert.ok(card.includes('not reported'));
  assert.ok(card.includes('private conference repository'));
  assert.ok(card.includes('Board chat, waker replies, and bus activity are not counted'));
  assert.ok(card.includes('cut-off replies'));
  assert.ok(!/estimated/i.test(card));
  assert.deepEqual(vendorHits(card),{});
  assert.ok(card.includes('id="agent-scorecard"'));
  assert.ok(source.includes("'/data/ops-agent-metrics-daily.json'"));
  assert.ok(source.includes("'/data/ops-agent-metrics.json'"));
  assert.ok(source.includes('14 * 24 * 60 * 60 * 1000'));
  assert.ok(css.includes('@media (max-width:390px)'));
  assert.ok(css.includes('overflow-x:auto'));
  assert.ok(!/Mr\.? Salam/.test(html));
});

function chromeBin(){
  for(const bin of ['/usr/bin/google-chrome-stable','/usr/bin/google-chrome','/usr/local/bin/google-chrome']){
    if(fs.existsSync(bin)) return bin;
  }
  return null;
}

test('the scorecard fits a 390px screen',async(t)=>{
  const bin=chromeBin();
  if(!bin){t.skip('chrome is not installed');return;}
  const server=http.createServer((req,res)=>{
    const url=new URL(req.url,'http://127.0.0.1');
    let rel=decodeURIComponent(url.pathname);
    if(rel.endsWith('/')) rel+='index.html';
    const file=path.resolve(root,'.'+rel);
    if(!file.startsWith(root+path.sep)||!fs.existsSync(file)){res.writeHead(404).end('missing');return;}
    const types={'.html':'text/html','.js':'application/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.ico':'image/x-icon','.png':'image/png'};
    res.writeHead(200,{'content-type':types[path.extname(file)]||'application/octet-stream'});
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((resolve)=>server.listen(0,'127.0.0.1',resolve));
  const port=server.address().port;
  const origin='http://127.0.0.1:'+port;
  const debug=9600+(process.pid%200);
  const chrome=spawn(bin,[
    '--headless=new','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--disable-extensions','--no-first-run',
    '--user-data-dir=/tmp/ops-score-'+process.pid,'--remote-debugging-port='+debug,'about:blank'
  ],{stdio:'ignore'});
  let ws;
  try{
    let version;
    for(let i=0;i<40&&!version;i++){
      try{
        version=await new Promise((resolve,reject)=>{
          http.get('http://127.0.0.1:'+debug+'/json/version',(res)=>{
            let body='';
            res.on('data',(c)=>{body+=c;});
            res.on('end',()=>resolve(JSON.parse(body)));
          }).on('error',reject);
        });
      }catch(err){await new Promise((r)=>setTimeout(r,150));}
    }
    assert.ok(version,'chrome did not start');
    ws=new WebSocket(version.webSocketDebuggerUrl);
    let next=1;
    const pending=new Map();
    await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve);ws.addEventListener('error',reject);});
    ws.addEventListener('message',(ev)=>{
      const msg=JSON.parse(ev.data);
      if(msg.id&&pending.has(msg.id)){pending.get(msg.id)(msg);pending.delete(msg.id);}
    });
    const send=(method,params,sessionId)=>new Promise((resolve,reject)=>{
      const id=next++;
      const packet={id,method,params:params||{}};
      if(sessionId) packet.sessionId=sessionId;
      pending.set(id,(msg)=>msg.error?reject(new Error(JSON.stringify(msg.error))):resolve(msg.result));
      ws.send(JSON.stringify(packet));
    });
    const {targetId}=await send('Target.createTarget',{url:'about:blank'});
    const {sessionId}=await send('Target.attachToTarget',{targetId,flatten:true});
    const page=(method,params)=>send(method,params,sessionId);
    await page('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
    await page('Page.enable');
    await page('Page.navigate',{url:origin+'/ops/#agent-scorecard'});
    let info;
    for(let i=0;i<40;i++){
      await new Promise((r)=>setTimeout(r,250));
      const result=await page('Runtime.evaluate',{returnByValue:true,expression:`(() => {
        const card=document.getElementById('agent-scorecard');
        const doc=document.documentElement;
        return JSON.stringify({
          ready:!!(card && card.querySelector('.agent-trend, .score-trend')),
          scroll:doc.scrollWidth-doc.clientWidth,
          card:card?Math.round(card.getBoundingClientRect().width):0,
          text:card?card.innerText:''
        });
      })()`});
      info=JSON.parse(result.result.value);
      if(info.ready) break;
    }
    assert.ok(info.ready,'scorecard did not render');
    assert.ok(info.scroll<=1,'page is '+info.scroll+'px wider than 390');
    assert.ok(info.card<=390,'scorecard is '+info.card+'px');
    assert.match(info.text,/Today \(partial\)/);
    assert.match(info.text,/08:24 ET/);
    assert.match(info.text,/7-day trend/);
    assert.match(info.text,/Asks in/);
    assert.match(info.text,/not reported/);
    assert.deepEqual(vendorHits(info.text),{});
  }finally{
    if(ws) ws.close();
    chrome.kill('SIGKILL');
    await new Promise((resolve)=>server.close(resolve));
  }
});
