/* NEXT DEPLOY — Release data block (estimate vs execution).
 * Ordinary content: shipping one-liner + countdown + quiet pie. Not a button.
 * Homepage boot: assets/local-first-boot.js loads this file.
 * Override: window.__SFDC24_NEXT_DEPLOY (ISO) and window.__SFDC24_NEXT_NOTE.
 */
(function () {
  "use strict";
  var TZ = "America/Toronto";
  var LESSONS_URL = "/data/estimate-lessons.jsonl";
  var FEEDBACK_URL = "/feedback/estimate-lessons.jsonl";
  var LOG_KEY = "sfdc24_eta_feedback";
  var LESSONS_KEY = "sfdc24_estimate_lessons";
  var AUTO_KEY = "sfdc24_eta_auto_delta";
  var START_KEY = "sfdc24_deploy_start_ms";
  var PROMISE_KEY = "sfdc24_next_deploy_iso";
  var DEFAULT_NOTE = "Quiet Cobalt chrome and a static Release chip.";
  var DEFAULT_ETA_MIN = 20;
  var ON_TIME_SEC = 15;

  var SEED = [
    {"ts":"2026-09-19T01:02:00-04:00","who":"grok-bot","promise":"Countdown/release rail on homepage","eta_minutes":20,"actual_minutes":null,"outcome":"failed","why":"Waited on stuck executor; stacked scope without cutting to ship.","course_correct":"Ship minimal PR in <10 min; kill stuck workers at 2x ETA; never stack scope onto an open ETA without new ETA.","related":"PR#89"},
    {"ts":"2026-09-19T00:50:00-04:00","who":"grok-bot","promise":"Cabinet #88 merge/resolve","eta_minutes":25,"actual_minutes":null,"outcome":"delayed","why":"Promised 15–25 min then hit merge conflict.","course_correct":"Check mergeable before ETA; include rebase buffer.","related":"PR#88"},
    {"ts":"2026-09-19T00:40:00-04:00","who":"grok-bot","promise":"Site ready to test","eta_minutes":null,"actual_minutes":null,"outcome":"failed","why":"Told the site ready to test while polish PRs were still unmerged.","course_correct":"Live markers check before saying ready.","related":"overnight-polish"}
  ];

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
      "font:500 12px/1.25 system-ui,sans-serif;color:#F3F2EF;margin:0;" +
      "white-space:nowrap;overflow:hidden;text-overflow:ellipsis}" +
      "#nextDeploy .nd-sum .s:empty{display:none}" +
      "#nextDeploy b.v{color:#FFFFFF;font-size:13px}" +
      "#nextDeploy .rem{flex:none;font:600 11px/1 ui-monospace,Menlo,monospace}" +
      "#nextDeploy .rem[data-state] b{color:#FFFFFF}" +
      "#nextDeploy .cls{font:700 11px/1.2 system-ui,sans-serif;letter-spacing:.08em;text-transform:uppercase;color:#FFFFFF}" +
      "#nextDeploy .viz{display:flex;align-items:center;gap:6px;flex:none}" +
      "#nextDeploy .viz svg{display:block;width:22px;height:22px}" +
      "#nextDeploy .viz .leg{display:none}" +
      "@media(max-width:720px){" +
      "#nextDeploy{top:auto;bottom:8px;right:8px;left:auto;border-left:1px solid #666666}" +
      ".chrome-bar #nextDeploy,header.masthead #nextDeploy,header.bar #nextDeploy,.top #nextDeploy{" +
      "position:relative;bottom:auto;right:auto;left:auto;max-width:min(280px,calc(100vw - 24px))}}";
    (document.head || document.documentElement).appendChild(s);
  }

  function pieSvg(counts) {
    var beat = counts.beat || 0, on = counts.on_time || 0, late = (counts.delayed || 0) + (counts.failed || 0);
    var total = beat + on + late;
    var slices = [
      { n: beat, c: "#0A66C2" },
      { n: on, c: "#666666" },
      { n: late, c: "#FFFFFF" }
    ];
    var cx = 36, cy = 36, r = 28;
    if (!total) {
      return '<svg viewBox="0 0 72 72" width="72" height="72" role="img" aria-label="No lessons yet">' +
        '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="#F3F2EF" stroke="#666666" stroke-width="1"/></svg>';
    }
    function pt(frac) {
      var a = (frac * 2 * Math.PI) - Math.PI / 2;
      return (cx + r * Math.cos(a)).toFixed(2) + "," + (cy + r * Math.sin(a)).toFixed(2);
    }
    var d = "", acc = 0;
    slices.forEach(function (s) {
      if (!s.n) return;
      var start = acc / total;
      acc += s.n;
      var end = acc / total;
      var large = (end - start) > 0.5 ? 1 : 0;
      if (s.n === total) {
        d += '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="' + s.c + '"/>';
        return;
      }
      d += '<path fill="' + s.c + '" d="M' + cx + "," + cy + " L" + pt(start) + " A" + r + "," + r + " 0 " + large + " 1 " + pt(end) + ' Z"/>';
    });
    return '<svg viewBox="0 0 72 72" width="72" height="72" role="img" aria-label="Beat, on time, delayed share">' +
      d + '<circle cx="' + cx + '" cy="' + cy + '" r="12" fill="#191919"/></svg>';
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
    el.setAttribute("aria-label", "Release — estimate vs execution");
    el.setAttribute("data-next-note", DEFAULT_NOTE);
    el.innerHTML =
      '<div class="nd-sum">' +
      "<b>Release</b>" +
      '<span class="s" id="ndSentence"></span>' +
      '<span class="cls" id="ndClass" hidden></span>' +
      '<span class="rem" id="ndRemWrap"><b class="v" id="ndRem">--:--</b></span>' +
      '<span class="viz" id="ndViz" aria-label="Beat, on time, delayed share"></span>' +
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
    var o = h > 0 ? h + ":" + pad(m) + ":" + pad(s) : m + ":" + pad(s);
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
  function pulse(d) { try { if (typeof window.__chromeAccuracy === "function") window.__chromeAccuracy(d); } catch (e) {} }
  function storeGet(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } }
  function storeSet(k, v) { try { sessionStorage.setItem(k, v); } catch (e) {} }

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

  function paintViz(rows) {
    var host = document.getElementById("ndViz");
    if (!host) return;
    host.innerHTML = "";
    if (!rows.length) {
      host.textContent = "no lessons yet";
      return;
    }
    var counts = { beat: 0, on_time: 0, delayed: 0, failed: 0 };
    rows.forEach(function (r) {
      var out = String(r.outcome || "failed").replace("-", "_");
      if (out === "on-time") out = "on_time";
      if (counts[out] == null) counts.failed += 1;
      else counts[out] += 1;
    });
    host.innerHTML = pieSvg(counts) +
      '<div class="leg">' +
      '<span><i class="beat"></i>beat ' + counts.beat + "</span>" +
      '<span><i class="on_time"></i>on time ' + counts.on_time + "</span>" +
      '<span><i class="delayed"></i>delayed ' + (counts.delayed + counts.failed) + "</span>" +
      "</div>";
  }

  function classify(promisedMs, now) {
    var sec = Math.round((now - promisedMs) / 1000);
    if (sec <= -ON_TIME_SEC) return { kind: "beat", sec: sec };
    if (Math.abs(sec) <= ON_TIME_SEC) return { kind: "on_time", sec: sec };
    return { kind: "delayed", sec: sec };
  }

  function label(kind) {
    if (kind === "beat") return "BEAT";
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
    try {
      if (navigator.sendBeacon) navigator.sendBeacon(FEEDBACK_URL, line + "\n");
    } catch (e) {}
  }

  function boot() {
    css();
    var root = bar();
    var rem = document.getElementById("ndRem");
    var remW = document.getElementById("ndRemWrap");
    var sent = document.getElementById("ndSentence");
    var cls = document.getElementById("ndClass");
    if (!rem || !sent) return;

    sent.textContent = window.__SFDC24_NEXT_NOTE || root.getAttribute("data-next-note") || DEFAULT_NOTE;
    root.setAttribute("data-next-note", sent.textContent);
    root.setAttribute("data-next-deploy", defaultPromised());
    place(root);
    setTimeout(function () { place(root); }, 0);
    setTimeout(function () { place(root); }, 400);

    var lessons = SEED.slice();
    paintViz(lessons);

    function mergeLessons(extra) {
      lessons = extra.concat(sessionLessons()).concat(SEED);
      var seen = {};
      lessons = lessons.filter(function (r) {
        var k = (r.ts || "") + (r.promise || "");
        if (seen[k]) return false;
        seen[k] = 1;
        return true;
      });
      paintViz(lessons);
    }

    function loadLessons(url) {
      return fetch(url, { cache: "no-store" }).then(function (res) {
        if (!res.ok) return [];
        return res.text().then(parseJsonl);
      }).catch(function () { return []; });
    }
    loadLessons(LESSONS_URL).then(function (rows) {
      if (rows.length) mergeLessons(rows);
      return loadLessons(FEEDBACK_URL);
    }).then(function (rows) {
      if (rows && rows.length) mergeLessons(rows);
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
      if (kind === "beat" || kind === "on_time") pulse(4);
      else pulse(-3);
      if (cls) { cls.hidden = false; cls.setAttribute("data-kind", kind); cls.textContent = label(kind); }
      remW.setAttribute("data-state", kind);
      mergeLessons([]);
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
      if (left > 0) {
        rem.textContent = fmt(left);
        if (remW.getAttribute("data-state") !== "beat") remW.setAttribute("data-state", "counting");
      } else {
        if (!logged) rem.textContent = "LAND";
        auto(p, now);
      }
    }

    window.__SFDC24_NEXT_DEPLOY = window.__SFDC24_NEXT_DEPLOY || promised();
    tick();
    setInterval(tick, 1000);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
