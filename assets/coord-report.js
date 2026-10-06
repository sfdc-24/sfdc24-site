/* Coordination read for Ops, Process, and Method.
   The published delivery snapshot answers. Redis is not opened in the browser.
   A Cloud Run route may later serve a shadow of the same shape. See docs/COORD-REDIS.md.
   No AUTH string, no Redis URL, and no query-string override. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else {
    root.CoordReport = api;
    if (root.document) api.mountAll(root.document, root);
  }
})(typeof window === 'undefined' ? globalThis : window, function () {
  'use strict';

  const STAGES = ['backlog', 'dev', 'staging', 'test', 'production'];
  const STATUSES = ['recorded', 'blocked', 'pending', 'verified'];
  const GATES = {backlog:'Backlog', dev:'Development', staging:'Staging', test:'Test', production:'Production'};
  const GATE_ORDER = {dev:0, staging:1, test:2, production:3, backlog:4};
  const READ_KEYS = {
    rollup: {redis:'blackboard:coord:v1:rollup', dual_run_key:'coord:v1:rollup'},
    fleet: {redis:'blackboard:coord:v1:fleet', dual_run_key:'coord:v1:fleet'},
    projects: {redis:'blackboard:coord:v1:projects', dual_run_key:'coord:v1:projects'},
    tasks: {redis:'blackboard:coord:v1:tasks', dual_run_key:'coord:v1:tasks'},
    okf: {redis:'blackboard:coord:v1:okf', dual_run_key:'coord:v1:okf'},
    blockers: {redis:'blackboard:coord:v1:blockers', dual_run_key:'coord:v1:blockers'}
  };
  const FLEET = [
    {id:'claude', name:'Claude', role:'Redis governance and control'},
    {id:'grok', name:'Grok', role:'Strategic lead and execution C2'},
    {id:'codex', name:'Codex', role:'Verifies'},
    {id:'gemini', name:'Gemini', role:'Next-phase architecture'},
    {id:'cursor', name:'Cursor', role:'Exact-head review support'}
  ];
  const DEFAULT_FLAG = {
    schema: 'sfdc24.coord.flag.v1',
    dual_run: 'off',
    redis_answers: false,
    site_authoritative: true,
    api: '',
    site_snapshot: '/data/ops-delivery.json',
    key_prefix: 'blackboard:',
    keys: READ_KEYS
  };
  const LEADS = {
    ops: 'The published delivery snapshot is authoritative. This strip is the Redis reporting surface. It stays dark until the dual-run is on. Conference action items above are unchanged.',
    process: 'Delivery gates on each project: what is in progress, and what has landed. Landed means production and verified. A merge is not landed. Redis is not contacted.',
    method: 'Same read as Ops and Process. Counts come from the published snapshot. This page does not become a second board, and it does not require Redis.'
  };
  const MODES = ['ops', 'process', 'method'];
  const state = new WeakMap();
  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

  function dateOk(v) {
    return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(v) && Number.isFinite(Date.parse(v));
  }
  function textOk(v, n) {
    return typeof v === 'string' && v.length > 0 && v.length <= n && /[A-Za-z]/.test(v);
  }
  function safeLink(v) {
    try {
      const u = new URL(v);
      return u.protocol === 'https:' && !u.port && !u.username && !u.password &&
        ((u.hostname === 'github.com' && u.pathname.startsWith('/sfdc-24/')) ||
         (u.hostname === 'www.sfdc24.com' && u.pathname.startsWith('/'))) ? u.href : '';
    } catch (_) { return ''; }
  }
  function safeDataPath(v, fallback) {
    if (typeof v !== 'string' || !/^\/data\/[a-z0-9._/-]+\.json$/.test(v) || v.indexOf('..') >= 0) return fallback;
    return v;
  }
  function safeApi(v) {
    return v === '/api/coord' || v === '/api/coord/' ? '/api/coord' : '';
  }
  function isLanded(item) {
    return item.stage === 'production' && item.status === 'verified';
  }
  function itemOk(x) {
    return !!x && typeof x.id === 'string' && /^[a-z0-9-]{1,80}$/.test(x.id) &&
      textOk(x.title, 180) && textOk(x.project, 80) && textOk(x.owner, 100) &&
      typeof x.next === 'string' && x.next.length > 0 && x.next.length <= 400 &&
      STAGES.indexOf(x.stage) >= 0 && STATUSES.indexOf(x.status) >= 0;
  }
  function taskRow(x) {
    return {
      id: x.id,
      title: x.title,
      project: x.project,
      owner: x.owner,
      stage: x.stage,
      gate: GATES[x.stage],
      status: x.status,
      next: x.next,
      source: safeLink(x.source),
      landed: isLanded(x)
    };
  }
  function compareTask(a, b) {
    const ab = a.status === 'blocked' ? 0 : 1;
    const bb = b.status === 'blocked' ? 0 : 1;
    if (ab !== bb) return ab - bb;
    const g = (GATE_ORDER[a.stage] == null ? 9 : GATE_ORDER[a.stage]) - (GATE_ORDER[b.stage] == null ? 9 : GATE_ORDER[b.stage]);
    if (g) return g;
    return a.title < b.title ? -1 : a.title > b.title ? 1 : 0;
  }
  function validateSnapshot(raw) {
    if (!raw || raw.schema_version !== 1 || !dateOk(raw.observed_at) || !Array.isArray(raw.items) || raw.items.length > 100) return null;
    const ids = new Set();
    const items = [];
    for (let i = 0; i < raw.items.length; i++) {
      const x = raw.items[i];
      if (!itemOk(x) || ids.has(x.id)) return null;
      ids.add(x.id);
      items.push(taskRow(x));
    }
    return {schema_version:1, observed_at:raw.observed_at, items};
  }
  function rollup(items) {
    const by = new Map();
    const blockers = [];
    items.forEach(item => {
      if (!by.has(item.project)) by.set(item.project, {project:item.project, in_progress:[], landed:[]});
      const bucket = by.get(item.project);
      if (item.landed) bucket.landed.push(item);
      else bucket.in_progress.push(item);
      if (item.status === 'blocked') blockers.push(item);
    });
    const projects = Array.from(by.values()).sort((a, b) =>
      (b.in_progress.length - a.in_progress.length) || (a.project < b.project ? -1 : 1));
    projects.forEach(p => { p.in_progress.sort(compareTask); p.landed.sort(compareTask); });
    blockers.sort(compareTask);
    return {projects, blockers, tasks:items.slice()};
  }
  function parseFlag(raw) {
    const flag = {
      schema: DEFAULT_FLAG.schema,
      dual_run: 'off',
      redis_answers: false,
      site_authoritative: true,
      api: '',
      site_snapshot: DEFAULT_FLAG.site_snapshot,
      key_prefix: 'blackboard:',
      keys: READ_KEYS
    };
    if (!raw || raw.schema !== 'sfdc24.coord.flag.v1') return flag;
    if (raw.dual_run === 'shadow' || raw.dual_run === 'live' || raw.dual_run === 'off') flag.dual_run = raw.dual_run;
    flag.api = safeApi(raw.api);
    flag.site_snapshot = safeDataPath(raw.site_snapshot, DEFAULT_FLAG.site_snapshot);
    return flag;
  }
  function flagAllowsShadow(flag) {
    return !!flag && (flag.dual_run === 'shadow' || flag.dual_run === 'live') && !!safeApi(flag.api);
  }
  function endpointsFor(flag) {
    const parsed = parseFlag(flag);
    const api = flagAllowsShadow(parsed) ? safeApi(parsed.api) : '';
    return {
      snapshot: safeDataPath(parsed.site_snapshot, DEFAULT_FLAG.site_snapshot),
      shadow: api,
      control: api ? api + '/controls' : ''
    };
  }
  function buildModel(snapshot, flag) {
    const parsed = parseFlag(flag);
    const rolled = snapshot ? rollup(snapshot.items) : {projects:[], blockers:[], tasks:[]};
    return {
      schema: 'sfdc24.coord.read.v1',
      source: 'site-snapshot',
      authoritative: true,
      dual_run: parsed.dual_run,
      redis_answers: false,
      observed_at: snapshot ? snapshot.observed_at : '',
      redis: {
        attempted: false,
        reason: parsed.dual_run === 'off' ? 'dual-run off' : 'the browser does not open Redis',
        key_prefix: 'blackboard:',
        keys: READ_KEYS
      },
      fleet: FLEET.map(x => ({id:x.id, name:x.name, role:x.role, posture:'named role'})),
      projects: rolled.projects,
      tasks: rolled.tasks,
      blockers: rolled.blockers,
      okf: {
        included: false,
        redis_key: READ_KEYS.okf.redis,
        dual_run_key: READ_KEYS.okf.dual_run_key,
        note: 'The public snapshot has no raw OKF rollup. Nothing is invented here.'
      }
    };
  }
  function shadowVerdict(raw) {
    if (!raw || raw.schema !== 'sfdc24.coord.read.v1' || raw.authoritative === true) return {state:'unread'};
    const projects = Array.isArray(raw.projects) ? raw.projects.length : null;
    const blockers = Array.isArray(raw.blockers) ? raw.blockers.length : null;
    if (projects === null || blockers === null) return {state:'unread'};
    return {state:'read', projects, blockers, observed_at: dateOk(raw.observed_at) ? raw.observed_at : ''};
  }
  function counts(model) {
    return {
      in_progress: model.projects.reduce((n, p) => n + p.in_progress.length, 0),
      landed: model.projects.reduce((n, p) => n + p.landed.length, 0),
      blockers: model.blockers.length,
      projects: model.projects.length
    };
  }
  function titleHtml(item) {
    const label = esc(item.title);
    return item.source ? '<a href="' + esc(item.source) + '" target="_blank" rel="noopener noreferrer">' + label + '</a>' : label;
  }
  function workItem(item, mode, chosen) {
    const hot = item.status === 'blocked' ? ' <span class="coord-hot">Blocked</span>' : '';
    const pick = mode === 'process' && item.status === 'blocked'
      ? '<button type="button" class="coord-btn coord-pick" data-coord-action="choose" data-coord-id="' + esc(item.id) + '">' +
        (chosen === item.id ? 'Chosen' : 'Choose this blocker') + '</button>'
      : '';
    return '<li><p class="coord-title">' + titleHtml(item) + hot + '</p>' +
      '<p class="coord-meta">' + esc(item.gate) + ' · ' + esc(item.status) + ' · ' + esc(item.owner) + '</p>' +
      '<p class="coord-next">' + esc(item.next) + '</p>' + pick + '</li>';
  }
  function projectsBlock(model, mode, chosen) {
    if (!model.projects.length) return '<p class="coord-note">No projects in the snapshot. No progress is inferred.</p>';
    const cards = '<div class="coord-projects">' + model.projects.map(p => {
      const head = '<h3>' + esc(p.project) + '</h3><p class="coord-meta">' +
        p.in_progress.length + ' in progress · ' + p.landed.length + ' landed</p>';
      if (mode !== 'process') return '<article class="coord-project">' + head + '</article>';
      const active = p.in_progress.length
        ? '<ul class="coord-work">' + p.in_progress.map(item => workItem(item, mode, chosen)).join('') + '</ul>'
        : '<p class="coord-note">Nothing in progress on this snapshot.</p>';
      const done = p.landed.length
        ? '<details class="coord-landed"><summary>Landed · ' + p.landed.length + '</summary><ul class="coord-work">' +
          p.landed.map(item => workItem(item, mode, chosen)).join('') + '</ul></details>'
        : '<p class="coord-note">Nothing landed on this snapshot.</p>';
      return '<article class="coord-project">' + head + active + done + '</article>';
    }).join('') + '</div>';
    if (mode === 'ops') return '<details class="coord-shape"><summary>Projects on the snapshot</summary>' + cards + '</details>';
    return cards;
  }
  function render(model, mode, options) {
    const opts = options || {};
    const view = MODES.indexOf(mode) >= 0 ? mode : 'ops';
    const n = counts(model);
    const off = model.dual_run === 'off' || !opts.shadowEnabled;
    const shadowOn = !!opts.shadowEnabled;
    const chosen = opts.chosen || '';
    const canSend = !!opts.controlEnabled && !!chosen && model.blockers.some(b => b.id === chosen);
    const pages = [['/ops/', 'Ops', 'ops'], ['/process/', 'Process', 'process'], ['/method/', 'Method', 'method']];
    const chips = [
      '<li class="is-off">Redis ' + esc(model.dual_run === 'off' ? 'off' : model.dual_run) + '</li>',
      '<li>Site snapshot authoritative</li>',
      '<li>' + n.in_progress + ' in progress</li>',
      '<li>' + n.landed + ' landed</li>',
      '<li' + (n.blockers ? ' class="is-hot"' : '') + '>' + n.blockers + ' snapshot blocker' + (n.blockers === 1 ? '' : 's') + '</li>'
    ];
    const fleetItems = model.fleet.map(a => '<li><b>' + esc(a.name) + '</b><span>' + esc(a.role) + '</span></li>').join('');
    const fleet = view === 'process'
      ? '<ul class="coord-fleet">' + fleetItems + '</ul>'
      : '<p class="coord-note">' + model.fleet.map(a => '<b>' + esc(a.name) + '</b> ' + esc(a.role)).join(' · ') + '</p>';
    const links = pages.map(p => '<a href="' + p[0] + '"' + (p[2] === view ? ' aria-current="page"' : '') + '>' + p[1] + '</a>').join('');
    const observed = model.observed_at ? 'Observed ' + esc(model.observed_at) + '. Not live activity.' : 'Snapshot unread. No progress is inferred.';
    const shape = '<details class="coord-shape"><summary>Redis read shape</summary><p>Prefix <code>blackboard:</code>. ' +
      'Dual-run keys <code>coord:v1:rollup</code>, <code>coord:v1:fleet</code>, <code>coord:v1:projects</code>, ' +
      '<code>coord:v1:tasks</code>, <code>coord:v1:okf</code>, <code>coord:v1:blockers</code>. ' +
      'The wrapper adds the prefix. ' + esc(model.okf.note) + ' Future route <code>GET /api/coord</code>.</p></details>';
    return '<div class="coord" data-coord-state="' + esc(model.dual_run) + '">' +
      '<p class="coord-kicker">Coordination</p>' +
      '<p class="coord-lead">' + esc(LEADS[view]) + '</p>' +
      '<ul class="coord-chips">' + chips.join('') + '</ul>' +
      fleet +
      '<p class="coord-note">Roles for this layer, not a live presence reading. ' + observed + '</p>' +
      '<div class="coord-actions">' +
        '<button type="button" class="coord-btn is-primary" data-coord-action="refresh">Refresh the snapshot</button>' +
        '<button type="button" class="coord-btn" data-coord-action="shadow"' + (shadowOn ? '' : ' disabled') +
          ' title="Reads a same-origin Cloud Run shadow only when the dual-run flag is on.">Read the Redis shadow</button>' +
        '<button type="button" class="coord-btn" data-coord-action="ack"' + (canSend ? '' : ' disabled') +
          ' title="Sends a control only when the dual-run flag is on. The browser never carries Redis AUTH.">Mark a blocker seen</button>' +
      '</div>' +
      '<p class="coord-links">' + links + '</p>' +
      projectsBlock(model, view, chosen) +
      shape +
      '<p class="coord-status" role="status">' + esc(opts.status || (off && !shadowOn
        ? 'Site snapshot shown. Redis dual-run is off. No control was sent.'
        : 'Site snapshot shown. Redis does not answer these pages.')) + '</p>' +
      '</div>';
  }

  function paint(host, model, extra) {
    const mode = host.getAttribute('data-coord-report');
    const flag = (extra && extra.flag) || DEFAULT_FLAG;
    const chosen = host.getAttribute('data-coord-selected') || '';
    host.innerHTML = render(model, mode, {
      flag,
      chosen,
      shadowEnabled: flagAllowsShadow(flag),
      controlEnabled: flagAllowsShadow(flag),
      status: extra && extra.status
    });
  }
  async function fetchJson(win, url, limit) {
    const controller = new AbortController();
    const timer = win.setTimeout(() => controller.abort(), 10000);
    try {
      const res = await win.fetch(url, {cache:'no-store', credentials:'omit', signal:controller.signal, headers:{accept:'application/json'}});
      if (!res.ok) throw Error('read failed');
      const body = await res.text();
      if (body.length > limit) throw Error('oversized');
      return JSON.parse(body);
    } finally { win.clearTimeout(timer); }
  }
  async function load(doc, win, host) {
    const flagUrl = host.getAttribute('data-coord-flag') || '/data/coord-redis.json';
    let flag = DEFAULT_FLAG;
    if (safeDataPath(flagUrl, '')) {
      try { flag = parseFlag(await fetchJson(win, flagUrl, 100000)); } catch (_) { flag = parseFlag(null); }
    }
    const paths = endpointsFor(flag);
    let snapshot = null;
    try { snapshot = validateSnapshot(await fetchJson(win, paths.snapshot, 200000)); } catch (_) { snapshot = null; }
    const model = buildModel(snapshot, flag);
    state.set(host, {flag, model});
    const status = !snapshot
      ? 'Delivery snapshot could not be read. No progress is inferred. Redis was not contacted.'
      : (flag.dual_run === 'off'
        ? 'Site snapshot shown. Redis dual-run is off. No control was sent.'
        : 'Site snapshot shown. Redis does not answer these pages. No control was sent.');
    paint(host, model, {flag, status});
  }
  async function onClick(doc, win, host, target) {
    const action = target.getAttribute && target.getAttribute('data-coord-action');
    if (!action) return;
    const held = state.get(host) || {flag:DEFAULT_FLAG, model:buildModel(null, DEFAULT_FLAG)};
    if (action === 'refresh') {
      await load(doc, win, host);
      const next = state.get(host);
      if (next) paint(host, next.model, {flag:next.flag, status:'Snapshot re-read. Redis was not contacted.'});
      return;
    }
    if (action === 'choose') {
      const id = target.getAttribute('data-coord-id') || '';
      const row = held.model.blockers.filter(b => b.id === id)[0];
      if (!row) return;
      host.setAttribute('data-coord-selected', id);
      const dark = !flagAllowsShadow(held.flag);
      paint(host, held.model, {flag:held.flag, status: dark
        ? 'Chosen: ' + row.title + '. Dual-run is off, so this was not sent.'
        : 'Chosen: ' + row.title + '. Mark seen sends a control to Cloud Run, not to Redis from this browser.'});
      return;
    }
    if (action === 'shadow') {
      if (!flagAllowsShadow(held.flag)) return;
      const paths = endpointsFor(held.flag);
      let verdict = {state:'unread'};
      try { verdict = shadowVerdict(await fetchJson(win, paths.shadow, 200000)); } catch (_) { verdict = {state:'unread'}; }
      const siteN = counts(held.model);
      const status = verdict.state !== 'read'
        ? 'Redis shadow was not read. The site snapshot stays on screen.'
        : (verdict.projects === siteN.projects && verdict.blockers === siteN.blockers
          ? 'Shadow read agrees on project and blocker counts. The site snapshot stays on screen.'
          : 'Shadow diverges from the site snapshot. The site snapshot stays on screen.');
      paint(host, held.model, {flag:held.flag, status});
      return;
    }
    if (action === 'ack') {
      const chosen = host.getAttribute('data-coord-selected') || '';
      const row = held.model.blockers.filter(b => b.id === chosen)[0];
      if (!row || !flagAllowsShadow(held.flag)) {
        paint(host, held.model, {flag:held.flag, status:'No control was sent.'});
        return;
      }
      const paths = endpointsFor(held.flag);
      let status = 'Control route did not accept the mark. Nothing on the snapshot changed.';
      try {
        const res = await win.fetch(paths.control, {
          method: 'POST',
          cache: 'no-store',
          credentials: 'omit',
          headers: {'accept':'application/json', 'content-type':'application/json'},
          body: JSON.stringify({schema:'sfdc24.coord.control.v1', action:'ack-blocker', id:row.id, source:'site'})
        });
        status = res.ok
          ? 'Control accepted for ' + row.title + '. The site snapshot stays authoritative.'
          : status;
      } catch (_) { /* route absent */ }
      paint(host, held.model, {flag:held.flag, status});
    }
  }
  function mountAll(doc, win) {
    const hosts = doc.querySelectorAll('[data-coord-report]');
    for (let i = 0; i < hosts.length; i++) {
      const host = hosts[i];
      host.addEventListener('click', event => {
        const button = event.target && event.target.closest ? event.target.closest('[data-coord-action]') : null;
        if (button && host.contains(button)) onClick(doc, win, host, button);
      });
      load(doc, win, host);
    }
  }

  return {
    STAGES, STATUSES, GATES, FLEET, READ_KEYS, DEFAULT_FLAG, LEADS,
    esc, safeLink, safeApi, safeDataPath, isLanded, itemOk, validateSnapshot, rollup,
    parseFlag, flagAllowsShadow, endpointsFor, buildModel, shadowVerdict, counts, render, mountAll
  };
});
