/* V6 task tracker. Counters are counted from the rows.
 * Public text drops case numbers, pull-request numbers, and git hashes.
 * The assignee "You" is shown as "Owner". Task ids stay.
 */
(function (root) {
  "use strict";
  var ORDER = ["Done", "Built, not merged", "In progress", "Waiting", "Rework", "Not started"];
  var PILL = {
    "Done": "pill-done",
    "Built, not merged": "pill-built",
    "In progress": "pill-progress",
    "Waiting": "pill-waiting",
    "Rework": "pill-rework",
    "Not started": "pill-idle"
  };
  var COLOR = {
    "Done": "#136F3A",
    "Built, not merged": "#0A66C2",
    "In progress": "#8A4B00",
    "Waiting": "#5B3FD9",
    "Rework": "#9B2C2C",
    "Not started": "#9E9E9E"
  };
  var DAY = { Wed: 11, Thu: 12, Fri: 13, Sat: 14 };

  function sanitize(value) {
    var text = String(value == null ? "" : value);
    text = text.replace(/\bYou\b/g, "Owner");
    text = text.replace(/\bCase\s*0+\d+\b/gi, "");
    text = text.replace(/#\d+\b/g, "");
    text = text.replace(/\b[0-9a-f]{40}\b/g, "");
    return text.replace(/\s{2,}/g, " ").trim();
  }

  function taskRows(doc) {
    var out = [];
    (doc && doc.tables || []).forEach(function (table) {
      (table.rows || []).forEach(function (row) {
        if (row && row.status) out.push(row);
      });
    });
    return out;
  }

  function counts(doc) {
    var tally = {};
    ORDER.forEach(function (name) { tally[name] = 0; });
    taskRows(doc).forEach(function (row) {
      var status = sanitize(row.status);
      if (!tally.hasOwnProperty(status)) tally[status] = 0;
      tally[status] += 1;
    });
    tally.total = taskRows(doc).length;
    return tally;
  }

  function parseDue(text) {
    var raw = String(text || "");
    var day = raw.match(/\b(Wed|Thu|Fri|Sat)\b/);
    if (!day || !DAY[day[1]]) return null;
    var clock = raw.match(/(\d{1,2}):(\d{2})\s*(am|pm)?/i);
    var hour = 18;
    var minute = 0;
    if (clock) {
      hour = parseInt(clock[1], 10);
      minute = parseInt(clock[2], 10);
      var mer = (clock[3] || "").toLowerCase();
      if (mer === "pm" && hour < 12) hour += 12;
      if (mer === "am" && hour === 12) hour = 0;
    } else if (!/evening/i.test(raw)) {
      return null;
    }
    var date = DAY[day[1]];
    var stamp = "2026-11-" + (date < 10 ? "0" : "") + date + "T" +
      (hour < 10 ? "0" : "") + hour + ":" + (minute < 10 ? "0" : "") + minute + ":00-05:00";
    var ms = Date.parse(stamp);
    return isFinite(ms) ? ms : null;
  }

  function burndown(doc) {
    var dues = taskRows(doc).map(function (row) { return parseDue(row.due_et); }).filter(function (ms) {
      return ms != null;
    }).sort(function (a, b) { return a - b; });
    var points = [];
    dues.forEach(function (ms) {
      var remaining = dues.filter(function (due) { return due >= ms; }).length;
      if (!points.length || points[points.length - 1].at !== ms) points.push({ at: ms, remaining: remaining });
      else points[points.length - 1].remaining = remaining;
    });
    return points;
  }

  function byAssignee(doc) {
    var map = {};
    taskRows(doc).forEach(function (row) {
      var name = sanitize(row.assigned) || "Unassigned";
      if (!map[name]) {
        map[name] = {};
        ORDER.forEach(function (status) { map[name][status] = 0; });
      }
      var status = sanitize(row.status);
      if (!map[name].hasOwnProperty(status)) map[name][status] = 0;
      map[name][status] += 1;
    });
    return map;
  }

  function svg(doc, name, attrs) {
    var node = doc.createElementNS("http://www.w3.org/2000/svg", name);
    Object.keys(attrs).forEach(function (key) { node.setAttribute(key, attrs[key]); });
    return node;
  }

  function statusChart(doc, host, tally) {
    while (host.firstChild) host.removeChild(host.firstChild);
    var w = 800, h = 200, left = 150, right = 36, top = 16;
    var rowH = 26;
    host.setAttribute("viewBox", "0 0 " + w + " " + h);
    var max = Math.max.apply(null, ORDER.map(function (name) { return tally[name] || 0; }).concat([1]));
    ORDER.forEach(function (name, i) {
      var y = top + i * rowH;
      var width = ((tally[name] || 0) / max) * (w - left - right);
      host.appendChild(svg(doc, "rect", { x: left, y: y, width: Math.max(width, 1), height: 16, fill: COLOR[name] }));
      var label = svg(doc, "text", { x: left - 8, y: y + 12, "text-anchor": "end", "font-size": "11", fill: "#191919", "font-family": "sans-serif" });
      label.textContent = name;
      host.appendChild(label);
      var n = svg(doc, "text", { x: left + width + 6, y: y + 12, "font-size": "11", fill: "#525252", "font-family": "sans-serif" });
      n.textContent = String(tally[name] || 0);
      host.appendChild(n);
    });
  }

  function burndownChart(doc, host, points) {
    while (host.firstChild) host.removeChild(host.firstChild);
    if (!points.length) return;
    var w = 800, h = 180, left = 36, right = 16, top = 16, bottom = 28;
    var plotW = w - left - right, plotH = h - top - bottom;
    var max = points[0].remaining || 1;
    host.setAttribute("viewBox", "0 0 " + w + " " + h);
    host.appendChild(svg(doc, "line", {
      x1: left, y1: top + plotH, x2: w - right, y2: top + plotH, stroke: "#BDBDBD", "stroke-width": "1.5"
    }));
    var pts = points.map(function (point, i) {
      var x = left + (points.length === 1 ? 0 : (i / (points.length - 1)) * plotW);
      var y = top + plotH - (point.remaining / max) * plotH;
      return x.toFixed(1) + "," + y.toFixed(1);
    });
    host.appendChild(svg(doc, "polyline", {
      fill: "none", stroke: "#0A66C2", "stroke-width": "2.5", points: pts.join(" ")
    }));
  }

  function paint(doc, data) {
    if (!data) return;
    var intro = doc.getElementById("v6-intro");
    var asof = doc.getElementById("v6-asof");
    if (intro) intro.textContent = sanitize(data.intro);
    if (asof) asof.textContent = sanitize(data.as_of);
    var tally = counts(data);
    var counters = doc.getElementById("v6-counters");
    if (counters) {
      while (counters.firstChild) counters.removeChild(counters.firstChild);
      ORDER.concat(["total"]).forEach(function (name) {
        var chip = doc.createElement("div");
        chip.className = "kpi-chip";
        var a = doc.createElement("div"); a.className = "kpi-label"; a.textContent = name === "total" ? "Total" : name;
        var b = doc.createElement("div"); b.className = "kpi-val"; b.textContent = String(name === "total" ? tally.total : (tally[name] || 0));
        chip.appendChild(a); chip.appendChild(b);
        counters.appendChild(chip);
      });
    }
    var statusHost = doc.getElementById("v6-status");
    if (statusHost) statusChart(doc, statusHost, tally);
    var burnHost = doc.getElementById("v6-burndown");
    if (burnHost) burndownChart(doc, burnHost, burndown(data));
    var body = doc.getElementById("v6-by-assignee");
    if (body) {
      while (body.firstChild) body.removeChild(body.firstChild);
      var groups = byAssignee(data);
      Object.keys(groups).sort().forEach(function (name) {
        var tr = doc.createElement("tr");
        var who = doc.createElement("td");
        who.textContent = name;
        tr.appendChild(who);
        ORDER.forEach(function (status) {
          var td = doc.createElement("td");
          td.textContent = String(groups[name][status] || 0);
          tr.appendChild(td);
        });
        body.appendChild(tr);
      });
    }
    var tables = doc.getElementById("v6-tables");
    if (!tables) return;
    while (tables.firstChild) tables.removeChild(tables.firstChild);
    (data.tables || []).forEach(function (table) {
      var title = doc.createElement("h3");
      title.className = "chart-title";
      title.textContent = sanitize(table.title);
      tables.appendChild(title);
      if (table.caption) {
        var cap = doc.createElement("p");
        cap.className = "chart-desc";
        cap.textContent = sanitize(table.caption);
        tables.appendChild(cap);
      }
      if (table.note) {
        var note = doc.createElement("p");
        note.className = "chart-desc";
        note.textContent = sanitize(table.note);
        tables.appendChild(note);
      }
      if (table.id === "road-to-launch") {
        var train = doc.createElement("div");
        train.className = "train-timeline";
        train.setAttribute("role", "list");
        (table.rows || []).forEach(function (row) {
          var node = doc.createElement("article");
          node.className = "checkpoint-node";
          var head = doc.createElement("div");
          head.className = "node-head";
          var when = doc.createElement("span");
          when.className = "node-id";
          when.textContent = sanitize(row.when);
          head.appendChild(when);
          var what = doc.createElement("div");
          what.className = "node-title";
          what.textContent = sanitize(row.what);
          var who = doc.createElement("div");
          who.className = "node-status-line";
          who.textContent = sanitize(row.assigned);
          node.appendChild(head);
          node.appendChild(what);
          node.appendChild(who);
          train.appendChild(node);
        });
        tables.appendChild(train);
      }
      var wrap = doc.createElement("div");
      wrap.className = "metrics-table-wrap";
      wrap.tabIndex = 0;
      var grid = doc.createElement("table");
      grid.className = "metrics-table";
      var headRow = doc.createElement("tr");
      var headers = table.id === "road-to-launch" ? ["When", "What", "Assigned"] : ["Task", "What", "Assigned", "Due ET", "Status"];
      headers.forEach(function (label) {
        var th = doc.createElement("th");
        th.scope = "col";
        th.textContent = label;
        headRow.appendChild(th);
      });
      var thead = doc.createElement("thead");
      thead.appendChild(headRow);
      grid.appendChild(thead);
      var tbody = doc.createElement("tbody");
      (table.rows || []).forEach(function (row) {
        var tr = doc.createElement("tr");
        if (table.id === "road-to-launch") {
          [row.when, row.what, row.assigned].forEach(function (value) {
            var td = doc.createElement("td");
            td.textContent = sanitize(value);
            tr.appendChild(td);
          });
        } else {
          ["task", "what", "assigned", "due_et"].forEach(function (key) {
            var td = doc.createElement("td");
            td.textContent = sanitize(row[key]);
            tr.appendChild(td);
          });
          var state = doc.createElement("td");
          var pill = doc.createElement("span");
          var status = sanitize(row.status);
          pill.className = "pill " + (PILL[status] || "pill-idle");
          pill.textContent = status;
          state.appendChild(pill);
          tr.appendChild(state);
        }
        tbody.appendChild(tr);
      });
      grid.appendChild(tbody);
      wrap.appendChild(grid);
      tables.appendChild(wrap);
    });
  }

  function boot() {
    var doc = root.document;
    if (!doc || !doc.getElementById("v6-tracker")) return;
    fetch("/data/v6-tracker.json", { cache: "no-store", credentials: "omit" }).then(function (res) {
      if (!res.ok) return null;
      return res.json();
    }).then(function (data) {
      if (data) paint(doc, data);
    }).catch(function () {});
  }

  var api = { sanitize: sanitize, counts: counts, parseDue: parseDue, burndown: burndown, byAssignee: byAssignee };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root.document) {
    if (root.document.readyState === "loading") root.document.addEventListener("DOMContentLoaded", boot);
    else boot();
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
