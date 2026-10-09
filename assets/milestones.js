/* Phase 1 reads the committed chart text.
   Phase 2 may read proj:milestones:v1:mermaid and proj:milestones:v1:progress
   through the reviewed read path. LIVE_CHART stays false until that review
   PASSes and the owner records GO. This file does not call that path. */
(function () {
  "use strict";
  var LIVE_CHART = false;
  var HELD_KEYS = {
    timeline: "proj:milestones:v1:mermaid",
    progress: "proj:milestones:v1:progress",
    pokayoke: "proj:pokayoke:v1",
    governance: "proj:governance:v1",
    spend: "proj:spend:v1"
  };
  var CHECKS_URL = "/assets/milestones/pokayoke.json";
  var SPEND_URL = "/assets/milestones/spend.json";
  var AWAITING = "Awaiting Aya's figures";
  var ALERT_LINE = "Alert at 80% of cap.";
  var STREAMS = [
    ["shared-state", "Shared state and governance"],
    ["live-transcription", "Live transcription"],
    ["voice-room-agents", "Voice-room agents"],
    ["cloud-move", "Cloud move"],
    ["issues-m6", "sfdc24.com"],
    ["converspan", "Converspan"],
    ["prospect-demo", "Prospect demo"]
  ];
  var VERDICTS = { PASS: 1, FAIL: 1, "NOT TESTED": 1, "NOT TESTABLE": 1 };
  var SOURCES = {
    progress: "/assets/milestones/2026-10-08-progress.mmd",
    timeline: "/assets/milestones/2026-10-08.mmd"
  };

  function loadHeldCharts() {
    if (!LIVE_CHART) return null;
    return HELD_KEYS;
  }

  function fitChart(svg) {
    var vb = svg.viewBox && svg.viewBox.baseVal;
    if (!vb || !vb.width || !vb.height) return;
    var lockedW = Math.ceil(vb.width);
    var lockedH = Math.ceil(vb.height);
    svg.setAttribute("width", String(lockedW));
    svg.setAttribute("height", String(lockedH));
    svg.style.width = lockedW + "px";
    svg.style.height = lockedH + "px";
    svg.style.maxWidth = "none";
    svg.style.minWidth = "0";
    var box = svg.getBoundingClientRect();
    if (!box.width || !box.height) return;
    var sx = vb.width / box.width;
    var sy = vb.height / box.height;
    var minX = vb.x;
    var minY = vb.y;
    var maxX = vb.x + vb.width;
    var maxY = vb.y + vb.height;
    var nodes = svg.querySelectorAll("text");
    for (var i = 0; i < nodes.length; i++) {
      var rect = nodes[i].getBoundingClientRect();
      if (!rect.width && !rect.height) continue;
      var x = vb.x + (rect.left - box.left) * sx;
      var y = vb.y + (rect.top - box.top) * sy;
      var x2 = vb.x + (rect.right - box.left) * sx;
      var y2 = vb.y + (rect.bottom - box.top) * sy;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x2 > maxX) maxX = x2;
      if (y2 > maxY) maxY = y2;
    }
    var pad = 22;
    minX -= pad;
    minY -= pad;
    maxX += pad;
    maxY += pad;
    var width = Math.ceil(maxX - minX);
    var height = Math.ceil(maxY - minY);
    svg.setAttribute("viewBox", minX + " " + minY + " " + (maxX - minX) + " " + (maxY - minY));
    svg.setAttribute("width", String(width));
    svg.setAttribute("height", String(height));
    svg.style.width = width + "px";
    svg.style.height = height + "px";
    svg.style.maxWidth = "none";
    svg.style.minWidth = "0";
    svg.style.overflow = "visible";
  }

  function draw(id, text) {
    var host = document.getElementById(id);
    if (!host || !window.mermaid) return Promise.reject(new Error("chart"));
    return window.mermaid.render("svg-" + id, text).then(function (out) {
      host.innerHTML = out.svg;
      var svg = host.querySelector("svg");
      if (svg) {
        svg.setAttribute("role", "img");
        fitChart(svg);
      }
      if (out.bindFunctions) out.bindFunctions(host);
    });
  }

  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  }

  function governanceTally(rows) {
    var order = ["PASS", "FAIL", "NOT TESTED", "NOT TESTABLE"];
    var counts = {};
    var n = 0;
    var i;
    for (i = 0; i < rows.length; i++) {
      var verdict = String(rows[i] && rows[i].verdict || "").trim();
      if (!verdict) continue;
      counts[verdict] = (counts[verdict] || 0) + 1;
      n += 1;
    }
    if (!n) return "";
    var parts = [];
    var seen = {};
    function add(key) {
      if (!counts[key]) return;
      seen[key] = 1;
      parts.push(counts[key] + " " + key.toLowerCase());
    }
    for (i = 0; i < order.length; i++) add(order[i]);
    for (var key in counts) {
      if (!seen[key]) add(key);
    }
    return parts.join(", ") + " of " + n;
  }

  function renderChecks(data) {
    var pending = data && data.placeholder ? String(data.placeholder) : "Governance check in progress, results pending";
    var learnings = data && Array.isArray(data.learnings) ? data.learnings : [];
    var governance = data && Array.isArray(data.governance) ? data.governance : [];
    var pokeStatus = document.getElementById("pokayoke-status");
    var pokeRows = document.getElementById("pokayoke-rows");
    var govStatus = document.getElementById("governance-status");
    var govRows = document.getElementById("governance-rows");
    var showEnforced = learnings.some(function (row) { return row && row.enforced_in; });
    if (pokeStatus) pokeStatus.textContent = learnings.length ? "" : "No mistake-proofing rows are recorded yet.";
    if (govStatus) {
      var tally = governanceTally(governance);
      govStatus.textContent = tally || (governance.length ? "" : pending);
    }
    var govAsOf = document.getElementById("governance-asof");
    if (govAsOf) {
      govAsOf.hidden = true;
      govAsOf.textContent = "";
    }
    if (pokeRows) {
      pokeRows.innerHTML = learnings.length ? "<div class=\"tablewrap\"><table class=\"streams\"><thead><tr><th scope=\"col\">Id</th><th scope=\"col\">Defect</th><th scope=\"col\">Control</th><th scope=\"col\">Owner</th>"
        + (showEnforced ? "<th scope=\"col\">Enforced in</th>" : "")
        + "<th scope=\"col\">Status</th></tr></thead><tbody>"
        + learnings.map(function (row) {
          return "<tr><td class=\"id\">" + esc(row.id) + "</td><td>" + esc(row.defect) + "</td><td>" + esc(row.control) + "</td><td>" + esc(row.owner) + "</td>"
            + (showEnforced ? "<td>" + esc(row.enforced_in) + "</td>" : "")
            + "<td>" + esc(row.status) + "</td></tr>";
        }).join("") + "</tbody></table></div>" : "";
    }
    if (govRows) {
      govRows.innerHTML = governance.length ? "<div class=\"tablewrap\"><table class=\"streams\"><thead><tr><th scope=\"col\">Protocol</th><th scope=\"col\">Verdict</th><th scope=\"col\">As of</th></tr></thead><tbody>"
        + governance.map(function (row) {
          var verdict = String(row.verdict || "");
          var protocol = row.note ? String(row.protocol || "") + " (" + String(row.note) + ")" : row.protocol;
          var mark = verdict === "FAIL" ? " rag red" : "";
          return "<tr><td>" + esc(protocol) + "</td><td class=\"" + mark.trim() + "\">" + esc(verdict) + "</td><td>" + esc(row.as_of) + "</td></tr>";
        }).join("") + "</tbody></table></div>" : "";
    }
  }

  function loadChecks() {
    return fetch(CHECKS_URL, { credentials: "omit", cache: "no-store" }).then(function (res) {
      if (!res.ok) throw new Error("checks");
      return res.json();
    }).then(renderChecks).catch(function () {
      renderChecks(null);
    });
  }

  function num(value) {
    return typeof value === "number" && isFinite(value) ? value : null;
  }

  function hideDollars(data) {
    return !data || data.public_view !== false;
  }

  function percentOfBudget(data) {
    var budget = num(data && data.budget);
    var actual = num(data && data.actual_to_date);
    if (budget == null || actual == null || budget === 0) return null;
    return (actual / budget) * 100;
  }

  function overBudget(data) {
    var budget = num(data && data.budget);
    var actual = num(data && data.actual_to_date);
    return budget != null && actual != null && actual > budget;
  }

  function alertOn(data) {
    var pct = percentOfBudget(data);
    return pct != null && pct >= 80;
  }

  function awaitingFigures(data) {
    if (!data) return true;
    if (num(data.budget) != null || num(data.forecast) != null || num(data.actual_to_date) != null) return false;
    var rows = Array.isArray(data.workstreams) ? data.workstreams : [];
    var keys = ["est_hours", "actual_hours", "est_tokens", "actual_tokens", "est_cost", "actual_cost"];
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i] || {};
      for (var k = 0; k < keys.length; k++) if (num(row[keys[k]]) != null) return false;
    }
    return true;
  }

  function formatPercent(pct) {
    if (pct == null) return "\u2014";
    var rounded = Math.round(pct * 10) / 10;
    if (Math.abs(rounded - Math.round(rounded)) < 1e-9) return String(Math.round(rounded)) + "%";
    return rounded.toFixed(1) + "%";
  }

  function formatMoney(value, currency) {
    if (value == null) return "\u2014";
    return value.toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " " + (currency || "CAD");
  }

  function formatCount(value) {
    if (value == null) return "\u2014";
    return value.toLocaleString("en-CA", { maximumFractionDigits: 2 });
  }

  function spendRows(data) {
    var byId = {};
    var list = data && Array.isArray(data.workstreams) ? data.workstreams : [];
    for (var i = 0; i < list.length; i++) {
      var row = list[i] || {};
      if (row.id && !byId[row.id]) byId[row.id] = row;
    }
    var out = [];
    var seen = {};
    for (var s = 0; s < STREAMS.length; s++) {
      seen[STREAMS[s][0]] = 1;
      out.push(Object.assign({ id: STREAMS[s][0], name: STREAMS[s][1] }, byId[STREAMS[s][0]] || {}));
    }
    for (var j = 0; j < list.length; j++) {
      var extra = list[j] || {};
      if (extra.id && !seen[extra.id]) {
        seen[extra.id] = 1;
        out.push(Object.assign({ name: String(extra.id) }, extra));
      }
    }
    return out;
  }

  function columnTotal(rows, key) {
    if (!rows.length) return null;
    var sum = 0;
    for (var i = 0; i < rows.length; i++) {
      var value = num(rows[i][key]);
      if (value == null) return null;
      sum += value;
    }
    return sum;
  }

  function renderSpend(data) {
    var waiting = awaitingFigures(data);
    var panel = document.getElementById("spend");
    if (panel) panel.hidden = !!waiting;
    if (waiting) return;
    var hidden = hideDollars(data);
    var currency = data && data.currency ? String(data.currency) : "CAD";
    var pct = data ? percentOfBudget(data) : null;
    var over = !!(data && overBudget(data));
    var onAlert = !!(data && alertOn(data));
    var status = document.getElementById("spend-status");
    var state = document.getElementById("spend-state");
    var alert = document.getElementById("spend-alert");
    var asof = document.getElementById("spend-asof");
    var source = document.getElementById("spend-source");
    var figures = document.getElementById("spend-figures");
    var note = document.getElementById("spend-public-note");
    if (status) status.textContent = waiting ? AWAITING : "";
    if (state) {
      state.textContent = over ? "Over budget" : "";
      state.className = over ? "spend-over" : "";
    }
    if (alert) {
      alert.textContent = ALERT_LINE;
      alert.className = onAlert ? "spend-alert on" : "spend-alert";
    }
    if (asof) asof.textContent = "as of " + (data && data.as_of ? String(data.as_of) : "\u2014");
    if (source) source.textContent = "Source: " + (data && data.source ? String(data.source) : "\u2014");
    if (note) {
      note.textContent = hidden && !waiting
        ? "Dollar amounts stay off this public view. The total is the percent of budget."
        : "";
    }
    var onOps = document.body.getAttribute("data-chrome-section") === "Ops";
    var budgetValue = !hidden && data ? formatMoney(num(data.budget), currency) : "\u2014";
    var forecastValue = !hidden && data ? formatMoney(num(data.forecast), currency) : "\u2014";
    var actualValue = !hidden && data ? formatMoney(num(data.actual_to_date), currency) : "\u2014";
    var percentValue = pct != null ? formatPercent(pct) : "\u2014";
    function figure(href, id, label, value, extra) {
      return "<a" + (id ? " id=\"" + id + "\"" : "") + " class=\"spend-fig" + (extra ? " " + extra : "") + "\" href=\"" + href + "\"><span class=\"k\">" + esc(label) + "</span><span class=\"v\">" + esc(value) + "</span></a>";
    }
    if (figures) {
      var prefix = onOps ? "#spend-rows" : "";
      figures.innerHTML = figure(onOps ? prefix : "/ops/#spend-budget", onOps ? "spend-budget" : "", "Budget", budgetValue)
        + figure(onOps ? prefix : "/ops/#spend-forecast", onOps ? "spend-forecast" : "", "Forecast", forecastValue)
        + figure(onOps ? prefix : "/ops/#spend-actual", onOps ? "spend-actual" : "", "Actual to date", actualValue)
        + figure(onOps ? prefix : "/ops/#spend-percent", onOps ? "spend-percent" : "", "Percent of budget used", percentValue, over ? "spend-over" : "");
    }
    var rowsHost = document.getElementById("spend-rows");
    if (!rowsHost) return;
    var rows = spendRows(data);
    var costHead = hidden ? "" : "<th scope=\"col\">Estimate cost</th><th scope=\"col\">Actual cost</th>";
    function cells(row) {
      var body = "<td>" + formatCount(num(row.est_hours)) + "</td><td>" + formatCount(num(row.actual_hours)) + "</td>"
        + "<td>" + formatCount(num(row.est_tokens)) + "</td><td>" + formatCount(num(row.actual_tokens)) + "</td>";
      if (!hidden) body += "<td>" + formatMoney(num(row.est_cost), currency) + "</td><td>" + formatMoney(num(row.actual_cost), currency) + "</td>";
      return body;
    }
    var body = rows.map(function (row) {
      return "<tr id=\"spend-ws-" + esc(row.id) + "\"><th scope=\"row\">" + esc(row.name) + "</th>" + cells(row) + "</tr>";
    }).join("");
    var total = {
      est_hours: columnTotal(rows, "est_hours"),
      actual_hours: columnTotal(rows, "actual_hours"),
      est_tokens: columnTotal(rows, "est_tokens"),
      actual_tokens: columnTotal(rows, "actual_tokens"),
      est_cost: columnTotal(rows, "est_cost"),
      actual_cost: columnTotal(rows, "actual_cost")
    };
    body += "<tr><th scope=\"row\">Total</th>" + cells(total) + "</tr>";
    rowsHost.innerHTML = "<div class=\"tablewrap\"><table><thead><tr><th scope=\"col\">Workstream</th><th scope=\"col\">Estimate hours</th><th scope=\"col\">Actual hours</th><th scope=\"col\">Estimate tokens</th><th scope=\"col\">Actual tokens</th>"
      + costHead + "</tr></thead><tbody>" + body + "</tbody></table></div>";
  }

  function loadSpend() {
    return fetch(SPEND_URL, { credentials: "omit", cache: "no-store" }).then(function (res) {
      if (!res.ok) throw new Error("spend");
      return res.json();
    }).then(renderSpend).catch(function () {
      renderSpend(null);
    });
  }

  function fail() {
    var note = document.getElementById("chart-error");
    if (note) note.hidden = false;
  }

  function boot() {
    var button = document.getElementById("milestone-live");
    if (button) {
      button.disabled = true;
      button.setAttribute("data-held-timeline", HELD_KEYS.timeline);
      button.setAttribute("data-held-progress", HELD_KEYS.progress);
      button.setAttribute("data-held-pokayoke", HELD_KEYS.pokayoke);
      button.setAttribute("data-held-governance", HELD_KEYS.governance);
      button.setAttribute("data-held-spend", HELD_KEYS.spend);
    }
    loadHeldCharts();
    if (document.getElementById("pokayoke-rows") || document.getElementById("governance-rows")) loadChecks();
    if (document.getElementById("spend")) loadSpend();
    window.__SFDC24_SPEND = {
      hideDollars: hideDollars,
      percentOfBudget: percentOfBudget,
      overBudget: overBudget,
      alertOn: alertOn,
      awaitingFigures: awaitingFigures,
      formatPercent: formatPercent,
      render: renderSpend
    };
    if (!document.getElementById("chart-progress") || !window.mermaid) {
      if (document.getElementById("chart-progress") && !window.mermaid) fail();
      return;
    }
    window.mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: "neutral",
      fontFamily: "Segoe UI, Helvetica, Arial, sans-serif",
      gantt: { useMaxWidth: false, barHeight: 22, fontSize: 12, sectionFontSize: 13 },
      xyChart: { useMaxWidth: false }
    });
    Promise.all(Object.keys(SOURCES).map(function (key) {
      return fetch(SOURCES[key], { credentials: "omit", cache: "no-store" }).then(function (res) {
        if (!res.ok) throw new Error("chart");
        return res.text();
      }).then(function (text) {
        return draw("chart-" + key, text);
      });
    })).catch(fail);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
