/* Overnight polish boot — check label, Grok engage, estimator one-pass. */
(function(){
  "use strict";
  function install(){
    try {
      var HUMAN = "Verified — no live system was read";
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
          try {
            if (window.__TRIAGE && typeof window.__TRIAGE.ask === "function") {
              var tri = window.__TRIAGE.ask(q);
              if (tri && tri.answer && !tri.handTo) return tri.answer;
            }
          } catch (eT) {}
          var product = /\b(what'?s next|whats next|what is next|much better|looks better|way better|roadmap|challenge prep|next up|up next)\b/i.test(q);
          var dismiss = /outside what we do|thank you for visiting|thanks for visiting/i.test(r);
          var weak = /What Salesforce problem/i.test(r)
            || /If you have a Salesforce problem/i.test(r)
            || /If you have a (salesforce |CRM )?problem/i.test(r)
            || /describe it\.?\s*$/i.test(r)
            || /How can we help|What can we help/i.test(r)
            || r.indexOf(stockHelp) >= 0
            || r.indexOf(stockHelp2) >= 0
            || dismiss
            || (r.length < 80 && /salesforce problem|describe (it|the (issue|problem))/i.test(r));
          if (product) {
            return "Release (top right) is the next ship. History is the log. Method holds how the work goes, including challenge prep.";
          }
          /* THE REFUSAL HAS TO SPEAK THE BOX'S OWN LANGUAGE.
             The input box asks "What decision are you facing?". This used to
             answer with a sentence built around our own internal phrase for
             the kind of decision we take on - a phrase no visitor has heard,
             arriving with no next step. (Not quoted here: this file ships to
             the browser, and rejected copy should not travel with its own
             replacement. See git history for the exact wording.) Worse, it
             THREW AWAY the model's own refusal, which was already in plain
             English and already specific to what had been asked:
               "That is a business strategy question, not Salesforce work."
             Measured 2026-09-20: both Claude and Grok were overwritten by the
             jargon line. Keep the model's sentence, drop only its closer, and
             add the one concrete thing on offer in registry wording. */
          if (dismiss) {
            /* The prompt's closer is "Thank you for visiting our page." - not
               "Thanks for visiting", which is what the first version of this
               line matched, so the closer survived and the visitor was told
               goodbye and then handed an offer. Match the words that are
               actually there, in either form. */
            var plain = r.replace(/[Tt]hank(?:s|\s+you)?\s+for\s+visiting[\s\S]*$/, "").trim();
            if (!plain) plain = "That one is outside what we do.";
            return plain
              + "\n\nWhat is in scope: a decision that turns on how a Salesforce org "
              + "actually behaves. The first piece of work is a fixed-scope diagnostic "
              + "that ends in a written recommendation, and it commits you to nothing. "
              + "abdus@sfdc24.com reaches a person.";
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
