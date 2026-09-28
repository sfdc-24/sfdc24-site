/* /conference points at the existing Cloud Run gateway.
   That gateway already signs the owner in and issues the room token.
   This file does not mint, store, or redeem a token, and it does not add a log. */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.conferenceJoin = api;
  if (typeof document !== "undefined") {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", function () { api.mount(document); });
    } else {
      api.mount(document);
    }
  }
})(typeof window !== "undefined" ? window : globalThis, function (root) {
  "use strict";

  var GATEWAY = "https://conference-gateway-96522051727.us-central1.run.app/";
  var ADDRESS_KEY = "sfdc24_conf_address";
  var DENY = {
    invite: 1, invited: 1, invitation: 1, fake: 1, demo: 1, sample: 1,
    placeholder: 1, test: 1, missing: 1, token: 1, "null": 1, undefined: 1,
    todo: 1, example: 1, calendar: 1
  };

  function classifyToken(raw) {
    var s = String(raw == null ? "" : raw).trim();
    if (!s || s.length < 20 || s.length > 2048) return "missing";
    if (/[\s"'<>]/.test(s)) return "missing";
    if (!/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+){0,2}$/.test(s)) return "missing";
    var parts = s.split(".");
    for (var i = 0; i < parts.length; i++) {
      if (DENY[parts[i].toLowerCase()]) return "missing";
    }
    return "present";
  }

  function readRaw(loc) {
    var hash = String((loc && loc.hash) || "").replace(/^#/, "");
    var search = String((loc && loc.search) || "");
    var params;
    try { params = new URLSearchParams(search); }
    catch (e) { params = { get: function () { return ""; } }; }
    if (hash.indexOf("t=") === 0) return decodeURIComponent(hash.slice(2));
    if (hash.indexOf("token=") === 0) return decodeURIComponent(hash.slice(6));
    return params.get("t") || params.get("token") || "";
  }

  function sanitizeAddress(raw) {
    return String(raw == null ? "" : raw).replace(/[^\p{L}\p{M} .'-]/gu, "").replace(/\s+/g, " ").trim().slice(0, 80);
  }

  function joinHref() {
    return GATEWAY;
  }

  function note(kind) {
    return "Noted in this tab: " + kind + ". This page does not add a log. The conference gateway already keeps the room log.";
  }

  function showNote(el, text) {
    if (!el) return;
    el.textContent = text;
    el.classList.remove("chalk");
    void el.offsetWidth;
    el.classList.add("chalk");
  }

  function mount(doc) {
    var status = doc.getElementById("join-status");
    var link = doc.getElementById("join");
    var beacon = doc.getElementById("beacon-status");
    var address = doc.getElementById("address");
    var record = doc.getElementById("record");
    if (!status || !link) return;
    if (record) {
      record.checked = false;
      record.disabled = true;
    }
    link.href = joinHref();

    var loc = root.location || { hash: "", search: "", pathname: "/conference/" };
    var storage = null;
    try { storage = root.sessionStorage; } catch (e) { storage = null; }
    var tokenState = classifyToken(readRaw(loc));
    if (storage) {
      try { storage.removeItem("sfdc24_conf_token"); } catch (e2) {}
    }
    if ((loc.search || loc.hash) && root.history && root.history.replaceState) {
      try { root.history.replaceState(null, "", loc.pathname || "/conference/"); } catch (e4) {}
    }

    if (tokenState === "present") {
      status.textContent = "A token is on this link. This page does not store it or redeem it. Sign-in uses the conference gateway, which already issues the room token. No invite is sent from here.";
    } else {
      status.textContent = "No join token on this link. This page does not mint one and does not send an invite. Sign-in uses the conference gateway, which already issues the room token.";
    }
    if (beacon) beacon.textContent = note("page");

    if (address && storage) {
      try {
        var saved = storage.getItem(ADDRESS_KEY) || "";
        if (saved && !address.value) address.value = saved;
      } catch (e5) {}
      address.addEventListener("change", function () {
        var value = sanitizeAddress(address.value);
        if (address.value !== value) address.value = value;
        try { storage.setItem(ADDRESS_KEY, value); } catch (e6) {}
        showNote(beacon, "Address saved in this tab. It is not sent.");
      });
    }

    var pads = doc.querySelectorAll("[data-feedback]");
    for (var p = 0; p < pads.length; p++) {
      pads[p].addEventListener("click", function (ev) {
        var which = ev.currentTarget.getAttribute("data-feedback");
        if (which !== "heard" && which !== "missed" && which !== "stuck") return;
        showNote(beacon, note(which));
      });
    }
  }

  return {
    GATEWAY: GATEWAY,
    classifyToken: classifyToken,
    sanitizeAddress: sanitizeAddress,
    readRaw: readRaw,
    joinHref: joinHref,
    note: note,
    mount: mount
  };
});
