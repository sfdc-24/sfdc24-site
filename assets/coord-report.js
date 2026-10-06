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
    method: 'Same read as Ops and Process. Counts come from the published snapshot, in the blackboard:coord:v1:rollup shape. This page does not become a second board.',
    status: 'Redis dual-run is off. This line is the blackboard:coord:v1:rollup shape, filled from the published snapshot until Cloud Run serves it.'
  };
  const MODES = ['ops', 'process', 'method', 'status'];
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
  function normalizeTasks(list, project) {
    if (list == null) return [];
    if (!Array.isArray(list) || list.length > 100) return null;
    const out = [];
    for (let i = 0; i < list.length; i++) {
      const item = list[i];
      if (!item || !textOk(item.title, 180)) return null;
      if (item.id != null && item.id !== '' && !/^[a-z0-9-]{1,80}$/.test(item.id)) return null;
      const stage = STAGES.indexOf(item.stage) >= 0 ? item.stage : 'backlog';
      const status = STATUSES.indexOf(item.status) >= 0 ? item.status : 'recorded';
      const owner = textOk(item.owner, 100) ? item.owner : 'Unassigned';
      const namedProject = textOk(item.project, 80) ? item.project : project;
      out.push({
        id: item.id || ('rollup-' + i),
        title: item.title,
        project: namedProject || 'Unassigned',
        owner,
        stage,
        gate: GATES[stage],
        status,
        next: typeof item.next === 'string' && item.next.length <= 400 ? item.next : 'Next step is on the rollup.',
        source: safeLink(item.source),
        landed: stage === 'production' && status === 'verified'
      });
    }
    return out;
  }
  function validateRollup(raw) {
    if (!raw || raw.schema !== 'sfdc24.coord.read.v1' || raw.authoritative === true || raw.redis_answers === true) return null;
    if (!Array.isArray(raw.projects) || raw.projects.length > 100 || !Array.isArray(raw.blockers)) return null;
    const projects = [];
    for (let i = 0; i < raw.projects.length; i++) {
      const project = raw.projects[i];
      if (!project || !textOk(project.project, 80)) return null;
      const in_progress = normalizeTasks(project.in_progress, project.project);
      const landed = normalizeTasks(project.landed, project.project);
      if (!in_progress || !landed) return null;
      projects.push({project: project.project, in_progress, landed});
    }
    const blockers = normalizeTasks(raw.blockers, '');
    if (!blockers) return null;
    return {
      schema: 'sfdc24.coord.read.v1',
      source: 'redis-rollup',
      authoritative: false,
      redis_answers: false,
      observed_at: dateOk(raw.observed_at) ? raw.observed_at : '',
      projects,
      blockers,
      keys: READ_KEYS
    };
  }
  function consumeRollup(snapshotModel, flag, raw) {
    const parsed = parseFlag(flag);
    if (!flagAllowsShadow(parsed)) return {model: snapshotModel, from: 'snapshot', rollup: null, unread: false};
    const rollup = validateRollup(raw);
    if (!rollup) return {model: snapshotModel, from: 'snapshot', rollup: null, unread: true};
    if (parsed.dual_run !== 'live') return {model: snapshotModel, from: 'snapshot', rollup, unread: false};
    const tasks = [];
    rollup.projects.forEach(p => { p.in_progress.forEach(t => tasks.push(t)); p.landed.forEach(t => tasks.push(t)); });
    return {
      model: Object.assign({}, snapshotModel, {
        source: 'redis-rollup',
        authoritative: false,
        redis_answers: false,
        observed_at: rollup.observed_at || snapshotModel.observed_at,
        projects: rollup.projects,
        blockers: rollup.blockers,
        tasks
      }),
      from: 'rollup',
      rollup,
      unread: false
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
    const pick = mode === 'process' && item.status === 'blocked' && /^[a-z0-9-]{1,80}$/.test(item.id) && item.id.indexOf('rollup-') !== 0
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
  function leadFor(view, model) {
    if (model.source === 'redis-rollup') {
      if (view === 'status') return 'This line is the Redis rollup. Counts come from Cloud Run. This browser did not open Memorystore.';
      if (view === 'ops') return 'Counts on this strip come from the Redis rollup. Conference action items above are unchanged. This browser did not open Memorystore.';
      if (view === 'process') return 'Delivery gates on each project come from the Redis rollup. Landed means production and verified. A merge is not landed. This browser did not open Memorystore.';
      return 'Same rollup as Ops and Process. Counts come from Redis through Cloud Run. This page does not become a second board.';
    }
    if (view === 'status' && model.dual_run !== 'off') {
      return 'Redis dual-run is ' + model.dual_run + '. The published snapshot still fills this line. This browser did not open Memorystore.';
    }
    return LEADS[view];
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
      '<li>' + (model.source === 'redis-rollup' ? 'Redis rollup' : 'Site snapshot authoritative') + '</li>',
      '<li>' + n.in_progress + ' in progress</li>',
      '<li>' + n.landed + ' landed</li>',
      '<li' + (n.blockers ? ' class="is-hot"' : '') + '>' + n.blockers + (model.source === 'redis-rollup' ? ' blocker' : ' snapshot blocker') + (n.blockers === 1 ? '' : 's') + '</li>'
    ];
    const fleetItems = model.fleet.map(a => '<li><b>' + esc(a.name) + '</b><span>' + esc(a.role) + '</span></li>').join('');
    const fleet = view === 'process'
      ? '<ul class="coord-fleet">' + fleetItems + '</ul>'
      : '<p class="coord-note">' + model.fleet.map(a => '<b>' + esc(a.name) + '</b> ' + esc(a.role)).join(' · ') + '</p>';
    const links = pages.map(p => '<a href="' + p[0] + '"' + (p[2] === view ? ' aria-current="page"' : '') + '>' + p[1] + '</a>').join('');
    const observed = model.observed_at ? 'Observed ' + esc(model.observed_at) + '. Not live activity.' : 'Snapshot unread. No progress is inferred.';
    const shape = '<details class="coord-shape"><summary>Redis rollup keys</summary><p><code>blackboard:coord:v1:rollup</code>, ' +
      '<code>blackboard:coord:v1:fleet</code>, <code>blackboard:coord:v1:projects</code>, <code>blackboard:coord:v1:tasks</code>, ' +
      '<code>blackboard:coord:v1:okf</code>, <code>blackboard:coord:v1:blockers</code>. ' +
      'Cloud Run reads them when dual-run is on. This browser does not. ' + esc(model.okf.note) + '</p></details>';
    const escalate = '<p class="coord-note">Escalations stay on WhatsApp.</p>';
    if (view === 'status') {
      return '<div class="coord is-status" data-coord-state="' + esc(model.dual_run) + '">' +
        '<p class="coord-kicker">Coordination</p>' +
        '<p class="coord-lead">' + esc(leadFor('status', model)) + '</p>' +
        '<ul class="coord-chips">' + chips.join('') + '</ul>' +
        escalate +
        '<p class="coord-links"><a href="/process/">Project delivery</a><a href="/ops/">Ops</a><a href="/method/">Method</a></p>' +
        shape +
        '<p class="coord-status" role="status">' + esc(opts.status || 'Snapshot standing in for the Redis rollup. Redis was not contacted.') + '</p>' +
        '</div>';
    }
    return '<div class="coord" data-coord-state="' + esc(model.dual_run) + '">' +
      '<p class="coord-kicker">Coordination</p>' +
      '<p class="coord-lead">' + esc(leadFor(view, model)) + '</p>' +
      '<ul class="coord-chips">' + chips.join('') + '</ul>' +
      fleet +
      '<p class="coord-note">Roles for this layer, not a live presence reading. ' + observed + '</p>' +
      escalate +
      '<div class="coord-actions">' +
        '<button type="button" class="coord-btn is-primary" data-coord-action="refresh">Refresh the snapshot</button>' +
        '<button type="button" class="coord-btn" data-coord-action="shadow"' + (shadowOn ? '' : ' disabled') +
          ' title="Reads GET /api/coord when dual-run is on. Does not open Memorystore.">Read the Redis rollup</button>' +
        '<button type="button" class="coord-btn" data-coord-action="ack"' + (canSend ? '' : ' disabled') +
          ' title="Not an escalation. Escalations stay on WhatsApp. A mark goes to Cloud Run only when dual-run is on.">Mark a blocker seen</button>' +
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
    let rollupRaw = null;
    if (flagAllowsShadow(flag) && paths.shadow) {
      try { rollupRaw = await fetchJson(win, paths.shadow, 200000); } catch (_) { rollupRaw = null; }
    }
    const consumed = consumeRollup(buildModel(snapshot, flag), flag, rollupRaw);
    const model = consumed.model;
    state.set(host, {flag, model, rollup: consumed.rollup});
    const status = !snapshot && consumed.from !== 'rollup'
      ? 'Delivery snapshot could not be read. No progress is inferred. Redis was not contacted.'
      : (flag.dual_run === 'off'
        ? 'Snapshot standing in for the Redis rollup. Redis was not contacted.'
        : (consumed.unread
          ? 'Redis rollup was not read. Snapshot shown. This browser did not open Memorystore.'
          : (consumed.from === 'rollup'
            ? 'Redis rollup shown from Cloud Run. This browser did not open Memorystore.'
            : 'Redis rollup read. Snapshot stays on screen. This browser did not open Memorystore.')));
    paint(host, model, {flag, status});
  }
  async function onClick(doc, win, host, target) {
    const action = target.getAttribute && target.getAttribute('data-coord-action');
    if (!action) return;
    const held = state.get(host) || {flag:DEFAULT_FLAG, model:buildModel(null, DEFAULT_FLAG)};
    if (action === 'refresh') {
      await load(doc, win, host);
      const next = state.get(host);
      if (next) paint(host, next.model, {flag:next.flag, status: next.flag.dual_run === 'off'
        ? 'Snapshot re-read. Redis was not contacted.'
        : 'Rollup re-read through Cloud Run. Redis was not contacted from this browser.'});
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
      if (host.getAttribute('data-coord-mounted') === '1') continue;
      host.setAttribute('data-coord-mounted', '1');
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
    parseFlag, flagAllowsShadow, endpointsFor, buildModel, validateRollup, consumeRollup, shadowVerdict, counts, render, mountAll
  };
});
