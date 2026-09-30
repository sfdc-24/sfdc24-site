/* Agent repository work on /ops, from data/ops-agent-metrics.json (tools/ops_agent_metrics.py).
   Every number is read from pull requests and their review verdicts; an agent with no record in the
   window shows a dash, never a zero, and the page prints each measure's definition beside it. */
(function () {
  "use strict";

  function pct(value) {
    return typeof value === "number" && isFinite(value) ? Math.round(value * 100) + "%" : "—";
  }

  function hours(value) {
    return typeof value === "number" && isFinite(value) ? value.toFixed(1) + " h" : "—";
  }

  // One row per agent, as plain strings: the page and the tests read the same thing.
  function rows(snapshot) {
    var agents = snapshot && Array.isArray(snapshot.agents) ? snapshot.agents : [];
    return agents.map(function (a) {
      var did = (Array.isArray(a.did) ? a.did : []).slice(0, 3).map(function (d) {
        return String(d.title || "") + " (" + String(d.repo || "") + " #" + String(d.number || "") + ")";
      });
      // The private repositories give counts only: their titles are never on the page.
      var counts = a.merged_by_repo && typeof a.merged_by_repo === "object" ? a.merged_by_repo : {};
      var hidden = (Array.isArray(snapshot.private_repos) ? snapshot.private_repos : []).map(function (r) {
        var name = String(r).split("/")[1];
        return counts[name] ? counts[name] + " merged in " + (name === "conference" ? "the conference" : "the board") +
          " repository" : "";
      }).filter(Boolean);
      if (hidden.length) did.push(hidden.join(", ") + " (private: titles not shown).");
      return {
        agent: String(a.agent || ""),
        prs: a.pull_requests ? a.pull_requests + " (" + a.merged + " merged)" : "—",
        utilization: a.pull_requests ? pct(a.utilization) + " (" + a.active_hours + " of " + a.window_hours + " h)" : "—",
        errors: a.verdicts ? pct(a.error_rate) + " (" + a.nogo + " NO-GO of " + a.verdicts + ")" : "—",
        efficiency: hours(a.median_hours_to_merge),
        did: did.length ? did : [a.note ? String(a.note) : "No merged pull request in the window."],
      };
    });
  }

  function cell(tag, text) {
    var el = document.createElement(tag);
    el.textContent = text;
    return el;
  }

  function render(snapshot) {
    var table = document.getElementById("agent-metrics-table");
    var defs = document.getElementById("agent-metrics-defs");
    var note = document.getElementById("agent-metrics-note");
    if (!table || !defs) return;
    var t = document.createElement("table");
    var head = document.createElement("tr");
    ["Agent", "Pull requests", "Utilization", "Error rate", "Efficiency", "Who did what"].forEach(function (h) {
      head.appendChild(cell("th", h));
    });
    t.appendChild(head);
    rows(snapshot).forEach(function (r) {
      var tr = document.createElement("tr");
      [r.agent, r.prs, r.utilization, r.errors, r.efficiency].forEach(function (v) { tr.appendChild(cell("td", v)); });
      var what = document.createElement("td");
      var ul = document.createElement("ul");
      r.did.forEach(function (d) { ul.appendChild(cell("li", d)); });
      what.appendChild(ul);
      tr.appendChild(what);
      t.appendChild(tr);
    });
    table.replaceChildren(t);
    var d = snapshot.definitions || {};
    defs.replaceChildren();
    [["Utilization", d.utilization], ["Error rate", d.error_rate], ["Efficiency", d.efficiency],
      ["Who is who", d.attribution]].forEach(function (pair) {
      if (!pair[1]) return;
      defs.appendChild(cell("dt", pair[0]));
      defs.appendChild(cell("dd", String(pair[1])));
    });
    if (note && snapshot.window_start && snapshot.observed_at) {
      note.textContent = "From pull requests and their review verdicts in the site, board and conference " +
        "repositories, " + snapshot.window_start.slice(0, 16).replace("T", " ") + " to " +
        snapshot.observed_at.slice(0, 16).replace("T", " ") + " UTC. Repository work only: board and chat work is not counted.";
    }
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = {rows: rows, pct: pct, hours: hours};
    return;
  }
  fetch("/data/ops-agent-metrics.json", {cache: "no-cache"})
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (snapshot) {
      if (snapshot) render(snapshot);
      else document.getElementById("agent-metrics-table").textContent = "The agent work snapshot did not load.";
    })
    .catch(function () {
      var el = document.getElementById("agent-metrics-table");
      if (el) el.textContent = "The agent work snapshot did not load.";
    });
}());
