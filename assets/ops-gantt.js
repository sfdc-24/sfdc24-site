/* Ops delivery projection. No credentials, board reads, or inferred deployments. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.OpsGantt = api; api.mount(root.document, root); }
})(typeof window === 'undefined' ? globalThis : window, function () {
  'use strict';
  const STAGES = ['backlog', 'dev', 'staging', 'test', 'production'];
  const LABELS = ['Backlog', 'Development', 'Staging', 'Test', 'Production'];
  const COLORS = ['#697586', '#2563eb', '#7c3aed', '#b45309', '#15803d'];
  const STALE_MS = 30 * 60000;
  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const date = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().replace('.000Z','Z') === v ? Date.parse(v) : null;
  const text = (v, n) => typeof v === 'string' && v.length > 0 && v.length <= n;
  function safeLink(v) {
    try { const u = new URL(v); return u.protocol === 'https:' && !u.port && !u.username && !u.password &&
      ((u.hostname === 'github.com' && u.pathname.startsWith('/sfdc-24/')) ||
       (u.hostname === 'www.sfdc24.com' && u.pathname.startsWith('/'))) ? u.href : null; }
    catch (_) { return null; }
  }
  function validate(raw, now) {
    const stamp = raw && date(raw.observed_at);
    if (!raw || raw.schema_version !== 1 || stamp === null || stamp > now + 60000 ||
        !Array.isArray(raw.items) || raw.items.length > 100) throw Error('Invalid delivery snapshot');
    const ids = new Set();
    const items = raw.items.map(x => {
      if (!x || !text(x.id, 80) || ids.has(x.id) || !text(x.title, 180) || !text(x.project, 80) ||
          !text(x.owner, 100) || !text(x.assignment, 120) || !text(x.next, 400) ||
          !text(x.evidence, 400) || !STAGES.includes(x.stage) || !['recorded','blocked','pending','verified'].includes(x.status) ||
          date(x.observed_at) === null || date(x.observed_at) > stamp || !safeLink(x.source) ||
          !Array.isArray(x.periods) || x.periods.length > 20) throw Error('Invalid delivery item');
      ids.add(x.id);
      const periods = x.periods.map(p => {
        const start = date(p.start), end = date(p.end);
        if (!STAGES.includes(p.stage) || !['actual','planned'].includes(p.kind) || start === null ||
            end === null || end < start || (p.kind === 'actual' && end > date(x.observed_at))) throw Error('Invalid delivery period');
        return {stage:p.stage, kind:p.kind, start:p.start, end:p.end};
      });
      // Whitelist fields: no raw payloads, tokens or invented merge/deploy flags.
      return {id:x.id,title:x.title,project:x.project,owner:x.owner,assignment:x.assignment,stage:x.stage,
        status:x.status,next:x.next,evidence:x.evidence,observed_at:x.observed_at,source:safeLink(x.source),periods};
    });
    return {schema_version:1, observed_at:raw.observed_at, items};
  }
  function select(items, filters) {
    return items.filter(x => ['project','owner','stage'].every(k => !filters[k] || filters[k] === x[k]));
  }
  function freshness(snapshot, now, failed) {
    if (!snapshot) return 'Delivery data unavailable — retry refresh. No progress inferred.';
    const minutes = Math.max(0, Math.floor((now - date(snapshot.observed_at)) / 60000));
    return (failed ? 'Refresh failed — retained snapshot. ' : '') +
      (now - date(snapshot.observed_at) >= STALE_MS ? 'STALE · ' : 'Published snapshot · ') +
      minutes + 'm old · observed ' + snapshot.observed_at + ' · checks every 120s, not live activity';
  }
  function accept(state, raw, now) {
    try {
      const snapshot = validate(raw, now);
      if (state.snapshot && date(snapshot.observed_at) < date(state.snapshot.observed_at)) throw Error('Older snapshot');
      return {snapshot, failed:false};
    } catch (_) { return {snapshot:state.snapshot || null,failed:true}; }
  }
  const fail = state => ({snapshot:state.snapshot || null,failed:true});
  function renderRows(items, now) {
    if (!items.length) return '<p class="og-empty">No work items match these filters.</p>';
    return '<div class="og-table-wrap" tabindex="0" role="region" aria-label="Delivery work details"><table><caption>Owners, evidence and next action — dates in UTC</caption><thead><tr><th scope="col">Work / owner</th><th scope="col">Stage / status</th><th scope="col">Timeline evidence</th><th scope="col">Next action</th></tr></thead><tbody>' + items.map(x => {
      const old = now - date(x.observed_at) >= STALE_MS;
      const periods = x.periods.map(p => esc(p.kind === 'planned' ? 'Planned' : 'Recorded') + ' ' + esc(LABELS[STAGES.indexOf(p.stage)]) + ': ' + esc(p.start) + ' → ' + esc(p.end)).join('<br>');
      return '<tr><td><a href="'+esc(x.source)+'" target="_blank" rel="noopener noreferrer">'+esc(x.title)+'</a><small>'+esc(x.project)+' · '+esc(x.owner)+'</small><small>'+esc(x.assignment)+'</small></td><td><span class="og-badge">'+esc(LABELS[STAGES.indexOf(x.stage)])+'</span><small>'+esc(x.status)+(old ? ' · stale observation' : '')+'</small></td><td>'+(periods || 'Dates not scheduled / not evidenced')+'<small>'+esc(x.evidence)+'</small><small>Observed '+esc(x.observed_at)+'</small></td><td>'+esc(x.next)+'</td></tr>';
    }).join('') + '</tbody></table></div>';
  }
  function chartConfig(items) {
    const datasets = [];
    STAGES.forEach((stage, i) => ['actual','planned'].forEach(kind => {
      const points = [];
      items.forEach((x, row) => x.periods.filter(p => p.stage === stage && p.kind === kind).forEach(p =>
        points.push({x:[date(p.start),date(p.end)],y:x.id,row})));
      if (points.length) datasets.push({label:LABELS[i]+' · '+(kind === 'actual'?'recorded':'planned'),data:points,
        backgroundColor:kind === 'actual'?COLORS[i]:COLORS[i]+'25',borderColor:COLORS[i],borderWidth:2,
        grouped:false,barThickness:13,minBarLength:3});
    }));
    const times = items.flatMap(x => x.periods.flatMap(p => [date(p.start),date(p.end)]));
    const fmt = v => new Date(Number(v)).toLocaleString('en-GB',{timeZone:'UTC',month:'short',day:'2-digit',hour:'2-digit',minute:'2-digit'});
    return {type:'bar',data:{labels:items.map(x=>x.id),datasets},options:{indexAxis:'y',responsive:true,maintainAspectRatio:false,animation:false,
      scales:{x:{type:'linear',min:times.length?Math.min(...times)-300000:undefined,max:times.length?Math.max(...times)+300000:undefined,
        title:{display:true,text:'Recorded / planned timeline (UTC)'},ticks:{maxTicksLimit:7,callback:fmt}},
        y:{type:'category',grid:{display:false},ticks:{autoSkip:false,callback:v=>items[v]?items[v].title+' · '+items[v].owner:''}}},
      plugins:{legend:{position:'bottom'},tooltip:{callbacks:{title:ctx=>{const p=ctx[0]; return items[p.raw.row].title;},label:ctx=>ctx.dataset.label+': '+fmt(ctx.raw.x[0])+' → '+fmt(ctx.raw.x[1])}}}}};
  }
  function mount(doc, win) {
    const host = doc.getElementById('delivery-gantt');
    if (!host) return;
    let state = {snapshot:null,failed:false}, chart = null, busy = false;
    const filters = {project:'',owner:'',stage:''};
    host.innerHTML = '<header class="og-heading"><div><p class="og-kicker">Delivery overview</p><h2>Work, owners &amp; release timeline</h2></div><button type="button" id="og-refresh">Refresh</button></header><p id="og-freshness" role="status">Loading delivery snapshot…</p><div id="og-filters" class="og-filters"></div><div id="og-stages" class="og-stages" aria-label="Delivery stages"></div><p class="og-note">Solid bars: recorded intervals. Outlined bars: plans, not promises. Undated work stays in the list. Merged code is not production proof.</p><div class="og-chart-scroll" tabindex="0" role="region" aria-label="Scrollable delivery Gantt"><div id="og-chart-box"><canvas id="og-chart" role="img" aria-label="Delivery Gantt; equivalent evidence is in the work table below"></canvas></div></div><p id="og-chart-note" class="og-note"></p><div id="og-rows"></div>';
    const el = id => doc.getElementById(id);
    function clock() {
      const message = freshness(state.snapshot,Date.now(),state.failed);
      if (el('og-freshness').textContent !== message) el('og-freshness').textContent = message;
    }
    function draw() {
      clock();
      const items = select(state.snapshot ? state.snapshot.items : [],filters);
      el('og-stages').innerHTML = STAGES.map((s,i)=>'<span><b>'+LABELS[i]+'</b> '+items.filter(x=>x.stage===s).length+'</span>').join('');
      el('og-rows').innerHTML = renderRows(items,Date.now());
      if (chart) { chart.destroy(); chart=null; }
      const hasDates = items.some(x=>x.periods.length);
      el('og-chart-note').textContent = !hasDates ? 'No evidenced or planned dates for this selection yet.' :
        !win.Chart ? 'Chart library unavailable. All dates and owners remain available in the table.' : 'Open a work item for its source. A current stage is a recorded observation, not proof an agent is online.';
      el('og-chart-box').hidden = !hasDates || !win.Chart;
      if (hasDates && win.Chart) {
        el('og-chart-box').style.height = Math.max(260,items.length*45+100)+'px';
        chart = new win.Chart(el('og-chart'),chartConfig(items));
      }
    }
    function setupFilters() {
      const items = state.snapshot ? state.snapshot.items : [];
      el('og-filters').innerHTML = ['project','owner','stage'].map(k=>{
        const values = k==='stage'?STAGES:[...new Set(items.map(x=>x[k]))].sort();
        if (!values.includes(filters[k])) filters[k]='';
        return '<label>'+k[0].toUpperCase()+k.slice(1)+'<select id="og-'+k+'"><option value="">All '+k+'s</option>'+values.map(v=>'<option value="'+esc(v)+'"'+(v===filters[k]?' selected':'')+'>'+esc(k==='stage'?LABELS[STAGES.indexOf(v)]:v)+'</option>').join('')+'</select></label>';
      }).join('');
      Object.keys(filters).forEach(k=>el('og-'+k).addEventListener('change',()=>{filters[k]=el('og-'+k).value;draw();}));
    }
    async function refresh() {
      if (busy) return;
      busy=true; el('og-refresh').disabled=true;
      const controller = new AbortController();
      const timeout = win.setTimeout(()=>controller.abort(),10000);
      try {
        const res = await win.fetch('/data/ops-delivery.json',{cache:'no-store',signal:controller.signal});
        if (!res.ok) throw Error('Snapshot fetch failed');
        const body = await res.text();
        if (body.length > 200000) throw Error('Oversized snapshot');
        state = accept(state,JSON.parse(body),Date.now());
      } catch (_) { state=fail(state); }
      finally { win.clearTimeout(timeout);busy=false;el('og-refresh').disabled=false;setupFilters();draw(); }
    }
    el('og-refresh').addEventListener('click',refresh);
    refresh();
    const ageTimer=win.setInterval(clock,1000), refreshTimer=win.setInterval(()=>{if(!doc.hidden) refresh();},120000);
    win.addEventListener('pagehide',(event={})=>{if(event.persisted)return;win.clearInterval(ageTimer);win.clearInterval(refreshTimer);if(chart)chart.destroy();});
    win.addEventListener('pageshow',event=>{if(event.persisted){clock();refresh();}});
  }
  return {STAGES,STALE_MS,esc,safeLink,validate,select,freshness,accept,fail,renderRows,chartConfig,mount};
});
