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
  const FLEET = ['Grok', 'Claude', 'Codex', 'Gemini', 'Copilot', 'Cursor'];
  const STALE_MS = 30 * 60000;
  const SNAPSHOT_URL = 'https://raw.githubusercontent.com/sfdc-24/sfdc24-site/ops-delivery-snap/data/ops-delivery.json';
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
    const snapshot = {schema_version:1, observed_at:raw.observed_at, items};
    if (raw.milestones != null) snapshot.milestones = cleanMilestones(raw.milestones, stamp);
    return snapshot;
  }
  function cleanMilestones(raw, stamp) {
    if (!Array.isArray(raw) || raw.length > 20) throw Error('Invalid delivery milestones');
    const ids = new Set();
    return raw.map(m => {
      if (!m || !text(m.id, 80) || ids.has(m.id) || !text(m.label, 80) || !text(m.project, 80) ||
          !text(m.evidence, 400) || !['recorded','planned'].includes(m.status) || date(m.at) === null ||
          !safeLink(m.source) || (m.status === 'recorded' && date(m.at) > stamp)) throw Error('Invalid delivery milestone');
      ids.add(m.id);
      return {id:m.id, label:m.label, project:m.project, at:m.at, status:m.status,
        evidence:m.evidence, source:safeLink(m.source)};
    });
  }
  function lanes(items) {
    const groups = new Map();
    items.forEach(item => {
      if (!groups.has(item.owner)) groups.set(item.owner, []);
      groups.get(item.owner).push(item);
    });
    return [...groups.keys()].sort((a, b) => {
      const ia = FLEET.indexOf(a), ib = FLEET.indexOf(b);
      return (ia < 0 ? FLEET.length : ia) - (ib < 0 ? FLEET.length : ib) || a.localeCompare(b);
    }).map(owner => {
      const rows = groups.get(owner);
      return {id:'lane:'+owner, title:rows.length === 1 ? rows[0].title : rows.length+' work items',
        owner, periods:rows.flatMap(row => row.periods.map(period => ({...period, work:row.title})))};
    });
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
  function chartConfig(items, milestones, now) {
    const marks = Array.isArray(milestones) ? milestones : [];
    const datasets = [];
    STAGES.forEach((stage, i) => ['actual','planned'].forEach(kind => {
      const points = [];
      items.forEach((x, row) => x.periods.filter(p => p.stage === stage && p.kind === kind).forEach(p =>
        points.push({x:[date(p.start),date(p.end)],y:x.id,row,work:p.work})));
      if (points.length) datasets.push({label:LABELS[i]+' · '+(kind === 'actual'?'recorded':'planned'),data:points,
        backgroundColor:kind === 'actual'?COLORS[i]:COLORS[i]+'25',borderColor:COLORS[i],borderWidth:2,
        grouped:false,barThickness:13,minBarLength:3});
    }));
    const times = items.flatMap(x => x.periods.flatMap(p => [date(p.start),date(p.end)])).concat(marks.map(m => date(m.at)));
    const pad = marks.length ? 900000 : 300000;
    const fmt = v => new Date(Number(v)).toLocaleString('en-GB',{timeZone:'UTC',month:'short',day:'2-digit',hour:'2-digit',minute:'2-digit'});
    const config = {type:'bar',data:{labels:items.map(x=>x.id),datasets},options:{indexAxis:'y',responsive:true,maintainAspectRatio:false,animation:false,
      scales:{x:{type:'linear',min:times.length?Math.min(...times)-pad:undefined,max:times.length?Math.max(...times)+pad:undefined,
        title:{display:true,text:'Recorded / planned timeline (UTC)'},ticks:{maxTicksLimit:7,callback:fmt}},
        y:{type:'category',grid:{display:false},ticks:{autoSkip:false,callback:v=>items[v]?items[v].title+' · '+items[v].owner:''}}},
      plugins:{legend:{position:'bottom'},ogMilestones:marks,ogNow:typeof now === 'number' ? now : null,
        tooltip:{callbacks:{title:ctx=>{const p=ctx[0]; return p.raw.work || items[p.raw.row].title;},label:ctx=>ctx.dataset.label+': '+fmt(ctx.raw.x[0])+' → '+fmt(ctx.raw.x[1])}}}}};
    if (marks.length || typeof now === 'number') config.plugins = [{id:'ogMilestones', afterDraw(chart) {
      const area = chart.chartArea, scale = chart.scales && chart.scales.x, ctx = chart.ctx;
      const drawn = chart.options.plugins.ogMilestones || [];
      const marker = chart.options.plugins.ogNow;
      if (!area || !scale || !ctx) return;
      ctx.save();
      if (typeof marker === 'number' && marker >= scale.min && marker <= scale.max) {
        const nx = scale.getPixelForValue(marker);
        ctx.strokeStyle = '#1762a7'; ctx.lineWidth = 1; ctx.setLineDash([2,3]);
        ctx.beginPath(); ctx.moveTo(nx, area.top); ctx.lineTo(nx, area.bottom); ctx.stroke();
      }
      drawn.forEach((mark, i) => {
        const at = date(mark.at);
        if (at === null || at < scale.min || at > scale.max) return;
        const px = scale.getPixelForValue(at);
        ctx.strokeStyle = mark.status === 'planned' ? '#1762a7' : '#15803d';
        ctx.lineWidth = 2; ctx.setLineDash(mark.status === 'planned' ? [4,3] : []);
        ctx.beginPath(); ctx.moveTo(px, area.top); ctx.lineTo(px, area.bottom); ctx.stroke();
        ctx.fillStyle = '#172338'; ctx.font = '11px system-ui,sans-serif';
        const width = typeof ctx.measureText === 'function' ? ctx.measureText(mark.label).width : 72;
        const y = area.top + 12 + (i % 5) * 12;
        if (px + 6 + width > area.right - 4) {
          ctx.textAlign = 'right';
          ctx.fillText(mark.label, Math.max(area.left + width + 4, px - 4), y);
        } else {
          ctx.textAlign = 'left';
          ctx.fillText(mark.label, Math.max(area.left + 4, px + 4), y);
        }
      });
      ctx.restore();
    }}];
    return config;
  }
  function mount(doc, win) {
    const host = doc.getElementById('delivery-gantt');
    if (!host) return;
    let state = {snapshot:null,failed:false}, chart = null, busy = false;
    const filters = {project:'',owner:'',stage:''};
    host.innerHTML = '<header class="og-heading"><div><p class="og-kicker">Delivery overview</p><h2>Work, owners &amp; release timeline</h2></div><button type="button" id="og-refresh">Refresh</button></header><p id="og-freshness" role="status">Loading delivery snapshot…</p><div id="og-filters" class="og-filters"></div><div id="og-stages" class="og-stages" aria-label="Delivery stages"></div><div id="og-milestones" class="og-milestones"></div><p class="og-note">Solid bars: recorded intervals. Outlined bars: plans, not promises. Lines: sourced milestones. Undated work stays in the list. Merged code is not production proof.</p><div class="og-chart-scroll" tabindex="0" role="region" aria-label="Scrollable delivery Gantt"><div id="og-chart-box"><canvas id="og-chart" role="img" aria-label="Delivery Gantt; equivalent evidence is in the work table below"></canvas></div></div><p id="og-chart-note" class="og-note"></p><div id="og-rows"></div>';
    const el = id => doc.getElementById(id);
    function clock() {
      const message = freshness(state.snapshot,Date.now(),state.failed);
      if (el('og-freshness').textContent !== message) el('og-freshness').textContent = message;
    }
    function draw() {
      clock();
      const items = select(state.snapshot ? state.snapshot.items : [],filters);
      const marks = ((state.snapshot && state.snapshot.milestones) || []).filter(m => !filters.project || m.project === filters.project);
      const chartItems = filters.project ? lanes(items) : items;
      el('og-stages').innerHTML = STAGES.map((s,i)=>'<span><b>'+LABELS[i]+'</b> '+items.filter(x=>x.stage===s).length+'</span>').join('');
      el('og-milestones').innerHTML = marks.map(m => '<span>'+esc(m.status === 'planned' ? 'Planned' : 'Recorded')+' · '+esc(m.label)+'<small>'+esc(m.at)+'</small><small>'+esc(m.evidence)+'</small></span>').join('');
      el('og-rows').innerHTML = renderRows(items,Date.now());
      if (chart) { chart.destroy(); chart=null; }
      const hasDates = chartItems.some(x=>x.periods.length) || marks.length > 0;
      const latest = marks.filter(m => m.status === 'planned').sort((a,b) => date(a.at) - date(b.at)).pop();
      el('og-chart-note').textContent = !hasDates ? 'No evidenced or planned dates for this selection yet.' :
        !win.Chart ? 'Chart library unavailable. All dates and owners remain available in the table.' :
        'Open a work item for its source. A current stage is a recorded observation, not proof an agent is online.' +
        (latest ? ' Latest planned gate: '+latest.label+' at '+latest.at+'. A planned gate is not acceptance.' : '');
      el('og-chart-box').hidden = !hasDates || !win.Chart;
      if (hasDates && win.Chart) {
        el('og-chart-box').style.height = Math.max(260,Math.max(chartItems.length,1)*45+100)+'px';
        chart = new win.Chart(el('og-chart'),chartConfig(chartItems,marks,Date.now()));
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
    async function readSnapshot(url) {
      const controller = new AbortController();
      const timeout = win.setTimeout(()=>controller.abort(),10000);
      try {
        const res = await win.fetch(url,{cache:'no-store',credentials:'omit',signal:controller.signal});
        if (!res.ok) throw Error('Snapshot fetch failed');
        const body = await res.text();
        if (body.length > 200000) throw Error('Oversized snapshot');
        const candidate = accept(state,JSON.parse(body),Date.now());
        if (candidate.failed) throw Error('Invalid snapshot');
        return candidate;
      } finally { win.clearTimeout(timeout); }
    }
    async function refresh() {
      if (busy) return;
      busy=true; el('og-refresh').disabled=true;
      try {
        state = await readSnapshot(SNAPSHOT_URL);
      } catch (_) {
        // Only bootstrap from the checked-in receipt. Never replace a newer
        // retained hosted snapshot with old fallback data after a failed poll.
        if (!state.snapshot) {
          try { state=await readSnapshot('/data/ops-delivery.json'); } catch (_) {}
        }
        state=fail(state);
      } finally { busy=false;el('og-refresh').disabled=false;setupFilters();draw(); }
    }
    el('og-refresh').addEventListener('click',refresh);
    refresh();
    const ageTimer=win.setInterval(clock,1000), refreshTimer=win.setInterval(()=>{if(!doc.hidden) refresh();},120000);
    win.addEventListener('pagehide',(event={})=>{if(event.persisted)return;win.clearInterval(ageTimer);win.clearInterval(refreshTimer);if(chart)chart.destroy();});
    win.addEventListener('pageshow',event=>{if(event.persisted){clock();refresh();}});
  }
  return {STAGES,FLEET,STALE_MS,SNAPSHOT_URL,esc,safeLink,validate,lanes,select,freshness,accept,fail,renderRows,chartConfig,mount};
});
