/* Sheet counts for Ops and Process. Reads the published delivery snapshot.
   No Redis read. A stamp older than 36 hours shows "Not yet refreshed." */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else {
    root.DeliveryCounts = api;
    if (root.document) api.mount(root.document);
  }
})(typeof window === 'undefined' ? globalThis : window, function () {
  'use strict';
  const MAX_AGE_MS = 36 * 60 * 60 * 1000;
  const SKEW_MS = 60 * 1000;
  const STALE = 'Not yet refreshed.';
  const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

  function stampMs(value) {
    if (typeof value !== 'string' || !STAMP.test(value)) return null;
    const ms = Date.parse(value);
    return Number.isFinite(ms) && new Date(ms).toISOString().replace('.000Z', 'Z') === value ? ms : null;
  }

  function summarize(raw) {
    if (!raw || raw.schema_version !== 1 || !Array.isArray(raw.items) || raw.items.length > 100) return null;
    const observed = stampMs(raw.observed_at);
    if (observed === null) return null;
    let landed = 0;
    let blocked = 0;
    const projects = [];
    const byProject = {};
    for (let i = 0; i < raw.items.length; i++) {
      const item = raw.items[i];
      if (!item || typeof item.project !== 'string' || !item.project ||
          typeof item.stage !== 'string' || typeof item.status !== 'string') return null;
      const isLanded = item.stage === 'production' && item.status === 'verified';
      if (isLanded) landed += 1;
      if (item.status === 'blocked') blocked += 1;
      if (!byProject[item.project]) {
        byProject[item.project] = {in: 0, landed: 0};
        projects.push(item.project);
      }
      if (isLanded) byProject[item.project].landed += 1;
      else byProject[item.project].in += 1;
    }
    const total = raw.items.length;
    const notLanded = total - landed;
    const parts = projects.map(function (name) {
      const row = byProject[name];
      return name + ' ' + row.in + ' in progress and ' + row.landed + ' landed';
    });
    const sheet = total + ' rows. ' + landed + ' landed. ' + notLanded + ' not landed. ' + blocked + ' blocked.' +
      (parts.length ? ' ' + parts.join('. ') + '.' : '');
    const sheetOps = total + ' delivery rows. ' + landed + ' landed (production and verified). ' +
      notLanded + ' not landed. ' + blocked + ' blocked.';
    const pills = {};
    projects.forEach(function (name) {
      const row = byProject[name];
      pills[name] = row.in + ' in progress · ' + row.landed + ' landed';
    });
    return {observed_at: raw.observed_at, sheet: sheet, sheetOps: sheetOps, projects: pills};
  }

  function render(raw, now) {
    const summary = summarize(raw);
    const observed = summary && stampMs(summary.observed_at);
    const fresh = summary !== null && observed !== null && now >= observed - SKEW_MS && now - observed < MAX_AGE_MS;
    if (!fresh) return {fresh: false, status: STALE, sheet: STALE, sheetOps: STALE, projects: {}};
    return {
      fresh: true,
      status: 'Observed ' + summary.observed_at + '.',
      sheet: summary.sheet,
      sheetOps: summary.sheetOps,
      projects: summary.projects
    };
  }

  function apply(doc, view) {
    const nodes = doc.querySelectorAll('[data-delivery-counts]');
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      const kind = node.getAttribute('data-delivery-counts');
      let text = STALE;
      if (view.fresh && kind === 'status') text = view.status;
      else if (view.fresh && kind === 'sheet') text = view.sheet;
      else if (view.fresh && kind === 'sheet-ops') text = view.sheetOps;
      else if (view.fresh && kind === 'project') {
        const name = node.getAttribute('data-project') || '';
        text = Object.prototype.hasOwnProperty.call(view.projects, name) ? view.projects[name] : STALE;
      }
      node.textContent = text;
    }
  }

  function mount(doc) {
    if (!doc || typeof doc.querySelectorAll !== 'function') return;
    if (!doc.querySelector('[data-delivery-counts]')) return;
    const showStale = function () { apply(doc, render(null, 0)); };
    if (typeof fetch !== 'function') {
      showStale();
      return;
    }
    fetch('/data/ops-delivery.json', {cache: 'no-store'})
      .then(function (response) {
        if (!response.ok) throw new Error('missing');
        return response.json();
      })
      .then(function (data) { apply(doc, render(data, Date.now())); })
      .catch(showStale);
  }

  return {MAX_AGE_MS: MAX_AGE_MS, STALE: STALE, summarize: summarize, render: render, apply: apply, mount: mount};
});
