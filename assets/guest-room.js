/* Guest seat.
   The invite code is location.hash only. It is never read from the query
   string, never written to storage, and never sent anywhere except the
   join request body. Nothing in this file writes that code into a log.
   POST {token, device} to serviceUrl + /api/guest/join
   (serviceUrl lives in /data/guest-join.json).
   200 JSON {url, token}: url is the media socket, token is the media
   access token. serverUrl and accessToken are fallbacks when url or token
   is absent. Optional mediaUrl in the same config is used only when the
   response omits a socket URL.
   409 whose body means the call has not started: retry every 10 seconds.
   The seat publishes a microphone only. It plays remote audio, shows a
   scr_ participant's video large, and lists everyone else underneath.
*/
(function () {
  "use strict";

  var RETRY_MS = 10000;
  var JOIN_PATH = "/api/guest/join";
  var DEVICE_KEY = "sfdc24-guest-device";

  var statusEl, stage, screenVideos, screenEmpty, people, muteBtn, leaveBtn, audioBin;
  var joinUrl = "";
  var configuredMediaUrl = "";
  var room = null;
  var joined = false;
  var left = false;
  var micOn = false;
  var generation = 0;
  var retryTimer = 0;
  var memoryDevice = "";
  var attached = typeof WeakSet === "function" ? new WeakSet() : null;

  function inviteToken() {
    var raw = "";
    try { raw = String(location.hash || ""); } catch (err) { return ""; }
    if (raw.charAt(0) === "#") raw = raw.slice(1);
    if (!raw) return "";
    var plusKept = raw.replace(/\+/g, "%2B");
    try { raw = decodeURIComponent(plusKept); } catch (err) { raw = plusKept; }
    if (raw.indexOf("token=") === 0) raw = raw.slice(6);
    return raw.trim();
  }

  function newDevice() {
    try {
      if (window.crypto && typeof crypto.randomUUID === "function") return crypto.randomUUID();
    } catch (err) {}
    return "web-" + Math.random().toString(36).slice(2, 12);
  }

  function deviceId() {
    var token = inviteToken();
    var existing = "";
    try { existing = sessionStorage.getItem(DEVICE_KEY) || ""; } catch (err) { existing = memoryDevice; }
    if (existing && existing !== token) return existing;
    var created = newDevice();
    if (!created || created === token) created = "web-guest";
    memoryDevice = created;
    try { sessionStorage.setItem(DEVICE_KEY, created); } catch (err) {}
    return created;
  }

  function silenceMediaLogs() {
    var LK = window.LivekitClient;
    if (!LK || typeof LK.setLogLevel !== "function" || !LK.LogLevel) return;
    try { LK.setLogLevel(LK.LogLevel.silent); } catch (err) {}
  }

  function say(text) {
    if (statusEl) statusEl.textContent = text;
  }

  function showLeave() {
    if (leaveBtn) leaveBtn.hidden = false;
  }

  function clearRetry() {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = 0;
  }

  function scheduleRetry() {
    clearRetry();
    retryTimer = setTimeout(attempt, RETRY_MS);
  }

  function callNotStarted(text) {
    return /has not started|not yet started|not[_ ]started|call[_ ]not[_ ]started/i.test(String(text || ""));
  }

  function firstString() {
    for (var i = 0; i < arguments.length; i++) {
      if (typeof arguments[i] === "string" && arguments[i].trim()) return arguments[i].trim();
    }
    return "";
  }

  function signalUrl(value) {
    var url = String(value || "").trim();
    if (/^https:\/\//i.test(url)) url = "wss://" + url.slice(8);
    else if (/^http:\/\//i.test(url)) url = "ws://" + url.slice(7);
    if (!/^wss:\/\//i.test(url) && !/^ws:\/\//i.test(url)) return "";
    if (/\s/.test(url)) return "";
    return url;
  }

  function mediaParts(data) {
    var src = data;
    if (data && typeof data === "object") {
      var nested = data.livekit || data.room || data.connection;
      if (nested && typeof nested === "object") src = nested;
    }
    if (!src || typeof src !== "object") src = {};
    var url = signalUrl(firstString(src.url, src.serverUrl, src.livekitUrl, src.wsUrl, configuredMediaUrl));
    var token = firstString(src.token, src.accessToken, src.livekitToken);
    if (!url || !token) return null;
    return { url: url, token: token };
  }

  function isLocalParticipant(participant) {
    if (!participant) return false;
    if (participant.isLocal) return true;
    return !!(room && participant === room.localParticipant);
  }

  function isScreenDevice(participant) {
    var id = participant && participant.identity ? String(participant.identity) : "";
    return id.indexOf("scr_") === 0;
  }

  function personKey(participant) {
    if (isLocalParticipant(participant)) return "local";
    var id = participant && participant.identity ? String(participant.identity) : "";
    var token = inviteToken();
    if (!id || (token && id === token)) return "guest";
    return id;
  }

  function labelFor(participant) {
    if (isLocalParticipant(participant)) return "Guest";
    var token = inviteToken();
    var name = participant && participant.name ? String(participant.name).trim() : "";
    if (name && name !== token) return name;
    var id = participant && participant.identity ? String(participant.identity) : "";
    if (id && id !== token) return id;
    return "Guest";
  }

  function safeFrom(participant) {
    var id = participant && participant.identity ? String(participant.identity) : "";
    var token = inviteToken();
    if (!id || (token && id === token)) return "";
    return id;
  }

  function findPerson(key) {
    if (!people) return null;
    var nodes = people.children;
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i].getAttribute("data-person") === key) return nodes[i];
    }
    return null;
  }

  function ensurePerson(participant) {
    if (!participant || !people || isScreenDevice(participant)) return null;
    var key = personKey(participant);
    var existing = findPerson(key);
    if (existing) return existing;
    var block = document.createElement("div");
    block.className = "guest-person";
    block.setAttribute("role", "listitem");
    block.setAttribute("data-person", key);
    var slot = document.createElement("div");
    slot.className = "guest-person-video";
    var name = document.createElement("span");
    name.textContent = labelFor(participant);
    block.appendChild(slot);
    block.appendChild(name);
    people.appendChild(block);
    return block;
  }

  function playEl(el) {
    try {
      var pending = el.play();
      if (pending && typeof pending.catch === "function") pending.catch(function () {});
    } catch (err) {}
  }

  function unlockAudio() {
    if (!audioBin && !screenVideos) return;
    var nodes = [];
    if (audioBin) nodes = nodes.concat([].slice.call(audioBin.querySelectorAll("audio")));
    if (screenVideos) nodes = nodes.concat([].slice.call(screenVideos.querySelectorAll("video")));
    for (var i = 0; i < nodes.length; i++) playEl(nodes[i]);
  }

  function markAttached(track) {
    if (!track) return false;
    if (attached && attached.has(track)) return false;
    if (attached) attached.add(track);
    return true;
  }

  function onSubscribed(track, publication, participant) {
    if (!track || isLocalParticipant(participant)) return;
    if (!markAttached(track)) return;
    var kind = String(track.kind || "");
    if (kind === "audio") {
      var audio = track.attach();
      audio.autoplay = true;
      audio.setAttribute("data-guest-audio", "1");
      if (audioBin) audioBin.appendChild(audio);
      playEl(audio);
      if (!isScreenDevice(participant)) ensurePerson(participant);
      return;
    }
    if (kind !== "video") return;
    var video = track.attach();
    video.autoplay = true;
    video.playsInline = true;
    video.muted = true;
    video.setAttribute("data-guest-video", "1");
    var from = safeFrom(participant);
    if (from) video.setAttribute("data-from", from);
    if (isScreenDevice(participant)) {
      if (screenVideos) screenVideos.appendChild(video);
      if (screenEmpty) screenEmpty.hidden = true;
    } else {
      var block = ensurePerson(participant);
      var slot = block && block.querySelector(".guest-person-video");
      if (slot) slot.appendChild(video);
    }
    playEl(video);
  }

  function onUnsubscribed(track) {
    if (attached && track) attached.delete(track);
    var els = [];
    try { els = (track && track.detach && track.detach()) || []; } catch (err) { els = []; }
    for (var i = 0; i < els.length; i++) {
      if (els[i] && els[i].parentNode) els[i].parentNode.removeChild(els[i]);
    }
    if (screenVideos && screenEmpty && !screenVideos.querySelector("video")) screenEmpty.hidden = false;
  }

  function onParticipant(participant) {
    if (!isScreenDevice(participant)) ensurePerson(participant);
  }

  function onParticipantGone(participant) {
    var block = findPerson(personKey(participant));
    if (block && block.parentNode) block.parentNode.removeChild(block);
    var from = safeFrom(participant);
    if (from && screenVideos) {
      var vids = screenVideos.querySelectorAll("video");
      for (var i = 0; i < vids.length; i++) {
        if (vids[i].getAttribute("data-from") === from && vids[i].parentNode) vids[i].parentNode.removeChild(vids[i]);
      }
    }
    if (screenVideos && screenEmpty && !screenVideos.querySelector("video")) screenEmpty.hidden = false;
  }

  function onDisconnected() {
    if (left) return;
    joined = false;
    micOn = false;
    clearStage();
    if (muteBtn) muteBtn.hidden = true;
    say("The call ended.");
    showLeave();
  }

  function bind(next) {
    var ev = (window.LivekitClient && window.LivekitClient.RoomEvent) || {};
    next.on(ev.TrackSubscribed || "trackSubscribed", onSubscribed);
    next.on(ev.TrackUnsubscribed || "trackUnsubscribed", onUnsubscribed);
    next.on(ev.ParticipantConnected || "participantConnected", onParticipant);
    next.on(ev.ParticipantDisconnected || "participantDisconnected", onParticipantGone);
    next.on(ev.Disconnected || "disconnected", onDisconnected);
  }

  function pullExisting(next) {
    var remotes = next.remoteParticipants;
    if (!remotes || typeof remotes.forEach !== "function") return;
    remotes.forEach(function (participant) {
      if (!isScreenDevice(participant)) ensurePerson(participant);
      [participant.audioTrackPublications, participant.videoTrackPublications].forEach(function (map) {
        if (!map || typeof map.forEach !== "function") return;
        map.forEach(function (pub) {
          var track = pub && (pub.track || pub.audioTrack || pub.videoTrack);
          if (track) onSubscribed(track, pub, participant);
        });
      });
    });
  }

  function paintMute() {
    if (!muteBtn) return;
    muteBtn.hidden = !joined;
    muteBtn.textContent = micOn ? "Mute" : "Unmute";
    muteBtn.setAttribute("aria-pressed", micOn ? "false" : "true");
    muteBtn.setAttribute("aria-label", micOn ? "Mute" : "Unmute");
  }

  function clearStage() {
    if (screenVideos) screenVideos.textContent = "";
    if (people) people.textContent = "";
    if (audioBin) audioBin.textContent = "";
    if (screenEmpty) screenEmpty.hidden = false;
    if (stage) stage.hidden = true;
  }

  function connect(media) {
    var LK = window.LivekitClient;
    if (!LK || typeof LK.Room !== "function") {
      say("The call could not be joined.");
      showLeave();
      return;
    }
    silenceMediaLogs();
    joined = true;
    clearRetry();
    var next = new LK.Room({
      adaptiveStream: true,
      dynacast: true,
      audioCaptureDefaults: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });
    room = next;
    bind(next);
    return next.connect(media.url, media.token).then(function () {
      if (left) {
        try { next.disconnect(); } catch (err) {}
        return;
      }
      if (stage) stage.hidden = false;
      showLeave();
      ensurePerson(next.localParticipant);
      pullExisting(next);
      say("In the call.");
      return next.localParticipant.setMicrophoneEnabled(true).then(function () {
        micOn = true;
        paintMute();
      }, function () {
        micOn = false;
        paintMute();
        say("In the call. The microphone is off.");
      });
    }, function () {
      if (room === next) room = null;
      joined = false;
      say("The call could not be joined.");
      showLeave();
    });
  }

  function attempt() {
    if (left || joined || !joinUrl) return;
    var token = inviteToken();
    if (!token) {
      say("This invite is missing its code.");
      return;
    }
    var gen = ++generation;
    var device = deviceId();
    fetch(joinUrl, {
      method: "POST",
      headers: { "content-type": "application/json", "accept": "application/json" },
      body: JSON.stringify({ token: token, device: device }),
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      referrerPolicy: "no-referrer"
    }).then(function (res) {
      return res.text().then(function (text) {
        if (left || gen !== generation) return;
        if (res.status === 409 && callNotStarted(text)) {
          say("The call has not started. Waiting.");
          showLeave();
          scheduleRetry();
          return;
        }
        if (!res.ok) {
          say("The call could not be joined.");
          showLeave();
          return;
        }
        var data = null;
        try { data = JSON.parse(text); } catch (err) { data = null; }
        var media = mediaParts(data);
        if (!media) {
          say("The call could not be joined.");
          showLeave();
          return;
        }
        return connect(media);
      });
    }).catch(function () {
      if (left || gen !== generation) return;
      say("The call could not be reached.");
      showLeave();
    });
  }

  function onMute() {
    if (!room || !joined || !room.localParticipant) return;
    var next = !micOn;
    room.localParticipant.setMicrophoneEnabled(next).then(function () {
      micOn = next;
      paintMute();
      if (joined) say("In the call.");
    }, function () {
      micOn = false;
      paintMute();
      say("In the call. The microphone is off.");
    });
  }

  function leave() {
    if (left) return;
    left = true;
    joined = false;
    micOn = false;
    clearRetry();
    generation += 1;
    var current = room;
    room = null;
    if (current && current.localParticipant) {
      try { current.localParticipant.setMicrophoneEnabled(false); } catch (err) {}
    }
    if (current && typeof current.disconnect === "function") {
      try { current.disconnect(); } catch (err) {}
    }
    clearStage();
    if (muteBtn) muteBtn.hidden = true;
    if (leaveBtn) leaveBtn.hidden = true;
    say("Left the call.");
    try { history.replaceState(null, "", location.pathname); } catch (err) {}
  }

  function loadConfig() {
    return fetch("/data/guest-join.json", { cache: "no-store", credentials: "omit" }).then(function (res) {
      if (!res.ok) throw new Error("config");
      return res.json();
    }).then(function (data) {
      var base = data && typeof data.serviceUrl === "string" ? data.serviceUrl.trim().replace(/\/+$/, "") : "";
      if (!/^https?:\/\/[a-z0-9.-]+(?::\d+)?(?:\/[^?#]*)?$/i.test(base)) throw new Error("config");
      configuredMediaUrl = data && typeof data.mediaUrl === "string" ? data.mediaUrl.trim() : "";
      return base + JOIN_PATH;
    });
  }

  function boot() {
    statusEl = document.getElementById("guest-status");
    stage = document.getElementById("guest-stage");
    screenVideos = document.getElementById("guest-screen-videos");
    screenEmpty = document.getElementById("guest-screen-empty");
    people = document.getElementById("guest-people");
    muteBtn = document.getElementById("guest-mute");
    leaveBtn = document.getElementById("guest-leave");
    audioBin = document.getElementById("guest-audio");
    if (!statusEl || !stage || !muteBtn || !leaveBtn) return;
    silenceMediaLogs();
    muteBtn.addEventListener("click", onMute);
    leaveBtn.addEventListener("click", leave);
    document.addEventListener("pointerdown", unlockAudio);
    if (!inviteToken()) {
      say("This invite is missing its code.");
      return;
    }
    loadConfig().then(function (url) {
      joinUrl = url;
      attempt();
    }, function () {
      say("The call could not be reached.");
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
