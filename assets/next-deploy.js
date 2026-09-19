/* NEXT DEPLOY countdown — single edit point: data-next-deploy or window.__SFDC24_NEXT_DEPLOY */
(function(){
  "use strict";
  var root = document.getElementById("nextDeploy");
  if (!root) return;
  var timeEl = document.getElementById("ndTime");
  var STAGING = "https://cdn.jsdelivr.net/gh/sfdc-24/sfdc24-site@staging-live/";
  var BUILD = (document.documentElement.getAttribute("data-build") ||
               document.querySelector('meta[name="sfdc24-build"]') &&
               document.querySelector('meta[name="sfdc24-build"]').content) || "";

  function targetIso(){
    if (window.__SFDC24_NEXT_DEPLOY) return String(window.__SFDC24_NEXT_DEPLOY);
    return root.getAttribute("data-next-deploy") || "";
  }

  function pad(n){ return (n < 10 ? "0" : "") + n; }

  function fmt(ms){
    if (ms < 0) ms = 0;
    var s = Math.floor(ms / 1000);
    var h = Math.floor(s / 3600); s %= 3600;
    var m = Math.floor(s / 60); s %= 60;
    if (h > 0) return h + ":" + pad(m) + ":" + pad(s);
    return pad(m) + ":" + pad(s);
  }

  function pulse(delta){
    try {
      if (typeof window.__chromeAccuracy === "function") window.__chromeAccuracy(delta);
    } catch (e) {}
  }

  var dueAt = 0, hitZero = false, timer = null;

  function tick(){
    var iso = targetIso();
    var t = Date.parse(iso);
    if (!isFinite(t)) {
      timeEl.textContent = "—";
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
    /* hit zero */
    if (!hitZero) {
      hitZero = true;
      timeEl.textContent = "DEPLOYING…";
      timeEl.setAttribute("data-state", "deploying");
      /* optional freshness: if build stamp newer than target, treat as live */
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
        /* after brief DEPLOYING… flip to DUE — refresh */
        setTimeout(function(){
          if (Date.now() < dueAt) return;
          var still = targetIso();
          if (Date.parse(still) !== dueAt) return;
          timeEl.textContent = "DUE — refresh";
          timeEl.setAttribute("data-state", "due");
        }, 8000);
      }
    }
  }

  /* ETA feedback → same accuracy chart path visitors already use */
  root.querySelectorAll(".nd-fb button[data-eta]").forEach(function(btn){
    btn.addEventListener("click", function(){
      var kind = btn.getAttribute("data-eta");
      root.querySelectorAll(".nd-fb button").forEach(function(b){
        b.setAttribute("aria-pressed", b === btn ? "true" : "false");
      });
      /* useful → accuracy up; late → mild down; wrong → stronger down */
      if (kind === "useful") pulse(4);
      else if (kind === "late") pulse(-3);
      else if (kind === "wrong") pulse(-6);
      try {
        sessionStorage.setItem("sfdc24_eta_feedback", JSON.stringify({
          kind: kind, at: new Date().toISOString(), target: targetIso()
        }));
      } catch (e3) {}
    });
  });

  tick();
  timer = setInterval(tick, 1000);
  window.__SFDC24_NEXT_DEPLOY = window.__SFDC24_NEXT_DEPLOY || targetIso();
})();
