/* Pull-request board on the Ops page. PR_BOARD_ENABLED defaults off.
   Off: the note stays, the table stays empty, and this file does not fetch.
   On: it reads the public projection and fills one row per pull request.
   The projection is produced by tools/ops_pr_board.py --enable. */
(function (root) {
  "use strict";
  var PR_BOARD_ENABLED = false;
  var COLUMNS = ["pr", "priority", "blocks", "blocked_by", "owner", "closure_driver", "status", "days_open"];
  var TURN_FIELDS = ["pr", "first_review", "review_to_close", "open_to_close"];
  var TURN_METRICS = [
    ["first_review", "First review"],
    ["review_to_close", "Review to close"],
    ["open_to_close", "Open to close"]
  ];
  var TURN_REPOS = ["conference", "Blackboard", "sfdc24-site"];
  var TURN_AGENTS = ["Claude", "Aya", "Jenny", "Cody", "Greg"];

  function shown(value) {
    var text = value == null ? "" : String(value).replace(/^\s+|\s+$/g, "");
    return text ? text : "unassessed";
  }

  function shownTime(value) {
    var text = value == null ? "" : String(value).replace(/^\s+|\s+$/g, "");
    return text ? text : "unknown";
  }

  function displayRows(rows) {
    return (rows || []).map(function (row) {
      var out = {};
      for (var i = 0; i < COLUMNS.length; i++) out[COLUMNS[i]] = shown(row[COLUMNS[i]]);
      return out;
    });
  }

  function turnaroundRows(rows) {
    return (rows || []).map(function (row) {
      var out = {};
      for (var i = 0; i < TURN_FIELDS.length; i++) out[TURN_FIELDS[i]] = shownTime(row[TURN_FIELDS[i]]);
      return out;
    });
  }

  function addCell(document, row, text, scope) {
    var cell = document.createElement(scope ? "th" : "td");
    if (scope) cell.scope = scope;
    cell.textContent = text;
    row.appendChild(cell);
  }

  function fillTrends(document, host, turn) {
    host.textContent = "";
    var days = turn.days || [];
    var metrics = turn.metrics || {};
    for (var m = 0; m < TURN_METRICS.length; m++) {
      var key = TURN_METRICS[m][0];
      var label = TURN_METRICS[m][1];
      var metric = metrics[key] || {};
      var repos = metric.repos || {};
      var authors = metric.author || {};
      var reviewers = metric.reviewer || {};
      var table = document.createElement("table");
      var caption = document.createElement("caption");
      caption.textContent = label + ", daily median. Oldest day first.";
      table.appendChild(caption);
      var head = document.createElement("thead");
      var headRow = document.createElement("tr");
      addCell(document, headRow, "Who", "col");
      addCell(document, headRow, "Role", "col");
      for (var d = 0; d < days.length; d++) addCell(document, headRow, days[d], "col");
      head.appendChild(headRow);
      table.appendChild(head);
      var body = document.createElement("tbody");
      function addWho(name, role, values) {
        var tr = document.createElement("tr");
        addCell(document, tr, name, "row");
        addCell(document, tr, role, "");
        var series = values || [];
        for (var i = 0; i < days.length; i++) addCell(document, tr, shownTime(series[i]), false);
        body.appendChild(tr);
      }
      for (var r = 0; r < TURN_REPOS.length; r++) addWho(TURN_REPOS[r], "Repository", repos[TURN_REPOS[r]]);
      for (var a = 0; a < TURN_AGENTS.length; a++) {
        addWho(TURN_AGENTS[a], "Author", authors[TURN_AGENTS[a]]);
        addWho(TURN_AGENTS[a], "Reviewer", reviewers[TURN_AGENTS[a]]);
      }
      table.appendChild(body);
      host.appendChild(table);
    }
  }

  function fillTurnaround(document, snapshot) {
    var note = document.getElementById("pr-turnaround-note");
    var table = document.getElementById("pr-turnaround-table");
    var body = document.getElementById("pr-turnaround-rows");
    var trendNote = document.getElementById("pr-turnaround-trend-note");
    var trends = document.getElementById("pr-turnaround-trends");
    if (!note || !table || !body) return;
    body.textContent = "";
    if (trends) trends.textContent = "";
    if (!PR_BOARD_ENABLED || !snapshot || snapshot.enabled !== true) {
      table.hidden = true;
      note.textContent = "Turnaround is off. Review and close times are not loaded.";
      if (trendNote) {
        trendNote.textContent = "Daily median for each repository and each agent, oldest day first. This sits with the scorecard. It is not loaded while turnaround is off.";
      }
      return;
    }
    var turn = snapshot.turnaround || {};
    var rows = turnaroundRows(turn.rows);
    note.textContent = rows.length
      ? "Turnaround as of " + shown(snapshot.as_of) + ". Unknown means the history was not measured."
      : "No open pull requests in this projection.";
    table.hidden = false;
    for (var r = 0; r < rows.length; r++) {
      var tr = document.createElement("tr");
      for (var c = 0; c < TURN_FIELDS.length; c++) addCell(document, tr, rows[r][TURN_FIELDS[c]], "");
      body.appendChild(tr);
    }
    if (trendNote) trendNote.textContent = "Daily median for each repository and each agent. Oldest day first.";
    if (trends) fillTrends(document, trends, turn);
  }

  function fill(document, snapshot) {
    fillTurnaround(document, snapshot);
    var note = document.getElementById("pr-board-note");
    var table = document.getElementById("pr-board-table");
    var body = document.getElementById("pr-board-rows");
    if (!note || !table || !body) return;
    body.textContent = "";
    if (!PR_BOARD_ENABLED || !snapshot || snapshot.enabled !== true) {
      table.hidden = true;
      note.textContent = "The pull-request board is off. Priority and blockers are not loaded.";
      return;
    }
    var rows = displayRows(snapshot.rows);
    note.textContent = rows.length
      ? "Open pull requests as of " + shown(snapshot.as_of) + ". Highest priority first."
      : "No open pull requests in this projection.";
    table.hidden = false;
    for (var r = 0; r < rows.length; r++) {
      var tr = document.createElement("tr");
      if (rows[r].priority === "P0") tr.className = "p0";
      for (var c = 0; c < COLUMNS.length; c++) {
        var td = document.createElement("td");
        td.textContent = rows[r][COLUMNS[c]];
        tr.appendChild(td);
      }
      body.appendChild(tr);
    }
  }

  function pageDocument() {
    try {
      return typeof globalThis.document === "undefined" ? undefined : globalThis.document;
    } catch (error) {
      return undefined;
    }
  }

  function boot() {
    var page = pageDocument();
    if (!PR_BOARD_ENABLED || !page) return;
    var request = new XMLHttpRequest();
    request.open("GET", "/data/pr-board-public.json", true);
    request.onload = function () {
      if (request.status < 200 || request.status >= 300) return;
      try { fill(page, JSON.parse(request.responseText)); } catch (error) { /* keep the off note */ }
    };
    request.send();
  }

  var api = {
    PR_BOARD_ENABLED: PR_BOARD_ENABLED,
    COLUMNS: COLUMNS,
    TURN_FIELDS: TURN_FIELDS,
    displayRows: displayRows,
    turnaroundRows: turnaroundRows,
    fill: fill
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.opsPrBoard = api;
  var page = pageDocument();
  if (page) {
    if (page.readyState === "loading") page.addEventListener("DOMContentLoaded", boot);
    else boot();
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
