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
  /* Default Cobalt only. Future Python inference may assign cobalt |
     google-blue | trust-navy, log data-palette with visitor events, and
     pick a winner at n≥20+CI. Do not randomize in the browser tonight. */
  function ensurePalette() {
    var root = document.documentElement;
    if (!root.getAttribute("data-palette")) root.setAttribute("data-palette", "cobalt");
  }
  function ensureFonts() {
    if (document.querySelector("link[data-chrome-fonts]")) return;
    if (document.querySelector('link[href*="family=Public+Sans"]')) return;
    var l = document.createElement("link");
    l.rel = "stylesheet";
    l.setAttribute("data-chrome-fonts", "1");
    l.href = "https://fonts.googleapis.com/css2?family=Spectral:ital,wght@0,300;0,400;0,600;1,400&family=Public+Sans:wght@400;500;600;700&display=swap";
    (document.head || document.documentElement).appendChild(l);
  }
  function sectionLabel() {
    if (isHome()) return "";
    var map = {
      "/method": "Method", "/panels": "Panels", "/projects": "Projects",
      "/privacy": "Privacy", "/terms": "Terms", "/agents": "Agents",
      "/org": "Pipeline", "/intake": "Intake", "/xray": "X-ray",
      "/governor": "Governor", "/voice": "Voice", "/review": "Review", "/looks": "Looks", "/speed": "SPEED",
      "/history": "History", "/stats": "Stats", "/stream": "Stream",
      "/operating-model": "Operating Model"
    };
    var p = pathNorm();
    for (var k in map) if (p === k || p.indexOf(k + "/") === 0) return map[k];
    return (document.body && document.body.getAttribute("data-chrome-section")) || "";
  }
  function summaryFor() {
    var map = {
      "": "",
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
      "History": "",
      "Stream": "Three minutes of continuous speech for a call back.",
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
    if (header.parentNode !== document.body || header !== document.body.firstElementChild) {
      document.body.insertBefore(header, document.body.firstChild);
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
    mark.setAttribute("title", "America/Toronto");
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
    /* Keep one shared date alongside the Toronto clock, on every page. */
    var stale = header.querySelectorAll("[data-chrome-date], .bardate, .chrome-date, [data-live-date], .deskline");
    for (var i = 0; i < stale.length; i++) {
      if (stale[i].parentNode) stale[i].parentNode.removeChild(stale[i]);
    }
    if (!header.querySelector('.header-calendar')) {
      var calendar = document.createElement('time');
      calendar.className = 'header-calendar';
      calendar.title = 'Current date in Toronto';
      header.appendChild(calendar);
    }
    paintLiveBrand();
  }

  function torontoClock(now) {
    var parts = {};
    try {
      new Intl.DateTimeFormat("en-GB", {
        timeZone: "America/Toronto",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23"
      }).formatToParts(now || new Date()).forEach(function (p) { parts[p.type] = p.value; });
    } catch (e) {
      var d = now || new Date();
      parts.hour = String(d.getHours());
      parts.minute = String(d.getMinutes());
    }
    function pad(n) { n = parseInt(n, 10); return (n < 10 ? "0" : "") + n; }
    return pad(parts.hour) + ":" + pad(parts.minute);
  }

  function paintLiveBrand() {
    var clock = torontoClock(new Date());
    var marks = document.querySelectorAll("a.chrome-mark[data-live-brand], a.mark[data-live-brand]");
    for (var i = 0; i < marks.length; i++) {
      marks[i].innerHTML = 'SFDC<span class="chrome-clock">' + clock + "</span>";
    }
    var today = document.getElementById("today");
    var now = new Date();
    var calendars = document.querySelectorAll('.header-calendar');
    var dateText = new Intl.DateTimeFormat('en-CA', {timeZone:'America/Toronto', weekday:'short', month:'short', day:'numeric', year:'numeric'}).format(now);
    var parts = {};
    new Intl.DateTimeFormat('en-CA', {timeZone:'America/Toronto', year:'numeric', month:'2-digit', day:'2-digit'})
      .formatToParts(now).forEach(function(p){ parts[p.type] = p.value; });
    for (var j = 0; j < calendars.length; j++) {
      calendars[j].textContent = dateText;
      calendars[j].dateTime = parts.year + '-' + parts.month + '-' + parts.day;
    }
    if (today) today.hidden = true;
  }

  function micSvg() {
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15a3.5 3.5 0 0 0 3.5-3.5v-6a3.5 3.5 0 0 0-7 0v6A3.5 3.5 0 0 0 12 15z"/><path d="M18.5 11.5a.9.9 0 0 0-1.8 0 4.7 4.7 0 0 1-9.4 0 .9.9 0 0 0-1.8 0 6.5 6.5 0 0 0 5.6 6.4V21a.9.9 0 0 0 1.8 0v-3.1a6.5 6.5 0 0 0 5.6-6.4z"/></svg>';
  }

  function ensureShell() {
    if (document.getElementById("chrome-ask-shell")) return;
    /* Homepage already has ask+flow — nav lives in the footer only. */
    var hasHomeAsk = document.getElementById("box") && document.querySelector(".seek");
    if (hasHomeAsk) {
      /* Homepage stays ask bar + Release chip only. */
      var motto = document.querySelector(".liveflow-motto");
      if (motto && motto.parentNode) motto.parentNode.removeChild(motto);
      var replay = document.getElementById("liveReplay");
      if (replay && replay.parentNode) replay.parentNode.removeChild(replay);
      var extra = document.getElementById("chrome-flow");
      if (extra && extra.parentNode) extra.parentNode.removeChild(extra);
      return;
    }
    var shell = document.createElement("div");
    shell.className = "chrome-shell";
    shell.id = "chrome-ask-shell";
    /* Mid-page lean: ask bar only. Nav lives in the footer. Release is homepage-only. */
    shell.innerHTML =
      '<div class="chrome-ask" id="chrome-ask">' +
      '<input id="chrome-box" type="text" autocomplete="off" aria-label="What decision are you facing?" placeholder="What decision are you facing?">' +
      '<button class="chrome-mic" id="chrome-mic" type="button" aria-pressed="false" aria-label="Ask out loud" hidden>' + micSvg() + '</button></div>';
    var header = document.querySelector("header.chrome-bar, header.masthead, header.bar");
    if (header && header.parentNode) {
      header.parentNode.insertBefore(shell, header.nextSibling);
    } else {
      document.body.insertBefore(shell, document.body.firstChild);
    }
    wireAsk(shell);
  }

  function wireAsk(root) {
    var box = root.querySelector("#chrome-box");
    var mic = root.querySelector("#chrome-mic");
    if (!box) return;
    function go() {
      var text = box.value.trim();
      if (!text) return;
      try { sessionStorage.setItem("sfdc24_pending_ask", text); } catch (e) {}
      location.assign("/?ask=" + encodeURIComponent(text));
    }
    box.addEventListener("input", function () {
      try { if (window.__liveFlow && window.__liveFlow.noteInput) window.__liveFlow.noteInput(); } catch (eN) {}
    });
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

  /* THE footer list. Owner, 2026-09-25: no Board or Studio; the email after LinkedIn. It is also used by chrome-footer-polish.js, which runs
     later on some pages and rebuilds the nav; a second copy of this list
     there is how a new link (Studio, 2026-09-24) could appear on one pass and
     vanish on the next. */
  function footerLinks(home, hasCabinet) {
    return [
      ["/method/", "Method", hasCabinet ? "method" : ""],
      ["/history/", "History", hasCabinet ? "history" : ""],
      ["/privacy/", "Privacy", hasCabinet ? "privacy" : ""],
      ["/terms/", "Terms", hasCabinet ? "terms" : ""],
      ["/operating-model/", "Operating Model", ""],
      ["https://www.linkedin.com/in/salams", "LinkedIn", ""],
      ["mailto:abdus@sfdc24.com", "abdus@sfdc24.com", ""]
    ];
  }
  window.__SFDC24_FOOTER_LINKS = footerLinks;

  function ensureFooter() {
    /* Short standard footer only. No mid-page tab/button row. */
    var home = isHome();
    var hasCabinet = !!document.querySelector("[data-cabinet-panel]");
    var links = footerLinks(home, hasCabinet);
    var specialized = document.querySelector("footer.method");
    var foot = document.querySelector("footer.chrome-foot");
    if (!foot) {
      var raw = document.querySelector("footer:not(.method)");
      foot = raw;
    }
    if (!foot) {
      foot = document.createElement("footer");
      foot.className = "chrome-foot";
      if (specialized && specialized.parentNode) specialized.parentNode.appendChild(foot);
      else document.body.appendChild(foot);
    } else if (String(foot.className).indexOf("chrome-foot") < 0) {
      foot.className += " chrome-foot";
    }
    var extras = foot.querySelectorAll("[data-chrome-tagline], .chrome-mark, [data-live-brand], .chrome-date, .bardate, .deskline");
    for (var x = 0; x < extras.length; x++) {
      if (extras[x].parentNode) extras[x].parentNode.removeChild(extras[x]);
    }
    var leftovers = Array.prototype.slice.call(foot.children);
    for (var t = 0; t < leftovers.length; t++) {
      var kid = leftovers[t];
      if (kid.tagName === "NAV") continue;
      var txt = (kid.textContent || "").replace(/\s+/g, " ").trim();
      if (!txt || /interactive build/i.test(txt) || /^SFDC/.test(txt) || /Started/i.test(txt)) {
        if (kid.parentNode) kid.parentNode.removeChild(kid);
      }
    }
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
      if (/^https?:/i.test(links[j][0])) {
        a.target = "_blank";
        a.rel = "noopener noreferrer";
      }
      nav.appendChild(a);
    }
  }

  function killNoise() {
    var nodes = document.querySelectorAll(".cli, #statuscli, #cliout, .liveflow-motto, #liveReplay, .strip.more, .visual-interactive-label, #chrome-tabs, nav.chromenav, nav.barnav, #chrome-flow, .chrome-flow, .sf-feedback-label");
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i].parentNode) nodes[i].parentNode.removeChild(nodes[i]);
    }
    var quick = document.getElementById("quick");
    if (quick) {
      quick.hidden = true;
      while (quick.firstChild) quick.removeChild(quick.firstChild);
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
    try { ensurePalette(); } catch (e) {}
    try { ensureFonts(); } catch (e) {}
    try { ensureBanner(); } catch (e) {}
    try { ensureShell(); } catch (e) {}
    try { ensureFooter(); } catch (e) {}
    try { killNoise(); } catch (e) {}
    try { if (isHome()) loadScript("/assets/next-deploy.js"); } catch (e) {}
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
