/* Ops additive: real 2-week Gantt runway via Chart x.max + measured per-agent scorecard.
   OpsGantt.mount() calls a *local* chartConfig, so wrapping api.chartConfig never
   moves the live axis. Patch window.Chart instead. Rates come from
   data/ops-agent-metrics-daily.json (one ET day, published daily). If that file
   is missing, fall back to data/ops-agent-metrics.json (the hand-run 7-day snapshot). */
(function (root) {
  'use strict';
  var AXIS_PAD_MS = 14 * 24 * 60 * 60 * 1000;
  var AXIS_EDGE_MS = 5 * 60 * 1000;
  var DAILY_URL = '/data/ops-agent-metrics-daily.json';
  var SNAPSHOT_URL = '/data/ops-agent-metrics.json';
  var PERSONA = {
    Claude: 'Claude',
    Codex: 'Aya',
    Cursor: 'Cody',
    Copilot: 'Paired review',
    Grok: 'Greg',
    Gemini: 'Jenny',
    Greg: 'Greg',
    Aya: 'Aya',
    Jenny: 'Jenny',
    Cody: 'Cody',
    'Paired review': 'Paired review',
    Owner: 'Owner',
    Total: 'Total'
  };
  // Longer phrases first, so "Copilot Agents" does not become "Paired review Agents".
  var VENDOR_PHRASES = [
    ['Grok Bot', 'Greg'],
    ['Copilot Agents', 'Paired review']
  ];
  var VENDOR_WORDS = [
    ['Grok', 'Greg'],
    ['Codex', 'Aya'],
    ['Gemini', 'Jenny'],
    ['Cursor', 'Cody'],
    ['Copilot', 'Paired review']
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
  function tag(name, attrs, body) {
    var html = '\u003c' + name;
    if (attrs) {
      Object.keys(attrs).forEach(function (key) {
        if (attrs[key] == null || attrs[key] === false) return;
        html += ' ' + key + '="' + esc(attrs[key]) + '"';
      });
    }
    if (body == null) return html + '\u003e';
    return html + '\u003e' + body + '\u003c/' + name + '\u003e';
  }
  function personaText(value) {
    var out = String(value == null ? '' : value);
    var i;
    for (i = 0; i < VENDOR_PHRASES.length; i++) {
      out = out.replace(new RegExp(VENDOR_PHRASES[i][0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), VENDOR_PHRASES[i][1]);
    }
    for (i = 0; i < VENDOR_WORDS.length; i++) {
      out = out.replace(new RegExp('\\b' + VENDOR_WORDS[i][0] + '\\b', 'gi'), VENDOR_WORDS[i][1]);
    }
    return out;
  }
  function personaName(name) {
    var s = String(name || '').trim();
    if (Object.prototype.hasOwnProperty.call(PERSONA, s)) return PERSONA[s];
    return personaText(s);
  }
  function share(value) {
    return typeof value === 'number' && isFinite(value) ? Math.round(value * 100) + '%' : '—';
  }
  function countText(value) {
    return typeof value === 'number' && isFinite(value) ? String(value) : '—';
  }
  // same_day_close_rate is a 0–1 share. closed_same_day_pct above 1 is already a percent.
  function rateText(value) {
    if (typeof value !== 'number' || !isFinite(value)) return '—';
    return Math.round((Math.abs(value) <= 1 ? value * 100 : value)) + '%';
  }
  function formatET(iso) {
    var ms = Date.parse(iso);
    if (!Number.isFinite(ms)) return '';
    try {
      var parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Toronto',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23'
      }).formatToParts(new Date(ms));
      var bag = {};
      parts.forEach(function (p) { if (p.type !== 'literal') bag[p.type] = p.value; });
      var hour = bag.hour === '24' ? '00' : bag.hour;
      if (!bag.year || !hour) return '';
      return bag.year + '-' + bag.month + '-' + bag.day + ' ' + hour + ':' + bag.minute + ' ET';
    } catch (e) {
      return '';
    }
  }
  function sortedDays(doc) {
    if (!doc || !Array.isArray(doc.days)) return [];
    return doc.days.slice().sort(function (a, b) {
      return String(a && a.date || '').localeCompare(String(b && b.date || ''));
    });
  }
  function latestDay(doc) {
    if (!doc || typeof doc !== 'object') return null;
    var days = sortedDays(doc);
    if (days.length) return days[days.length - 1];
    if (Array.isArray(doc.agents)) return doc;
    return null;
  }
  function trendDays(doc) {
    var days = sortedDays(doc);
    return days.length > 7 ? days.slice(-7) : days;
  }
  function costText(agent) {
    if (!agent || agent.cost == null || agent.cost === '') return 'not reported';
    return personaText(agent.cost);
  }
  function boardView(agent) {
    var board = agent && agent.board && typeof agent.board === 'object' ? agent.board : null;
    if (!board) {
      return {asks:'—', results:'—', closedSameDay:'—', overdue:'—', repeatAsks:'—', cutoff:'—'};
    }
    var closedN = typeof board.closed_same_day === 'number' && isFinite(board.closed_same_day) ? board.closed_same_day : null;
    var rate = board.same_day_close_rate != null ? board.same_day_close_rate : board.closed_same_day_pct;
    var closed = '—';
    var rateLabel = rateText(rate);
    if (closedN != null && rateLabel !== '—') closed = closedN + ' (' + rateLabel + ')';
    else if (closedN != null) closed = String(closedN);
    else closed = rateLabel;
    var results = board.results != null ? board.results : board.resulted;
    var repeat = board.repeat_asks != null ? board.repeat_asks : board.repeat_asks_sent;
    return {
      asks: countText(board.asks_in),
      results: countText(results),
      closedSameDay: closed,
      overdue: countText(board.overdue_eod),
      repeatAsks: countText(repeat),
      cutoff: countText(board.cutoff_rows)
    };
  }
  function ciFails(agent) {
    if (!agent) return null;
    if (typeof agent.ci_failed === 'number') return agent.ci_failed;
    if (typeof agent.ci_failed_runs === 'number') return agent.ci_failed_runs;
    return null;
  }
  function closeRate(agent) {
    var board = agent && agent.board;
    if (!board) return null;
    if (typeof board.same_day_close_rate === 'number') return board.same_day_close_rate;
    if (typeof board.closed_same_day_pct === 'number') {
      return Math.abs(board.closed_same_day_pct) <= 1 ? board.closed_same_day_pct : board.closed_same_day_pct / 100;
    }
    return null;
  }

  // One row per agent, as plain strings: the page and the tests read the same thing.
  // Legacy vendor names (Codex, Cursor, Copilot, Grok, Gemini) become personas here.
  function measuredRows(snapshot) {
    var agents = snapshot && Array.isArray(snapshot.agents) ? snapshot.agents : [];
    var priv = (snapshot && Array.isArray(snapshot.private_repos) ? snapshot.private_repos : [])
      .map(function (r) { return String(r).split('/')[1]; });
    return agents.map(function (a) {
      var did = (Array.isArray(a.did) ? a.did : []).slice(0, 3).map(function (d) {
        return personaText(d.title || '') + ' (' + personaText(d.repo || '') + ' #' + String(d.number || '') + ')';
      });
      var counts = a.merged_by_repo && typeof a.merged_by_repo === 'object' ? a.merged_by_repo : {};
      var hidden = priv.filter(function (name) { return counts[name]; }).map(function (name) {
        return counts[name] + ' merged in the ' + name + ' repository';
      });
      if (hidden.length) did.push(hidden.join(', ') + ' (private: titles not shown)');
      if (a.note) did.push(personaText(a.note));
      if (!did.length) did.push('No merged pull request in the window.');
      var prs = a.pull_requests || 0;
      var utilBasis = prs
        ? a.active_hours + ' of ' + a.window_hours + ' h with repository work'
        : 'no pull requests in the window';
      if (a.note && prs) utilBasis += ' · board/chat work not counted';
      return {
        agent: personaName(a.agent),
        util: prs ? share(a.utilization) : '—',
        utilBasis: utilBasis,
        error: a.verdicts ? share(a.error_rate) : '—',
        errorBasis: a.verdicts ? a.nogo + ' NO-GO of ' + a.verdicts + ' review verdicts' : 'no review verdicts',
        efficiency: typeof a.median_hours_to_merge === 'number' && isFinite(a.median_hours_to_merge)
          ? a.median_hours_to_merge.toFixed(1) + ' h' : '—',
        efficiencyBasis: prs ? 'median hours opened→merged · ' + a.merged + ' of ' + prs + ' merged' : 'no pull requests',
        cost: costText(a),
        board: boardView(a),
        did: did
      };
    });
  }

  function windowPhrase(day) {
    var observed = formatET(day && day.observed_at);
    if (day && day.partial === true) return 'Today (partial)' + (observed ? ', observed ' + observed : '');
    if (day && typeof day.date === 'string' && day.date) return day.date + (observed ? ', observed ' + observed : '');
    var start = formatET(day && day.window_start);
    if (start && observed) return start + ' to ' + observed;
    if (day && typeof day.window_start === 'string' && typeof day.observed_at === 'string') {
      return day.window_start.slice(0, 16).replace('T', ' ') + ' to ' + day.observed_at.slice(0, 16).replace('T', ' ') + ' UTC';
    }
    return 'the snapshot window';
  }

  function metricCell(label, strong, basis) {
    return tag('td', {'data-label': label}, tag('strong', null, esc(strong)) + (basis ? tag('small', null, esc(basis)) : ''));
  }
  function textCell(label, text, className) {
    return tag('td', {'data-label': label, 'class': className || null}, esc(text));
  }

  function scoreTable(caption, label, head, rows) {
    var body = rows.map(function (cells) { return tag('tr', {class: cells.cls || null}, cells.html); }).join('');
    return tag('table', {class: 'agent-score', 'aria-label': label},
      tag('caption', null, esc(caption)) + tag('thead', null, tag('tr', null, head)) + tag('tbody', null, body));
  }

  function sparkline(nums) {
    var present = nums.filter(function (v) { return typeof v === 'number' && isFinite(v); });
    if (!present.length) return '';
    var min = Math.min.apply(Math, present);
    var max = Math.max.apply(Math, present);
    var w = 64, h = 16, n = nums.length, poly = [], dots = '';
    nums.forEach(function (v, i) {
      if (typeof v !== 'number' || !isFinite(v)) return;
      var x = n === 1 ? w / 2 : (i * (w - 4) / (n - 1)) + 2;
      var y = max === min ? h / 2 : ((max - v) / (max - min)) * (h - 4) + 2;
      poly.push(x.toFixed(1) + ',' + y.toFixed(1));
      dots += '\u003ccircle cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="1.4"\u003e\u003c/circle\u003e';
    });
    return '\u003csvg class="spark" viewBox="0 0 ' + w + ' ' + h + '" width="' + w + '" height="' + h + '" aria-hidden="true"\u003e'
      + (poly.length > 1 ? '\u003cpolyline points="' + poly.join(' ') + '"\u003e\u003c/polyline\u003e' : '')
      + dots + '\u003c/svg\u003e';
  }

  function agentOn(day, name) {
    var list = day && Array.isArray(day.agents) ? day.agents : [];
    for (var i = 0; i < list.length; i++) {
      if (personaName(list[i].agent) === name) return list[i];
    }
    return null;
  }

  function renderTrend(snapshot, names) {
    var days = trendDays(snapshot);
    if (!days.length) {
      return tag('p', {class: 'conf-note'}, '7-day trend is not in this snapshot.');
    }
    var dates = days.map(function (d, i) {
      var name = d.date || ('day ' + (i + 1));
      if (d.partial) name += ' partial';
      return name;
    }).join(' · ');
    var head = ['Agent', 'Same-day close %', 'Overdue', 'Error rate', 'Cut-off rows', 'CI fails'].map(function (h) {
      return tag('th', {scope: 'col'}, esc(h));
    }).join('');
    var rows = names.map(function (name) {
      var series = days.map(function (d) { return agentOn(d, name); });
      function cell(label, text, nums) {
        return tag('td', {'data-label': label}, sparkline(nums) + tag('span', {class: 'trend-nums'}, esc(text)));
      }
      var close = series.map(closeRate);
      var overdue = series.map(function (a) { return a && a.board ? a.board.overdue_eod : null; });
      var error = series.map(function (a) { return a ? a.error_rate : null; });
      var cutoff = series.map(function (a) { return a && a.board ? a.board.cutoff_rows : null; });
      var ci = series.map(ciFails);
      var html = tag('th', {scope: 'row'}, esc(name))
        + cell('Same-day close %', close.map(rateText).join(' · '), close)
        + cell('Overdue', overdue.map(countText).join(' · '), overdue)
        + cell('Error rate', error.map(share).join(' · '), error)
        + cell('Cut-off rows', cutoff.map(countText).join(' · '), cutoff)
        + cell('CI fails', ci.map(countText).join(' · '), ci);
      return {cls: name === 'Total' ? 'score-total' : null, html: html};
    });
    return tag('section', {class: 'score-trend', 'aria-label': '7-day trend per agent'},
      tag('h4', null, '7-day trend')
      + tag('p', {class: 'conf-note'}, 'Oldest to newest: ' + esc(dates) + '. Same-day close %, overdue, error rate, cut-off rows, CI fails.')
      + scoreTable('7-day trend', '7-day trend per agent', head, rows));
  }

  function renderAgentScorecard(snapshot) {
    var day = latestDay(snapshot) || {agents: []};
    var privSource = day.private_repos || (snapshot && snapshot.private_repos) || [];
    var rows = measuredRows({agents: day.agents, private_repos: privSource});
    var privNames = privSource.map(function (r) { return String(r).split('/').pop(); }).filter(Boolean);
    var extra = '';
    if (day.github_scope) extra = ' ' + personaText(day.github_scope) + '.';
    else if (privNames.length) extra = ' Private ' + privNames.join(', ') + ' counts are included; private titles are omitted.';
    var phrase = windowPhrase(day);
    var head = tag('div', {class: 'agent-score-wrap'},
      tag('p', {class: 'conf-note' + (day.partial ? ' score-partial' : '')},
        'Measured from pull requests and review verdicts, ' + esc(phrase) + '. Utilization % = hours with repository work ÷ window hours. Error rate % = NO-GO ÷ review verdicts. Efficiency = median hours opened→merged (not a %).'
        + esc(extra)
        + ' Board chat and waker work are not counted. Idle working time is not measured. Cost shows not reported when none was given.')
      + scoreTable('AI agents · measured for this day', 'Per-agent utilization, error rate, and efficiency',
        ['Agent', 'Utilization %', 'Error rate %', 'Efficiency (median h)', 'Cost', 'Who did what'].map(function (h) {
          return tag('th', {scope: 'col'}, esc(h));
        }).join(''),
        rows.map(function (r) {
          var did = r.did.map(function (d) { return tag('span', {class: 'who-bucket'}, esc(d)); }).join('');
          return {
            cls: r.agent === 'Total' ? 'score-total' : null,
            html: tag('th', {scope: 'row'}, esc(r.agent))
              + metricCell('Utilization %', r.util, r.utilBasis)
              + metricCell('Error rate %', r.error, r.errorBasis)
              + metricCell('Efficiency (median h)', r.efficiency, r.efficiencyBasis)
              + textCell('Cost', r.cost, 'cost' + (r.cost === 'not reported' ? ' cost-missing' : ''))
              + tag('td', {class: 'who-did', 'data-label': 'Who did what'}, did)
          };
        }))
      + tag('section', {class: 'score-board', 'aria-label': 'Board asks and results'},
        tag('h4', null, 'Board')
        + tag('p', {class: 'conf-note'}, 'Asks in, results, closed same day, overdue, repeat asks, and cut-off replies.')
        + scoreTable('Board', 'Board asks and results',
          ['Agent', 'Asks in', 'Results', 'Closed same day', 'Overdue', 'Repeat asks', 'Cut-off replies'].map(function (h) {
            return tag('th', {scope: 'col'}, esc(h));
          }).join(''),
          rows.map(function (r) {
            var b = r.board;
            return {
              cls: r.agent === 'Total' ? 'score-total' : null,
              html: tag('th', {scope: 'row'}, esc(r.agent))
                + textCell('Asks in', b.asks)
                + textCell('Results', b.results)
                + textCell('Closed same day', b.closedSameDay)
                + textCell('Overdue', b.overdue)
                + textCell('Repeat asks', b.repeatAsks)
                + textCell('Cut-off replies', b.cutoff)
            };
          })))
      + renderTrend(snapshot, rows.map(function (r) { return r.agent; })));
    return head;
  }

  function readMetrics(fetchFn) {
    var get = typeof fetchFn === 'function' ? fetchFn : root.fetch.bind(root);
    function pull(url) {
      return Promise.resolve().then(function () {
        return get(url, {cache: 'no-store', credentials: 'omit'});
      }).then(function (res) {
        if (!res || !res.ok) throw Error('fail');
        return res.json();
      });
    }
    return pull(DAILY_URL).then(function (doc) {
      if (!doc || typeof doc !== 'object' || (!Array.isArray(doc.days) && !Array.isArray(doc.agents))) throw Error('empty');
      return doc;
    }).catch(function () {
      return pull(SNAPSHOT_URL);
    });
  }

  var api = root.OpsGantt;
  if (api) {
    api.AXIS_PAD_MS = AXIS_PAD_MS;
    api.DAILY_URL = DAILY_URL;
    api.SNAPSHOT_URL = SNAPSHOT_URL;
    api.personaName = personaName;
    api.formatET = formatET;
    api.measuredRows = measuredRows;
    api.renderAgentScorecard = renderAgentScorecard;
    api.readMetrics = readMetrics;
  }

  function fillScorecard() {
    patchChart(root);
    var host = root.document && root.document.getElementById('agent-scorecard');
    if (!host) return;
    readMetrics().then(function (snapshot) {
      host.innerHTML = renderAgentScorecard(snapshot);
    }).catch(function () {
      host.innerHTML = tag('p', {class: 'conf-note'}, 'Agent scorecard not loaded. A missing read is not a measured rate.');
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
