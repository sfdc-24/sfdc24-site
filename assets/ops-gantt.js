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
    return {schema_version:1, observed_at:raw.observed_at, items};
  }
  function select(items, filters) {
    return items.filter(x => ['project','owner','stage'].every(k => !filters[k] || filters[k] === x[k]));
  }
  function freshness(snapshot, now, failed, notice) {
    if (!snapshot) return 'Delivery data unavailable — retry refresh. No progress inferred.';
    const minutes = Math.max(0, Math.floor((now - date(snapshot.observed_at)) / 60000));
    const age = (now - date(snapshot.observed_at) >= STALE_MS ? 'STALE · ' : 'Published snapshot · ') +
      minutes + 'm old · observed ' + snapshot.observed_at + ' · checks every 120s, not live activity';
    if (failed) return 'Refresh failed — retained snapshot. ' + age;
    if (notice === 'hosted-older') return 'Hosted snap is older than this bake. ' + age;
    return age;
  }
  function ageBrief(snapshot, now, failed, notice) {
    if (!snapshot) return 'Delivery data unavailable. No progress inferred.';
    const minutes = Math.max(0, Math.floor((now - date(snapshot.observed_at)) / 60000));
    const bits = [];
    if (failed) bits.push('Refresh failed.');
    else if (notice === 'hosted-older') bits.push('Hosted snap is older.');
    if (now - date(snapshot.observed_at) >= STALE_MS) bits.push('STALE.');
    bits.push('Observed ' + snapshot.observed_at + ' · ' + minutes + 'm old · not live activity');
    return bits.join(' ');
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
  const ROLES = [
    {id:'experience', title:'Experience'},
    {id:'qa', title:'QA'},
    {id:'okf', title:'OKF flow'},
    {id:'build', title:'Build'},
    {id:'delivery', title:'Delivery'}
  ];
  const ROLE_OWNERS = {
    experience:'experience', 'experience lead':'experience',
    qa:'qa', 'qa/architecture':'qa',
    'okf flow':'okf', build:'build',
    delivery:'delivery', 'delivery lead':'delivery'
  };
  function roleOf(item) {
    if (!item || typeof item.owner !== 'string') return null;
    return ROLE_OWNERS[item.owner.trim().toLowerCase()] || null;
  }
  function countRate(part, total) {
    if (!total) return 'not computed';
    return part + ' of ' + total + ' (' + Math.round((part / total) * 100) + '%)';
  }
  function conferenceReport(items) {
    const list = Array.isArray(items) ? items : [];
    const conference = list.filter(x => x && x.project === 'Conference');
    const lanes = ROLES.map(role => {
      const rows = conference.filter(x => roleOf(x) === role.id);
      return {
        id:role.id, title:role.title, rows,
        blocked:rows.filter(x => x.status === 'blocked').length,
        verified:rows.filter(x => x.status === 'verified').length
      };
    });
    return {
      lanes, conference, untagged:conference.filter(x => !roleOf(x)), total:list.length,
      blocked:list.filter(x => x && x.status === 'blocked').length,
      verified:list.filter(x => x && x.status === 'verified').length,
      openGates:list.filter(x => x && (x.status === 'pending' || x.status === 'blocked')).length
    };
  }
  function domainOf(rows) {
    const times = [];
    rows.forEach(x => (Array.isArray(x.periods) ? x.periods : []).forEach(p => {
      const start = date(p.start), end = date(p.end);
      if (start !== null) times.push(start);
      if (end !== null) times.push(end);
    }));
    if (!times.length) return null;
    const min = Math.min.apply(null, times), max = Math.max.apply(null, times);
    return {min, max, span:Math.max(max - min, 60000)};
  }
  function bars(periods, domain) {
    return (Array.isArray(periods) ? periods : []).map(p => {
      const start = date(p.start), end = date(p.end);
      if (start === null || end === null || !domain) return '';
      const width = Math.max(((end - start) / domain.span) * 100, end === start ? 2 : 0.8);
      const left = Math.min(Math.max(((start - domain.min) / domain.span) * 100, 0), 100 - width);
      const kind = p.kind === 'planned' ? 'planned' : 'recorded';
      return '<i class="conf-bar is-' + kind + '" style="left:' + left.toFixed(2) + '%;width:' + width.toFixed(2) + '%"></i>';
    }).join('');
  }
  function laneRow(name, detail, periods, domain) {
    const drawn = domain && Array.isArray(periods) && periods.length;
    const track = drawn
      ? '<div class="conf-track">' + bars(periods, domain) + '</div>'
      : '<div class="conf-track is-empty"><span>No dated interval</span></div>';
    return '<div class="conf-lane"><div class="conf-lane-name"><b>' + esc(name) + '</b><small>' + esc(detail) + '</small></div>' + track + '</div>';
  }
  function stamp(ms) {
    return new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  }
  function renderConference(items) {
    const report = conferenceReport(items);
    const tagged = report.conference.length - report.untagged.length;
    const confBlocked = report.conference.filter(x => x.status === 'blocked').length;
    const share = report.conference.length ? countRate(tagged, report.conference.length) : 'not computed';
    const metrics = [
      ['is-gap', 'Not measured', 'Utilization', '—',
        'Estimated item share, where owner is exactly a role title: ' + share + '. Not time-on-task, and not an idle measurement. Recorded PR windows are not working time.'],
      ['is-estimated', 'Estimated', 'Error rate (rework)', countRate(report.blocked, report.total),
        'Nearest whole percent of snapshot rows with status blocked (' + confBlocked + ' of them are Conference). Not a measured defect rate.'],
      ['is-estimated', 'Estimated', 'Poka-yoke', countRate(report.verified, report.total),
        'Verified receipts are the closed-loop signal in this feed. Not a scored prevention index.'],
      ['is-estimated', 'Estimated', 'Continuous improvement', countRate(report.openGates, report.total),
        'Open gates are pending or blocked rows, set against verified receipts. Not a sampled improvement rate.']
    ];
    const cards = '<div class="conf-metrics">' + metrics.map(row =>
      '<article class="conf-stat"><span class="conf-basis ' + row[0] + '">' + esc(row[1]) + '</span><b>' + esc(row[2]) + '</b><strong>' + esc(row[3]) + '</strong><small>' + esc(row[4]) + '</small></article>'
    ).join('') + '</div>';
    const domain = domainOf(report.conference);
    const axis = domain
      ? '<p class="conf-axis"><span>' + esc(stamp(domain.min)) + '</span><span>' + esc(stamp(domain.max)) + '</span></p>'
      : '';
    const roleRows = report.lanes.map(lane => {
      const periods = lane.rows.flatMap(x => Array.isArray(x.periods) ? x.periods : []);
      const names = lane.rows.map(x => x.title).filter(Boolean).join(', ');
      const detail = (names ? names + '. ' : '') + 'Measured utilization: not measured. Estimated item share: '
        + (report.conference.length ? countRate(lane.rows.length, report.conference.length) : 'not computed')
        + '. Rework: ' + lane.blocked + ' blocked. Poka-yoke: ' + lane.verified + ' verified.';
      return laneRow(lane.title, detail, periods, domain);
    }).join('');
    const recorded = report.untagged.filter(x => Array.isArray(x.periods) && x.periods.length);
    const undated = report.untagged.filter(x => !Array.isArray(x.periods) || !x.periods.length);
    let untaggedBlock;
    if (!report.conference.length) {
      untaggedBlock = '<p class="conf-note">No Conference rows in this snapshot. Role lanes stay empty. No bars invented.</p>';
    } else {
      const recordedRows = recorded.map(x => laneRow(
        x.title,
        'Role not tagged. ' + (x.stage || 'stage unset') + ' · ' + (x.status || 'status unset') + '. Estimated placement withheld.',
        x.periods, domain)).join('')
        || '<p class="conf-note">No recorded interval on an untagged conference row.</p>';
      const undatedList = undated.length
        ? '<ul class="conf-undated">' + undated.map(x => '<li>' + esc(x.title) + ' <small>' + esc(x.stage || '') + ' · ' + esc(x.status || '') + ' · undated, no bar</small></li>').join('') + '</ul>'
        : '<p class="conf-note">No undated conference rows.</p>';
      untaggedBlock = '<h3>Recorded conference intervals</h3><p class="conf-note">These rows stay off the role lanes. The snapshot owner is not a role title, and this strip does not rename it.</p>'
        + recordedRows + '<h3>Undated conference rows</h3>' + undatedList;
    }
    return cards + '<h3>Role lanes</h3><p class="conf-note">Solid bars are recorded intervals. Outlined bars are plans. A role lane accepts a row only when owner is that title.</p>'
      + axis + roleRows + untaggedBlock;
  }
  function mount(doc, win) {
    const host = doc.getElementById('delivery-gantt');
    if (!host) return;
    let state = {snapshot:null,failed:false}, chart = null, busy = false;
    const filters = {project:'',owner:'',stage:''};
    host.innerHTML = '<header class="og-heading"><div><p class="og-kicker">Delivery overview</p><h2>Work, owners &amp; release timeline</h2></div><button type="button" id="og-refresh">Refresh</button></header><p id="og-freshness" role="status">Loading delivery snapshot…</p><div id="og-filters" class="og-filters"></div><div id="og-stages" class="og-stages" aria-label="Delivery stages"></div><p class="og-note">Solid bars: recorded intervals. Outlined bars: plans, not promises. Undated work stays in the list. Merged code is not production proof.</p><div class="og-chart-scroll" tabindex="0" role="region" aria-label="Scrollable delivery Gantt"><div id="og-chart-box"><canvas id="og-chart" role="img" aria-label="Delivery Gantt; equivalent evidence is in the work table below"></canvas></div></div><p id="og-chart-note" class="og-note"></p><div id="og-rows"></div>';
    const el = id => doc.getElementById(id);
    function clock() {
      const message = freshness(state.snapshot,Date.now(),state.failed,state.notice);
      if (el('og-freshness').textContent !== message) el('og-freshness').textContent = message;
      const brief = ageBrief(state.snapshot,Date.now(),state.failed,state.notice);
      const age = doc.getElementById('ops-data-age');
      if (age && age.textContent !== brief) age.textContent = brief;
    }
    function draw() {
      clock();
      const items = select(state.snapshot ? state.snapshot.items : [],filters);
      el('og-stages').innerHTML = STAGES.map((s,i)=>'<span><b>'+LABELS[i]+'</b> '+items.filter(x=>x.stage===s).length+'</span>').join('');
      el('og-rows').innerHTML = renderRows(items,Date.now());
      el('conference-lanes').innerHTML = renderConference(state.snapshot ? state.snapshot.items : []);
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
    async function loadUrl(url) {
      const controller = new AbortController();
      const timeout = win.setTimeout(()=>controller.abort(),10000);
      try {
        const res = await win.fetch(url,{cache:'no-store',credentials:'omit',signal:controller.signal});
        if (!res.ok) throw Error('Snapshot fetch failed');
        const body = await res.text();
        if (body.length > 200000) throw Error('Oversized snapshot');
        return JSON.parse(body);
      } finally { win.clearTimeout(timeout); }
    }
    function validated(raw, now) {
      try { return validate(raw, now); } catch (_) { return null; }
    }
    async function refresh() {
      if (busy) return;
      busy=true; el('og-refresh').disabled=true;
      // Hosted snap first, then the checked-in bake. Keep the newer observation.
      // A failed hosted read stays a visible failure. An older hosted snap does
      // not hide a newer bake and is not described as live activity.
      let hosted=null, local=null;
      try { hosted=validated(await loadUrl(SNAPSHOT_URL),Date.now()); } catch (_) {}
      try { local=validated(await loadUrl('/data/ops-delivery.json'),Date.now()); } catch (_) {}
      const hostedAt=hosted?date(hosted.observed_at):-1, localAt=local?date(local.observed_at):-1;
      let chosen=null, notice='';
      if (hosted && local && localAt>hostedAt) { chosen=local; notice='hosted-older'; }
      else if (hosted) chosen=hosted;
      else if (local) { chosen=local; notice='hosted-failed'; }
      if (!chosen) state=fail(state);
      else {
        const next=accept(state,chosen,Date.now());
        if (next.failed) state=next;
        else if (notice==='hosted-failed') state={snapshot:next.snapshot,failed:true};
        else state={snapshot:next.snapshot,failed:false,notice};
      }
      busy=false;el('og-refresh').disabled=false;setupFilters();draw();
    }
    el('og-refresh').addEventListener('click',refresh);
    refresh();
    const ageTimer=win.setInterval(clock,1000), refreshTimer=win.setInterval(()=>{if(!doc.hidden) refresh();},120000);
    win.addEventListener('pagehide',(event={})=>{if(event.persisted)return;win.clearInterval(ageTimer);win.clearInterval(refreshTimer);if(chart)chart.destroy();});
    win.addEventListener('pageshow',event=>{if(event.persisted){clock();refresh();}});
  }
  return {STAGES,STALE_MS,SNAPSHOT_URL,ROLES,esc,safeLink,validate,select,freshness,ageBrief,accept,fail,renderRows,chartConfig,roleOf,countRate,conferenceReport,renderConference,mount};
});
