(function () {
  "use strict";

  var shell = document.querySelector("[data-assistant-shell]");
  if (!shell) return;

  var frame = shell.querySelector("[data-assistant-frame]");
  var state = shell.querySelector("[data-assistant-state]");
  var label = shell.querySelector("[data-testid='assistant-state-label']");
  var detail = shell.querySelector("[data-testid='assistant-state-detail']");
  var actions = shell.querySelector("[data-assistant-actions]");
  var retry = shell.querySelector("[data-assistant-retry]");
  var assistantUrl = shell.getAttribute("data-assistant-url");

  if (!frame || !state || !label || !detail || !actions || !retry || !assistantUrl) return;

  var READY_TYPE = "sfdc24:assistant-ready";
  var PRODUCTION_TIMEOUT_MS = 12000;
  var override = Number(window.__SFDC24_ASSISTANT_TIMEOUT_MS);
  var timeoutMs = Number.isFinite(override) && override >= 25 && override <= 60000
    ? override
    : PRODUCTION_TIMEOUT_MS;
  var activeNonce = "";
  var timer = 0;
  var attempt = 0;

  function trustedAssistantOrigin(origin) {
    return origin === "https://script.google.com" ||
      /^https:\/\/[a-z0-9-]+-script\.googleusercontent\.com$/i.test(origin);
  }

  function newNonce() {
    var bytes = new Uint8Array(16);
    if (window.crypto && window.crypto.getRandomValues) {
      window.crypto.getRandomValues(bytes);
      return Array.prototype.map.call(bytes, function (b) {
        return b.toString(16).padStart(2, "0");
      }).join("");
    }
    return (Date.now().toString(36) + Math.random().toString(36).slice(2) +
      Math.random().toString(36).slice(2)).replace(/[^a-z0-9]/g, "").slice(0, 32);
  }

  function showLoading() {
    shell.classList.remove("is-ready");
    shell.setAttribute("aria-busy", "true");
    state.hidden = false;
    label.textContent = "Connecting to the assistant…";
    detail.textContent = "This normally takes only a moment.";
    actions.hidden = true;
    frame.setAttribute("aria-hidden", "true");
    frame.setAttribute("tabindex", "-1");
  }

  function showUnavailable() {
    timer = 0;
    shell.setAttribute("aria-busy", "false");
    state.hidden = false;
    label.textContent = "The assistant is unavailable right now.";
    detail.textContent = "Your browser reached SFDC24, but not the live assistant. You can retry here or contact Abdus directly.";
    actions.hidden = false;
  }

  function showReady() {
    if (timer) window.clearTimeout(timer);
    timer = 0;
    shell.classList.add("is-ready");
    shell.setAttribute("aria-busy", "false");
    state.hidden = true;
    actions.hidden = true;
    frame.removeAttribute("aria-hidden");
    frame.removeAttribute("tabindex");
  }

  function loadAssistant() {
    if (timer) window.clearTimeout(timer);
    attempt += 1;
    activeNonce = newNonce();
    showLoading();

    var url = new URL(assistantUrl, window.location.href);
    url.searchParams.set("ready_nonce", activeNonce);
    url.searchParams.set("embed_attempt", String(attempt));
    frame.src = url.toString();
    timer = window.setTimeout(showUnavailable, timeoutMs);
  }

  // A load event is deliberately ignored. Google error/interstitial documents also
  // load successfully. Only the nonce echoed by the initialized reception can
  // remove the recovery state.
  window.addEventListener("message", function (event) {
    var message = event && event.data;
    if (!trustedAssistantOrigin(event.origin)) return;
    if (!message || message.type !== READY_TYPE || message.version !== 1) return;
    if (message.nonce !== activeNonce) return;
    showReady();
  });

  retry.addEventListener("click", loadAssistant);
  loadAssistant();
})();
