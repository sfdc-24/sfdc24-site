/* Executive delivery charts and the ops fleet table.
 * Reads the sanitized fleet pack and the same release files the homepage uses.
 * Does not render source, board-row phase maps, per-agent board-row counts,
 * or review failure rates. A missing pair is "not tracked yet".
 */
(function (root) {
  "use strict";
  var SEAT = {
    Claude: "Clay", Grok: "Greg", Gemini: "Jemma", Cursor: "Cody",
    Codex: "Paired review", Jev: "Jev", system: "Automation",
    intake: "Intake", other: "Other", Copilot: "Copilot"
  };
  var REPO = {
    "sfdc-24/sfdc24-site": "site",
    "sfdc-24/Blackboard": "board",
    "sfdc-24/conference": "conference",
    "sfdc-24/converspan": "converspan"
  };

  function delta(rows, key) {
    return rows.map(function (row, i) {
      if (i === 0) return null;
      var prev = rows[i - 1][key];
      var cur = row[key];
      if (typeof prev !== "number" || typeof cur !== "number") return null;
      return cur - prev;
    });
  }

  function seat(name) {
    return SEAT[name] || name;
  }

  function repo(name) {
    return REPO[name] || name;
  }

  function num(value) {
    return typeof value === "number" && isFinite(value) ? String(value) : "not tracked yet";
  }

  function ratio(value) {
    return typeof value === "number" && isFinite(value) ? value + "x" : "not tracked yet";
  }

  function pct(value) {
    return typeof value === "number" && isFinite(value) ? value + "%" : "not tracked yet";
  }

  function el(doc, id) {
    return doc.getElementById(id);
  }

  function cell(doc, text, label) {
    var td = doc.createElement("td");
    td.textContent = text;
    if (label) td.setAttribute("data-label", label);
    if (text === "not tracked yet") td.className = "muted-na";
    return td;
  }

  function svgEl(doc, name, attrs) {
    var node = doc.createElementNS("http://www.w3.org/2000/svg", name);
    Object.keys(attrs).forEach(function (key) { node.setAttribute(key, attrs[key]); });
    return node;
  }

  function lineChart(doc, svg, rows, series) {
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    var w = 800, h = 210, left = 44, right = 16, top = 16, bottom = 36;
    var plotW = w - left - right, plotH = h - top - bottom;
    var max = 1;
    series.forEach(function (s) {
      rows.forEach(function (row) {
        var v = Math.abs(row[s.key] || 0);
        if (v > max) max = v;
      });
    });
    svg.setAttribute("viewBox", "0 0 " + w + " " + h);
    svg.appendChild(svgEl(doc, "line", {
      x1: left, y1: top + plotH, x2: w - right, y2: top + plotH,
      stroke: "#BDBDBD", "stroke-width": "1.5"
    }));
    var n = rows.length;
    series.forEach(function (s) {
      var pts = [];
      rows.forEach(function (row, i) {
        var x = left + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW);
        var y = top + plotH - ((row[s.key] || 0) / max) * plotH;
        pts.push(x.toFixed(1) + "," + y.toFixed(1));
      });
      svg.appendChild(svgEl(doc, "polyline", {
        fill: "none", stroke: s.color, "stroke-width": "2.5",
        "stroke-linecap": "round", "stroke-linejoin": "round", points: pts.join(" ")
      }));
    });
    rows.forEach(function (row, i) {
      var x = left + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW);
      var label = svgEl(doc, "text", {
        x: x, y: h - 12, "text-anchor": "middle", "font-size": "10",
        fill: "#525252", "font-family": "sans-serif"
      });
      label.textContent = String(row.week || "").replace("2026-", "");
      svg.appendChild(label);
    });
  }

  function accelChart(doc, svg, rows, deltas) {
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    var w = 800, h = 180, left = 44, right = 16, top = 16, bottom = 32;
    var plotW = w - left - right, plotH = h - top - bottom;
    var max = 1;
    deltas.forEach(function (v) { if (v != null && Math.abs(v) > max) max = Math.abs(v); });
    var mid = top + plotH / 2;
    svg.setAttribute("viewBox", "0 0 " + w + " " + h);
    svg.appendChild(svgEl(doc, "line", {
      x1: left, y1: mid, x2: w - right, y2: mid, stroke: "#BDBDBD", "stroke-width": "1.5"
    }));
    var n = rows.length;
    var gap = plotW / n;
    rows.forEach(function (row, i) {
      var v = deltas[i];
      var x = left + i * gap + gap * 0.2;
      var bh = v == null ? 0 : (Math.abs(v) / max) * (plotH / 2);
      var y = v != null && v < 0 ? mid : mid - bh;
      svg.appendChild(svgEl(doc, "rect", {
        x: x, y: y, width: gap * 0.6, height: Math.max(bh, v == null ? 0 : 1),
        fill: v != null && v < 0 ? "#8A4B00" : "#0A66C2"
      }));
      var label = svgEl(doc, "text", {
        x: x + gap * 0.3, y: h - 10, "text-anchor": "middle", "font-size": "10",
        fill: "#525252", "font-family": "sans-serif"
      });
      label.textContent = String(row.week || "").replace("2026-", "");
      svg.appendChild(label);
    });
  }

  function paintMirror(doc, pack) {
    var host = el(doc, "home-mirror-body");
    if (!host) return;
    while (host.firstChild) host.removeChild(host.firstChild);
    var rigor = pack.rigor || {};
    var releases = pack.releases || {};
    var milestone = pack.milestone;
    var cards = doc.createElement("div");
    cards.className = "meta-strip";
    function card(label, value, sub) {
      var box = doc.createElement("div");
      box.className = "stat-card";
      var a = doc.createElement("span"); a.className = "stat-label"; a.textContent = label;
      var b = doc.createElement("span"); b.className = "stat-val"; b.textContent = value;
      var c = doc.createElement("span"); c.className = "stat-sub"; c.textContent = sub;
      box.appendChild(a); box.appendChild(b); box.appendChild(c);
      cards.appendChild(box);
    }
    var tests = rigor.chair_tests || [];
    var breaks = rigor.chair_break_it_checks || [];
    var lastTest = tests.length ? tests[tests.length - 1] : null;
    var lastBreak = breaks.length ? breaks[breaks.length - 1] : null;
    card("Chair tests", lastTest ? lastTest.count.toLocaleString("en-US") : "not tracked yet",
      lastTest ? "as of " + lastTest.date : "build-rigor.json");
    card("Break-it checks", lastBreak ? lastBreak.count.toLocaleString("en-US") : "not tracked yet",
      lastBreak ? "as of " + lastBreak.date : "build-rigor.json");
    var since = rigor.changes_merged && rigor.changes_merged.since;
    card("Changes merged", since ? since.count.toLocaleString("en-US") : "not tracked yet",
      since ? "since " + since.from : "build-rigor.json");
    if (milestone) {
      card("Next milestone", milestone.label || "not tracked yet",
        milestone.at ? String(milestone.at) : "no date set");
    }
    host.appendChild(cards);
    var list = doc.createElement("ul");
    list.className = "chart-desc";
    var current = releases.current || {};
    var next = releases.next || {};
    function item(text) {
      var li = doc.createElement("li");
      li.textContent = text;
      list.appendChild(li);
    }
    if (current.title) item("Live release train: " + current.title + (current.date ? " (" + current.date + ")" : ""));
    if (next.date) item("Next weekly target: " + next.date + (next.summary ? ". " + next.summary : ""));
    (releases.history || []).slice(0, 4).forEach(function (row) {
      if (row && row.title) item("Earlier train: " + row.title);
    });
    (pack.milestones || []).forEach(function (row) {
      if (row && row.text) item((row.date || "") + " — " + row.text);
    });
    host.appendChild(list);
  }

  function paintDelivery(doc, pack) {
    var weeks = (pack.weekly && pack.weekly.weeks) || [];
    var totals = pack.totals || {};
    paintMirror(doc, pack);
    var kpis = el(doc, "fleet-kpis");
    if (kpis) {
      while (kpis.firstChild) kpis.removeChild(kpis.firstChild);
      var acc = totals.estimate_accuracy || {};
      var bits = [
        ["On time", pct(acc.on_time_pct), "paired estimates in the pack"],
        ["Median actual / estimate", ratio(acc.median_ratio), acc.paired ? acc.paired + " pairs" : "not tracked yet"],
        ["Pull requests merged", num(totals.prs_merged_total), "1 Sep through 12 Nov 2026"],
        ["Work done", num(totals.done_rows_excluding_waker), "excludes automatic replies"],
        ["Work orders", num(totals.work_orders_total), "unique task tokens"],
        ["Conference tests", num(totals.conference_test_rows),
          num(totals.conference_test_pass) + " recorded pass, " + num(totals.conference_test_outcome_unrecorded) + " unrecorded"]
      ];
      bits.forEach(function (bit) {
        var chip = doc.createElement("div");
        chip.className = "kpi-chip";
        var a = doc.createElement("div"); a.className = "kpi-label"; a.textContent = bit[0];
        var b = doc.createElement("div"); b.className = "kpi-val"; b.textContent = bit[1];
        var c = doc.createElement("div"); c.className = "kpi-sub"; c.textContent = bit[2];
        chip.appendChild(a); chip.appendChild(b); chip.appendChild(c);
        kpis.appendChild(chip);
      });
    }
    var vel = el(doc, "fleet-velocity-svg");
    if (vel) lineChart(doc, vel, weeks, [
      { key: "prs_merged_total", color: "#0A66C2" },
      { key: "done_rows_excluding_waker", color: "#136F3A" }
    ]);
    var prDelta = delta(weeks, "prs_merged_total");
    var workDelta = delta(weeks, "done_rows_excluding_waker");
    var accSvg = el(doc, "fleet-accel-svg");
    if (accSvg) accelChart(doc, accSvg, weeks, prDelta);
    var body = el(doc, "fleet-week-rows");
    if (body) {
      while (body.firstChild) body.removeChild(body.firstChild);
      weeks.forEach(function (week, i) {
        var tr = doc.createElement("tr");
        var ea = week.estimate_accuracy || {};
        [week.week, num(week.done_rows_excluding_waker), num(week.prs_merged_total),
          i === 0 ? "not tracked yet" : num(prDelta[i]),
          i === 0 ? "not tracked yet" : num(workDelta[i]),
          pct(ea.on_time_pct), ratio(ea.median_ratio)].forEach(function (text) {
          tr.appendChild(cell(doc, text));
        });
        body.appendChild(tr);
      });
    }
    var repos = el(doc, "fleet-repo-rows");
    if (repos) {
      while (repos.firstChild) repos.removeChild(repos.firstChild);
      weeks.forEach(function (week) {
        var counts = week.prs_merged_by_repo || {};
        Object.keys(counts).forEach(function (name) {
          var tr = doc.createElement("tr");
          [week.week, repo(name), num(counts[name])].forEach(function (text) {
            tr.appendChild(cell(doc, text));
          });
          repos.appendChild(tr);
        });
      });
    }
    var agents = el(doc, "fleet-agent-rows");
    if (agents) {
      while (agents.firstChild) agents.removeChild(agents.firstChild);
      var done = totals.done_rows_by_agent_excluding_waker || {};
      var orders = totals.work_orders_by_agent || {};
      var names = {};
      Object.keys(done).forEach(function (n) { names[n] = 1; });
      Object.keys(orders).forEach(function (n) { names[n] = 1; });
      Object.keys(names).sort().forEach(function (name) {
        var tr = doc.createElement("tr");
        [seat(name), num(orders[name] || 0), num(done[name] || 0), "not tracked yet"].forEach(function (text) {
          tr.appendChild(cell(doc, text));
        });
        agents.appendChild(tr);
      });
    }
  }

  function paintOps(doc, pack) {
    var note = el(doc, "ops-fleet-note");
    var body = el(doc, "ops-fleet-rows");
    if (!note || !body) return;
    var gen = pack.generated || {};
    var totals = pack.totals || {};
    var acc = totals.estimate_accuracy || {};
    note.textContent = "Fleet pack " + (gen.generated_at || "time unavailable") +
      ", America/Toronto. Board rows start 18 Sep, so the weeks of 1 Sep and 7 Sep are zero on board-derived counts. Error rate stays on the scorecard above and is not repeated here.";
    while (body.firstChild) body.removeChild(body.firstChild);
    var rows = [
      ["Work orders", num(totals.work_orders_total)],
      ["Work done, excluding automatic replies", num(totals.done_rows_excluding_waker)],
      ["Work done, including automatic replies", num(totals.done_rows_including_waker)],
      ["On time", pct(acc.on_time_pct)],
      ["Median actual / estimate", ratio(acc.median_ratio)],
      ["Pull requests merged", num(totals.prs_merged_total)],
      ["Conference test rows", num(totals.conference_test_rows)],
      ["Mutant planted and killed", "not tracked yet"],
      ["Board release log", "not tracked yet"],
      ["Scorecard utilization, error rate, and spend", "not tracked yet"]
    ];
    rows.forEach(function (row) {
      var tr = doc.createElement("tr");
      tr.appendChild(cell(doc, row[0], "Measure"));
      tr.appendChild(cell(doc, row[1], "Value"));
      body.appendChild(tr);
    });
  }

  function readJson(url) {
    return fetch(url, { cache: "no-store", credentials: "omit" }).then(function (res) {
      if (!res.ok) return null;
      return res.json();
    }).catch(function () { return null; });
  }

  function currentMilestone(doc) {
    var rows = doc && Array.isArray(doc.milestones) ? doc.milestones : [];
    for (var i = 0; i < rows.length; i++) {
      if (rows[i] && rows[i].status !== "passed") return rows[i];
    }
    return null;
  }

  function boot() {
    var doc = root.document;
    if (!doc) return;
    if (!el(doc, "fleet-week-rows") && !el(doc, "ops-fleet-rows")) return;
    var fleet = root.SFDC24FleetPack;
    var strip = fleet && fleet.strip ? fleet.strip : function (v) { return v; };
    Promise.all([
      readJson("/data/fleet-pack/weekly.json"),
      readJson("/data/fleet-pack/totals.json"),
      readJson("/data/fleet-pack/milestones.json"),
      readJson("/data/fleet-pack/generated_at.json"),
      readJson("/data/build-rigor.json"),
      readJson("/data/releases.json"),
      readJson("/data/release-milestones.json")
    ]).then(function (parts) {
      var pack = {
        weekly: strip(parts[0] || {}),
        totals: strip(parts[1] || {}),
        milestones: (strip(parts[2] || {}).items) || [],
        generated: strip(parts[3] || {}),
        rigor: parts[4] || {},
        releases: parts[5] || {},
        milestone: currentMilestone(parts[6] || {})
      };
      paintDelivery(doc, pack);
      paintOps(doc, pack);
    });
  }

  var api = { delta: delta, seat: seat, repo: repo, paintDelivery: paintDelivery, paintOps: paintOps };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root.document) {
    if (root.document.readyState === "loading") root.document.addEventListener("DOMContentLoaded", boot);
    else boot();
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
