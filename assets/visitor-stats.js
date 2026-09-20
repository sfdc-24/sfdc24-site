/* Visitor tracker — privacy-thin aggregates, honest labels.
 * This browser + optional board snapshot (data/visitor-stats.json).
 * Emails and phone-like numbers are scrubbed from ask buckets. A name typed
 * into an ask can remain in this browser. No IPs. Not advertising analytics.
 * Not Salesforce.
 */
(function () {
  "use strict";
  var SNAP_URL = "/data/visitor-stats.json";
  var DAY_KEY = "sfdc24_vs_days";
  var ASK_KEY = "sfdc24_vs_asks";
  var ACT_KEY = "sfdc24_vs_acts";
  var TZ = "America/Toronto";
  var snapshot = null;

  function storeGet(k) {
    try { return localStorage.getItem(k); } catch (e) { return null; }
  }
  function storeSet(k, v) {
    try { localStorage.setItem(k, v); } catch (e) {}
  }
  function readMap(k) {
    try { var o = JSON.parse(storeGet(k) || "{}"); return o && typeof o === "object" ? o : {}; }
    catch (e) { return {}; }
  }
  function writeMap(k, o) { storeSet(k, JSON.stringify(o)); }

  function torontoDay(d) {
    try {
      var parts = {};
      new Intl.DateTimeFormat("en-CA", {
        timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit"
      }).formatToParts(d || new Date()).forEach(function (p) { parts[p.type] = p.value; });
      return parts.year + "-" + parts.month + "-" + parts.day;
    } catch (e) {
      var x = d || new Date();
      return x.getFullYear() + "-" + String(x.getMonth() + 1).padStart(2, "0") + "-" + String(x.getDate()).padStart(2, "0");
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function sanitizeAsk(raw) {
    var s = String(raw || "").replace(/\s+/g, " ").trim();
    s = s.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig, "[email]");
    s = s.replace(/\+?\d[\d\s().-]{7,}\d/g, "[num]");
    s = s.replace(/[<>&"'`]/g, "");
    if (s.length > 48) s = s.slice(0, 48) + "…";
    return s;
  }

  function bump(map, key, n) {
    if (!key) return map;
    map[key] = (map[key] || 0) + (n || 1);
    return map;
  }

  function pathBucket() {
    var p = (location.pathname || "/").replace(/\/+$/, "") || "/";
    if (p === "/" || p === "/index.html") return "board";
    return p.replace(/^\//, "").split("/")[0] || "board";
  }

  function noteDay() {
    var days = readMap(DAY_KEY);
    var day = torontoDay(new Date());
    if (!days[day]) {
      days[day] = 1;
      writeMap(DAY_KEY, days);
    }
    return Object.keys(days).length;
  }

  function noteAct(kind) {
    var acts = bump(readMap(ACT_KEY), kind || pathBucket(), 1);
    writeMap(ACT_KEY, acts);
    paint();
  }

  function noteAsk(text) {
    var clean = sanitizeAsk(text);
    if (!clean || clean === "[email]" || clean === "[num]") return;
    var asks = bump(readMap(ASK_KEY), clean, 1);
    writeMap(ASK_KEY, asks);
    noteAct("ask");
  }

  function topEntries(map, n) {
    return Object.keys(map).map(function (k) {
      return { k: k, n: map[k] };
    }).sort(function (a, b) { return b.n - a.n; }).slice(0, n || 4);
  }

  function barRow(label, n, cap) {
    var w = cap ? Math.max(8, Math.round((n / cap) * 100)) : 8;
    return '<div class="vs-row"><span>' + escapeHtml(label) + "</span><i><em style=\"width:" + w +
      '%"></em></i><b>' + escapeHtml(n) + "</b></div>";
  }

  function css() {
    if (document.getElementById("vs-style")) return;
    var s = document.createElement("style");
    s.id = "vs-style";
    s.textContent =
      "#visitor-stats,.visitor-stats{margin-top:4px;padding-top:8px}" +
      "#visitor-stats .vs-k,.visitor-stats .vs-k{font:700 11px/1 system-ui,sans-serif;letter-spacing:.08em;text-transform:uppercase;color:#191919;margin:16px 0 8px}" +
      "#visitor-stats .vs-k:first-child,.visitor-stats .vs-k:first-child{margin-top:0}" +
      "#visitor-stats .vs-nums,.visitor-stats .vs-nums{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:0 0 8px}" +
      "#visitor-stats .vs-card,.visitor-stats .vs-card{background:#FFFFFF;border:1px solid #666666;border-radius:4px;padding:10px 12px}" +
      "#visitor-stats .vs-card span,.visitor-stats .vs-card span{display:block;font:600 11px/1.2 system-ui,sans-serif;letter-spacing:.06em;text-transform:uppercase;color:#666666}" +
      "#visitor-stats .vs-card b,.visitor-stats .vs-card b{display:block;font:700 22px/1.1 ui-monospace,Menlo,monospace;color:#191919;margin-top:4px}" +
      "#visitor-stats .vs-row,.visitor-stats .vs-row{display:grid;grid-template-columns:72px 1fr 28px;gap:8px;align-items:center;margin:4px 0}" +
      "#visitor-stats .vs-row span,.visitor-stats .vs-row span{font:600 13px/1.2 system-ui,sans-serif;color:#191919;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
      "#visitor-stats .vs-row i,.visitor-stats .vs-row i{display:block;height:6px;background:#F3F2EF;border-radius:2px;overflow:hidden}" +
      "#visitor-stats .vs-row em,.visitor-stats .vs-row em{display:block;height:100%;background:#0A66C2}" +
      "#visitor-stats .vs-row b,.visitor-stats .vs-row b{font:600 12px/1 ui-monospace,Menlo,monospace;color:#191919;text-align:right}" +
      "#visitor-stats .vs-note,.visitor-stats .vs-note{margin:14px 0 0;font:500 13px/1.45 system-ui,sans-serif;color:#666666}" +
      "#visitor-stats a,.visitor-stats a{color:#0A66C2;border-bottom:1px solid #0A66C2;text-decoration:none}";
    (document.head || document.documentElement).appendChild(s);
  }

  function html() {
    var browserDays = noteDay();
    var acts = readMap(ACT_KEY);
    var asks = readMap(ASK_KEY);
    var actRows = topEntries(acts, 4);
    var askRows = topEntries(asks, 4);
    var actCap = actRows.length ? actRows[0].n : 1;
    var askCap = askRows.length ? askRows[0].n : 1;
    var boardN = snapshot && typeof snapshot.visitors_to_date === "number" ? snapshot.visitors_to_date : "—";
    var boardLbl = snapshot && snapshot.label ? snapshot.label : "board snapshot — not live";
    boardLbl = escapeHtml(boardLbl);
    boardN = escapeHtml(boardN);

    var actHtml = actRows.length
      ? actRows.map(function (r) { return barRow(r.k, r.n, actCap); }).join("")
      : '<div class="vs-row"><span>none yet</span><i></i><b>0</b></div>';
    var askHtml = askRows.length
      ? askRows.map(function (r) { return barRow(r.k, r.n, askCap); }).join("")
      : '<div class="vs-row"><span>no asks yet</span><i></i><b>0</b></div>';

    var note = '<p class="vs-note">This browser + optional board snapshot. Emails and phone-like numbers are scrubbed from asks. A typed name can remain in this browser. No IPs. Not advertising analytics. Not a Salesforce report. <a href="/method/#keeping-honest">Keeping things honest</a></p>';
    var body = '<div class="vs-k">Visitors</div>' +
      '<div class="vs-nums">' +
      '<div class="vs-card"><span>this browser</span><b>' + browserDays + "</b></div>" +
      '<div class="vs-card" title="' + boardLbl + '"><span>board file</span><b>' + boardN + "</b></div>" +
      "</div>" +
      '<div class="vs-k">Activities</div>' + actHtml +
      '<div class="vs-k">Top asks</div>' + askHtml;
    return { body: body, note: note };
  }

  function paint() {
    css();
    var stray = document.getElementById("ndVisitors");
    if (stray && stray.parentNode) stray.parentNode.removeChild(stray);
    var parts = html();
    var panel = document.getElementById("visitor-stats");
    if (panel) panel.innerHTML = parts.body + parts.note;
    var cab = document.getElementById("cabVisitors");
    if (cab) cab.textContent = String(noteDay());
  }

  function hookAsks() {
    function fromBox(id) {
      var el = document.getElementById(id);
      if (!el || el.__vsHooked) return;
      el.__vsHooked = true;
      el.addEventListener("keydown", function (e) {
        if (e.key === "Enter") noteAsk(el.value);
      });
    }
    fromBox("box");
    fromBox("chrome-box");
    document.addEventListener("click", function (e) {
      var t = e.target && e.target.closest ? e.target.closest("[data-say], #chips button, .chip") : null;
      if (!t) return;
      var q = t.getAttribute("data-say") || t.textContent;
      if (q) noteAsk(q);
    });
    try {
      var pending = sessionStorage.getItem("sfdc24_pending_ask");
      if (pending) noteAsk(pending);
    } catch (e) {}
  }

  function boot() {
    noteDay();
    noteAct(pathBucket());
    hookAsks();
    paint();
    fetch(SNAP_URL, { cache: "no-store" }).then(function (res) {
      if (!res.ok) return null;
      return res.json();
    }).then(function (data) {
      if (data) snapshot = data;
      paint();
    }).catch(function () { paint(); });
    setTimeout(paint, 400);
    setTimeout(paint, 1200);
  }

  window.__SFDC24_TRACK = { ask: noteAsk, act: noteAct, paint: paint };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
