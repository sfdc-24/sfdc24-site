/* NEXT DEPLOY — right-side Release rail (estimate vs execution).
 * Collapsed by default: one-liner + countdown. Click expands details.
 * Homepage boot: assets/local-first-boot.js loads this file.
 * Override: window.__SFDC24_NEXT_DEPLOY (ISO) and window.__SFDC24_NEXT_NOTE.
 */
(function () {
  "use strict";
  var TZ = "America/Toronto";
  var STAGING = "https://cdn.jsdelivr.net/gh/sfdc-24/sfdc24-site@staging/index.html";
  var LESSONS_URL = "/data/estimate-lessons.jsonl";
  var FEEDBACK_URL = "/feedback/estimate-lessons.jsonl";
  var LOG_KEY = "sfdc24_eta_feedback";
  var LESSONS_KEY = "sfdc24_estimate_lessons";
  var AUTO_KEY = "sfdc24_eta_auto_delta";
  var START_KEY = "sfdc24_deploy_start_ms";
  var PROMISE_KEY = "sfdc24_next_deploy_iso";
  var DEFAULT_NOTE = "";
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
      "body.nd-rail{box-sizing:border-box}" +
      "@media(min-width:721px){body.nd-rail.nd-open{padding-right:228px}}" +
      "#nextDeploy{position:fixed;top:0;right:0;z-index:40;width:auto;max-width:min(420px,calc(100vw - 20px));" +
      "display:block;padding:0;margin:0;background:#191919;color:#FFFFFF;border:0;border-left:1px solid #666666;" +
      "font:600 11px/1.35 ui-monospace,Menlo,monospace}" +
      ".chrome-bar #nextDeploy,header.masthead #nextDeploy,header.bar #nextDeploy,.top #nextDeploy{" +
      "position:relative;top:auto;right:auto;z-index:2;flex:none;margin:0;" +
      "background:transparent;border:1px solid #666666;border-radius:3px;max-width:min(340px,calc(100vw - 36px))}" +
      "body.nd-open .chrome-bar,body.nd-open header.masthead{z-index:50;overflow:visible}" +
      "#nextDeploy[data-open=\"1\"]{border:1px solid #666666;border-radius:0 0 8px 8px;" +
      "width:min(220px,calc(100vw - 24px));max-width:none;padding:8px 10px}" +
      ".chrome-bar #nextDeploy[data-open=\"1\"],header.masthead #nextDeploy[data-open=\"1\"]," +
      "header.bar #nextDeploy[data-open=\"1\"],.top #nextDeploy[data-open=\"1\"]{" +
      "position:absolute;top:calc(100% + 6px);right:10px;background:#191919;border-radius:8px}" +
      "#nextDeploy .nd-sum{appearance:none;display:flex;align-items:center;gap:8px;width:100%;" +
      "background:transparent;border:0;color:inherit;cursor:pointer;padding:5px 10px;text-align:left;font:inherit}" +
      "#nextDeploy[data-open=\"1\"] .nd-sum{padding:0 0 8px;margin:0 0 8px;border-bottom:1px solid #666666;border-radius:0}" +
      "#nextDeploy .nd-sum>b{font:700 9px/1 system-ui,sans-serif;letter-spacing:.12em;text-transform:uppercase;color:#FFFFFF;flex:none}" +
      "#nextDeploy .nd-sum .s{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" +
      "font:500 12px/1.25 system-ui,sans-serif;color:#F3F2EF;margin:0}" +
      "#nextDeploy .nd-sum .s:empty{display:none}" +
      "#nextDeploy .nd-caret{flex:none;width:0;height:0;border-left:4px solid transparent;border-right:4px solid transparent;" +
      "border-top:5px solid #666666}" +
      "#nextDeploy[data-open=\"1\"] .nd-caret{border-top:0;border-bottom:5px solid #666666}" +
      "#nextDeploy .nd-more[hidden]{display:none!important}" +
      "#nextDeploy .nd-more{display:flex;flex-direction:column;gap:7px}" +
      "#nextDeploy .r{display:flex;flex-wrap:wrap;gap:4px 8px;align-items:baseline}" +
      "#nextDeploy .lbl{letter-spacing:.06em;text-transform:uppercase;color:#666666;font-size:10px}" +
      "#nextDeploy b.v{color:#FFFFFF;font-size:13px}" +
      "#nextDeploy .rem{flex:none;font:600 11px/1 ui-monospace,Menlo,monospace}" +
      "#nextDeploy .rem[data-state] b{color:#FFFFFF}" +
      "#nextDeploy .cls{font:700 11px/1.2 system-ui,sans-serif;letter-spacing:.08em;text-transform:uppercase;color:#FFFFFF}" +
      "#nextDeploy .links,#nextDeploy .cycle{display:flex;flex-wrap:wrap;gap:6px}" +
      "#nextDeploy a{color:#0A66C2;text-decoration:none;border:0;border-bottom:1px solid #0A66C2;" +
      "background:transparent;padding:0;font:600 11px/1 system-ui,sans-serif}" +
      "#nextDeploy .cycle button{color:#FFFFFF;text-decoration:none;border:0;border-bottom:1px solid #666666;" +
      "background:transparent;padding:0;font:600 11px/1 system-ui,sans-serif;cursor:pointer}" +
      "#nextDeploy a:hover,#nextDeploy a:focus-visible{color:#FFFFFF;border-bottom-color:#FFFFFF}" +
      "#nextDeploy .cycle button:hover,#nextDeploy .cycle button:focus-visible," +
      "#nextDeploy .cycle button[aria-current=step]{border-bottom-color:#FFFFFF}" +
      "#nextDeploy .fb{display:flex;flex-wrap:wrap;gap:4px;align-items:center}" +
      "#nextDeploy .fb span{font:500 9px/1 system-ui,sans-serif;letter-spacing:.04em;text-transform:uppercase;color:#666666}" +
      "#nextDeploy .fb button{border:1px solid #666666;background:#191919;border-radius:3px;" +
      "font:600 9px/1 system-ui,sans-serif;padding:5px 7px;cursor:pointer;color:#FFFFFF}" +
      "#nextDeploy .fb button:hover,#nextDeploy .fb button:focus-visible{border-color:#FFFFFF}" +
      "#nextDeploy .fb button[aria-pressed=true]{border-color:#0A66C2;background:#0A66C2;color:#FFFFFF}" +
      "#nextDeploy .viz{display:flex;flex-direction:column;align-items:center;gap:6px}" +
      "#nextDeploy .viz svg{display:block}" +
      "#nextDeploy .viz .leg{display:flex;flex-wrap:wrap;gap:6px 10px;justify-content:center}" +
      "#nextDeploy .viz .leg span{font:600 9px/1 system-ui,sans-serif;letter-spacing:.04em;text-transform:uppercase;color:#F3F2EF}" +
      "#nextDeploy .viz .leg i{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:4px;vertical-align:middle}" +
      "#nextDeploy .viz .leg i.beat{background:#0A66C2}" +
      "#nextDeploy .viz .leg i.on_time{background:#666666}" +
      "#nextDeploy .viz .leg i.delayed{background:#FFFFFF}" +
      "#nextDeploy .cc{font:500 10px/1.3 system-ui,sans-serif;color:#666666;margin:0}" +
      "#nextDeploy .mark{display:flex;align-items:center;gap:8px}" +
      "#nextDeploy .mark svg{flex:none}" +
      "#nextDeploy .mark small{font:600 9px/1.2 system-ui,sans-serif;letter-spacing:.04em;text-transform:uppercase;color:#666666}" +
      "@media(max-width:720px){" +
      "#nextDeploy{top:auto;bottom:8px;right:8px;left:auto;border-left:1px solid #666666}" +
      ".chrome-bar #nextDeploy,header.masthead #nextDeploy,header.bar #nextDeploy,.top #nextDeploy{" +
      "position:relative;bottom:auto;right:auto;left:auto;max-width:min(280px,calc(100vw - 24px))}" +
      ".chrome-bar #nextDeploy[data-open=\"1\"],header.masthead #nextDeploy[data-open=\"1\"],.top #nextDeploy[data-open=\"1\"]{" +
      "position:absolute;right:8px;left:8px;width:auto;max-width:none}" +
      "body.nd-rail{padding-right:0;padding-bottom:0}body.nd-rail.nd-open{padding-bottom:0}}";
    (document.head || document.documentElement).appendChild(s);
  }

  function skateSvg() {
    return '<svg viewBox="0 0 72 28" width="72" height="28" aria-hidden="true">' +
      '<rect x="1" y="14" width="38" height="7" rx="3.5" fill="#666666"/>' +
      '<circle cx="10" cy="24" r="3" fill="#F3F2EF"/><circle cx="30" cy="24" r="3" fill="#F3F2EF"/>' +
      '<text x="20" y="20" text-anchor="middle" font-size="8" font-weight="700" font-family="ui-monospace,Menlo,sans-serif" fill="#191919">24</text>' +
      '<circle cx="58" cy="13" r="11" fill="none" stroke="#666666" stroke-width="2"/>' +
      '<line x1="58" y1="13" x2="58" y2="6" stroke="#FFFFFF" stroke-width="1.6"/>' +
      '<line x1="58" y1="13" x2="64" y2="13" stroke="#FFFFFF" stroke-width="1.6"/>' +
      '</svg>';
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
    var date = header.querySelector(".chrome-date, [data-live-date]");
    if (date && date.parentNode !== row) row.appendChild(date);
    if (el.parentNode !== row) row.appendChild(el);
    if (date && date.parentNode === row && el.previousSibling !== date) {
      row.insertBefore(el, date.nextSibling);
    }
    return true;
  }

  function bar() {
    var el = document.getElementById("nextDeploy");
    if (el) { place(el); return el; }
    el = document.createElement("aside");
    el.id = "nextDeploy";
    el.setAttribute("role", "complementary");
    el.setAttribute("aria-label", "Release — estimate vs execution");
    el.setAttribute("data-open", "0");
    el.innerHTML =
      '<button type="button" class="nd-sum" id="ndToggle" aria-expanded="false" aria-controls="ndMore">' +
      "<b>Release</b>" +
      '<span class="s" id="ndSentence"></span>' +
      '<span class="cls" id="ndClass" hidden></span>' +
      '<span class="rem" id="ndRemWrap"><b class="v" id="ndRem">--:--</b></span>' +
      '<span class="nd-caret" aria-hidden="true"></span></button>' +
      '<div class="nd-more" id="ndMore" hidden>' +
      '<div class="mark">' + skateSvg() + '</div>' +
      '<div class="r"><span title="Promised ETA">ETA <b class="v" id="ndEst">--:--</b></span></div>' +
      '<div class="r"><span title="Elapsed stopwatch">run <b class="v" id="ndRun">0:00</b></span></div>' +
      '<nav class="cycle" aria-label="Build, deploy, feedback, improve">' +
      '<button type="button" data-step="build">Build</button>' +
      '<button type="button" data-step="deploy">Deploy</button>' +
      '<button type="button" data-step="feedback">Feedback</button>' +
      '<button type="button" data-step="improve">Improve</button></nav>' +
      '<div class="links"><a href="' + STAGING + '" target="_blank" rel="noopener noreferrer" title="Staging preview">Staging</a>' +
      '<a href="/history/" title="Storybook since 4 Sep 2026">History</a>' +
      '<a href="/method/#skateboarder" title="Skateboarder Mode">Method</a></div>' +
      '<div class="viz" id="ndViz" aria-label="Estimate versus actual"></div>' +
      '<p class="cc" id="ndCorrect" hidden></p>' +
      '<div class="fb" role="group" aria-label="Classify this estimate">' +
      '<button type="button" data-eta="beat" title="Beat the estimate">BEAT</button>' +
      '<button type="button" data-eta="on_time" title="On time">ON TIME</button>' +
      '<button type="button" data-eta="delayed" title="Delayed">DELAYED</button></div></div>';
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

  function maxMin(rows) {
    var m = 20;
    rows.forEach(function (r) {
      if (typeof r.eta_minutes === "number") m = Math.max(m, r.eta_minutes);
      if (typeof r.actual_minutes === "number") m = Math.max(m, r.actual_minutes);
    });
    return m || 20;
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

  function latestCorrect(rows) {
    for (var i = 0; i < rows.length; i++) {
      if ((rows[i].outcome === "delayed" || rows[i].outcome === "failed") && rows[i].course_correct) {
        return rows[i].course_correct;
      }
    }
    return "";
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
    var est = document.getElementById("ndEst");
    var rem = document.getElementById("ndRem");
    var remW = document.getElementById("ndRemWrap");
    var run = document.getElementById("ndRun");
    var sent = document.getElementById("ndSentence");
    var cls = document.getElementById("ndClass");
    if (!est || !rem || !run || !sent) return;

    sent.textContent = window.__SFDC24_NEXT_NOTE || DEFAULT_NOTE;
    root.setAttribute("data-next-deploy", defaultPromised());

    function setOpen(on) {
      root.setAttribute("data-open", on ? "1" : "0");
      document.body.classList.toggle("nd-open", !!on);
      var more = document.getElementById("ndMore");
      var tog = document.getElementById("ndToggle");
      if (more) more.hidden = !on;
      if (tog) tog.setAttribute("aria-expanded", on ? "true" : "false");
    }
    setOpen(false);
    var togEl = document.getElementById("ndToggle");
    if (togEl) {
      togEl.addEventListener("click", function () {
        setOpen(root.getAttribute("data-open") !== "1");
      });
    }
    place(root);
    setTimeout(function () { place(root); }, 0);
    setTimeout(function () { place(root); }, 400);

    var lessons = SEED.slice();
    paintViz(lessons);
    var cc = latestCorrect(lessons);
    var ccEl = document.getElementById("ndCorrect");
    if (cc && ccEl) { ccEl.hidden = false; ccEl.textContent = "cite: " + cc; }

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
      var next = latestCorrect(lessons);
      if (next && ccEl) { ccEl.hidden = false; ccEl.textContent = "cite: " + next; }
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
      if (kind === "beat") sent.textContent = "Beat the estimate — landed early.";
      else if (kind === "on_time") sent.textContent = "On time — estimate matched execution.";
      else sent.textContent = "Delayed — execution past the estimate.";
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
      est.textContent = clockEt(iso);
      run.textContent = fmt(now - startMs());
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

    root.querySelectorAll(".fb button[data-eta]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var kind = btn.getAttribute("data-eta");
        root.querySelectorAll(".fb button").forEach(function (b) {
          b.setAttribute("aria-pressed", b === btn ? "true" : "false");
        });
        var p = Date.parse(promised());
        var sec = isFinite(p) ? Math.round((Date.now() - p) / 1000) : 0;
        logged = true;
        record(kind, sec, "visitor");
      });
    });

    root.querySelectorAll(".cycle button[data-step]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        root.querySelectorAll(".cycle button").forEach(function (b) {
          if (b === btn) b.setAttribute("aria-current", "step");
          else b.removeAttribute("aria-current");
        });
        var step = btn.getAttribute("data-step");
        if (step === "deploy") {
          window.open(STAGING, "_blank", "noopener,noreferrer");
          pulse(1);
          return;
        }
        if (step === "improve") {
          location.assign("/method/#skateboarder");
          return;
        }
        var flow = document.getElementById("chrome-flow") || document.getElementById("liveflow") || document.getElementById("ndViz");
        if (flow && flow.scrollIntoView) flow.scrollIntoView({ behavior: "smooth", block: "center" });
        pulse(1);
      });
    });

    window.__SFDC24_NEXT_DEPLOY = window.__SFDC24_NEXT_DEPLOY || promised();
    tick();
    setInterval(tick, 1000);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
