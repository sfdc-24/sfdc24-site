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
  var VERDICTS = { PASS: 1, FAIL: 1, "NOT TESTED": 1 };
  var SOURCES = {
    progress: "/assets/milestones/2026-10-08-progress.mmd",
    timeline: "/assets/milestones/2026-10-08.mmd"
  };

  function loadHeldCharts() {
    if (!LIVE_CHART) return null;
    return HELD_KEYS;
  }

  function draw(id, text) {
    var host = document.getElementById(id);
    if (!host || !window.mermaid) return Promise.reject(new Error("chart"));
    return window.mermaid.render("svg-" + id, text).then(function (out) {
      host.innerHTML = out.svg;
      var svg = host.querySelector("svg");
      if (svg) {
        svg.style.maxWidth = "none";
        svg.style.minWidth = id === "chart-timeline" ? "880px" : "640px";
        svg.setAttribute("role", "img");
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
    if (pokeStatus) pokeStatus.textContent = learnings.length ? "" : "No mistake-proofing rows are recorded yet.";
    if (govStatus) govStatus.textContent = governance.length ? "" : pending;
    if (pokeRows) {
      pokeRows.innerHTML = learnings.length ? "<table class=\"streams\"><thead><tr><th scope=\"col\">Id</th><th scope=\"col\">Defect</th><th scope=\"col\">Control</th><th scope=\"col\">Owner</th><th scope=\"col\">Enforced in</th><th scope=\"col\">Status</th></tr></thead><tbody>"
        + learnings.map(function (row) {
          return "<tr><td>" + esc(row.id) + "</td><td>" + esc(row.defect) + "</td><td>" + esc(row.control) + "</td><td>" + esc(row.owner) + "</td><td>" + esc(row.enforced_in) + "</td><td>" + esc(row.status) + "</td></tr>";
        }).join("") + "</tbody></table>" : "";
    }
    if (govRows) {
      govRows.innerHTML = governance.length ? "<table class=\"streams\"><thead><tr><th scope=\"col\">Protocol</th><th scope=\"col\">Verdict</th><th scope=\"col\">As of</th></tr></thead><tbody>"
        + governance.map(function (row) {
          var verdict = String(row.verdict || "");
          return "<tr><td>" + esc(row.protocol) + "</td><td>" + esc(VERDICTS[verdict] ? verdict : verdict) + "</td><td>" + esc(row.as_of) + "</td></tr>";
        }).join("") + "</tbody></table>" : "";
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
      gantt: { useMaxWidth: false, barHeight: 22, fontSize: 12 },
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
