/* Release record. The page and /ops/ both render data/releases.json.
   A weekly release updates that file. This script refuses to paint a blank record. */
(function (root) {
  var MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  var REPO = "https://github.com/sfdc-24/sfdc24-site";

  function fail(msg) {
    throw new Error(msg);
  }

  function esc(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function pad(n) {
    return n < 10 ? "0" + n : String(n);
  }

  function formatUtc(iso) {
    var d = new Date(iso);
    if (!Number.isFinite(d.getTime())) fail("release date is empty");
    return d.getUTCDate() + " " + MONTHS[d.getUTCMonth()] + " " + d.getUTCFullYear()
      + ", " + pad(d.getUTCHours()) + ":" + pad(d.getUTCMinutes()) + " UTC";
  }

  function shortSha(sha) {
    return String(sha).slice(0, 7);
  }

  function renderReleasePage(data) {
    if (!data || typeof data !== "object") fail("release page rendered empty");
    var current = data.current;
    if (!current || typeof current !== "object") fail("current live release is empty");
    if (!current.sha || String(current.sha).length < 7) fail("current live release is empty");
    if (current.pr == null || current.pr === "") fail("current live release is empty");
    if (!current.title) fail("current live release is empty");
    if (!current.date) fail("current live release is empty");

    var next = data.next;
    if (!next || typeof next !== "object" || !next.date) fail("next release date is empty");
    var summary = String(next.summary || "").trim();
    if (!summary) fail("next release summary is empty");
    var items = next.items || [];
    if (!Array.isArray(items)) fail("release manifest is empty");

    if (!Array.isArray(data.history) || data.history.length === 0) fail("release history is empty");

    var itemHtml = "";
    for (var i = 0; i < items.length; i++) {
      if (!String(items[i] || "").trim()) fail("release manifest is empty");
      itemHtml += "<li>" + esc(items[i]) + "</li>";
    }

    var historyHtml = "";
    for (var h = 0; h < data.history.length; h++) {
      var row = data.history[h];
      if (!row || !row.sha || String(row.sha).length < 7 || !row.title || !row.date) fail("release history is empty");
      historyHtml += "<li><time datetime=\"" + esc(row.date) + "\">" + esc(formatUtc(row.date)) + "</time> "
        + "<a href=\"" + REPO + "/commit/" + esc(row.sha) + "\">" + esc(shortSha(row.sha)) + "</a> "
        + esc(row.title) + "</li>";
    }

    var html = ""
      + "<section aria-label=\"Current live release\">"
      + "<h2>Current live release</h2>"
      + "<p><b>#" + esc(current.pr) + "</b> · <time datetime=\"" + esc(current.date) + "\">" + esc(formatUtc(current.date)) + "</time></p>"
      + "<p>" + esc(current.title) + "</p>"
      + "<p>Merge <a href=\"" + REPO + "/commit/" + esc(current.sha) + "\">" + esc(shortSha(current.sha)) + "</a>"
      + " · <a href=\"" + REPO + "/pull/" + esc(current.pr) + "\">pull request " + esc(current.pr) + "</a></p>"
      + "</section>"
      + "<section aria-label=\"Next weekly target\">"
      + "<h2>Next weekly target</h2>"
      + "<p><time datetime=\"" + esc(next.date) + "\">" + esc(formatUtc(next.date)) + "</time></p>"
      + "<h2>Manifest</h2>"
      + "<p>" + esc(summary) + "</p>"
      + (itemHtml ? "<ul>" + itemHtml + "</ul>" : "")
      + "</section>"
      + "<section aria-label=\"History\">"
      + "<h2>History</h2>"
      + "<ol>" + historyHtml + "</ol>"
      + "</section>";

    var text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (!text || text.indexOf(shortSha(current.sha)) < 0 || text.indexOf(summary) < 0) fail("release page rendered empty");
    if (html.indexOf(String(next.date)) < 0) fail("release page rendered empty");
    return html;
  }

  function paint(data) {
    var html = renderReleasePage(data);
    var nodes = document.querySelectorAll("[data-releases]");
    if (!nodes.length) fail("release page rendered empty");
    for (var i = 0; i < nodes.length; i++) nodes[i].innerHTML = html;
  }

  var api = { renderReleasePage: renderReleasePage, paint: paint };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.SFDC24Releases = api;

  if (typeof document !== "undefined" && document.querySelector("[data-releases]")) {
    var first = document.querySelector("[data-releases]");
    var url = first.getAttribute("data-releases") || "/data/releases.json";
    fetch(url).then(function (res) {
      if (!res.ok) fail("release data did not load");
      return res.json();
    }).then(paint).catch(function () {
      var nodes = document.querySelectorAll("[data-releases]");
      for (var i = 0; i < nodes.length; i++) nodes[i].textContent = "The release record did not load.";
    });
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
