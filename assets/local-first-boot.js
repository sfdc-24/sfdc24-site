/* Overnight local-first boot patch. Loads before chat submit path settles.
   Fixes theatrical __wakeFleet on Python-local answers without replacing index.html.
   SF-ish free-text asks handTo the existing demo stage → /org/, but only after
   local rules (whats-next, greeting, …) have had first look. */
(function(){
  "use strict";
  var SF_DESK = /\b(salesforce|sfdc|pipeline|opportunit(?:y|ies)|leads?|soql|apex|orgs?|flows?)\b/i;

  /* A NOUN IS NOT A REQUEST TO BE SHOWN SOMETHING.
     SF_DESK alone opened the pipeline-desk card. Measured 2026-09-20, that
     meant it opened for "Which is better for lead assignment, Apex trigger or
     Flow?", for "hire a Salesforce admin or use a partner?" and for "split the
     org or keep one?" - none of which asked to see anything - while "Can you
     show me something you have actually built?" got no card at all. The card
     appeared for every question except the one it exists to answer. So the
     gate is intent first, subject second. */
  var WANTS_TO_SEE = /\b(show me|show us|see (?:it|one|a demo|an example|something)|demo|example|sample|walk me through|can i see|look(?:s)? like)\b/i;
  var WHAT_WE_BUILT = /\bwhat have you (?:built|made|done|shipped)\b|\banything (?:real|live|working)\b|\byou have (?:actually )?built\b/i;

  function wantsTheDesk(q) {
    if (!WANTS_TO_SEE.test(q) && !WHAT_WE_BUILT.test(q)) return false;
    return SF_DESK.test(q) || WHAT_WE_BUILT.test(q);
  }

  function installSfDesk(){
    try {
      if (!window.__TRIAGE || typeof window.__TRIAGE.ask !== "function") return;
      if (window.__TRIAGE.ask.__sfDeskWrapped) return;
      var origAsk = window.__TRIAGE.ask;
      var wrapped = function(text){
        var q = String(text == null ? "" : text);
        var res = origAsk.apply(this, arguments);
        if (res && (res.answer || res.handTo)) return res;
        if (q.trim() && wantsTheDesk(q)) {
          /* THE DEMO CARD IS NOT AN ANSWER.
             This used to return handTo:"demo", and index.html's submit() treats a
             handTo as "handled here" - it stages the panel and RETURNS, so the
             question never reaches an agent. Every Salesforce ask a visitor typed
             - the one subject this site sells - opened a pipeline-desk card and
             was then answered by nobody. (2026-09-20: it now also takes asking
             to SEE something - see wantsTheDesk.) Stage the card as a side
             effect and let
             the ask carry on to the model, so the visitor gets the card AND a
             reply. res still carries routeTo from triage's own routing table. */
          try { if (typeof window.__stage === "function") window.__stage("demo"); } catch (eStage) {}
          return res;
        }
        return res;
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

/* Load overnight polish helpers + Release rail. */
(function(){
  function add(src){
    try {
      if (document.querySelector('script[src="'+src+'"]')) return;
      var s = document.createElement("script");
      s.src = src; s.defer = true;
      document.head.appendChild(s);
    } catch (e) {}
  }
  add("/assets/overnight-polish-boot.js");
  add("/assets/chrome-footer-polish.js");
  add("/assets/next-deploy.js");
  add("/assets/visitor-stats.js");
})();
