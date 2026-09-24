/* Browser-side clock and lead helpers for the 3-minute stream.
   The speech key never lives here. */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SFDC24Stt = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  var MAX_SECONDS = 180;
  var WARN_SECONDS = 30;
  var RESET_HOLD_MS = 700;
  var STARTUP_MS = 12000;
  var FLUSH_MS = 200;
  var RECOVER_MS = 2500;
  var RECOVER_RETRY_MS = 1000;
  var LEAD_FORWARDED = "Thank you. That is enough for a call back. Forwarded for a call back.";
  var LEAD_STAGED = "Thank you. That is enough for a call back. Held for this session only.";
  var LEAD_FAILED = "Thank you. That is enough for a call back. The transcript did not reach the desk. Please use the request form at www.sfdc24.com/intake/.";

  function interpretLeadResponse(httpOk, body) {
    if (!httpOk || !body || typeof body !== "object" || Array.isArray(body)) return "failed";
    if (body.ok !== true) return "failed";
    if (body.durable === true && body.sink === "forwarded") return "forwarded";
    if (body.durable === false) return "staged";
    return "failed";
  }

  function leadStatus(outcome) {
    if (outcome === "forwarded") return LEAD_FORWARDED;
    if (outcome === "staged") return LEAD_STAGED;
    return LEAD_FAILED;
  }

  function clampLimit(seconds) {
    var n = Number(seconds);
    if (!isFinite(n) || n <= 0) n = MAX_SECONDS;
    if (n > MAX_SECONDS) n = MAX_SECONDS;
    return n;
  }

  function formatClock(remainingMs) {
    var ms = Number(remainingMs);
    if (!isFinite(ms) || ms <= 0) return "0:00";
    var total = Math.ceil(ms / 1000);
    var minutes = Math.floor(total / 60);
    var seconds = total % 60;
    return minutes + ":" + (seconds < 10 ? "0" : "") + seconds;
  }

  function createSessionClock() {
    var maxSeconds = MAX_SECONDS;
    var warnSeconds = WARN_SECONDS;
    var startedAt = null;
    var satisfiedRemaining = null;
    return {
      start: function (limit, warn, now) {
        maxSeconds = clampLimit(limit);
        var requested = Number(warn);
        warnSeconds = isFinite(requested) && requested > 0 ? Math.min(maxSeconds, requested) : WARN_SECONDS;
        startedAt = now;
        satisfiedRemaining = null;
      },
      satisfy: function (now) {
        if (startedAt == null || satisfiedRemaining != null) return;
        satisfiedRemaining = Math.max(0, maxSeconds * 1000 - (now - startedAt));
      },
      reset: function () {
        startedAt = null;
        satisfiedRemaining = null;
        maxSeconds = MAX_SECONDS;
        warnSeconds = WARN_SECONDS;
      },
      snapshot: function (now) {
        var limitMs = maxSeconds * 1000;
        var satisfied = satisfiedRemaining != null;
        var remaining = satisfied ? satisfiedRemaining
          : (startedAt == null ? limitMs : Math.max(0, limitMs - (now - startedAt)));
        var done = !satisfied && startedAt != null && remaining <= 0;
        var warn = !satisfied && startedAt != null && !done && remaining <= warnSeconds * 1000;
        return {
          remainingMs: remaining,
          warn: warn,
          done: done,
          satisfied: satisfied,
          label: formatClock(remaining),
        };
      },
    };
  }

  function relayWsUrl(base, streamPath) {
    var trimmed = String(base || "").replace(/\/+$/, "");
    if (!trimmed) return "";
    var path = streamPath || "/v1/stream";
    if (path.charAt(0) !== "/") path = "/" + path;
    return trimmed.replace(/^http:/i, "ws:").replace(/^https:/i, "wss:") + path;
  }


  /*
    IS THIS A WORKABLE PROBLEM STATEMENT? THREE ANSWERS, NOT TWO.

    Asked for 2026-09-23: three minutes to reach a problem somebody could be
    paid to solve, and "if they cannot describe what they want, OR WE REALIZE WE
    CANNOT SERVE THEM, you can wrap up the streaming audio".

    The first version of this asked triage whether an agent was needed and read
    "no" as "not a real visitor". MEASURED against the live layer, that is
    wrong in both directions: triage routes everything it has no rule for to an
    agent, so "hello there how are you today my friend" routes to codex, while
    "our flow on the work order cannot pull the serial number" also merely
    routes. Routing says nothing about whether the sentence is work.

    What the local layer CAN say for certain is that domain vocabulary is
    present. route() reports why=keyword when it matched on our own subject -
    "this apex trigger and lwc are failing", "our validation rule fires on every
    record type". That is a positive signal with no false positives in the cases
    measured, and it is free.

    Absence of a keyword is NOT evidence of the opposite. So this returns:

      true   domain vocabulary present. Workable, decided locally, no model call.
      null   UNDECIDED. The local layer cannot tell, and saying "no" here would
             cut off a prospect describing a real problem in their own words.
             The caller asks the desk and judges from the answer - which is what
             "we realize we cannot serve them" actually means.
      false  too short to be anything, or no triage layer at all. Fails CLOSED
             on a missing layer because failing open makes the budget
             unenforceable at exactly the moment the bundle did not load.
  */
  function isWorkable(text, triage) {
    var trimmed = String(text || "").trim();
    if (trimmed.split(/\s+/).filter(Boolean).length < 6) return false;
    if (!triage || typeof triage.ask !== "function") return false;

    var hit;
    try { hit = triage.ask(trimmed); } catch (e) { return false; }

    // A DOMAIN fact is our subject answered locally and instantly - the best
    // outcome available, and emphatically not time-wasting. A fact about the
    // moon is not.
    if (hit && hit.id && hit.id.indexOf("fact-") === 0) return !!hit.domain;

    if (typeof triage.route === "function") {
      var routed;
      try { routed = triage.route(trimmed); } catch (e) { routed = null; }
      if (routed && routed.why === "keyword") return true;
    }
    return null;
  }

  /*
    THE REFUSAL, RECOGNISED BY A CLOSED GRAMMAR.

    This is the other half of his rule: when the desk says it cannot serve them,
    the microphone stops THEN rather than making an honest visitor sit out a
    timer. A lone word like "scope" would fire on an answer that merely mentions
    scope while being perfectly in it, so this matches the phrases the desk
    actually produces.
  */
  var REFUSAL = /outside what we do|outside salesforce scope|not salesforce work|thanks? (?:you )?for visiting/i;

  function isRefusal(reply) {
    return REFUSAL.test(String(reply || ""));
  }

  return {
    MAX_SECONDS: MAX_SECONDS,
    WARN_SECONDS: WARN_SECONDS,
    RESET_HOLD_MS: RESET_HOLD_MS,
    STARTUP_MS: STARTUP_MS,
    FLUSH_MS: FLUSH_MS,
    RECOVER_MS: RECOVER_MS,
    RECOVER_RETRY_MS: RECOVER_RETRY_MS,
    LEAD_FORWARDED: LEAD_FORWARDED,
    LEAD_STAGED: LEAD_STAGED,
    LEAD_FAILED: LEAD_FAILED,
    clampLimit: clampLimit,
    formatClock: formatClock,
    createSessionClock: createSessionClock,
    relayWsUrl: relayWsUrl,
    interpretLeadResponse: interpretLeadResponse,
    leadStatus: leadStatus,
    isWorkable: isWorkable,
    isRefusal: isRefusal,
  };
});
