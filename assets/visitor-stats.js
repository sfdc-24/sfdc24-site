/* Visitor tracker — privacy-thin aggregates, honest labels.
 * This browser + optional board snapshot (data/visitor-stats.json).
 * No names, emails, or raw IPs. Not advertising analytics. Not Salesforce.
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

  function sanitizeAsk(raw) {
    var s = String(raw || "").replace(/\s+/g, " ").trim();
    s = s.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig, "[email]");
    s = s.replace(/\+?\d[\d\s().-]{7,}\d/g, "[num]");
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
    return '<div class="vs-row"><span>' + label + "</span><i><em style=\"width:" + w + '%"></em></i><b>' + n + "</b></div>";
  }

  function css() {
    if (document.getElementById("vs-style")) return;
    var s = document.createElement("style");
    s.id = "vs-style";
    s.textContent =
      "#ndVisitors,.visitor-stats{margin-top:4px;padding-top:8px;border-top:1px solid #14507F}" +
      "#ndVisitors .vs-k,.visitor-stats .vs-k{font:700 9px/1 system-ui,sans-serif;letter-spacing:.12em;text-transform:uppercase;color:#57C1FF;margin:0 0 6px}" +
      "#ndVisitors .vs-nums,.visitor-stats .vs-nums{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin:0 0 8px}" +
      "#ndVisitors .vs-card,.visitor-stats .vs-card{background:#1B3A5C;border:1px solid #2F5075;border-radius:4px;padding:6px 7px}" +
      "#ndVisitors .vs-card span,.visitor-stats .vs-card span{display:block;font:600 9px/1.2 system-ui,sans-serif;letter-spacing:.06em;text-transform:uppercase;color:#9BD4FF}" +
      "#ndVisitors .vs-card b,.visitor-stats .vs-card b{display:block;font:700 18px/1.1 ui-monospace,Menlo,monospace;color:#fff;margin-top:3px}" +
      "#ndVisitors .vs-row,.visitor-stats .vs-row{display:grid;grid-template-columns:52px 1fr 22px;gap:5px;align-items:center;margin:2px 0}" +
      "#ndVisitors .vs-row span,.visitor-stats .vs-row span{font:600 10px/1.2 system-ui,sans-serif;color:#CFE9FF;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
      "#ndVisitors .vs-row i,.visitor-stats .vs-row i{display:block;height:6px;background:#14507F;border-radius:2px;overflow:hidden}" +
      "#ndVisitors .vs-row em,.visitor-stats .vs-row em{display:block;height:100%;background:#57C1FF}" +
      "#ndVisitors .vs-row b,.visitor-stats .vs-row b{font:600 10px/1 ui-monospace,Menlo,monospace;color:#F0C14A;text-align:right}" +
      "#ndVisitors .vs-note,.visitor-stats .vs-note{margin:6px 0 0;font:500 10px/1.35 system-ui,sans-serif;color:#9BD4FF}" +
      "#ndVisitors a,.visitor-stats a{color:#fff;border-bottom:1px solid #57C1FF;text-decoration:none}";
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

    var actHtml = actRows.length
      ? actRows.map(function (r) { return barRow(r.k, r.n, actCap); }).join("")
      : '<div class="vs-row"><span>none yet</span><i></i><b>0</b></div>';
    var askHtml = askRows.length
      ? askRows.map(function (r) { return barRow(r.k, r.n, askCap); }).join("")
      : '<div class="vs-row"><span>no asks yet</span><i></i><b>0</b></div>';

    var note = '<p class="vs-note">This browser + optional board snapshot. No names, emails, or IPs. Not advertising analytics. Not a Salesforce report. <a href="/method/#keeping-honest">Keeping things honest</a></p>';
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
    var parts = html();
    var rail = document.getElementById("nextDeploy");
    if (rail) {
      var slot = document.getElementById("ndVisitors");
      if (!slot) {
        slot = document.createElement("div");
        slot.id = "ndVisitors";
        var more = document.getElementById("ndMore");
        (more || rail).appendChild(slot);
      }
      slot.innerHTML = parts.body;
    }
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
