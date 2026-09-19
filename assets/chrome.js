/* Shared lightweight template injector. */
(function () {
  "use strict";

  function pathNorm() {
    return (location.pathname || "/").replace(/\/+$/, "") || "/";
  }
  function isHome() {
    var p = pathNorm();
    return p === "/" || p === "/index.html";
  }
  function sectionLabel() {
    if (isHome()) return "";
    var map = {
      "/method": "Method", "/panels": "Panels", "/projects": "Projects",
      "/privacy": "Privacy", "/terms": "Terms", "/agents": "Agents",
      "/org": "Pipeline", "/intake": "Intake", "/xray": "X-ray",
      "/governor": "Governor", "/voice": "Voice", "/review": "Review", "/looks": "Looks", "/speed": "SPEED",
      "/history": "History"
    };
    var p = pathNorm();
    for (var k in map) if (p === k || p.indexOf(k + "/") === 0) return map[k];
    return (document.body && document.body.getAttribute("data-chrome-section")) || "";
  }
  function summaryFor() {
    var map = {
      "": "Ask anything — Python gates first, then one agent.",
      "Method": "How the work goes, what turns up, and the honest boundary.",
      "Panels": "Projects and voice in one pane.",
      "Projects": "Build lanes and open work.",
      "Privacy": "How visitor data is handled.",
      "Terms": "Terms of use for this site.",
      "Agents": "Division of labor across the fleet.",
      "Pipeline": "Dated snapshot of a development workspace.",
      "Intake": "Intake path for new work.",
      "X-ray": "Readout surface for scored samples.",
      "Governor": "Control surface for the fleet.",
      "Voice": "First-party talk path.",
      "Review": "Review surface.",
      "Looks": "Lookbook.",
      "SPEED": "Deployment, site, and polymorphic-progress control charts (Method).",
      "History": "Storybook of the board since 4 Sep 2026 — AI Fitness — 24."
    };
    return map[sectionLabel()] || map[""];
  }

  function ensureBanner() {
    var header = document.querySelector("header.masthead, header.bar, header.chrome-bar, .chrome-bar");
    if (!header) {
      header = document.createElement("header");
      header.className = "chrome-bar";
      document.body.insertBefore(header, document.body.firstChild);
    } else if (String(header.className).indexOf("chrome-bar") < 0) {
      header.className += " chrome-bar";
    }
    var mark = header.querySelector("a.chrome-mark, a.mark");
    if (!mark) {
      mark = document.createElement("a");
      mark.className = "mark chrome-mark";
      mark.href = "/";
      mark.innerHTML = "sfdc<span>24</span>";
      header.insertBefore(mark, header.firstChild);
    } else {
      mark.href = "/";
      if (String(mark.className).indexOf("chrome-mark") < 0) mark.className += " chrome-mark";
    }
    mark.setAttribute("data-live-brand", "1");
    mark.setAttribute("title", "SFDC · 24h America/Toronto · AI Fitness — 24");
    var sec = sectionLabel();
    var where = header.querySelector(".where");
    if (sec) {
      if (!where) {
        where = document.createElement("span");
        where.className = "where";
        header.insertBefore(where, mark.nextSibling);
      }
      where.textContent = sec;
      where.hidden = false;
    } else if (where) {
      where.textContent = "";
      where.hidden = true;
    }
    /* Live brand: SFDC + 24h HH:mm (no am/pm) + Day Month Year (America/Toronto)
       + Started since 4 Sep 2026. Hero #today is painted by the same tick. */
    var stale = header.querySelectorAll("[data-chrome-date], .bardate, .chrome-date");
    for (var i = 0; i < stale.length; i++) {
      if (stale[i].parentNode) stale[i].parentNode.removeChild(stale[i]);
    }
    var d = document.createElement("span");
    d.className = "chrome-date";
    d.setAttribute("data-live-date", "1");
    d.textContent = "Started 4 Sep 2026";
    header.appendChild(d);
    paintLiveBrand();
  }

  function torontoParts(now) {
    var parts = {};
    try {
      new Intl.DateTimeFormat("en-GB", {
        timeZone: "America/Toronto",
        weekday: "long",
        day: "numeric",
        month: "long",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23"
      }).formatToParts(now || new Date()).forEach(function (p) { parts[p.type] = p.value; });
    } catch (e) {
      var d = now || new Date();
      var days = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
      var mons = ["January","February","March","April","May","June","July","August","September","October","November","December"];
      parts.weekday = days[d.getDay()];
      parts.day = String(d.getDate());
      parts.month = mons[d.getMonth()];
      parts.year = String(d.getFullYear());
      parts.hour = String(d.getHours());
      parts.minute = String(d.getMinutes());
    }
    function pad(n) { n = parseInt(n, 10); return (n < 10 ? "0" : "") + n; }
    return {
      clock: pad(parts.hour) + ":" + pad(parts.minute),
      date: (parts.weekday || "") + " " + (parts.day || "") + " " + (parts.month || "") + " " + (parts.year || "")
    };
  }

  function paintLiveBrand() {
    var t = torontoParts(new Date());
    var marks = document.querySelectorAll("a.chrome-mark[data-live-brand], a.mark[data-live-brand]");
    for (var i = 0; i < marks.length; i++) {
      marks[i].innerHTML = 'SFDC<span class="chrome-clock">' + t.clock + "</span>";
    }
    var dates = document.querySelectorAll(".chrome-date[data-live-date]");
    for (var j = 0; j < dates.length; j++) {
      dates[j].innerHTML = t.date + ' · <b>Started 4 Sep 2026</b>';
    }
    var today = document.getElementById("today");
    if (today) today.textContent = t.date + " · " + t.clock;
  }

  function micSvg() {
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15a3.5 3.5 0 0 0 3.5-3.5v-6a3.5 3.5 0 0 0-7 0v6A3.5 3.5 0 0 0 12 15z"/><path d="M18.5 11.5a.9.9 0 0 0-1.8 0 4.7 4.7 0 0 1-9.4 0 .9.9 0 0 0-1.8 0 6.5 6.5 0 0 0 5.6 6.4V21a.9.9 0 0 0 1.8 0v-3.1a6.5 6.5 0 0 0 5.6-6.4z"/></svg>';
  }

  function chartSvg(pts) {
    var w = 320, h = 64, pad = 4;
    if (!pts.length) {
      return '<svg class="chrome-flow-chart" viewBox="0 0 '+w+' '+h+'" preserveAspectRatio="none"><polyline fill="none" stroke="#CFD8E3" stroke-width="2" points="0,'+(h/2)+' '+w+','+(h/2)+'"/></svg>';
    }
    var coords = [];
    for (var i = 0; i < pts.length; i++) {
      var x = pts.length === 1 ? pad : pad + (i / (pts.length - 1)) * (w - pad * 2);
      var y = h - pad - (Math.max(0, Math.min(100, pts[i])) / 100) * (h - pad * 2);
      coords.push(x.toFixed(1) + "," + y.toFixed(1));
    }
    return '<svg class="chrome-flow-chart" viewBox="0 0 '+w+' '+h+'" preserveAspectRatio="none" role="img" aria-label="Estimation accuracy over runs">' +
      '<polyline fill="none" stroke="#0176D3" stroke-width="2" points="' + coords.join(" ") + '"/></svg>';
  }

  var runs = [];
  function pulseAccuracy(delta) {
    var last = runs.length ? runs[runs.length - 1] : 70;
    var next = Math.max(15, Math.min(100, last + delta));
    runs.push(next);
    var host = document.getElementById("chrome-flow");
    if (!host) return;
    var meta = host.querySelector(".chrome-flow-meta");
    host.querySelector(".chrome-flow-chart-wrap").innerHTML = chartSvg(runs);
    if (meta) meta.textContent = "runs " + runs.length + " · accuracy " + Math.round(next) + "%";
  }
  window.__chromeAccuracy = pulseAccuracy;

  function ensureShell() {
    if (document.getElementById("chrome-ask-shell")) return;
    /* Homepage already has ask+tabs+flow — only add missing pieces lightly */
    var hasHomeAsk = document.getElementById("box") && document.querySelector(".seek");
    if (hasHomeAsk) {
      /* strip motto/replay if present */
      var motto = document.querySelector(".liveflow-motto");
      if (motto && motto.parentNode) motto.parentNode.removeChild(motto);
      var replay = document.getElementById("liveReplay");
      if (replay && replay.parentNode) replay.parentNode.removeChild(replay);
      var live = document.getElementById("liveflow");
      if (live && !document.getElementById("chrome-flow")) {
        var wrap = document.createElement("div");
        wrap.className = "chrome-flow";
        wrap.id = "chrome-flow";
        wrap.innerHTML = '<div class="chrome-flow-chart-wrap">' + chartSvg([]) + '</div>' +
          '<p class="chrome-flow-meta">runs 0 · accuracy —</p>';
        if (live.parentNode) live.parentNode.insertBefore(wrap, live.nextSibling);
      }
      return;
    }
    var shell = document.createElement("div");
    shell.className = "chrome-shell";
    shell.id = "chrome-ask-shell";
    shell.innerHTML =
      '<p class="chrome-sum" id="chrome-sum"></p>' +
      '<div class="chrome-ask" id="chrome-ask">' +
      '<input id="chrome-box" type="text" autocomplete="off" aria-label="Ask the agents anything" placeholder="Ask the agents anything, then press Enter">' +
      '<button class="chrome-mic" id="chrome-mic" type="button" aria-pressed="false" aria-label="Ask out loud" hidden>' + micSvg() + '</button></div>' +
      '<div class="chrome-tabs" id="chrome-tabs">' +
      '<a href="/org/">Salesforce demo</a>' +
      '<a href="/agents/">Meet the agents</a></div>' +
      '<section class="chrome-flow" id="chrome-flow">' +
      '<div class="chrome-flow-chart-wrap">' + chartSvg([]) + '</div>' +
      '<p class="chrome-flow-meta">runs 0 · accuracy —</p></section>';
    var header = document.querySelector("header.chrome-bar, header.masthead, header.bar");
    if (header && header.parentNode) {
      header.parentNode.insertBefore(shell, header.nextSibling);
    } else {
      document.body.insertBefore(shell, document.body.firstChild);
    }
    var sum = shell.querySelector("#chrome-sum");
    if (sum) sum.textContent = summaryFor();
    wireAsk(shell);
  }

  function wireAsk(root) {
    var box = root.querySelector("#chrome-box");
    var mic = root.querySelector("#chrome-mic");
    if (!box) return;
    function go() {
      var text = box.value.trim();
      if (!text) return;
      pulseAccuracy(-1);
      try { sessionStorage.setItem("sfdc24_pending_ask", text); } catch (e) {}
      location.assign("/?ask=" + encodeURIComponent(text));
    }
    box.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); go(); }
    });
    var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR || !mic) return;
    mic.hidden = false;
    var rec = null, listening = false, finals = "";
    function disarm() {
      listening = false;
      mic.setAttribute("aria-pressed", "false");
      mic.setAttribute("aria-label", "Ask out loud");
    }
    function arm(r) {
      r.lang = "en-US"; r.interimResults = true; r.continuous = true;
      r.onstart = function () {
        listening = true;
        mic.setAttribute("aria-pressed", "true");
        mic.setAttribute("aria-label", "Listening — tap to stop");
      };
      r.onresult = function (e) {
        var interim = "";
        for (var i = e.resultIndex; i < e.results.length; i++) {
          var piece = e.results[i][0].transcript || "";
          if (e.results[i].isFinal) finals += piece; else interim += piece;
        }
        box.value = (finals + interim).replace(/\s+/g, " ").trim();
      };
      r.onerror = function (e) {
        var err = e && e.error;
        if (err === "no-speech" || err === "aborted") return;
        disarm();
      };
      r.onend = function () {
        if (!listening) return;
        try { rec = new SR(); arm(rec); rec.start(); } catch (err) { disarm(); }
      };
    }
    mic.addEventListener("click", function () {
      if (listening) {
        disarm();
        try { if (rec) rec.stop(); } catch (e) {}
        go();
        return;
      }
      try { finals = ""; rec = new SR(); arm(rec); rec.start(); } catch (err) { disarm(); }
    });
  }

  function ensureFooter() {
    /* Homepage: Board/Method/Panels/SPEED stay in the cabinet shell
       (hash + data-cabinet-link). Privacy/Terms are quiet real-page footer
       links only — not mid-page cabinet tabs. Other pages keep real deep
       links. Tools outside the cabinet (Governor/Intake/X-ray) stay real
       links everywhere. */
    var home = isHome();
    var links = home ? [
      ["#", "Board", "board"],
      ["#cabinet-method", "Method", "method"],
      ["#cabinet-method", "SPEED", "method"],
      ["#cabinet-panels", "Panels", "panels"],
      ["/projects/", "Projects", ""],
      ["/history/", "History", ""],
      ["/privacy/", "Privacy", ""],
      ["/terms/", "Terms", ""],
      ["/governor/", "Governor", ""],
      ["/intake/", "Intake", ""],
      ["/xray/", "X-ray", ""],
      ["mailto:abdus@sfdc24.com", "abdus@sfdc24.com", ""]
    ] : [
      ["/method/", "Method", ""],
      ["/method/#speed", "SPEED", ""],
      ["/panels/", "Panels", ""],
      ["/projects/", "Projects", ""],
      ["/history/", "History", ""],
      ["/privacy/", "Privacy", ""],
      ["/terms/", "Terms", ""],
      ["/governor/", "Governor", ""],
      ["/intake/", "Intake", ""],
      ["/xray/", "X-ray", ""],
      ["mailto:abdus@sfdc24.com", "abdus@sfdc24.com", ""]
    ];
    var foot = document.querySelector("footer");
    if (!foot) {
      foot = document.createElement("footer");
      foot.className = "chrome-foot";
      document.body.appendChild(foot);
    } else if (String(foot.className).indexOf("chrome-foot") < 0) {
      foot.className += " chrome-foot";
    }
    var specialized = foot.classList && foot.classList.contains("method");
    if (specialized) return;
    var tag = foot.querySelector("[data-chrome-tagline]");
    if (!tag) {
      var kids0 = foot.children;
      for (var t = 0; t < kids0.length; t++) {
        if (kids0[t].tagName === "DIV" || kids0[t].tagName === "SPAN") {
          tag = kids0[t];
          break;
        }
      }
      if (!tag) {
        tag = document.createElement("div");
        foot.insertBefore(tag, foot.firstChild);
      }
      tag.setAttribute("data-chrome-tagline", "1");
    }
    tag.textContent = "Interactive build, integration and AI enablement";
    var nav = foot.querySelector("nav");
    if (!nav) {
      nav = document.createElement("nav");
      foot.appendChild(nav);
    }
    while (nav.firstChild) nav.removeChild(nav.firstChild);
    for (var j = 0; j < links.length; j++) {
      var a = document.createElement("a");
      a.href = links[j][0];
      a.textContent = links[j][1];
      if (links[j][2]) {
        a.setAttribute("data-cabinet-link", links[j][2]);
      }
      nav.appendChild(a);
    }
    /* Delegate so clicks work even before/after cabinet.js boots. */
    if (home && !foot.__cabFootBound) {
      foot.__cabFootBound = true;
      foot.addEventListener("click", function (e) {
        var a = e.target && e.target.closest ? e.target.closest("[data-cabinet-link]") : null;
        if (!a || !foot.contains(a)) return;
        var name = a.getAttribute("data-cabinet-link");
        if (!name) return;
        e.preventDefault();
        try {
          if (window.__SFDC24_CABINET && typeof window.__SFDC24_CABINET.show === "function") {
            window.__SFDC24_CABINET.show(name);
            return;
          }
        } catch (err) {}
        try { location.hash = name === "board" ? "#" : "#cabinet-" + name; } catch (err2) {}
      });
    }
  }

  function killNoise() {
    var nodes = document.querySelectorAll(".cli, #statuscli, #cliout, .liveflow-motto, #liveReplay, .strip.more, .visual-interactive-label");
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i].parentNode) nodes[i].parentNode.removeChild(nodes[i]);
    }
  }

  function loadScript(src) {
    try {
      if (document.querySelector('script[src="' + src + '"]')) return;
      var s = document.createElement("script");
      s.src = src;
      s.defer = true;
      (document.head || document.documentElement).appendChild(s);
    } catch (e) {}
  }

  function boot() {
    try { ensureBanner(); } catch (e) {}
    try { ensureShell(); } catch (e) {}
    try { ensureFooter(); } catch (e) {}
    try { killNoise(); } catch (e) {}
    try { loadScript("/assets/next-deploy.js"); } catch (e) {}
    try { loadScript("/assets/visitor-stats.js"); } catch (e2) {}
    try {
      if (!window.__SFDC24_LIVE_BRAND) {
        window.__SFDC24_LIVE_BRAND = setInterval(function () {
          try { paintLiveBrand(); } catch (err) {}
        }, 1000);
      }
    } catch (e2) {}
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
