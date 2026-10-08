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
    governance: "proj:governance:v1"
  };
  var CHECKS_URL = "/assets/milestones/pokayoke.json";
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
      govStatus.textContent = governance.length && data && data.governance_score
        ? String(data.governance_score)
        : (governance.length ? "" : pending);
    }
    var govAsOf = document.getElementById("governance-asof");
    if (govAsOf) {
      govAsOf.textContent = data && data.governance_as_of ? "as of " + String(data.governance_as_of) : "";
    }
    if (pokeRows) {
      pokeRows.innerHTML = learnings.length ? "<div class=\"tablewrap\"><table class=\"streams\"><thead><tr><th scope=\"col\">Id</th><th scope=\"col\">Defect</th><th scope=\"col\">Control</th><th scope=\"col\">Owner</th>"
        + (showEnforced ? "<th scope=\"col\">Enforced in</th>" : "")
        + "<th scope=\"col\">Status</th></tr></thead><tbody>"
        + learnings.map(function (row) {
          return "<tr><td>" + esc(row.id) + "</td><td>" + esc(row.defect) + "</td><td>" + esc(row.control) + "</td><td>" + esc(row.owner) + "</td>"
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
    }
    loadHeldCharts();
    loadChecks();
    if (!window.mermaid) { fail(); return; }
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
