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
  var LEAD_FAILED = "Thank you. That is enough for a call back. The transcript did not reach the desk. Write to abdus@sfdc24.com.";

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
    return {
      start: function (limit, warn, now) {
        maxSeconds = clampLimit(limit);
        var requested = Number(warn);
        warnSeconds = isFinite(requested) && requested > 0 ? Math.min(maxSeconds, requested) : WARN_SECONDS;
        startedAt = now;
      },
      reset: function () {
        startedAt = null;
        maxSeconds = MAX_SECONDS;
        warnSeconds = WARN_SECONDS;
      },
      snapshot: function (now) {
        var limitMs = maxSeconds * 1000;
        var remaining = startedAt == null ? limitMs : Math.max(0, limitMs - (now - startedAt));
        var done = startedAt != null && remaining <= 0;
        var warn = startedAt != null && !done && remaining <= warnSeconds * 1000;
        return {
          remainingMs: remaining,
          warn: warn,
          done: done,
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
  };
});
