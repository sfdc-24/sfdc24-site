/* Overnight local-first boot patch. Loads before chat submit path settles.
   Fixes theatrical __wakeFleet on Python-local answers without replacing index.html.
   SFDC-LEADS-UI: Salesforce-ish free-text asks handTo existing demo stage -> /org/. */
(function(){
  "use strict";
  var SF_DESK = /\b(salesforce|sfdc|pipeline|opportunit(?:y|ies)|leads?|soql|apex|orgs?|flows?)\b/i;

  function installSfDesk(){
    try {
      if (!window.__TRIAGE || typeof window.__TRIAGE.ask !== "function") return;
      if (window.__TRIAGE.ask.__sfDeskWrapped) return;
      var origAsk = window.__TRIAGE.ask;
      var wrapped = function(text){
        var q = String(text == null ? "" : text);
        if (q.trim() && SF_DESK.test(q)) {
          return { id: "sf-desk", answer: "", handTo: "demo", by: "python" };
        }
        return origAsk.apply(this, arguments);
      };
      wrapped.__sfDeskWrapped = true;
      window.__TRIAGE.ask = wrapped;
    } catch (e0) {}
  }

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
      installSfDesk();
    } catch (e3) {}
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", install);
  else install();
  setTimeout(install, 0);
  setTimeout(install, 500);
})();
