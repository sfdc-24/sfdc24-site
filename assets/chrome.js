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
      "/governor": "Governor", "/voice": "Voice", "/review": "Review", "/looks": "Looks", "/speed": "SPEED"
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
      "SPEED": "Deployment, site, and polymorphic-progress control charts (Method)."
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
    /* Date homepage-only in banner; hero #today stays on home content. */
    var stale = header.querySelectorAll("[data-chrome-date], .bardate, .chrome-date");
    for (var i = 0; i < stale.length; i++) {
      if (stale[i].parentNode) stale[i].parentNode.removeChild(stale[i]);
    }
    if (isHome()) {
      var d = document.createElement("span");
      d.className = "chrome-date";
      d.setAttribute("data-chrome-home-date", "1");
      try {
        var now = new Date();
        var days = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
        var mons = ["January","February","March","April","May","June","July","August","September","October","November","December"];
        d.textContent = days[now.getDay()] + ", ";
        var b = document.createElement("b");
        b.textContent = String(now.getDate());
        d.appendChild(b);
        d.appendChild(document.createTextNode(" " + mons[now.getMonth()] + " " + now.getFullYear()));
      } catch (e) { d.textContent = "Today"; }
      header.appendChild(d);
    }
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
    var links = [
      ["/method/", "Method"], ["/method/#speed", "SPEED"], ["/panels/", "Panels"],
      ["/governor/", "Governor"], ["/intake/", "Intake"], ["/xray/", "X-ray"],
      ["/privacy/", "Privacy"], ["/terms/", "Terms"],
      ["mailto:abdus@sfdc24.com", "abdus@sfdc24.com"]
    ];
    var foot = document.querySelector("footer");
    if (!foot) {
      foot = document.createElement("footer");
      foot.className = "chrome-foot";
      document.body.appendChild(foot);
    } else if (String(foot.className).indexOf("chrome-foot") < 0) {
      foot.className += " chrome-foot";
    }
    var nav = foot.querySelector("nav");
    if (!nav) { nav = document.createElement("nav"); foot.appendChild(nav); }
    var have = {};
    var as = nav.querySelectorAll("a");
    for (var i = 0; i < as.length; i++) have[as[i].getAttribute("href") || ""] = true;
    for (var j = 0; j < links.length; j++) {
      if (!have[links[j][0]]) {
        var a = document.createElement("a");
        a.href = links[j][0]; a.textContent = links[j][1];
        nav.appendChild(a);
      }
    }
    var kids = foot.children;
    for (var k = 0; k < kids.length; k++) {
      if (kids[k].tagName === "DIV" && /SFDC24|sfdc24/i.test(kids[k].textContent || "")) {
        kids[k].textContent = "Interactive build, integration and AI enablement";
      }
    }
  }

  function killNoise() {
    var nodes = document.querySelectorAll(".cli, #statuscli, #cliout, .liveflow-motto, #liveReplay, .strip.more, .visual-interactive-label");
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i].parentNode) nodes[i].parentNode.removeChild(nodes[i]);
    }
  }

  function boot() {
    try { ensureBanner(); } catch (e) {}
    try { ensureShell(); } catch (e) {}
    try { ensureFooter(); } catch (e) {}
    try { killNoise(); } catch (e) {}
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();

  /* Homepage cabinet + ask prefetch (must live here — not as a trailing inline
     script — because homepage_recovery.cjs requires the chat script to be the
     last inline block and to contain function submit().) */
  function bootCabinet() {
    function $(sel, root){ return (root||document).querySelector(sel) }
    function $all(sel, root){ return Array.prototype.slice.call((root||document).querySelectorAll(sel)) }
    function show(name){
      $all("#cabinetTabs [data-cabinet]").forEach(function(btn){
        var on = btn.getAttribute("data-cabinet") === name;
        btn.setAttribute("aria-selected", on ? "true" : "false");
      });
      $all("[data-cabinet-panel]").forEach(function(p){
        var on = p.getAttribute("data-cabinet-panel") === name;
        p.classList.toggle("is-on", on);
        p.hidden = !on;
      });
      $all("[data-cabinet-board]").forEach(function(el){
        el.hidden = (name !== "board");
        el.classList.toggle("is-on", name === "board");
      });
      try {
        history.replaceState(null, "", name === "board" ? "#" : "#cabinet-" + name);
      } catch (e) {}
      var spd = $("#cabSpeed");
      if (spd && name === "method") {
        spd.textContent = (performance && performance.now) ? Math.round(performance.now()) + " ms" : "fast";
      }
    }
    var nav = $("#cabinetTabs");
    if (!nav) return;
    nav.addEventListener("click", function(e){
      var btn = e.target.closest("[data-cabinet]");
      if (!btn) return;
      show(btn.getAttribute("data-cabinet"));
    });
    $all("[data-cabinet-link]").forEach(function(a){
      a.addEventListener("click", function(e){
        e.preventDefault();
        show(a.getAttribute("data-cabinet-link"));
      });
    });
    var hash = (location.hash || "").replace(/^#cabinet-/, "").replace(/^#/, "");
    if (hash && ["board","method","panels","privacy","terms"].indexOf(hash) >= 0) show(hash);
    else show("board");
  }
  function prefetchAsk() {
    var box = document.getElementById("box");
    if (!box) return;
    var done = false;
    function warm(){
      if (done) return; done = true;
      try {
        var u = "/data/site-manifest.json";
        if (window.fetch) fetch(u, { credentials:"same-origin", cache:"force-cache" }).catch(function(){});
        var l = document.createElement("link");
        l.rel = "prefetch"; l.href = u;
        document.head.appendChild(l);
      } catch (e) {}
      try {
        if (window.__TRIAGE && typeof window.__TRIAGE.warm === "function") window.__TRIAGE.warm();
      } catch (e2) {}
    }
    box.addEventListener("focus", warm);
    box.addEventListener("pointerdown", warm);
  }
