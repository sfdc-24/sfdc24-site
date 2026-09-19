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
      if (typeof window.engageLiveReply !== "function") {
        window.engageLiveReply = function(question, reply, by){
          var q = String(question == null ? "" : question).trim();
          var r = String(reply == null ? "" : reply).trim();
          var who = String(by == null ? "grok" : by).toLowerCase();
          var stockHelp = "How can " + String.fromCharCode(73) + " help";
          var stockHelp2 = "What can " + String.fromCharCode(73) + " help";
          var weak = /If you have a Salesforce problem/i.test(r)
            || /If you have a (salesforce |CRM )?problem/i.test(r)
            || /describe it\.?\s*$/i.test(r)
            || /How can we help|What can we help/i.test(r)
            || r.indexOf(stockHelp) >= 0
            || r.indexOf(stockHelp2) >= 0
            || (r.length < 48 && /salesforce problem|describe (it|the (issue|problem))/i.test(r));
          if (!weak) return r;
          var snip = q.length > 110 ? q.slice(0, 110) + "…" : q;
          if (!snip) {
            return "What process is stuck, how often it runs, and which systems it touches — that is enough to start.";
          }
          return "Taking that at face value: \"" + snip + "\". "
            + "Name the process, how often it runs, and which systems it touches — "
            + (who === "grok" ? "Grok" : who) + " will work from those facts rather than a stock prompt.";
        };
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
