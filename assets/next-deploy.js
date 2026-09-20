/* NEXT DEPLOY — Release countdown (stopwatch). Homepage only.
 * Override: window.__SFDC24_NEXT_DEPLOY (ISO) and window.__SFDC24_NEXT_NOTE.
 */
(function () {
  "use strict";
  var TZ = "America/Toronto";
  var LESSONS_URL = "/data/estimate-lessons.jsonl";
  // THERE IS NO FEEDBACK_URL, AND THERE CANNOT BE ONE HERE.
  //
  // This file used to sendBeacon() a visitor's ETA delta to
  // /feedback/estimate-lessons.jsonl and then fetch the same path back.
  // sendBeacon issues a POST. sfdc24.com is GitHub Pages, which serves static
  // bytes and accepts no writes, so the beacon was discarded silently from the
  // day it shipped - and the read cost a 404 in the console of every single
  // homepage visit. Measured again 2026-09-20: still 404, still on every load.
  //
  // A write path to a static host is not a missing file. Committing the file
  // would clear the 404 and leave the write just as dead. The only write
  // surface this site has is the Apps Script endpoint, and visitor telemetry
  // does not belong on the same route as the model call: Apps Script allows 30
  // concurrent executions and one model answer holds a slot for 10-40 seconds.
  //
  // Session lessons still accumulate in localStorage and the committed
  // /data/estimate-lessons.jsonl still loads, 200. Nothing a reader sees is
  // lost; what goes is a promise that was never kept.
  var LOG_KEY = "sfdc24_eta_feedback";
  var LESSONS_KEY = "sfdc24_estimate_lessons";
  var AUTO_KEY = "sfdc24_eta_auto_delta";
  var START_KEY = "sfdc24_deploy_start_ms";
  var PROMISE_KEY = "sfdc24_next_deploy_iso";
  var DEFAULT_NOTE = "Cobalt theme site-wide";
  var DEFAULT_ETA_MIN = 20;
  var ON_TIME_SEC = 15;

  var SEED = [
    {"ts":"2026-09-19T01:02:00-04:00","who":"grok-bot","promise":"Countdown/release rail on homepage","eta_minutes":20,"actual_minutes":null,"outcome":"failed","why":"Waited on stuck executor; stacked scope without cutting to ship.","course_correct":"Ship minimal PR in <10 min; kill stuck workers at 2x ETA; never stack scope onto an open ETA without new ETA.","related":"PR#89"},
    {"ts":"2026-09-19T00:50:00-04:00","who":"grok-bot","promise":"Cabinet #88 merge/resolve","eta_minutes":25,"actual_minutes":null,"outcome":"delayed","why":"Promised 15–25 min then hit merge conflict.","course_correct":"Check mergeable before ETA; include rebase buffer.","related":"PR#88"},
    {"ts":"2026-09-19T00:40:00-04:00","who":"grok-bot","promise":"Site ready to test","eta_minutes":null,"actual_minutes":null,"outcome":"failed","why":"Told the site ready to test while polish PRs were still unmerged.","course_correct":"Live markers check before saying ready.","related":"overnight-polish"}
  ];

  function isHome() {
    var p = (location.pathname || "/").replace(/\/+$/, "") || "/";
    return p === "/" || p === "/index.html";
  }

  function css() {
    if (document.getElementById("nd-style")) return;
    var s = document.createElement("style");
    s.id = "nd-style";
    s.textContent =
      "#nextDeploy{position:fixed;top:0;right:0;z-index:40;width:auto;max-width:min(420px,calc(100vw - 20px));" +
      "display:block;padding:0;margin:0;background:#191919;color:#FFFFFF;border:0;border-left:1px solid #666666;" +
      "font:600 11px/1.35 ui-monospace,Menlo,monospace;pointer-events:none}" +
      ".chrome-bar #nextDeploy,header.masthead #nextDeploy,header.bar #nextDeploy,.top #nextDeploy{" +
      "position:relative;top:auto;right:auto;z-index:2;flex:none;margin-left:auto;" +
      "background:transparent;border:0;border-radius:0;max-width:min(420px,calc(100vw - 48px))}" +
      "#nextDeploy .nd-sum{display:flex;align-items:center;gap:10px;width:100%;" +
      "background:transparent;border:0;color:inherit;cursor:default;padding:0;text-align:left;font:inherit}" +
      "#nextDeploy .nd-sum>b{font:700 9px/1 system-ui,sans-serif;letter-spacing:.12em;text-transform:uppercase;color:#FFFFFF;flex:none}" +
      "#nextDeploy .nd-sum .s{flex:1 1 auto;min-width:0;" +
      "font:500 12px/1.25 system-ui,sans-serif;color:#0A66C2;margin:0;" +
      "white-space:nowrap;overflow:hidden;text-overflow:ellipsis}" +
      "#nextDeploy .nd-sum .s:empty{display:none}" +
      "#nextDeploy b.v{color:#FFFFFF;font:600 13px/1 ui-monospace,Menlo,monospace}" +
      "#nextDeploy .rem{flex:none;font:600 11px/1 ui-monospace,Menlo,monospace}" +
      "#nextDeploy .rem[data-state] b{color:#FFFFFF}" +
      "#nextDeploy .cls{font:700 11px/1.2 system-ui,sans-serif;letter-spacing:.08em;text-transform:uppercase;color:#0A66C2}" +
      "#nextDeploy .viz{display:flex;align-items:center;gap:6px;flex:none}" +
      "#nextDeploy .viz svg{display:block;width:22px;height:22px}" +
      "#nextDeploy .watch{display:block}" +
      "@media(max-width:720px){" +
      "#nextDeploy{top:auto;bottom:8px;right:8px;left:auto;border-left:1px solid #666666}" +
      ".chrome-bar #nextDeploy,header.masthead #nextDeploy,header.bar #nextDeploy,.top #nextDeploy{" +
      "position:relative;bottom:auto;right:auto;left:auto;max-width:min(280px,calc(100vw - 24px))}}";
    (document.head || document.documentElement).appendChild(s);
  }

  /* Stopwatch countdown. A hand, not a filled pie of lesson counts. */
  function watchSvg(frac, state) {
    var f = Number(frac);
    if (!isFinite(f) || f < 0) f = 0;
    if (f > 1.15) f = 1.15;
    var ang = (f * 2 * Math.PI) - Math.PI / 2;
    var cx = 12, cy = 13.2, r = 6.2;
    var hx = (cx + r * Math.cos(ang)).toFixed(2);
    var hy = (cy + r * Math.sin(ang)).toFixed(2);
    var rim = state === "delayed" ? "#FFFFFF" : "#0A66C2";
    var hand = state === "beat" ? "#0A66C2" : "#FFFFFF";
    var label = state === "beat" ? "Early" :
      state === "on_time" ? "On time" :
      state === "delayed" ? "Delayed" :
      "Countdown to next release";
    return '<svg class="watch" viewBox="0 0 24 24" width="22" height="22" role="img" aria-label="' + label + '">' +
      '<rect x="10" y="1.2" width="4" height="2.6" rx="0.5" fill="#FFFFFF"/>' +
      '<path d="M8.2 3.6 L9.4 5.1" fill="none" stroke="#FFFFFF" stroke-width="1.2" stroke-linecap="round"/>' +
      '<circle cx="' + cx + '" cy="' + cy + '" r="8" fill="#191919" stroke="' + rim + '" stroke-width="1.6"/>' +
      '<line x1="12" y1="6.4" x2="12" y2="8.2" stroke="#0A66C2" stroke-width="1.1" stroke-linecap="round"/>' +
      '<line x1="' + cx + '" y1="' + cy + '" x2="' + hx + '" y2="' + hy + '" stroke="' + hand + '" stroke-width="1.5" stroke-linecap="round"/>' +
      '<circle cx="' + cx + '" cy="' + cy + '" r="1.15" fill="#FFFFFF"/>' +
      "</svg>";
  }

  function place(el) {
    var header = document.querySelector("header.chrome-bar, header.masthead, header.bar, .chrome-bar");
    if (!header) {
      if (!el.parentNode) document.body.appendChild(el);
      return false;
    }
    var row = header.querySelector(".top") || header;
    if (el.parentNode !== row) row.appendChild(el);
    return true;
  }

  function bar() {
    var el = document.getElementById("nextDeploy");
    if (el) { place(el); return el; }
    el = document.createElement("aside");
    el.id = "nextDeploy";
    el.setAttribute("role", "complementary");
    el.setAttribute("aria-label", "Release");
    el.setAttribute("data-next-note", DEFAULT_NOTE);
    el.innerHTML =
      '<div class="nd-sum">' +
      "<b>Release</b>" +
      '<span class="s" id="ndSentence"></span>' +
      '<span class="cls" id="ndClass" hidden></span>' +
      '<span class="rem" id="ndRemWrap"><b class="v" id="ndRem">--:--</b></span>' +
      '<span class="viz" id="ndViz" aria-label="Countdown to next release"></span>' +
      "</div>";
    place(el);
    if (!el.parentNode) document.body.appendChild(el);
    document.body.classList.add("nd-rail");
    return el;
  }

  function pad(n) { n = Number(n); return (n < 10 ? "0" : "") + n; }
  function fmt(ms) {
    var neg = ms < 0; if (neg) ms = -ms;
    var s = Math.floor(ms / 1000), h = Math.floor(s / 3600); s %= 3600;
    var m = Math.floor(s / 60); s %= 60;
    var o = pad(h) + ":" + pad(m) + ":" + pad(s);
    return neg ? "-" + o : o;
  }
  function clockEt(iso) {
    var t = Date.parse(iso); if (!isFinite(t)) return "--:--";
    try {
      var parts = {};
      new Intl.DateTimeFormat("en-GB", {
        timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23"
      }).formatToParts(new Date(t)).forEach(function (p) { parts[p.type] = p.value; });
      return pad(parts.hour) + ":" + pad(parts.minute);
    } catch (e) {
      var d = new Date(t);
      return pad(d.getHours()) + ":" + pad(d.getMinutes());
    }
  }
  function pulse() { /* Release rail only — no accuracy chart. */ }
  function storeGet(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } }
  function storeSet(k, v) { try { sessionStorage.setItem(k, v); } catch (e) {} }

  function shortNote(s) {
    var words = String(s || "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
    if (!words.length) return DEFAULT_NOTE;
    if (words.length > 9) words = words.slice(0, 9);
    return words.join(" ");
  }

  function defaultPromised() {
    if (window.__SFDC24_NEXT_DEPLOY) return String(window.__SFDC24_NEXT_DEPLOY);
    var saved = storeGet(PROMISE_KEY);
    if (saved && isFinite(Date.parse(saved))) return saved;
    var start = Date.now();
    var iso = new Date(start + DEFAULT_ETA_MIN * 60 * 1000).toISOString();
    storeSet(PROMISE_KEY, iso);
    return iso;
  }

  function parseJsonl(text) {
    var rows = [];
    String(text || "").split(/\n+/).forEach(function (line) {
      line = line.trim();
      if (!line) return;
      try { rows.push(JSON.parse(line)); } catch (e) {}
    });
    return rows;
  }

  function sessionLessons() {
    return parseJsonl(storeGet(LESSONS_KEY) || "");
  }

  function paintWatch(start, promised, now, state) {
    var host = document.getElementById("ndViz");
    if (!host) return;
    var span = promised - start;
    var frac = span > 0 ? (now - start) / span : 0;
    host.innerHTML = watchSvg(frac, state);
  }

  function classify(promisedMs, now) {
    var sec = Math.round((now - promisedMs) / 1000);
    if (sec <= -ON_TIME_SEC) return { kind: "beat", sec: sec };
    if (Math.abs(sec) <= ON_TIME_SEC) return { kind: "on_time", sec: sec };
    return { kind: "delayed", sec: sec };
  }

  function label(kind) {
    if (kind === "beat") return "EARLY";
    if (kind === "on_time") return "ON TIME";
    return "DELAYED";
  }

  function feedLesson(payload) {
    storeSet(LOG_KEY, JSON.stringify(payload));
    var line = JSON.stringify({
      ts: payload.at,
      who: "visitor",
      promise: payload.note || DEFAULT_NOTE,
      eta_minutes: DEFAULT_ETA_MIN,
      actual_minutes: Math.round(payload.deltaSec / 60),
      outcome: payload.kind,
      why: payload.source || "rail",
      course_correct: payload.kind === "delayed" ? "Cut scope; next ETA cites this miss." : "",
      related: "release-rail"
    });
    var prev = storeGet(LESSONS_KEY) || "";
    storeSet(LESSONS_KEY, prev ? prev + "\n" + line : line);
  }

  function boot() {
    if (!isHome()) return;
    css();
    var root = bar();
    var rem = document.getElementById("ndRem");
    var remW = document.getElementById("ndRemWrap");
    var sent = document.getElementById("ndSentence");
    var cls = document.getElementById("ndClass");
    if (!rem || !sent) return;

    sent.textContent = shortNote(window.__SFDC24_NEXT_NOTE || root.getAttribute("data-next-note") || DEFAULT_NOTE);
    root.setAttribute("data-next-note", sent.textContent);
    root.setAttribute("data-next-deploy", defaultPromised());
    place(root);
    setTimeout(function () { place(root); }, 0);
    setTimeout(function () { place(root); }, 400);

    var lessons = SEED.slice();

    function mergeLessons(extra) {
      lessons = extra.concat(sessionLessons()).concat(SEED);
      var seen = {};
      lessons = lessons.filter(function (r) {
        var k = (r.ts || "") + (r.promise || "");
        if (seen[k]) return false;
        seen[k] = 1;
        return true;
      });
    }

    function loadLessons(url) {
      return fetch(url, { cache: "no-store" }).then(function (res) {
        if (!res.ok) return [];
        return res.text().then(parseJsonl);
      }).catch(function () { return []; });
    }
    loadLessons(LESSONS_URL).then(function (rows) {
      if (rows.length) mergeLessons(rows);
    }).catch(function () {});

    function promised() {
      if (window.__SFDC24_NEXT_DEPLOY) return String(window.__SFDC24_NEXT_DEPLOY);
      return root.getAttribute("data-next-deploy") || defaultPromised();
    }
    function startMs() {
      var raw = window.__SFDC24_DEPLOY_START || root.getAttribute("data-deploy-start") || "";
      var t = Date.parse(raw);
      if (isFinite(t)) return t;
      var saved = Number(storeGet(START_KEY) || 0);
      if (saved) return saved;
      var now = Date.now();
      storeSet(START_KEY, String(now));
      return now;
    }

    var logged = false;

    function record(kind, sec, src) {
      var payload = { kind: kind, deltaSec: sec, promised: promised(), at: new Date().toISOString(), source: src || "auto", note: sent.textContent };
      feedLesson(payload);
      if (kind === "beat" || kind === "on_time") pulse();
      else pulse();
      if (cls) { cls.hidden = false; cls.setAttribute("data-kind", kind); cls.textContent = label(kind); }
      remW.setAttribute("data-state", kind);
    }

    function auto(promisedMs, now) {
      if (logged) return;
      var key = promised();
      try { if (storeGet(AUTO_KEY) === key) { logged = true; return; } } catch (e) {}
      if (now < promisedMs) return;
      logged = true;
      storeSet(AUTO_KEY, key);
      var hit = classify(promisedMs, now);
      record(hit.kind, hit.sec, "timer-zero");
    }

    function tick() {
      var iso = promised(), p = Date.parse(iso), now = Date.now();
      if (!isFinite(p)) { rem.textContent = "--:--"; return; }
      var left = p - now;
      var state = remW.getAttribute("data-state") || "counting";
      if (left > 0) {
        rem.textContent = fmt(left);
        if (state !== "beat") {
          remW.setAttribute("data-state", "counting");
          state = "counting";
        }
      } else {
        rem.textContent = fmt(left);
        auto(p, now);
        var hit = classify(p, now);
        state = remW.getAttribute("data-state") || hit.kind;
        if (state === "counting") state = hit.kind;
        remW.setAttribute("data-state", state);
        if (cls) {
          cls.hidden = false;
          cls.setAttribute("data-kind", state);
          cls.textContent = label(state);
        }
      }
      paintWatch(startMs(), p, now, state);
    }

    window.__SFDC24_NEXT_DEPLOY = window.__SFDC24_NEXT_DEPLOY || promised();
    tick();
    setInterval(tick, 1000);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
