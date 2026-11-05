/* Guest seat.
   The invite code is location.hash only (the leading # is stripped). It is
   never read from the query string, never written to storage, and never
   sent anywhere except the join request body. Nothing here writes that
   code, or the media join token, into a log.
   POST {token, device, join_nonce} to serviceUrl + /api/guest/join.
   serviceUrl lives in /data/guest-join.json. device is one stable id for
   this tab. join_nonce is a fresh url-safe value on every try.
   200 JSON {livekit_url, room, identity, join_token, join_expires_at, name, deadline}.
   Connect with livekit_url and join_token. Publish a microphone only.
   409 whose error is "the call has not started": retry every 10 seconds.
   409 "the call is full", 403 "this invite is not valid", 429 and 503 stop.
   Play remote audio. Show a scr_ participant's video large, and list
   everyone else underneath.
*/
(function () {
  "use strict";

  var RETRY_MS = 10000;
  var JOIN_PATH = "/api/guest/join";
  var DEVICE_KEY = "sfdc24-guest-device";
  var ID_OK = /^[A-Za-z0-9_-]{16,128}$/;
  var NOT_STARTED = "the call has not started";
  var CALL_FULL = "the call is full";
  var INVITE_INVALID = "this invite is not valid";

  var statusEl, stage, screenVideos, screenEmpty, people, muteBtn, leaveBtn, audioBin;
  var joinUrl = "";
  var guestLabel = "Guest";
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
    try { raw = decodeURIComponent(raw.replace(/\+/g, "%2B")); } catch (err) {}
    return raw.trim();
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
    var token = inviteToken();
    var existing = "";
    try { existing = sessionStorage.getItem(DEVICE_KEY) || ""; } catch (err) { existing = memoryDevice; }
    if (existing && existing !== token && ID_OK.test(existing)) return existing;
    var created = urlSafeId(24);
    if (!ID_OK.test(created) || created === token) created = urlSafeId(32);
    memoryDevice = created;
    try { sessionStorage.setItem(DEVICE_KEY, created); } catch (err) {}
    return created;
  }

  function joinNonce() {
    var token = inviteToken();
    var nonce = urlSafeId(24);
    if (nonce === token || !ID_OK.test(nonce)) nonce = urlSafeId(32);
    return nonce;
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

  function safeName(value) {
    var name = typeof value === "string" ? value.trim() : "";
    var token = inviteToken();
    if (!name || (token && name === token)) return "Guest";
    return name;
  }

  function mediaParts(data) {
    if (!data || typeof data !== "object") return null;
    var url = signalUrl(data.livekit_url);
    var token = typeof data.join_token === "string" ? data.join_token.trim() : "";
    if (!url || !token) return null;
    return { url: url, token: token, name: safeName(data.name) };
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
    if (isLocalParticipant(participant)) return guestLabel;
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
    guestLabel = media.name || "Guest";
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
      body: JSON.stringify({ token: token, device: device, join_nonce: joinNonce() }),
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      referrerPolicy: "no-referrer"
    }).then(function (res) {
      return res.text().then(function (text) {
        if (left || gen !== generation) return;
        var message = errorText(text);
        if (res.status === 409 && message === NOT_STARTED) {
          say("The call has not started. Waiting.");
          showLeave();
          scheduleRetry();
          return;
        }
        if (res.status === 409 && message === CALL_FULL) {
          say("The call is full.");
          showLeave();
          return;
        }
        if (res.status === 403) {
          say("This invite is not valid.");
          showLeave();
          return;
        }
        if (res.status === 429) {
          say("Too many tries. Wait a minute.");
          showLeave();
          return;
        }
        if (res.status === 503) {
          say("The call could not be reached.");
          showLeave();
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
