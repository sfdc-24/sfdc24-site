/* Pull-request board on the Ops page. PR_BOARD_ENABLED defaults off.
   Off: the note stays, the table stays empty, and this file does not fetch.
   On: it reads the public projection and fills one row per pull request.
   The projection is produced by tools/ops_pr_board.py --enable. */
(function (root) {
  "use strict";
  var PR_BOARD_ENABLED = false;
  var COLUMNS = ["pr", "priority", "blocks", "blocked_by", "owner", "closure_driver", "status", "days_open"];

  function shown(value) {
    var text = value == null ? "" : String(value).replace(/^\s+|\s+$/g, "");
    return text ? text : "unassessed";
  }

  function displayRows(rows) {
    return (rows || []).map(function (row) {
      var out = {};
      for (var i = 0; i < COLUMNS.length; i++) out[COLUMNS[i]] = shown(row[COLUMNS[i]]);
      return out;
    });
  }

  function fill(document, snapshot) {
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

  var api = { PR_BOARD_ENABLED: PR_BOARD_ENABLED, COLUMNS: COLUMNS, displayRows: displayRows, fill: fill };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.opsPrBoard = api;
  var page = pageDocument();
  if (page) {
    if (page.readyState === "loading") page.addEventListener("DOMContentLoaded", boot);
    else boot();
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
