/* Request-access behavior for /conference.
   The section stays hidden unless SFDC24_CONFERENCE_ACCESS.enabled is true.
   Posts JSON to the single requestUrl in that config. */
(function (root) {
  var MAX_WORDS = 19;
  var OVER_LIMIT = "Over the limit. Use fewer than 20 words.";
  var BLANK_MESSAGE = "0 words. Add a use case before sending.";
  var SENT = "Request sent. Approval comes back by email.";
  var NOT_SENT = "The request did not go through.";
  var NOT_CONFIGURED = "The access service is not configured.";
  var SENDING = "Sending the request.";

  function wordCount(text) {
    var trimmed = String(text || "").trim();
    if (!trimmed) return 0;
    return trimmed.split(/\s+/).length;
  }

  function useCaseState(text) {
    var count = wordCount(text);
    if (count === 0) return { ok: false, count: 0, reason: "blank" };
    if (count > MAX_WORDS) return { ok: false, count: count, reason: "over" };
    return { ok: true, count: count, reason: "" };
  }

  function counterText(count) {
    if (count === 0) return BLANK_MESSAGE;
    var noun = count === 1 ? "word" : "words";
    if (count > MAX_WORDS) return count + " " + noun + ".";
    return count + " " + noun + ". Fewer than 20.";
  }

  function emailOk(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
  }

  function bodyFrom(fields) {
    var src = fields || {};
    var useCase = src.use_case != null ? src.use_case : src.useCase;
    var fax = src.fax_number != null ? src.fax_number : src.faxNumber;
    return {
      email: String(src.email || "").trim(),
      name: String(src.name || "").trim(),
      use_case: String(useCase || "").trim(),
      fax_number: String(fax == null ? "" : fax)
    };
  }

  function canSubmit(fields) {
    var body = bodyFrom(fields);
    if (body.fax_number !== "") return { ok: false, reason: "honeypot", body: body };
    if (!emailOk(body.email)) return { ok: false, reason: "email", body: body };
    var use = useCaseState(body.use_case);
    if (!use.ok) return { ok: false, reason: use.reason, body: body, count: use.count };
    return { ok: true, reason: "", body: body, count: use.count };
  }

  function visitorReady(fields) {
    var body = bodyFrom(fields);
    return emailOk(body.email) && useCaseState(body.use_case).ok;
  }

  function mount(doc, config, fetchImpl) {
    var section = doc.getElementById("conference-access");
    if (!section) return { shown: false };
    var cfg = config || { enabled: false };
    if (cfg.enabled !== true) {
      section.hidden = true;
      return { shown: false };
    }
    if (section.getAttribute("data-bound") === "1") {
      section.hidden = false;
      return { shown: true };
    }
    section.setAttribute("data-bound", "1");
    var link = doc.getElementById("access-gateway-link");
    if (link && cfg.gatewaySignInUrl) link.setAttribute("href", cfg.gatewaySignInUrl);
    var form = doc.getElementById("conference-access-form");
    var email = doc.getElementById("access-email");
    var name = doc.getElementById("access-name");
    var useCase = doc.getElementById("access-use-case");
    var countEl = doc.getElementById("access-use-case-count");
    var errorEl = doc.getElementById("access-use-case-error");
    var fax = doc.getElementById("fax_number");
    var button = doc.getElementById("access-submit");
    var status = doc.getElementById("access-status");

    function fields() {
      return {
        email: email.value,
        name: name.value,
        use_case: useCase.value,
        fax_number: fax.value
      };
    }

    function paint() {
      var current = fields();
      var use = useCaseState(current.use_case);
      countEl.textContent = counterText(use.count);
      if (use.reason === "over") {
        errorEl.hidden = false;
        errorEl.textContent = OVER_LIMIT;
        useCase.setAttribute("aria-invalid", "true");
        countEl.setAttribute("data-over", "1");
      } else {
        errorEl.hidden = true;
        useCase.removeAttribute("aria-invalid");
        countEl.removeAttribute("data-over");
      }
      button.disabled = !visitorReady(current);
    }

    function onEdit() { paint(); }

    email.addEventListener("input", onEdit);
    name.addEventListener("input", onEdit);
    useCase.addEventListener("input", onEdit);
    form.addEventListener("submit", function (event) {
      if (event && event.preventDefault) event.preventDefault();
      var decision = canSubmit(fields());
      paint();
      if (!decision.ok) {
        if (decision.reason === "honeypot") status.textContent = SENT;
        else if (decision.reason === "over") status.textContent = OVER_LIMIT;
        else if (decision.reason === "blank") status.textContent = "Add a use case before sending.";
        else status.textContent = "Add an email address before sending.";
        return;
      }
      if (!cfg.requestUrl) {
        status.textContent = NOT_CONFIGURED;
        return;
      }
      status.textContent = SENDING;
      button.disabled = true;
      var send = fetchImpl || (typeof fetch === "function" ? fetch : null);
      if (!send) {
        status.textContent = NOT_SENT;
        paint();
        return;
      }
      send(cfg.requestUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify(decision.body),
        credentials: "omit",
        mode: "cors"
      }).then(function (res) {
        if (!res || res.ok !== true) throw new Error("status");
        status.textContent = SENT;
      }).catch(function () {
        status.textContent = NOT_SENT;
        paint();
      });
    });

    section.hidden = false;
    paint();
    return { shown: true };
  }

  var api = {
    MAX_WORDS: MAX_WORDS,
    OVER_LIMIT: OVER_LIMIT,
    BLANK_MESSAGE: BLANK_MESSAGE,
    SENT: SENT,
    NOT_SENT: NOT_SENT,
    wordCount: wordCount,
    useCaseState: useCaseState,
    counterText: counterText,
    canSubmit: canSubmit,
    mount: mount
  };

  if (root) root.SFDC24ConferenceAccess = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;

  if (typeof document !== "undefined" && document.getElementById && typeof module === "undefined") {
    var start = function () {
      var cfg = (typeof window !== "undefined" && window.SFDC24_CONFERENCE_ACCESS) || { enabled: false };
      api.mount(document, cfg, typeof fetch === "function" ? fetch.bind(window) : null);
    };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
    else start();
  }
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));
