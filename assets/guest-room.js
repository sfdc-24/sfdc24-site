/* Guest seat.
   A link puts the code in location.hash (the leading # is stripped) and
   the page joins on its own. With no hash, the page shows one box labeled
   "Enter your code" and a Join button. The offer line stays hidden there.
   The posted code is the hash or exactly what was typed: case, spaces,
   and dashes stay as they are.
   A hash is not trimmed. Only an all-whitespace hash counts as empty.
   The code is never read from the query string, never written to storage,
   and never sent anywhere except the join request body. Nothing here
   writes that code, or the media join token, into a log or into page text
   after Join. Leave clears the hash and keeps the query string.
   The code box is a form. The input has no name. Submit is cancelled in
   script, so the code is not placed on the query string.
   POST {code, device, join_nonce} to an https origin + /api/guest/join.
   serviceUrl lives in /data/guest-join.json and must be an https origin
   with no path, query, or fragment. device is one stable id for this tab.
   join_nonce is a fresh url-safe value on every try. Both come from
   crypto.getRandomValues. If that is missing, the join stops.
   200 JSON {livekit_url, room, identity, join_token, join_expires_at, name, deadline, role}.
   A role of presenter is refused. This page is for guests.
   Connect with livekit_url and join_token. Publish a microphone only.
   The signal address must be wss://. https:// is used as wss://.
   ws:// and http:// are refused. An http://localhost, http://127.0.0.1,
   or http://[::1] page may use ws:// to one of those hosts.
   409 whose error is "the call has not started": retry every 10 seconds.
   409 "the call is full", 403 "this invite is not valid", 429 and 503 stop.
   429 says there were too many invalid codes and to wait ten minutes.
   Play remote audio. Show a scr_ or prs_ participant's video large.
   Other video tracks are not drawn. Everyone else is a block in a row.
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
  var offerEl, roleEl, enterForm, codeInput;
  var joinUrl = "";
  var activeToken = "";
  var guestLabel = "Guest";
  var room = null;
  var joined = false;
  var left = false;
  var micOn = false;
  var generation = 0;
  var retryTimer = 0;
  var memoryDevice = "";
  var attached = typeof WeakSet === "function" ? new WeakSet() : null;

  function hashToken() {
    var raw = "";
    try { raw = String(location.hash || ""); } catch (err) { return ""; }
    if (raw.charAt(0) === "#") raw = raw.slice(1);
    if (!raw) return "";
    try { raw = decodeURIComponent(raw.replace(/\+/g, "%2B")); } catch (err) {}
    if (!raw || !String(raw).replace(/\s+/g, "")) return "";
    return raw;
  }

  function inviteToken() {
    if (activeToken) return activeToken;
    return hashToken();
  }

  function urlSafeId(length) {
    if (!window.crypto || typeof window.crypto.getRandomValues !== "function") return "";
    var alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    var size = length || 24;
    var bytes = new Uint8Array(size);
    var i;
    try { window.crypto.getRandomValues(bytes); } catch (err) { return ""; }
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
    if (!created || !ID_OK.test(created) || created === token) created = urlSafeId(32);
    if (!created || !ID_OK.test(created) || created === token) return "";
    memoryDevice = created;
    try { sessionStorage.setItem(DEVICE_KEY, created); } catch (err) {}
    return created;
  }

  function joinNonce() {
    var token = inviteToken();
    var nonce = urlSafeId(24);
    if (!nonce || nonce === token || !ID_OK.test(nonce)) nonce = urlSafeId(32);
    if (!nonce || nonce === token || !ID_OK.test(nonce)) return "";
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

  function clearCodeField() {
    if (codeInput) codeInput.value = "";
  }

  function showCodeStep() {
    clearCodeField();
    if (enterForm) enterForm.hidden = false;
    if (offerEl) offerEl.hidden = true;
    if (roleEl) roleEl.hidden = true;
    if (statusEl) {
      statusEl.hidden = true;
      statusEl.textContent = "";
    }
    if (stage) stage.hidden = true;
    if (muteBtn) muteBtn.hidden = true;
    if (leaveBtn) leaveBtn.hidden = true;
    if (codeInput) {
      try { codeInput.focus(); } catch (err) {}
    }
  }

  function showSession() {
    clearCodeField();
    if (enterForm) enterForm.hidden = true;
    if (offerEl) offerEl.hidden = false;
    if (roleEl) roleEl.hidden = false;
    if (statusEl) statusEl.hidden = false;
  }

  function offerCodeAgain() {
    if (hashToken()) return;
    activeToken = "";
    clearCodeField();
    if (offerEl) offerEl.hidden = true;
    if (roleEl) roleEl.hidden = true;
    if (enterForm) enterForm.hidden = false;
    if (codeInput) {
      try { codeInput.focus(); } catch (err) {}
    }
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

  function loopbackHost(hostname) {
    var host = String(hostname || "").toLowerCase();
    if (host.charAt(0) === "[" && host.charAt(host.length - 1) === "]") host = host.slice(1, -1);
    if (host.length && host.charAt(host.length - 1) === ".") host = host.slice(0, -1);
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  }

  function localDevPage() {
    var protocol = "";
    var host = "";
    try {
      protocol = String(location.protocol || "");
      host = String(location.hostname || "");
    } catch (err) {
      return false;
    }
    return protocol === "http:" && loopbackHost(host);
  }

  function signalUrl(value) {
    var raw = String(value || "").trim();
    if (!raw || /\s/.test(raw)) return "";
    var parsed;
    try { parsed = new URL(raw); } catch (err) { return ""; }
    if (parsed.username || parsed.password) return "";
    var scheme = String(parsed.protocol || "").toLowerCase();
    var secure = scheme === "https:" || scheme === "wss:";
    var plain = scheme === "http:" || scheme === "ws:";
    if (!secure && !plain) return "";
    if (plain && (!localDevPage() || !loopbackHost(parsed.hostname))) return "";
    if (scheme === "https:") parsed.protocol = "wss:";
    else if (scheme === "http:") parsed.protocol = "ws:";
    var out = parsed.href;
    if (/\s/.test(out)) return "";
    if (secure && !/^wss:\/\//i.test(out)) return "";
    if (plain && !/^ws:\/\//i.test(out)) return "";
    return out;
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
    return id.indexOf("scr_") === 0 || id.indexOf("prs_") === 0;
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
    var kind = String(track.kind || "");
    if (kind === "video" && !isScreenDevice(participant)) return;
    if (!markAttached(track)) return;
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
    if (screenVideos) screenVideos.appendChild(video);
    if (screenEmpty) screenEmpty.hidden = true;
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
    function live() { return room === next && !left; }
    next.on(ev.TrackSubscribed || "trackSubscribed", function (track, publication, participant) {
      if (!live()) return;
      onSubscribed(track, publication, participant);
    });
    next.on(ev.TrackUnsubscribed || "trackUnsubscribed", function (track) {
      if (!live()) return;
      onUnsubscribed(track);
    });
    next.on(ev.ParticipantConnected || "participantConnected", function (participant) {
      if (!live()) return;
      onParticipant(participant);
    });
    next.on(ev.ParticipantDisconnected || "participantDisconnected", function (participant) {
      if (!live()) return;
      onParticipantGone(participant);
    });
    next.on(ev.Disconnected || "disconnected", function () {
      if (room !== next || left) return;
      onDisconnected();
    });
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
      offerCodeAgain();
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
      if (left || room !== next) {
        try { next.disconnect(); } catch (err) {}
        return;
      }
      if (stage) stage.hidden = false;
      showLeave();
      ensurePerson(next.localParticipant);
      pullExisting(next);
      say("In the call.");
      return next.localParticipant.setMicrophoneEnabled(true).then(function () {
        if (left || room !== next) return;
        micOn = true;
        paintMute();
      }, function () {
        if (left || room !== next) return;
        micOn = false;
        paintMute();
        say("In the call. The microphone is off.");
      });
    }, function () {
      if (left || room !== next) return;
      if (room === next) room = null;
      joined = false;
      say("The call could not be joined.");
      showLeave();
      offerCodeAgain();
    });
  }

  function attempt() {
    if (left || joined || !joinUrl) return;
    var code = inviteToken();
    if (!code) {
      showCodeStep();
      return;
    }
    var gen = ++generation;
    var device = deviceId();
    var nonce = joinNonce();
    if (!device || !nonce) {
      say("The call could not be joined.");
      showLeave();
      offerCodeAgain();
      return;
    }
    fetch(joinUrl, {
      method: "POST",
      headers: { "content-type": "application/json", "accept": "application/json" },
      body: JSON.stringify({ code: code, device: device, join_nonce: nonce }),
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
          offerCodeAgain();
          return;
        }
        if (res.status === 403) {
          say("This invite is not valid.");
          showLeave();
          offerCodeAgain();
          return;
        }
        if (res.status === 429) {
          say("Too many invalid codes. Wait ten minutes.");
          showLeave();
          offerCodeAgain();
          return;
        }
        if (res.status === 503) {
          say("The call could not be reached.");
          showLeave();
          offerCodeAgain();
          return;
        }
        if (!res.ok) {
          say("The call could not be joined.");
          showLeave();
          offerCodeAgain();
          return;
        }
        var data = null;
        try { data = JSON.parse(text); } catch (err) { data = null; }
        if (data && typeof data.role === "string" && data.role.trim() === "presenter") {
          say("This page is for guests. A presenter cannot join here.");
          showLeave();
          offerCodeAgain();
          return;
        }
        var media = mediaParts(data);
        if (!media) {
          say("The call could not be joined.");
          showLeave();
          offerCodeAgain();
          return;
        }
        return connect(media);
      });
    }).catch(function () {
      if (left || gen !== generation) return;
      say("The call could not be reached.");
      showLeave();
      offerCodeAgain();
    });
  }

  function onMute() {
    unlockAudio();
    if (!room || !joined || !room.localParticipant) return;
    var next = !micOn;
    var current = room;
    room.localParticipant.setMicrophoneEnabled(next).then(function () {
      if (left || room !== current) return;
      micOn = next;
      paintMute();
      if (joined) say("In the call.");
    }, function () {
      if (left || room !== current) return;
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
    activeToken = "";
    try { history.replaceState(null, "", location.pathname + location.search); } catch (err) {}
    showCodeStep();
    say("Left the call.");
  }

  function loadConfig() {
    return fetch("/data/guest-join.json", { cache: "no-store", credentials: "omit" }).then(function (res) {
      if (!res.ok) throw new Error("config");
      return res.json();
    }).then(function (data) {
      var raw = data && typeof data.serviceUrl === "string" ? data.serviceUrl.trim() : "";
      var parsed;
      try { parsed = new URL(raw); } catch (err) { throw new Error("config"); }
      if (parsed.protocol !== "https:") throw new Error("config");
      if (parsed.username || parsed.password) throw new Error("config");
      if (parsed.search || parsed.hash) throw new Error("config");
      if (parsed.pathname !== "/" && parsed.pathname !== "") throw new Error("config");
      return parsed.origin + JOIN_PATH;
    });
  }

  function startJoin() {
    showSession();
    say("Checking the invite.");
    if (!joinUrl) {
      var gen = ++generation;
      loadConfig().then(function (url) {
        if (left || gen !== generation) return;
        joinUrl = url;
        attempt();
      }, function () {
        if (left || gen !== generation) return;
        say("The call could not be reached.");
        showLeave();
        offerCodeAgain();
      });
      return;
    }
    attempt();
  }

  function onEnter(event) {
    unlockAudio();
    if (event && event.preventDefault) event.preventDefault();
    if (joined) return;
    var typed = codeInput ? String(codeInput.value || "") : "";
    if (!typed.trim()) return;
    left = false;
    joined = false;
    micOn = false;
    clearRetry();
    clearStage();
    if (muteBtn) muteBtn.hidden = true;
    if (leaveBtn) leaveBtn.hidden = true;
    activeToken = typed;
    startJoin();
  }

  function followHash() {
    var fromHash = hashToken();
    if (!fromHash || joined || fromHash === activeToken) return;
    left = false;
    micOn = false;
    clearRetry();
    clearStage();
    if (muteBtn) muteBtn.hidden = true;
    if (leaveBtn) leaveBtn.hidden = true;
    activeToken = fromHash;
    startJoin();
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
    offerEl = document.getElementById("guest-offer");
    roleEl = document.getElementById("guest-role");
    enterForm = document.getElementById("guest-enter");
    codeInput = document.getElementById("guest-code");
    if (!statusEl || !stage || !muteBtn || !leaveBtn || !enterForm || !codeInput) return;
    silenceMediaLogs();
    muteBtn.addEventListener("click", onMute);
    leaveBtn.addEventListener("click", leave);
    enterForm.addEventListener("submit", onEnter);
    window.addEventListener("hashchange", followHash);
    document.addEventListener("click", unlockAudio);
    var fromHash = hashToken();
    if (!fromHash) {
      activeToken = "";
      showCodeStep();
      return;
    }
    activeToken = fromHash;
    startJoin();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
