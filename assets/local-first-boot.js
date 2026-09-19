/* Overnight local-first boot patch. Loads before chat submit path settles.
   Fixes theatrical __wakeFleet on Python-local answers without replacing index.html. */
(function(){
  "use strict";
  function install(){
    try {
      if (typeof window.__postLocalAsk !== "function") {
        window.__postLocalAsk = function(ask){
          try {
            var chalkHost = document.getElementById("chalk");
            /* Prefer existing board write if present; else chalk a quiet python line. */
            if (typeof window.write === "function") {
              window.write(ask, -1, -2, true);
            } else if (chalkHost) {
              var row = document.createElement("div");
              row.className = "tsk";
              row.textContent = (ask || "") + " · answered here · python";
              chalkHost.appendChild(row);
            }
          } catch (e) {}
        };
      }
      var origWake = window.__wakeFleet;
      if (typeof origWake === "function" && !window.__wakeFleet.__localFirstWrapped) {
        var wrapped = function(line){
          /* If triage would answer locally, prefer postLocalAsk — callers that still
             pass hello through wakeFleet get redirected. */
          try {
            if (window.__TRIAGE && typeof window.__TRIAGE.ask === "function") {
              var tri = window.__TRIAGE.ask(String(line || "").replace(/\s*…$/, ""));
              if (tri && tri.answer && !tri.handTo) {
                if (window.__postLocalAsk) window.__postLocalAsk(line);
                return;
              }
            }
          } catch (e2) {}
          return origWake.apply(this, arguments);
        };
        wrapped.__localFirstWrapped = true;
        window.__wakeFleet = wrapped;
      }
    } catch (e3) {}
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", install);
  else install();
  setTimeout(install, 0);
  setTimeout(install, 500);
})();
