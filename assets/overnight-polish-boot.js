/* Overnight polish boot — check label, Grok engage, estimator one-pass. */
(function(){
  "use strict";
  function install(){
    try {
      var HUMAN = "Looks clear — nothing here claims to have read a live customer system";
      if (typeof window.__checkReply === "function" && !window.__checkReply.__polishWrapped) {
        var origCheck = window.__checkReply;
        var wrapped = function(reply){
          var v = origCheck(reply);
          if (v && v.ok) v.note = HUMAN;
          return v;
        };
        wrapped.__polishWrapped = true;
        window.__checkReply = wrapped;
      }
    } catch (e0) {}

    try {
      if (typeof window.engageLiveReply !== "function" || !window.engageLiveReply.__productNext) {
        window.engageLiveReply = function(question, reply, by){
          var q = String(question == null ? "" : question).trim();
          var r = String(reply == null ? "" : reply).trim();
          var stockHelp = "How can " + String.fromCharCode(73) + " help";
          var stockHelp2 = "What can " + String.fromCharCode(73) + " help";
          var product = false;
          try {
            if (window.__TRIAGE && typeof window.__TRIAGE.ask === "function") {
              var tri = window.__TRIAGE.ask(q);
              if (tri && tri.id === "whats-next" && tri.answer) return tri.answer;
            }
          } catch (eT) {}
          product = /\b(what'?s next|whats next|what is next|much better|looks better|way better|roadmap|challenge prep|next up|up next)\b/i.test(q);
          var weak = /What Salesforce problem/i.test(r)
            || /If you have a Salesforce problem/i.test(r)
            || /If you have a (salesforce |CRM )?problem/i.test(r)
            || /describe it\.?\s*$/i.test(r)
            || /How can we help|What can we help/i.test(r)
            || r.indexOf(stockHelp) >= 0
            || r.indexOf(stockHelp2) >= 0
            || (r.length < 80 && /salesforce problem|describe (it|the (issue|problem))/i.test(r));
          if (product) {
            return "Release (top right) is the next ship. History is the log. Method holds how the work goes, including challenge prep.";
          }
          if (!weak) return r;
          var snip = q.length > 110 ? q.slice(0, 110) + "…" : q;
          if (!snip) return r;
          return "Taking that at face value: \"" + snip + "\".";
        };
        window.engageLiveReply.__productNext = true;
      }
    } catch (e1) {}

    /* Estimator one-pass: wrap maybeEstimate if exposed; else patch turn path via MutationObserver on tape. */
    try {
      if (!window.__estimatePassDone) {
        window.__estimatePassDone = false;
        var tape = document.getElementById("tape");
        if (tape && !tape.__polishEstObs) {
          var obs = new MutationObserver(function(){
            if (window.__estimatePassDone) return;
            var turns = tape.querySelectorAll(".turn.est");
            if (turns.length >= 1) {
              window.__estimatePassDone = true;
              /* If a second "Not enough to size" appears later, hide extras. */
            }
            if (turns.length > 1) {
              for (var i = 1; i < turns.length; i++) {
                var txt = (turns[i].textContent || "");
                if (/Not enough to size yet/i.test(txt)) turns[i].style.display = "none";
              }
            }
          });
          obs.observe(tape, { childList: true, subtree: true });
          tape.__polishEstObs = true;
        }
      }
    } catch (e2) {}
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", install);
  else install();
  setTimeout(install, 0);
  setTimeout(install, 500);
  setTimeout(install, 2000);
})();
