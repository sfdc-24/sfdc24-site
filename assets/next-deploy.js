/* NEXT DEPLOY — edit target: data-next-deploy on #nextDeploy, or window.__SFDC24_NEXT_DEPLOY */
(function () {
  "use strict";

  var TARGET_DEFAULT = "2026-09-19T00:56:00-04:00";
  var STAGING = "https://cdn.jsdelivr.net/gh/sfdc-24/sfdc24-site@staging-live/";

  function injectCss() {
    if (document.getElementById("nd-style")) return;
    var s = document.createElement("style");
    s.id = "nd-style";
    s.textContent =
      ".nextdeploy{display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:8px 12px;" +
      "margin:12px 0 0;padding:7px 12px;width:min(580px,100%);background:var(--raised,#FBFAF8);" +
      "border:1px solid var(--rule,#DDD8D0);border-radius:8px;" +
      "font:600 12px/1.3 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--ink,#12263F)}" +
      ".nextdeploy .nd-label{letter-spacing:.08em;text-transform:uppercase;color:var(--signal,#8A6A2F)}" +
      ".nextdeploy .nd-time{font-size:15px;letter-spacing:.04em;min-width:4.5ch;text-align:center}" +
      ".nextdeploy .nd-time[data-state=due]{color:var(--warn,#8A5A1E)}" +
      ".nextdeploy .nd-time[data-state=deploying]{color:var(--live,#2E8B57)}" +
      ".nextdeploy a.nd-staging{color:var(--ink,#12263F);text-decoration:none;border-bottom:1px solid var(--signal,#8A6A2F);font-weight:600}" +
      ".nextdeploy a.nd-staging:hover,.nextdeploy a.nd-staging:focus-visible{background:var(--signal-soft,#F0E8D8)}" +
      ".nextdeploy .nd-fb{display:inline-flex;gap:4px;align-items:center;margin-left:auto}" +
      ".nextdeploy .nd-fb span{font:500 10px/1 system-ui,sans-serif;letter-spacing:.04em;text-transform:uppercase;color:var(--soft,#4A5765)}" +
      ".nextdeploy .nd-fb button{border:1px solid var(--rule,#DDD8D0);background:var(--paper,#F2F0EC);border-radius:4px;" +
      "font:600 10px/1 system-ui,sans-serif;padding:5px 7px;cursor:pointer;color:var(--body,#33414F)}" +
      ".nextdeploy .nd-fb button:hover,.nextdeploy .nd-fb button:focus-visible{border-color:var(--signal,#8A6A2F);background:var(--signal-soft,#F0E8D8)}" +
      ".nextdeploy .nd-fb button[aria-pressed=true]{border-color:var(--signal,#8A6A2F);background:var(--signal,#8A6A2F);color:#fff}" +
      "@media(max-width:620px){.nextdeploy{margin-top:10px;padding:6px 10px}.nextdeploy .nd-fb{margin-left:0;width:100%;justify-content:center}}";
    (document.head || document.documentElement).appendChild(s);
  }

  function ensureBar() {
    var root = document.getElementById("nextDeploy");
    if (root) return root;
    var seek = document.querySelector(".seek");
    if (!seek || !seek.parentNode) return null;
    root = document.createElement("div");
    root.className = "nextdeploy";
    root.id = "nextDeploy";
    root.setAttribute("data-next-deploy", window.__SFDC24_NEXT_DEPLOY || TARGET_DEFAULT);
    root.setAttribute("role", "group");
    root.setAttribute("aria-label", "Next deploy countdown");
    root.innerHTML =
      '<span class="nd-label">NEXT DEPLOY</span>' +
      '<span class="nd-time" id="ndTime" aria-live="polite">--:--</span>' +
      '<a class="nd-staging" href="' + STAGING + '" target="_blank" rel="noopener noreferrer" title="Preview what is coming before production">Staging</a>' +
      '<div class="nd-fb" role="group" aria-label="Was this ETA honest?">' +
      "<span>ETA?</span>" +
      '<button type="button" data-eta="useful" title="ETA was useful">ok</button>' +
      '<button type="button" data-eta="late" title="ETA too late">late</button>' +
      '<button type="button" data-eta="wrong" title="ETA wrong">wrong</button></div>';
    seek.parentNode.insertBefore(root, seek.nextSibling);
    return root;
  }

  function pad(n) { return (n < 10 ? "0" : "") + n; }

  function fmt(ms) {
    if (ms < 0) ms = 0;
    var s = Math.floor(ms / 1000);
    var h = Math.floor(s / 3600); s %= 3600;
    var m = Math.floor(s / 60); s %= 60;
    if (h > 0) return h + ":" + pad(m) + ":" + pad(s);
    return pad(m) + ":" + pad(s);
  }

  function pulse(delta) {
    try {
      if (typeof window.__chromeAccuracy === "function") window.__chromeAccuracy(delta);
    } catch (e) {}
  }

  function boot() {
    injectCss();
    var root = ensureBar();
    if (!root) return;
    var timeEl = document.getElementById("ndTime");
    if (!timeEl) return;
    var BUILD =
      document.documentElement.getAttribute("data-build") ||
      (document.querySelector('meta[name="sfdc24-build"]') &&
        document.querySelector('meta[name="sfdc24-build"]').content) ||
      "";

    function targetIso() {
      if (window.__SFDC24_NEXT_DEPLOY) return String(window.__SFDC24_NEXT_DEPLOY);
      return root.getAttribute("data-next-deploy") || TARGET_DEFAULT;
    }

    var dueAt = 0, hitZero = false;

    function tick() {
      var iso = targetIso();
      var t = Date.parse(iso);
      if (!isFinite(t)) {
        timeEl.textContent = "--:--";
        timeEl.setAttribute("data-state", "");
        return;
      }
      dueAt = t;
      var left = t - Date.now();
      if (left > 0) {
        hitZero = false;
        timeEl.textContent = fmt(left);
        timeEl.setAttribute("data-state", "counting");
        timeEl.setAttribute("title", "Target " + iso);
        return;
      }
      if (!hitZero) {
        hitZero = true;
        timeEl.textContent = "DEPLOYING…";
        timeEl.setAttribute("data-state", "deploying");
        var fresh = false;
        try {
          if (BUILD) {
            var b = Date.parse(BUILD);
            if (isFinite(b) && b >= dueAt) fresh = true;
          }
        } catch (e2) {}
        if (fresh) {
          timeEl.textContent = "LIVE";
          timeEl.setAttribute("data-state", "live");
        } else {
          setTimeout(function () {
            if (Date.now() < dueAt) return;
            if (Date.parse(targetIso()) !== dueAt) return;
            timeEl.textContent = "DUE — refresh";
            timeEl.setAttribute("data-state", "due");
          }, 8000);
        }
      }
    }

    root.querySelectorAll(".nd-fb button[data-eta]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var kind = btn.getAttribute("data-eta");
        root.querySelectorAll(".nd-fb button").forEach(function (b) {
          b.setAttribute("aria-pressed", b === btn ? "true" : "false");
        });
        if (kind === "useful") pulse(4);
        else if (kind === "late") pulse(-3);
        else if (kind === "wrong") pulse(-6);
        try {
          sessionStorage.setItem(
            "sfdc24_eta_feedback",
            JSON.stringify({ kind: kind, at: new Date().toISOString(), target: targetIso() })
          );
        } catch (e3) {}
      });
    });

    tick();
    setInterval(tick, 1000);
    window.__SFDC24_NEXT_DEPLOY = window.__SFDC24_NEXT_DEPLOY || targetIso();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
