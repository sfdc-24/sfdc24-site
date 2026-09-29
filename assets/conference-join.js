/* /conference points at the existing Cloud Run gateway.
   That gateway already signs the owner in and issues the room token.
   Join and exit beacons post to the gateway feedback path.
   This file does not mint, store, or redeem a token.
   Opt-in audio stays in the tab; it is not uploaded. */
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

  function safeDecode(raw) {
    try { return decodeURIComponent(raw); }
    catch (e) { return ""; }
  }

  function readRaw(loc) {
    var hash = String((loc && loc.hash) || "").replace(/^#/, "");
    var search = String((loc && loc.search) || "");
    var params;
    try { params = new URLSearchParams(search); }
    catch (e) { params = { get: function () { return ""; } }; }
    if (hash.indexOf("t=") === 0) return safeDecode(hash.slice(2));
    if (hash.indexOf("token=") === 0) return safeDecode(hash.slice(6));
    return params.get("t") || params.get("token") || "";
  }

  function readCode(loc) {
    var hash = String((loc && loc.hash) || "").replace(/^#/, "");
    if (hash.indexOf("c=") !== 0) return "";
    return safeDecode(hash.slice(2)).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80);
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

  function statusNote(kind) {
    return "Noted in this tab: " + kind + ". Gateway answered 204.";
  }

  function beaconAccepted(status) {
    return Number(status) === 204;
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
      var pending = root.fetch(BEACON_URL, {
        method: "POST",
        body: json,
        keepalive: true,
        mode: "cors",
        credentials: "omit"
      });
      if (pending && typeof pending.then === "function") {
        root.__conferenceBeacon = pending.then(function (res) {
          var status = res && res.status;
          root.__conferenceBeaconStatus = status;
          if (beaconAccepted(status) && root.document) {
            var el = root.document.getElementById("beacon-status");
            var kind = payload && payload.feedback;
            if (el && kind) el.textContent = statusNote(kind);
          }
          return status;
        }).catch(function () { return 0; });
      }
      return true;
    } catch (e3) { return false; }
  }

  function audioCapture() {
    var room = root.conferenceRoom;
    if (room && typeof room.audioConstraints === "function") return room.audioConstraints();
    return {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
      sampleRate: 48000
    };
  }

  function withConsent(next) {
    var room = root.conferenceRoom;
    if (!room || typeof room.requestConsent !== "function") {
      next(false);
      return;
    }
    room.requestConsent(next);
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

  function chatLine(raw) {
    return String(raw == null ? "" : raw).replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim().slice(0, 160);
  }

  var POST = {
    key_issues: "Delay, and answers cut off.",
    discussion_notes: "Four voices, one floor.",
    action_items: "Measure both next call.",
    next_steps: "Sign in to join."
  };

  function applyPost(doc, card) {
    var slots = ["key_issues", "discussion_notes", "action_items", "next_steps"];
    var src = card && typeof card === "object" ? card : {};
    for (var i = 0; i < slots.length; i++) {
      var el = doc.querySelector('[data-slot="' + slots[i] + '"]');
      var text = src[slots[i]];
      if (!el || typeof text !== "string") continue;
      text = text.replace(/\s+/g, " ").trim().slice(0, 80);
      if (!text || text.indexOf("eyJ") !== -1) continue;
      el.textContent = text;
    }
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
    applyPost(doc, POST);
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

    var speech = null;

    function pushLine(text) {
      var log = doc.getElementById("chat-log");
      var line = chatLine(text);
      if (!log || !line) return;
      var live = doc.getElementById("chat-live");
      if (log.getAttribute("data-empty") === "1") {
        log.textContent = "";
        log.setAttribute("data-empty", "0");
        if (live) log.appendChild(live);
      }
      var row = doc.createElement("p");
      row.textContent = line;
      if (live && live.parentNode === log) log.insertBefore(row, live);
      else log.appendChild(row);
      var rows = log.querySelectorAll("p");
      while (rows.length > 6) {
        log.removeChild(rows[0]);
        rows = log.querySelectorAll("p");
      }
      log.scrollTop = log.scrollHeight;
    }

    function stopSpeech() {
      if (speech) {
        try { speech.onresult = null; speech.stop(); } catch (e) {}
        speech = null;
      }
      var live = doc.getElementById("chat-live");
      if (live) live.textContent = "";
    }

    function startSpeech() {
      stopSpeech();
      var SR = root.SpeechRecognition || root.webkitSpeechRecognition;
      if (typeof SR !== "function") return;
      try {
        speech = new SR();
        speech.continuous = true;
        speech.interimResults = true;
        speech.onresult = function (ev) {
          var finalText = "";
          var interim = "";
          var results = ev && ev.results ? ev.results : [];
          var startAt = ev && ev.resultIndex ? ev.resultIndex : 0;
          for (var i = startAt; i < results.length; i++) {
            var bit = results[i][0] ? results[i][0].transcript : "";
            if (results[i].isFinal) finalText += bit;
            else interim += bit;
          }
          if (finalText) pushLine(finalText);
          var liveNow = doc.getElementById("chat-live");
          if (liveNow) liveNow.textContent = chatLine(interim);
        };
        speech.start();
      } catch (eSpeech) {
        speech = null;
      }
    }

    function stopRecorder() {
      stopSpeech();
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
      devices.getUserMedia({ audio: audioCapture(), video: false }).then(function (next) {
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
          var recOpts;
          if (typeof root.MediaRecorder.isTypeSupported === "function" && root.MediaRecorder.isTypeSupported("audio/webm;codecs=opus")) {
            recOpts = {mimeType: "audio/webm;codecs=opus"};
          }
          recorder = recOpts ? new root.MediaRecorder(next, recOpts) : new root.MediaRecorder(next);
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
        startSpeech();
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
        if (record.checked) {
          withConsent(function (ok) {
            if (!record.checked) return;
            if (!ok) {
              record.checked = false;
              if (recording) recording.textContent = recordingLine("off");
              return;
            }
            startRecorder();
          });
        } else {
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
    var carried = readCode(loc);
    var codeEl = doc.getElementById("conf-code");
    if (codeEl && carried && !codeEl.value) codeEl.value = carried;
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
      status.textContent = "A token is on this link. This page does not store it or redeem it. No invite is sent from here.";
    } else {
      status.textContent = "No join token on this link. This page does not mint one and does not send an invite. The gateway already issues the room token.";
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
        for (var i = 0; i < pads.length; i++) {
          pads[i].setAttribute("aria-pressed", pads[i] === ev.currentTarget ? "true" : "false");
        }
        showNote(beacon, note(which));
        deliverBeacon(snapshot("live", { kind: "room", feedback: which }));
        try { doc.dispatchEvent(new root.CustomEvent("conference-feedback", {detail: which})); }
        catch (eNote) {}
      });
    }

    var chatForm = doc.getElementById("chat-form");
    var chatText = doc.getElementById("chat-text");
    if (chatForm && chatText) {
      chatForm.addEventListener("submit", function (ev) {
        ev.preventDefault();
        pushLine(chatText.value);
        chatText.value = "";
      });
    }

    var waitLine = doc.getElementById("wait-line");
    var taps = 0;
    var peekAt = 0;
    var lookAt = 0;
    var peeks = ["The room is thinking.", "A button was pressed. The room noticed.", "Still here."];
    var looks = ["Cobalt", "Quiet", "Ready"];
    var waits = doc.querySelectorAll("[data-wait]");
    for (var w = 0; w < waits.length; w++) {
      waits[w].addEventListener("click", function (ev) {
        var kind = ev.currentTarget.getAttribute("data-wait");
        if (!waitLine) return;
        if (kind === "tap") {
          taps += 1;
          waitLine.textContent = "Taps in this tab: " + taps;
        } else if (kind === "peek") {
          waitLine.textContent = peeks[peekAt % peeks.length];
          peekAt += 1;
        } else if (kind === "swap") {
          waitLine.textContent = looks[lookAt % looks.length];
          lookAt += 1;
        }
      });
    }
  }

  return {
    GATEWAY: GATEWAY,
    classifyToken: classifyToken,
    sanitizeAddress: sanitizeAddress,
    readRaw: readRaw,
    readCode: readCode,
    beaconAccepted: beaconAccepted,
    statusNote: statusNote,
    joinHref: joinHref,
    note: note,
    beaconPayload: beaconPayload,
    deliverBeacon: deliverBeacon,
    recordingLine: recordingLine,
    chatLine: chatLine,
    POST: POST,
    applyPost: applyPost,
    mount: mount
  };
});
