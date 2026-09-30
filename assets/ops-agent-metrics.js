/* Ops additive: 2-week Gantt runway + per-agent util/error/efficiency scorecard.
   Loads after /assets/ops-gantt.js. Does not invent working-time telemetry. */
(function (root) {
  'use strict';
  var api = root.OpsGantt;
  if (!api || typeof api.chartConfig !== 'function') return;
  var AXIS_PAD_MS = 14 * 24 * 60 * 60 * 1000;
  var AXIS_EDGE_MS = 5 * 60 * 1000;
  var AGENTS = [
    {id:'claude', title:'Claude'},
    {id:'codex', title:'Codex'},
    {id:'gemini', title:'Gemini'},
    {id:'cursor', title:'Cursor'},
    {id:'grok', title:'Grok'}
  ];
  function date(v) {
    return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().replace('.000Z','Z') === v ? Date.parse(v) : null;
  }
  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
    });
  }
  function agentOf(item) {
    if (!item || typeof item.owner !== 'string') return null;
    var key = item.owner.trim().toLowerCase();
    if (key === 'claude' || key.indexOf('claude') === 0) return 'claude';
    if (key === 'codex' || key.indexOf('codex') === 0) return 'codex';
    if (key === 'gemini' || key.indexOf('gemini') === 0) return 'gemini';
    if (key === 'cursor' || key.indexOf('cursor') === 0) return 'cursor';
    if (key === 'grok' || key === 'grok bot' || key.indexOf('grok') === 0) return 'grok';
    return null;
  }
  function pct(part, total) {
    if (!total) return null;
    return Math.round((part / total) * 100);
  }
  function agentReport(items) {
    var list = Array.isArray(items) ? items : [];
    var total = list.length;
    return {
      total: total,
      lanes: AGENTS.map(function (agent) {
        var rows = list.filter(function (x) { return agentOf(x) === agent.id; });
        var blocked = rows.filter(function (x) { return x.status === 'blocked'; }).length;
        var verified = rows.filter(function (x) { return x.status === 'verified'; }).length;
        return {
          id: agent.id, title: agent.title, rows: rows, blocked: blocked, verified: verified,
          utilPct: pct(rows.length, total),
          errorPct: pct(blocked, rows.length),
          efficiencyPct: pct(verified, rows.length)
        };
      })
    };
  }
  function whoDidWindows(item, observedAt) {
    var obs = date(observedAt) || Date.now();
    var ends = (Array.isArray(item.periods) ? item.periods : []).map(function (p) { return date(p.end); }).filter(function (t) { return t !== null; });
    if (!ends.length) {
      var seen = date(item.observed_at);
      if (seen === null) return 'undated';
      ends.push(seen);
    }
    var latest = Math.max.apply(null, ends);
    var age = Math.max(0, obs - latest);
    if (age <= 60 * 60 * 1000) return 'hour';
    if (age <= 24 * 60 * 60 * 1000) return 'day';
    if (age <= 7 * 24 * 60 * 60 * 1000) return 'week';
    return 'older';
  }
  function renderAgentScorecard(items, observedAt) {
    var report = agentReport(items);
    var head = '<div class="agent-score-wrap"><p class="conf-note">Per-agent figures are <b>estimated from the delivery snapshot</b> (item share, blocked, verified). Working-time utilization is <b>not measured</b> — no fabricated idle telemetry. Role titles stay anonymous on the HITL strip above.</p>'
      + '<table class="agent-score" aria-label="Per-agent utilization, error rate, and efficiency">'
      + '<caption>AI agents · estimated % from snapshot owners</caption>'
      + '<thead><tr><th scope="col">Agent</th><th scope="col">Utilization %</th><th scope="col">Error rate %</th><th scope="col">Efficiency %</th><th scope="col">Who did what (hour / day / week)</th></tr></thead><tbody>';
    var rows = report.lanes.map(function (lane) {
      var util = lane.utilPct === null ? '—' : lane.utilPct + '%';
      var err = lane.errorPct === null ? '—' : lane.errorPct + '%';
      var eff = lane.efficiencyPct === null ? '—' : lane.efficiencyPct + '%';
      var buckets = {hour:[], day:[], week:[], older:[], undated:[]};
      lane.rows.forEach(function (x) {
        var w = whoDidWindows(x, observedAt);
        (buckets[w] || buckets.undated).push(x.title || x.id);
      });
      function bit(label, list) {
        if (!list.length) return '';
        return '<span class="who-bucket"><b>' + esc(label) + '</b> ' + esc(list.slice(0, 4).join('; '))
          + (list.length > 4 ? ' +' + (list.length - 4) : '') + '</span>';
      }
      var who = bit('Hour', buckets.hour) + bit('Day', buckets.day) + bit('Week', buckets.week)
        + bit('Older', buckets.older) + bit('Undated', buckets.undated)
        || '<span class="who-bucket">No owned rows in this snapshot.</span>';
      var basis = 'Est. share ' + (lane.utilPct === null ? 'n/a' : lane.utilPct + '% of ' + report.total)
        + ' · blocked ' + lane.blocked + ' · verified ' + lane.verified;
      return '<tr><th scope="row">' + esc(lane.title) + '<small>' + esc(basis) + '</small></th>'
        + '<td><strong>' + esc(util) + '</strong><small>item share</small></td>'
        + '<td><strong>' + esc(err) + '</strong><small>blocked / owned</small></td>'
        + '<td><strong>' + esc(eff) + '</strong><small>verified / owned</small></td>'
        + '<td class="who-did">' + who + '</td></tr>';
    }).join('');
    return head + rows + '</tbody></table></div>';
  }
  var origChart = api.chartConfig;
  api.AXIS_PAD_MS = AXIS_PAD_MS;
  api.AGENTS = AGENTS;
  api.agentOf = agentOf;
  api.agentReport = agentReport;
  api.whoDidWindows = whoDidWindows;
  api.renderAgentScorecard = renderAgentScorecard;
  api.chartConfig = function (items, observedAt, nowMs) {
    var cfg = origChart(items, observedAt);
    if (!cfg || !cfg.options || !cfg.options.scales || !cfg.options.scales.x) return cfg;
    var times = (items || []).flatMap(function (x) {
      return (x.periods || []).flatMap(function (p) { return [date(p.start), date(p.end)]; });
    }).filter(function (t) { return t !== null; });
    var bound = times.slice();
    var observed = date(observedAt);
    if (observed !== null) bound.push(observed);
    var now = typeof nowMs === 'number' && isFinite(nowMs) ? nowMs : Date.now();
    var horizon = now + AXIS_PAD_MS;
    if (bound.length) bound.push(horizon); else bound.push(now, horizon);
    cfg.options.scales.x.min = Math.min.apply(null, bound) - AXIS_EDGE_MS;
    cfg.options.scales.x.max = Math.max.apply(null, bound) + AXIS_EDGE_MS;
    if (cfg.options.scales.x.title) cfg.options.scales.x.title.text = 'Recorded / planned + 2-week runway (UTC)';
    if (cfg.options.scales.x.ticks) cfg.options.scales.x.ticks.maxTicksLimit = 8;
    return cfg;
  };
  function fillScorecard() {
    var host = root.document && root.document.getElementById('agent-scorecard');
    if (!host) return;
    var snapUrl = '/data/ops-delivery.json';
    var hosted = 'https://raw.githubusercontent.com/sfdc-24/sfdc24-site/ops-delivery-snap/data/ops-delivery.json';
    function paint(raw) {
      try {
        var items = raw && Array.isArray(raw.items) ? raw.items : [];
        host.innerHTML = renderAgentScorecard(items, raw && raw.observed_at);
      } catch (_) {
        host.innerHTML = '<p class="conf-note">Agent scorecard unavailable for this snapshot.</p>';
      }
    }
    function load(url) {
      return root.fetch(url, {cache:'no-store', credentials:'omit'}).then(function (r) {
        if (!r.ok) throw Error('fail');
        return r.json();
      });
    }
    load(hosted).catch(function () { return load(snapUrl); }).then(paint).catch(function () {
      load(snapUrl).then(paint).catch(function () {
        host.innerHTML = '<p class="conf-note">Agent scorecard not loaded. A missing read is not a measured rate.</p>';
      });
    });
  }
  if (root.document && root.document.readyState === 'loading') {
    root.document.addEventListener('DOMContentLoaded', fillScorecard);
  } else {
    fillScorecard();
  }
  root.setInterval(fillScorecard, 120000);
})(typeof window === 'undefined' ? globalThis : window);
