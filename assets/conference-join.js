/* /conference join + feedback beacons.
   The static page cannot mint a room. Owner sign-in is the live door.
   A token on the link is held in this tab and is never forwarded. */
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
  var ROLES = [
    ["Grok", "Strategy"],
    ["Claude", "Implementation & release. Handoffs, not the live floor."],
    ["Codex", "PM & test lead. Preferred facilitation."],
    ["Gemini", "Adversarial reasoning"],
    ["Copilot Agents", "PR review & living docs"],
    ["Cursor", "Independent exact-head review"]
  ];

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
    var q = params.get("t") || params.get("token") || "";
    return q;
  }

  function sanitizeAddress(raw) {
    return String(raw == null ? "" : raw).replace(/[^\p{L}\p{M} .'-]/gu, "").replace(/\s+/g, " ").trim().slice(0, 80);
  }

  function beaconPayload(event, tokenState, width, height, feedback) {
    var body = {
      v: 1,
      event: String(event || "page_open"),
      path: "/conference/",
      token: tokenState === "present" ? "present" : "missing",
      recording: "off",
      w: width | 0,
      h: height | 0,
      t: Date.now()
    };
    if (feedback === "heard" || feedback === "missed" || feedback === "stuck") body.feedback = feedback;
    return body;
  }

  function joinHref() {
    return GATEWAY;
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
    var raw = readRaw(loc);
    var tokenState = classifyToken(raw);
    if (storage) {
      try { storage.removeItem("sfdc24_conf_token"); } catch (e2) {}
    }
    if ((loc.search || loc.hash) && root.history && root.history.replaceState) {
      try { root.history.replaceState(null, "", loc.pathname || "/conference/"); } catch (e4) {}
    }

    if (tokenState === "present") {
      status.textContent = "Join token is on this link. It is not stored and is not shown. Sign-in does not forward the token, and this page does not mint a room.";
    } else {
      status.textContent = "No join token on this link. This page does not mint one and does not send an invite. Sign-in is the owner door.";
    }

    if (address && storage) {
      try {
        var saved = storage.getItem(ADDRESS_KEY) || "";
        if (saved && !address.value) address.value = saved;
      } catch (e5) {}
      address.addEventListener("change", function () {
        var value = sanitizeAddress(address.value);
        if (address.value !== value) address.value = value;
        try { storage.setItem(ADDRESS_KEY, value); } catch (e6) {}
        emit("address_set", tokenState);
      });
    }

    var pads = doc.querySelectorAll("[data-feedback]");
    for (var p = 0; p < pads.length; p++) {
      pads[p].addEventListener("click", function (ev) {
        var which = ev.currentTarget.getAttribute("data-feedback");
        emit("feedback", tokenState, which);
      });
    }

    function emit(event, state, feedback) {
      var w = 0, h = 0;
      try {
        w = root.innerWidth || 0;
        h = root.innerHeight || 0;
      } catch (e7) {}
      var body = beaconPayload(event, state, w, h, feedback);
      var queued = false;
      try {
        if (root.navigator && root.navigator.sendBeacon) {
          var blob = new Blob([JSON.stringify(body)], { type: "text/plain" });
          queued = root.navigator.sendBeacon("/conference/feedback", blob) === true;
        }
      } catch (e8) { queued = false; }
      if (beacon) {
        beacon.textContent = (queued ? "Beacon queued: " : "Beacon kept in this tab: ") +
          body.event + ". Receipt not confirmed.";
      }
      return body;
    }

    link.addEventListener("click", function () {
      emit(tokenState === "present" ? "join_continue" : "join_no_token", tokenState);
    });
    emit("page_open", tokenState);
  }

  return {
    GATEWAY: GATEWAY,
    ROLES: ROLES,
    classifyToken: classifyToken,
    sanitizeAddress: sanitizeAddress,
    readRaw: readRaw,
    beaconPayload: beaconPayload,
    joinHref: joinHref,
    mount: mount
  };
});
