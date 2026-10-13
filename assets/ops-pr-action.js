/* Private action queue beside the Ops tasks. PR_ACTION_ENABLED defaults off.
   Off: the note stays, the table stays empty, and this file does not fetch.
   A verified queue is audience private, read_back full, and executes false.
   This file does not read the public projection and does not merge. */
(function (root) {
  "use strict";
  var PR_ACTION_ENABLED = false;
  var COLUMNS = [
    "owner", "handoff", "next_action", "assessed_priority", "age", "wait",
    "review_state", "checks_state", "conflict_state", "access_state",
    "blockers", "evidence", "generation", "freshness"
  ];
  var LINKS = [
    ["pr", "PR"],
    ["diff", "Diff"],
    ["review", "Review"],
    ["fix", "Fix"],
    ["checks", "Checks"],
    ["issue", "Issue"]
  ];
  var WORDS = { MERGE: 1, FIX: 1, DEFER: 1, CLOSE: 1 };
  var RANKS = { CRITICAL: 1, HIGH: 1, MEDIUM: 1, LOW: 1 };

  function shown(value, empty) {
    var text = value == null ? "" : String(value).replace(/^\s+|\s+$/g, "");
    return text ? text : empty;
  }

  function safeLink(value) {
    var text = shown(value, "");
    if (text.indexOf("https://github.com/sfdc-24/") !== 0) return "";
    if (text.indexOf(" ") >= 0 || text.indexOf('"') >= 0 || text.indexOf("'") >= 0) return "";
    return text;
  }

  function present(queue) {
    if (!queue || queue.audience !== "private" || queue.read_back !== "full") return false;
    if (queue.executes !== false || queue.recommendations_execute !== false) return false;
    if (queue.merges !== false || queue.closes !== false || queue.comments !== false) return false;
    return true;
  }

  function displayRow(row) {
    var out = {};
    for (var i = 0; i < COLUMNS.length; i++) {
      var key = COLUMNS[i];
      var empty = key === "age" || key === "wait" || key === "freshness" || key === "generation" ? "unknown" : "unassessed";
      var text = shown(row[key], empty);
      if (key === "next_action" && !WORDS[text]) text = "DEFER";
      if (key === "assessed_priority" && text !== "unassessed" && !RANKS[text]) text = "unassessed";
      out[key] = text;
    }
    out.links = {};
    for (var n = 0; n < LINKS.length; n++) out.links[LINKS[n][0]] = safeLink(row[LINKS[n][0]]);
    out.recommendations_execute = false;
    return out;
  }

  function addCell(document, row, text, scope) {
    var cell = document.createElement(scope ? "th" : "td");
    if (scope) cell.scope = scope;
    cell.textContent = text;
    row.appendChild(cell);
    return cell;
  }

  function fill(document, queue) {
    var note = document.getElementById("pr-action-note");
    var table = document.getElementById("pr-action-table");
    var body = document.getElementById("pr-action-rows");
    if (!note || !table || !body) return;
    body.textContent = "";
    if (!PR_ACTION_ENABLED || !present(queue)) {
      table.hidden = true;
      note.textContent = "The private action queue is off. It sits beside these tasks and does not load.";
      return;
    }
    var rows = (queue.rows || []).map(displayRow);
    note.textContent = rows.length
      ? "Private queue for generation " + shown(queue.generation, "unknown") + ". Advisory only. Freshness " + shown(queue.freshness, "unknown") + "."
      : "No verified action rows in this generation.";
    table.hidden = false;
    for (var r = 0; r < rows.length; r++) {
      var tr = document.createElement("tr");
      for (var c = 0; c < COLUMNS.length; c++) addCell(document, tr, rows[r][COLUMNS[c]], c === 0 ? "row" : "");
      var links = document.createElement("td");
      var any = false;
      for (var n = 0; n < LINKS.length; n++) {
        var href = rows[r].links[LINKS[n][0]];
        if (!href) continue;
        if (any) links.appendChild(document.createTextNode(" "));
        var anchor = document.createElement("a");
        anchor.href = href;
        anchor.textContent = LINKS[n][1];
        links.appendChild(anchor);
        any = true;
      }
      if (!any) links.textContent = "unassessed";
      tr.appendChild(links);
      body.appendChild(tr);
    }
  }

  function boot() {
    if (!PR_ACTION_ENABLED) return;
  }

  var api = {
    PR_ACTION_ENABLED: PR_ACTION_ENABLED,
    COLUMNS: COLUMNS,
    present: present,
    displayRow: displayRow,
    fill: fill
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.opsPrAction = api;
  boot();
})(typeof globalThis !== "undefined" ? globalThis : this);
