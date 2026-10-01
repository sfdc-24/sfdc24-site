/* Ops additive: real 2-week Gantt runway via Chart x.max + measured per-agent scorecard.
   OpsGantt.mount() calls a *local* chartConfig, so wrapping api.chartConfig never
   moves the live axis. Patch window.Chart instead. Rates come from
   data/ops-agent-metrics.json (PR/commit/verdict bake), not the delivery snapshot. */
(function (root) {
  'use strict';
  var AXIS_PAD_MS = 14 * 24 * 60 * 60 * 1000;
  var AXIS_EDGE_MS = 5 * 60 * 1000;
  var AGENTS = [
    {id:'claude', title:'Claude'},
    {id:'codex', title:'Codex'},
    {id:'gemini', title:'Gemini'},
    {id:'cursor', title:'Cursor'},
    {id:'grok', title:'Grok'}
  ];

  function ensureRunway(cfg) {
    if (!cfg || !cfg.options || !cfg.options.scales || !cfg.options.scales.x) return cfg;
    var x = cfg.options.scales.x;
    var horizon = Date.now() + AXIS_PAD_MS;
    var curMax = typeof x.max === 'number' ? x.max : null;
    x.max = Math.max(curMax == null ? horizon : curMax, horizon) + AXIS_EDGE_MS;
    if (!x.title) x.title = {};
    x.title.display = true;
    x.title.text = 'Recorded / planned + 2-week runway (UTC)';
    if (x.ticks) x.ticks.maxTicksLimit = 8;
    return cfg;
  }

  function patchChart(win) {
    if (!win || typeof win.Chart !== 'function' || win.Chart.__opsRunwayPatched) return;
    var Orig = win.Chart;
    function Wrapped(ctx, cfg) { return new Orig(ctx, ensureRunway(cfg)); }
    Wrapped.prototype = Orig.prototype;
    Object.keys(Orig).forEach(function (k) { try { Wrapped[k] = Orig[k]; } catch (_) {} });
    Wrapped.__opsRunwayPatched = true;
    Wrapped.__opsOrig = Orig;
    win.Chart = Wrapped;
  }

  patchChart(root);
  if (root.setTimeout) {
    root.setTimeout(function () { patchChart(root); }, 0);
    root.setTimeout(function () { patchChart(root); }, 400);
    root.setTimeout(function () { patchChart(root); }, 1500);
  }

  function date(v) {
    return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().replace('.000Z','Z') === v ? Date.parse(v) : null;
  }
  function esc(v) {
    return String(v == null ? '' : v).replace(/[\u0026\u003c\u003e"']/g, function (c) {
      // Real entities: #260 shipped a map from each character to itself, which escaped nothing.
      return {'\u0026':'\u0026amp;','\u003c':'\u0026lt;','\u003e':'\u0026gt;','"':'\u0026quot;',"'":'\u0026#39;'}[c];
    });
  }
  // Per-agent figures measured from the repositories (tools/ops_agent_metrics.py writes
  // data/ops-agent-metrics.json): pull requests, their commits, and Cursor's and Codex's review
  // verdicts over the snapshot's window. An agent with no record shows a dash, never a zero; the
  // private conference repository gives counts only, never titles.
  var METRICS_URL = '/data/ops-agent-metrics.json';

  function share(value) {
    return typeof value === 'number' && isFinite(value) ? Math.round(value * 100) + '%' : '—';
  }

  // One row per agent, as plain strings: the page and the tests read the same thing.
  function measuredRows(snapshot) {
    var agents = snapshot && Array.isArray(snapshot.agents) ? snapshot.agents : [];
    var priv = (snapshot && Array.isArray(snapshot.private_repos) ? snapshot.private_repos : [])
      .map(function (r) { return String(r).split('/')[1]; });
    return agents.map(function (a) {
      var did = (Array.isArray(a.did) ? a.did : []).slice(0, 3).map(function (d) {
        return String(d.title || '') + ' (' + String(d.repo || '') + ' #' + String(d.number || '') + ')';
      });
      var counts = a.merged_by_repo && typeof a.merged_by_repo === 'object' ? a.merged_by_repo : {};
      var hidden = priv.filter(function (name) { return counts[name]; }).map(function (name) {
        return counts[name] + ' merged in the ' + name + ' repository';
      });
      if (hidden.length) did.push(hidden.join(', ') + ' (private: titles not shown)');
      if (a.note) did.push(String(a.note));
      if (!did.length) did.push('No merged pull request in the window.');
      var prs = a.pull_requests || 0;
      var utilBasis = prs
        ? a.active_hours + ' of ' + a.window_hours + ' h with repository work'
        : 'no pull requests in the window';
      if (a.note && prs) utilBasis += ' · board/chat work not counted';
      return {
        agent: String(a.agent || ''),
        util: prs ? share(a.utilization) : '—',
        utilBasis: utilBasis,
        error: a.verdicts ? share(a.error_rate) : '—',
        errorBasis: a.verdicts ? a.nogo + ' NO-GO of ' + a.verdicts + ' review verdicts' : 'no review verdicts',
        efficiency: typeof a.median_hours_to_merge === 'number' && isFinite(a.median_hours_to_merge)
          ? a.median_hours_to_merge.toFixed(1) + ' h' : '—',
        efficiencyBasis: prs ? 'median hours opened→merged · ' + a.merged + ' of ' + prs + ' merged' : 'no pull requests',
        did: did
      };
    });
  }

  function renderAgentScorecard(snapshot) {
    var span = snapshot && typeof snapshot.window_start === 'string' && typeof snapshot.observed_at === 'string'
      ? snapshot.window_start.slice(0, 16).replace('T', ' ') + ' to ' + snapshot.observed_at.slice(0, 16).replace('T', ' ') + ' UTC'
      : 'the snapshot window';
    var privNames = (snapshot && Array.isArray(snapshot.private_repos) ? snapshot.private_repos : [])
      .map(function (r) { return String(r).split('/').pop(); }).filter(Boolean);
    var privNote = privNames.length
      ? ' Private ' + privNames.join(', ') + ' counts are included; private titles are omitted.'
      : '';
    var head = '\u003cdiv class="agent-score-wrap"\u003e\u003cp class="conf-note"\u003eMeasured from pull requests and review verdicts, '
      + esc(span) + '. Utilization % = hours with repository work ÷ window hours. Error rate % = NO-GO ÷ review verdicts. Efficiency = median hours opened→merged (not a %).'
      + esc(privNote)
      + ' Board chat and waker work are not counted. Idle working time is not measured.\u003c/p\u003e'
      + '\u003ctable class="agent-score" aria-label="Per-agent utilization, error rate, and efficiency"\u003e'
      + '\u003ccaption\u003eAI agents · measured from repositories (public + private counts)\u003c/caption\u003e'
      + '\u003cthead\u003e\u003ctr\u003e\u003cth scope="col"\u003eAgent\u003c/th\u003e\u003cth scope="col"\u003eUtilization %\u003c/th\u003e\u003cth scope="col"\u003eError rate %\u003c/th\u003e'
      + '\u003cth scope="col"\u003eEfficiency (median h)\u003c/th\u003e\u003cth scope="col"\u003eWho did what\u003c/th\u003e\u003c/tr\u003e\u003c/thead\u003e\u003ctbody\u003e';
    var rows = measuredRows(snapshot).map(function (r) {
      return '\u003ctr\u003e\u003cth scope="row"\u003e' + esc(r.agent) + '\u003c/th\u003e'
        + '\u003ctd\u003e\u003cstrong\u003e' + esc(r.util) + '\u003c/strong\u003e\u003csmall\u003e' + esc(r.utilBasis) + '\u003c/small\u003e\u003c/td\u003e'
        + '\u003ctd\u003e\u003cstrong\u003e' + esc(r.error) + '\u003c/strong\u003e\u003csmall\u003e' + esc(r.errorBasis) + '\u003c/small\u003e\u003c/td\u003e'
        + '\u003ctd\u003e\u003cstrong\u003e' + esc(r.efficiency) + '\u003c/strong\u003e\u003csmall\u003e' + esc(r.efficiencyBasis) + '\u003c/small\u003e\u003c/td\u003e'
        + '\u003ctd class="who-did"\u003e' + r.did.map(function (d) { return '\u003cspan class="who-bucket"\u003e' + esc(d) + '\u003c/span\u003e'; }).join('')
        + '\u003c/td\u003e\u003c/tr\u003e';
    }).join('');
    return head + rows + '\u003c/tbody\u003e\u003c/table\u003e\u003c/div\u003e';
  }

  var api = root.OpsGantt;
  if (api) {
    api.AXIS_PAD_MS = AXIS_PAD_MS;
    api.measuredRows = measuredRows;
    api.renderAgentScorecard = renderAgentScorecard;
  }

  function fillScorecard() {
    patchChart(root);
    var host = root.document && root.document.getElementById('agent-scorecard');
    if (!host) return;
    root.fetch(METRICS_URL, {cache:'no-store', credentials:'omit'}).then(function (r) {
      if (!r.ok) throw Error('fail');
      return r.json();
    }).then(function (snapshot) {
      host.innerHTML = renderAgentScorecard(snapshot);
    }).catch(function () {
      host.innerHTML = '\u003cp class="conf-note"\u003eAgent scorecard not loaded. A missing read is not a measured rate.\u003c/p\u003e';
    });
  }
  if (root.document && root.document.readyState === 'loading') {
    root.document.addEventListener('DOMContentLoaded', fillScorecard);
  } else {
    fillScorecard();
  }
  root.setInterval(fillScorecard, 120000);
  // Re-draw Gantt after Chart is patched so axis picks up ≥2-week runway immediately.
  root.setTimeout(function () {
    patchChart(root);
    var btn = root.document && root.document.getElementById('og-refresh');
    if (btn && typeof btn.click === 'function') btn.click();
  }, 600);
})(typeof window === 'undefined' ? globalThis : window);
