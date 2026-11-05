/* Presenter seat at /present/.
   The code is location.hash (bookmarkable; a fragment is not sent to a server)
   or exactly what was typed. A query string is ignored. The code is never
   written into storage, a log, page text, or a request URL.
   Verified against conference PR 308 at 52d42a5 (docs/GUESTS.md, guest_app.py):
   POST {code, device, join_nonce} to serviceUrl + /api/guest/join.
   serviceUrl is /data/present-join.json, the same origin /guest/ uses.
   The work order named the JSON field "token". That service reads "code".
   A 200 is connected only when role is "presenter", identity starts with scr_,
   and the join token's video grant publishes screen_share only and does not
   subscribe. That role and that grant are not in the service yet.
   409 whose error is "the call has not started" retries every 10 seconds.
   Stop aborts the try, stops the captured screen, and leaves the room.
   The picker opens inside the click, before any join request.
*/
(function () {
  "use strict";

  var RETRY_MS = 10000;
  var JOIN_PATH = "/api/guest/join";
  var DEVICE_KEY = "sfdc24-present-device";
  var ID_OK = /^[A-Za-z0-9_-]{16,128}$/;
  var NOT_STARTED = "the call has not started";
  var CALL_FULL = "the call is full";
  var ON_AIR = "This screen is in the call. The owner sees it, and the voices are told what is on it.";
  var WAITING = "The call has not started. Waiting.";
  var STOPPED = "Sharing stopped.";
  var ENDED = "The call ended, or this screen was replaced.";
  var NO_SCREEN = "No screen was picked.";
  var NOT_PRESENTER = "This code did not open a presenter seat.";
  var NOT_SCREEN = "This code did not open a screen seat.";
  var REFUSED = "Sharing did not start (the call is gone, or the room refused the track).";
  var UNREACHABLE = "The call could not be reached.";
  var INVALID = "This invite is not valid.";
  var FULL = "The call is full.";
  var LIMITED = "Too many tries. Wait a minute.";
  var FAILED = "The call could not be joined.";
  var JOINING = "Joining the call...";

  var statusEl, enterForm, codeInput, shareBtn, stopBtn, banner;
  var joinUrl = "";
  var configError = false;
  var configWait = null;
  var activeCode = "";
  var shared = null;
  var room = null;
  var busy = false;
  var session = 0;
  var retryTimer = 0;
  var inflight = null;
  var memoryDevice = "";

  function hashCode() {
    var raw = "";
    try { raw = String(location.hash || ""); } catch (err) { return ""; }
    if (raw.charAt(0) === "#") raw = raw.slice(1);
    if (!raw) return "";
    try { raw = decodeURIComponent(raw.replace(/\+/g, "%2B")); } catch (err) {}
    return raw.trim();
  }

  function codeToPost() {
    var fromHash = hashCode();
    if (fromHash) return fromHash;
    var typed = codeInput ? String(codeInput.value || "") : "";
    if (typed.trim()) return typed;
    return activeCode;
  }

  function urlSafeId(length) {
    var alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    var size = length || 24;
    var bytes = new Uint8Array(size);
    var i;
    try {
      if (window.crypto && typeof crypto.getRandomValues === "function") crypto.getRandomValues(bytes);
      else throw new Error("weak");
    } catch (err) {
      for (i = 0; i < size; i++) bytes[i] = Math.floor(Math.random() * 256);
    }
    var out = "";
    for (i = 0; i < size; i++) out += alphabet.charAt(bytes[i] & 63);
    return out;
  }

  function deviceId() {
    var code = activeCode || hashCode();
    var existing = "";
    try { existing = sessionStorage.getItem(DEVICE_KEY) || ""; } catch (err) { existing = memoryDevice; }
    if (existing && existing !== code && ID_OK.test(existing)) return existing;
    var created = urlSafeId(24);
    if (!ID_OK.test(created) || created === code) created = urlSafeId(32);
    memoryDevice = created;
    try { sessionStorage.setItem(DEVICE_KEY, created); } catch (err) {}
    return created;
  }

  function joinNonce() {
    var code = activeCode || hashCode();
    var nonce = urlSafeId(24);
    if (nonce === code || nonce === memoryDevice || !ID_OK.test(nonce)) nonce = urlSafeId(32);
    return nonce;
  }

  function silenceMediaLogs() {
    var LK = window.LivekitClient;
    if (!LK || typeof LK.setLogLevel !== "function" || !LK.LogLevel) return;
    try { LK.setLogLevel(LK.LogLevel.silent); } catch (err) {}
  }

  function say(text) {
    if (!statusEl) return;
    statusEl.hidden = false;
    statusEl.textContent = text;
  }

  function clearRetry() {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = 0;
  }

  function stopCapture() {
    var track = shared;
    shared = null;
    if (!track) return;
    try { track.stop(); } catch (err) {}
  }

  function showShare() {
    busy = false;
    if (shareBtn) {
      shareBtn.hidden = false;
      shareBtn.disabled = false;
    }
    if (stopBtn) stopBtn.hidden = true;
    if (banner) banner.hidden = true;
    if (hashCode()) {
      if (enterForm) enterForm.hidden = true;
    } else {
      activeCode = "";
      if (codeInput) codeInput.value = "";
      if (enterForm) enterForm.hidden = false;
    }
  }

  function showStop() {
    if (enterForm) enterForm.hidden = true;
    if (shareBtn) shareBtn.hidden = true;
    if (stopBtn) stopBtn.hidden = false;
  }

  function finish(why) {
    session += 1;
    clearRetry();
    if (inflight) {
      try { inflight.abort(); } catch (err) {}
      inflight = null;
    }
    stopCapture();
    var old = room;
    room = null;
    showShare();
    say(why);
    if (old && typeof old.disconnect === "function") {
      try {
        var done = old.disconnect();
        if (done && typeof done.catch === "function") done.catch(function () {});
      } catch (err) {}
    }
  }

  function errorText(text) {
    var raw = String(text || "").trim();
    try {
      var data = JSON.parse(raw);
      if (data && typeof data.error === "string") return data.error.trim();
    } catch (err) {}
    return raw;
  }

  function signalUrl(value) {
    var url = String(value || "").trim();
    if (/^https:\/\//i.test(url)) url = "wss://" + url.slice(8);
    else if (/^http:\/\//i.test(url)) url = "ws://" + url.slice(7);
    if (!/^wss:\/\//i.test(url) && !/^ws:\/\//i.test(url)) return "";
    if (/\s/.test(url)) return "";
    return url;
  }

  function jwtPayload(token) {
    var parts = String(token || "").split(".");
    if (parts.length < 2 || !parts[1]) return null;
    try {
      var b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
      while (b64.length % 4) b64 += "=";
      return JSON.parse(atob(b64));
    } catch (err) {
      return null;
    }
  }

  function isScreenIdentity(id) {
    return typeof id === "string" && id.indexOf("scr_") === 0 && id.length > 4 && id.length <= 128 && !/\s/.test(id);
  }

  function screenOnly(token) {
    var payload = jwtPayload(token);
    var video = payload && payload.video;
    var sources = video && video.canPublishSources;
    if (!video || video.canSubscribe !== false || video.canPublish === false || video.canPublishData === true) return false;
    if (!sources || typeof sources.length !== "number" || sources.length !== 1) return false;
    return sources[0] === "screen_share";
  }

  function seat(data) {
    if (!data || typeof data !== "object") return { error: FAILED };
    if (data.role !== "presenter") return { error: NOT_PRESENTER };
    if (!isScreenIdentity(data.identity)) return { error: NOT_SCREEN };
    var url = signalUrl(data.livekit_url);
    var token = typeof data.join_token === "string" ? data.join_token.trim() : "";
    if (!url || !token) return { error: FAILED };
    if (!screenOnly(token)) return { error: NOT_SCREEN };
    var claim = jwtPayload(token);
    if (claim && typeof claim.sub === "string" && claim.sub !== data.identity) return { error: NOT_SCREEN };
    return { url: url, token: token };
  }

  function dropAudio(stream) {
    var extra = [];
    try { extra = stream.getAudioTracks ? stream.getAudioTracks() : []; } catch (err) { extra = []; }
    for (var i = 0; i < extra.length; i++) {
      try { extra[i].stop(); } catch (err) {}
    }
  }

  function videoTrack(stream) {
    var tracks = [];
    try { tracks = stream.getVideoTracks ? stream.getVideoTracks() : []; } catch (err) { tracks = []; }
    return tracks[0] || null;
  }

  function refuseRemote(track, publication) {
    try {
      if (publication && typeof publication.setSubscribed === "function") publication.setSubscribed(false);
    } catch (err) {}
    try {
      if (track && typeof track.detach === "function") {
        var els = track.detach() || [];
        for (var i = 0; i < els.length; i++) {
          if (els[i] && els[i].parentNode) els[i].parentNode.removeChild(els[i]);
        }
      }
    } catch (err) {}
  }

  function sourceName() {
    var LK = window.LivekitClient;
    var source = LK && LK.Track && LK.Track.Source && LK.Track.Source.ScreenShare;
    return source || "screen_share";
  }

  function connect(gen, media) {
    var LK = window.LivekitClient;
    if (!LK || typeof LK.Room !== "function") {
      finish(REFUSED);
      return;
    }
    silenceMediaLogs();
    var next = new LK.Room({ adaptiveStream: false, dynacast: false });
    room = next;
    var ev = LK.RoomEvent || {};
    next.on(ev.TrackSubscribed || "trackSubscribed", refuseRemote);
    next.on(ev.Disconnected || "disconnected", function () {
      if (room === next) finish(ENDED);
    });
    var pending;
    try {
      pending = next.connect(media.url, media.token, { autoSubscribe: false });
    } catch (err) {
      finish(REFUSED);
      return;
    }
    Promise.resolve(pending).then(function () {
      if (gen !== session || room !== next) {
        try { next.disconnect(); } catch (err) {}
        return;
      }
      if (!shared || shared.readyState === "ended") {
        finish(STOPPED);
        return;
      }
      var local = next.localParticipant;
      if (!local || typeof local.publishTrack !== "function") {
        finish(REFUSED);
        return;
      }
      return Promise.resolve(local.publishTrack(shared, { source: sourceName() })).then(function () {
        if (gen !== session || room !== next) {
          try { next.disconnect(); } catch (err) {}
          return;
        }
        showStop();
        if (banner) banner.hidden = false;
        say(ON_AIR);
      });
    }).catch(function () {
      if (gen !== session) return;
      finish(REFUSED);
    });
  }

  function schedule(gen) {
    clearRetry();
    retryTimer = setTimeout(function () {
      if (gen !== session) return;
      join(gen);
    }, RETRY_MS);
  }

  function join(gen) {
    if (gen !== session || !shared) return;
    if (!joinUrl) {
      if (configError) finish(UNREACHABLE);
      else if (configWait) configWait.then(function () { if (gen === session) join(gen); });
      return;
    }
    var code = activeCode || hashCode();
    if (!code) {
      finish(FAILED);
      return;
    }
    if (inflight) {
      try { inflight.abort(); } catch (err) {}
    }
    inflight = typeof AbortController === "function" ? new AbortController() : null;
    say(JOINING);
    showStop();
    if (banner) banner.hidden = true;
    var opts = {
      method: "POST",
      headers: { "content-type": "application/json", "accept": "application/json" },
      body: JSON.stringify({ code: code, device: deviceId(), join_nonce: joinNonce() }),
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      referrerPolicy: "no-referrer"
    };
    if (inflight) opts.signal = inflight.signal;
    fetch(joinUrl, opts).then(function (res) {
      return res.text().then(function (text) {
        if (gen !== session) return;
        inflight = null;
        var message = errorText(text);
        if (res.status === 409 && message === NOT_STARTED) {
          say(WAITING);
          showStop();
          schedule(gen);
          return;
        }
        if (res.status === 409 && message === CALL_FULL) {
          finish(FULL);
          return;
        }
        if (res.status === 403) {
          finish(INVALID);
          return;
        }
        if (res.status === 429) {
          finish(LIMITED);
          return;
        }
        if (res.status === 503) {
          finish(UNREACHABLE);
          return;
        }
        if (!res.ok) {
          finish(FAILED);
          return;
        }
        var data = null;
        try { data = JSON.parse(text); } catch (err) { data = null; }
        var media = seat(data);
        if (media.error) {
          finish(media.error);
          return;
        }
        connect(gen, media);
      });
    }).catch(function (err) {
      if (gen !== session) return;
      if (err && err.name === "AbortError") return;
      finish(UNREACHABLE);
    });
  }

  function capture(gen) {
    var devices = navigator.mediaDevices;
    if (!devices || typeof devices.getDisplayMedia !== "function") {
      finish(NO_SCREEN);
      return;
    }
    var pending;
    try {
      pending = devices.getDisplayMedia({ video: true, audio: false });
    } catch (err) {
      finish(NO_SCREEN);
      return;
    }
    Promise.resolve(pending).then(function (stream) {
      if (gen !== session) {
        try {
          var gone = stream && stream.getTracks ? stream.getTracks() : [];
          for (var i = 0; i < gone.length; i++) gone[i].stop();
        } catch (err) {}
        return;
      }
      dropAudio(stream);
      var track = videoTrack(stream);
      if (!track) {
        finish(NO_SCREEN);
        return;
      }
      shared = track;
      track.addEventListener("ended", function () {
        if (shared === track) finish(STOPPED);
      });
      join(gen);
    }, function () {
      if (gen !== session) return;
      finish(NO_SCREEN);
    });
  }

  function begin(event) {
    if (event && event.preventDefault) event.preventDefault();
    if (busy) return;
    var code = codeToPost();
    if (!code || !String(code).trim()) return;
    busy = true;
    if (shareBtn) shareBtn.disabled = true;
    activeCode = code;
    if (codeInput) codeInput.value = "";
    if (enterForm) enterForm.hidden = true;
    capture(++session);
  }

  function loadConfig() {
    return fetch("/data/present-join.json", {
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer"
    }).then(function (res) {
      if (!res.ok) throw new Error("config");
      return res.json();
    }).then(function (data) {
      var base = data && typeof data.serviceUrl === "string" ? data.serviceUrl.trim().replace(/\/+$/, "") : "";
      if (!/^https?:\/\/[a-z0-9.-]+(?::\d+)?(?:\/[^?#]*)?$/i.test(base)) throw new Error("config");
      return base + JOIN_PATH;
    });
  }

  function followHash() {
    if (busy) return;
    activeCode = "";
    showShare();
    say("Ready to share.");
  }

  function boot() {
    statusEl = document.getElementById("present-status");
    enterForm = document.getElementById("present-enter");
    codeInput = document.getElementById("present-code");
    shareBtn = document.getElementById("present-share");
    stopBtn = document.getElementById("present-stop");
    banner = document.getElementById("present-on-air");
    if (!statusEl || !enterForm || !codeInput || !shareBtn || !stopBtn || !banner) return;
    silenceMediaLogs();
    shareBtn.addEventListener("click", begin);
    stopBtn.addEventListener("click", function () { finish(STOPPED); });
    enterForm.addEventListener("submit", begin);
    window.addEventListener("hashchange", followHash);
    if (hashCode()) enterForm.hidden = true;
    configWait = loadConfig().then(function (url) {
      joinUrl = url;
    }, function () {
      configError = true;
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
