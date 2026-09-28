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

  var BEACON_URL = GATEWAY + "feedback";

  function note(kind) {
    return "Noted in this tab: " + kind + ". Beacon sent. The gateway has not confirmed storage.";
  }

  function clipEnum(raw, fallback) {
    var s = String(raw == null ? "" : raw).replace(/[^A-Za-z0-9_.:-]/g, "").slice(0, 32);
    if (!s || s.indexOf("eyJ") !== -1) return fallback;
    return s;
  }

  function clipError(raw) {
    return String(raw == null ? "" : raw).replace(/[A-Za-z0-9_-]{12,}/g, "[redacted]").replace(/\s+/g, " ").trim().slice(0, 160);
  }

  function iceSummary(ice) {
    if (!ice || typeof ice !== "object") return { state: "absent", pairs: 0 };
    var pairs = Number(ice.pairs);
    return {
      state: clipEnum(ice.state || ice.iceConnectionState, "absent"),
      pairs: pairs > 0 && pairs < 1000 ? Math.floor(pairs) : 0
    };
  }

  function trackSummary(tracks) {
    if (!tracks || typeof tracks !== "object") return { audio: 0, video: 0 };
    function count(n) {
      n = Number(n);
      return n > 0 && n < 8 ? Math.floor(n) : 0;
    }
    return { audio: count(tracks.audio), video: count(tracks.video) };
  }

  function beaconPayload(kind, detail) {
    var allowed = { room: 1, ice: 1, tracks: 1, viewport: 1, error: 1, consent: 1 };
    var src = detail && typeof detail === "object" ? detail : {};
    var view = src.viewport && typeof src.viewport === "object" ? src.viewport : {};
    var w = Number(view.w);
    var h = Number(view.h);
    return {
      kind: allowed[kind] ? kind : "error",
      room: clipEnum(src.room, "absent"),
      ice: iceSummary(src.ice),
      tracks: trackSummary(src.tracks),
      viewport: {
        w: w > 0 && w < 10000 ? Math.floor(w) : 0,
        h: h > 0 && h < 10000 ? Math.floor(h) : 0
      },
      error: clipError(src.error || src.message),
      consent: src.consent === "on" ? "on" : "off",
      upload: "unsigned",
      phase: src.phase === "exit" || src.phase === "live" ? src.phase : "join",
      feedback: src.feedback === "heard" || src.feedback === "missed" || src.feedback === "stuck" || src.feedback === "page" ? src.feedback : ""
    };
  }

  function deliverBeacon(payload) {
    var json = "";
    try { json = JSON.stringify(payload || {}); } catch (e) { return false; }
    if (!json || json.indexOf("eyJ") !== -1) return false;
    if (root.navigator && typeof root.navigator.sendBeacon === "function") {
      try { return root.navigator.sendBeacon(BEACON_URL, json) === true; }
      catch (e2) { /* fetch keepalive below */ }
    }
    if (typeof root.fetch !== "function") return false;
    try {
      root.fetch(BEACON_URL, {
        method: "POST",
        body: json,
        keepalive: true,
        mode: "no-cors",
        credentials: "omit"
      });
      return true;
    } catch (e3) { return false; }
  }

  function recordingLine(consent, phase) {
    if (phase === "on") return "Recording: on. Microphone is on for this tab. Audio is not uploaded.";
    if (phase === "denied") return "Recording: off. Microphone permission was not granted.";
    if (phase === "missing") return "Recording: off. This browser has no recorder.";
    if (consent === "on") return "Recording: off. Consent is on. Waiting for the microphone.";
    return "Recording: off. Consent is off.";
  }

  function viewNow() {
    return { w: root.innerWidth || 0, h: root.innerHeight || 0 };
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
    var recording = doc.getElementById("recording-state");
    var tracksNow = { audio: 0, video: 0 };
    var stream = null;
    var recorder = null;
    var attempt = 0;

    function snapshot(phase, extra) {
      var src = extra || {};
      src.phase = phase;
      src.room = src.room || "absent";
      src.viewport = src.viewport || viewNow();
      src.tracks = src.tracks || tracksNow;
      if (src.consent !== "on" && src.consent !== "off") {
        src.consent = record && record.checked ? "on" : "off";
      }
      src.ice = src.ice || { state: "absent", pairs: 0 };
      return beaconPayload(src.kind || "room", src);
    }

    function stopRecorder() {
      attempt += 1;
      if (recorder && recorder.state !== "inactive") {
        try { recorder.stop(); } catch (e) {}
      }
      recorder = null;
      if (stream && stream.getTracks) {
        var tracks = stream.getTracks();
        for (var i = 0; i < tracks.length; i++) {
          try { tracks[i].stop(); } catch (e2) {}
        }
      }
      stream = null;
      tracksNow = { audio: 0, video: 0 };
    }

    function startRecorder() {
      var devices = root.navigator && root.navigator.mediaDevices;
      if (!devices || typeof devices.getUserMedia !== "function" || typeof root.MediaRecorder !== "function") {
        if (recording) recording.textContent = recordingLine("on", "missing");
        deliverBeacon(snapshot("live", { kind: "error", error: "recorder unavailable" }));
        return;
      }
      var mine = ++attempt;
      if (recording) recording.textContent = recordingLine("on");
      devices.getUserMedia({ audio: true, video: false }).then(function (next) {
        if (mine !== attempt || !record.checked) {
          var dropped = next.getTracks();
          for (var d = 0; d < dropped.length; d++) {
            try { dropped[d].stop(); } catch (e3) {}
          }
          return;
        }
        stream = next;
        tracksNow = { audio: next.getAudioTracks().length, video: 0 };
        try {
          recorder = new root.MediaRecorder(next);
          recorder.addEventListener("error", function () {
            deliverBeacon(snapshot("live", { kind: "error", error: "recorder error" }));
          });
          recorder.start();
        } catch (e4) {
          stopRecorder();
          record.checked = false;
          if (recording) recording.textContent = recordingLine("off", "missing");
          deliverBeacon(snapshot("live", { kind: "error", error: "recorder error", consent: "off" }));
          return;
        }
        if (recording) recording.textContent = recordingLine("on", "on");
        deliverBeacon(snapshot("live", { kind: "tracks" }));
      }).catch(function (err) {
        if (mine !== attempt) return;
        record.checked = false;
        tracksNow = { audio: 0, video: 0 };
        if (recording) recording.textContent = recordingLine("off", "denied");
        deliverBeacon(snapshot("live", {
          kind: "error",
          error: (err && err.name) || "mic denied",
          consent: "off"
        }));
      });
    }

    if (record) {
      record.checked = false;
      record.disabled = false;
      if (recording) recording.textContent = recordingLine("off");
      record.addEventListener("change", function () {
        if (record.checked) startRecorder();
        else {
          stopRecorder();
          if (recording) recording.textContent = recordingLine("off");
          deliverBeacon(snapshot("live", { kind: "consent" }));
        }
      });
    }
    if (root.addEventListener) {
      root.addEventListener("pagehide", function () {
        deliverBeacon(snapshot("exit"));
        stopRecorder();
      });
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
    deliverBeacon(snapshot("join", { kind: "room", feedback: "page" }));

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
        deliverBeacon(snapshot("live", { kind: "room", feedback: which }));
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
    beaconPayload: beaconPayload,
    deliverBeacon: deliverBeacon,
    recordingLine: recordingLine,
    mount: mount
  };
});
