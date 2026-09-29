/* Duplex room for /conference. Tokens come from the gate. This file does not
   mint them and does not hold a speech-vendor key. */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.conferenceRoom = api;
  if (typeof document !== "undefined") {
    var start = function () { api.mount(document); };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
    else start();
  }
})(typeof window !== "undefined" ? window : globalThis, function (root) {
  "use strict";

  var bridge = {};
  var IDLE_MS = 5 * 60 * 1000;
  var FILLER_MS = 700;
  var TOKEN_TTL_MAX = 15 * 60;
  var SAMPLE_RATE = 48000;
  var VAD_RMS = 0.02;
  var LIVEKIT_SRC = "https://cdn.jsdelivr.net/npm/livekit-client@2.15.4/dist/livekit-client.esm.mjs";
  var AGENT_STATES = {listening: 1, thinking: 1, speaking: 1};
  var SVG_TAGS = {svg: 1, g: 1, path: 1, rect: 1, circle: 1, line: 1, polyline: 1, polygon: 1, text: 1, title: 1, desc: 1, tspan: 1};

  function audioConstraints() {
    return {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
      sampleRate: SAMPLE_RATE,
      sampleSize: 16
    };
  }

  function idleDue(last, now) {
    return (Number(now) - Number(last)) >= IDLE_MS;
  }

  function fillerDue(since, now) {
    if (!since) return false;
    return (Number(now) - Number(since)) > FILLER_MS;
  }

  function lossRatio(lost, received) {
    lost = Number(lost);
    received = Number(received);
    if (!(lost >= 0) || !(received >= 0)) return null;
    var total = lost + received;
    if (!(total > 0)) return null;
    return lost / total;
  }

  function lossHigh(ratio) {
    return ratio != null && ratio > 0.02;
  }

  function dropQueue(queue) {
    if (queue && queue.length) queue.length = 0;
    return [];
  }

  function nextCard(current, event) {
    if (event === "heard") return "heard";
    if (event === "room") return "room-open";
    if (event === "agent") return "agent-in-room";
    if (event === "idle" || event === "disconnect") return "idle";
    return current || "idle";
  }

  function createFloor() {
    var holder = "open";
    var agentState = "listening";
    return {
      holder: function () { return holder; },
      agentState: function () { return agentState; },
      apply: function (state) {
        if (!AGENT_STATES[state]) return false;
        agentState = state;
        if (state === "speaking") holder = "agent";
        else if (holder === "agent") holder = "open";
        return true;
      },
      userTalk: function () {
        if (holder === "agent" || agentState === "speaking") {
          holder = "you";
          agentState = "listening";
          return "barge-in";
        }
        holder = "you";
        return "you";
      },
      userStop: function () {
        if (holder === "you") holder = "open";
      },
      canPublish: function () {
        return holder !== "agent";
      }
    };
  }

  function vadOpen(rms, threshold) {
    return Number(rms) >= (threshold == null ? VAD_RMS : threshold);
  }

  function sanitizeSvg(raw) {
    var s = String(raw || "").trim();
    if (!s || s.length > 20000) return "";
    if (!/^<svg[\s>]/i.test(s)) return "";
    if (/<\s*script|foreignObject|<\s*iframe|<\s*embed|<\s*object|javascript\s*:|on[a-z]+\s*=/i.test(s)) return "";
    var tags = s.match(/<\/?\s*([a-zA-Z0-9]+)/g) || [];
    for (var i = 0; i < tags.length; i++) {
      var name = tags[i].replace(/<\/?\s*/, "").toLowerCase();
      if (!SVG_TAGS[name]) return "";
    }
    return s;
  }

  function sanitizeMermaid(raw) {
    var s = String(raw || "").replace(/<[^>]*>/g, "").trim();
    if (!s || s.length > 4000) return "";
    if (!/^(flowchart|graph|stateDiagram|stateDiagram-v2|sequenceDiagram)\b/.test(s)) return "";
    if (/javascript\s*:|<\s*script/i.test(s)) return "";
    return s;
  }

  function escapeXml(raw) {
    return String(raw == null ? "" : raw).replace(/[&<>"]/g, function (ch) {
      return {"&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;"}[ch];
    });
  }

  function renderStateDiagram(raw) {
    var clean = sanitizeMermaid(raw);
    if (!clean || clean.indexOf("stateDiagram") !== 0) return "";
    var lines = clean.split(/\n+/);
    var edges = [];
    for (var i = 0; i < lines.length; i++) {
      var parts = lines[i].split("-->");
      if (parts.length !== 2) continue;
      var from = parts[0].replace(/[^\w-]/g, "").slice(0, 24);
      var to = parts[1].replace(/[^\w-]/g, "").slice(0, 24);
      if (from && to) edges.push([from, to]);
    }
    if (!edges.length) return "";
    var y = 28;
    var out = ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 ' + (edges.length * 36 + 16) + '" role="img">'];
    out.push("<title>Room flow</title>");
    for (var e = 0; e < edges.length; e++) {
      out.push('<text x="8" y="' + y + '" font-size="14" fill="#191919">' + escapeXml(edges[e][0] + " → " + edges[e][1]) + "</text>");
      y += 36;
    }
    out.push("</svg>");
    return out.join("");
  }

  function penpotSrc(raw) {
    try {
      var url = new URL(String(raw || ""));
      if (url.protocol !== "https:" || url.hostname !== "design.penpot.app") return "";
      if (url.username || url.password) return "";
      return url.origin + url.pathname + url.search;
    } catch (e) {
      return "";
    }
  }

  function decodePayload(token) {
    var parts = String(token || "").split(".");
    if (parts.length !== 3) return null;
    try {
      var b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
      var pad = b64.length % 4 === 0 ? "" : "====".slice(b64.length % 4);
      var json = JSON.parse(root.atob(b64 + pad));
      return json && typeof json === "object" ? json : null;
    } catch (e) {
      return null;
    }
  }

  function tokenOk(token, now) {
    var text = String(token || "");
    if (text.length < 20 || text.length > 4096 || text.indexOf("eyJ") !== 0) return false;
    var payload = decodePayload(text);
    if (!payload || !payload.exp) return false;
    var nowSec = Math.floor((now == null ? Date.now() : now) / 1000);
    if (payload.exp <= nowSec) return false;
    if (payload.exp - nowSec > TOKEN_TTL_MAX) return false;
    if (payload.iat && payload.exp - payload.iat > TOKEN_TTL_MAX) return false;
    if (payload.nbf && payload.exp - payload.nbf > TOKEN_TTL_MAX) return false;
    return true;
  }

  function livekitUrlOk(raw) {
    try {
      var url = new URL(String(raw || ""));
      if (url.protocol !== "wss:" || url.username || url.password) return false;
      if (url.searchParams.has("token") || url.searchParams.has("access_token")) return false;
      return true;
    } catch (e) {
      return false;
    }
  }

  function speechText(raw) {
    return String(raw == null ? "" : raw).replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim().slice(0, 240);
  }

  function loadClient() {
    if (root.LivekitClient && typeof root.LivekitClient.Room === "function") {
      return Promise.resolve(root.LivekitClient);
    }
    if (typeof root.importLivekit === "function") return root.importLivekit();
    try {
      return import(LIVEKIT_SRC).catch(function () { return null; });
    } catch (e) {
      return Promise.resolve(null);
    }
  }

  function mount(doc) {
    if (!doc || typeof doc.getElementById !== "function") return;
    var modal = doc.getElementById("consent-modal");
    var allow = doc.getElementById("consent-allow");
    var deny = doc.getElementById("consent-deny");
    var floor = createFloor();
    var consented = false;
    var pendingConsent = null;
    var muted = false;
    var userLeft = false;
    var reconnects = 0;
    var connected = false;
    var lastActive = Date.now();
    var thinkingSince = 0;
    var fillerSent = false;
    var userStopAt = 0;
    var localStream = null;
    var roomRef = null;
    var roomUrl = "";
    var roomToken = "";
    var pending = [];
    var raf = 0;
    var audioCtx = null;

    function poke() { lastActive = Date.now(); }

    function setRoomStatus(text) {
      var el = doc.getElementById("room-status");
      if (el) el.textContent = text;
    }

    function setCard(name) {
      var cards = doc.querySelectorAll("#room-states [data-state]");
      for (var i = 0; i < cards.length; i++) {
        var on = cards[i].getAttribute("data-state") === name;
        if (on) cards[i].setAttribute("aria-current", "true");
        else cards[i].removeAttribute("aria-current");
      }
      var box = doc.getElementById("room-states");
      if (box) box.setAttribute("data-current", name);
    }

    function floorLine() {
      var el = doc.getElementById("floor-lock");
      if (!el) return;
      var who = floor.holder();
      if (who === "agent") el.textContent = "One floor. Agent speaking.";
      else if (who === "you") el.textContent = "One floor. You have it.";
      else el.textContent = "One floor. Open.";
      var voices = doc.querySelectorAll(".voices li");
      for (var i = 0; i < voices.length; i++) {
        voices[i].removeAttribute("data-hold");
      }
    }

    function saySpeech(text) {
      var el = doc.getElementById("agent-speech");
      if (el) el.textContent = text;
    }

    function reduced() {
      return root.matchMedia && root.matchMedia("(prefers-reduced-motion: reduce)").matches;
    }

    function finishConsent(ok) {
      if (modal) modal.hidden = true;
      var next = pendingConsent;
      pendingConsent = null;
      if (ok) consented = true;
      if (next) next(!!ok);
    }

    function requestConsent(next) {
      if (consented) { next(true); return; }
      if (!modal || !allow || !deny) { next(false); return; }
      pendingConsent = next;
      modal.hidden = false;
      try { allow.focus(); } catch (e) {}
    }

    if (allow) allow.addEventListener("click", function () { finishConsent(true); });
    if (deny) deny.addEventListener("click", function () { finishConsent(false); });

    function stopStream() {
      if (raf && root.cancelAnimationFrame) root.cancelAnimationFrame(raf);
      raf = 0;
      if (audioCtx && audioCtx.close) {
        try { audioCtx.close(); } catch (e) {}
      }
      audioCtx = null;
      if (localStream && localStream.getTracks) {
        var tracks = localStream.getTracks();
        for (var i = 0; i < tracks.length; i++) {
          try { tracks[i].stop(); } catch (e2) {}
        }
      }
      localStream = null;
    }

    function beaconExit() {
      var join = root.conferenceJoin;
      if (!join || typeof join.deliverBeacon !== "function" || typeof join.beaconPayload !== "function") return;
      try {
        join.deliverBeacon(join.beaconPayload("room", {
          phase: "exit",
          room: "absent",
          ice: {state: "closed", pairs: 0},
          tracks: {audio: 0, video: 0},
          consent: consented ? "on" : "off"
        }));
      } catch (e) {}
    }

    function disconnect(why) {
      userLeft = true;
      connected = false;
      dropQueue(pending);
      var room = roomRef;
      roomRef = null;
      if (room && room.disconnect) {
        try { room.disconnect(); } catch (e) {}
      }
      stopStream();
      floor.apply("listening");
      floorLine();
      setCard("idle");
      if (why === "idle") setRoomStatus("Disconnected after 5 minutes idle. No room is allocated.");
      else setRoomStatus("Disconnected. No room is allocated.");
      beaconExit();
    }

    function publishGate(track) {
      if (!track) return;
      var open = !muted && floor.canPublish();
      track.enabled = !!open;
    }

    function onRms(rms) {
      var you = doc.getElementById("you-level");
      if (you && !reduced()) {
        var w = 8 + Math.max(0, Math.min(1, rms * 8)) * 112;
        you.setAttribute("width", String(Math.round(w)));
      }
      var cue = doc.getElementById("duplex-cue");
      var speaking = vadOpen(rms);
      if (speaking) {
        poke();
        userStopAt = 0;
        if (floor.agentState() === "speaking" || floor.holder() === "agent") {
          var took = floor.userTalk();
          if (took === "barge-in") {
            var audios = doc.querySelectorAll("audio");
            for (var a = 0; a < audios.length; a++) {
              try { audios[a].pause(); } catch (e) {}
            }
            pending.push({type: "barge-in"});
            var room = roomRef;
            if (room && room.localParticipant && room.localParticipant.publishData) {
              var bytes = new TextEncoder().encode('{"type":"barge-in"}');
              try { room.localParticipant.publishData(bytes, {reliable: true, topic: "floor"}); } catch (e2) {}
            }
            dropQueue(pending);
            saySpeech("Floor is yours.");
            if (cue) cue.textContent = "You took the floor.";
          }
        } else {
          floor.userTalk();
          if (cue) cue.textContent = "You are speaking.";
        }
        floorLine();
      } else if (floor.holder() === "you") {
        if (!userStopAt) userStopAt = Date.now();
        if (Date.now() - userStopAt > 400) {
          floor.userStop();
          floorLine();
          if (cue && floor.agentState() !== "speaking") cue.textContent = "Floor is open.";
        }
      }
      var tracks = localStream && localStream.getAudioTracks ? localStream.getAudioTracks() : [];
      if (tracks[0]) publishGate(tracks[0]);
    }

    function startLevels(stream) {
      var AC = root.AudioContext || root.webkitAudioContext;
      if (!AC || reduced() || !root.requestAnimationFrame) return;
      try {
        audioCtx = new AC();
        var source = audioCtx.createMediaStreamSource(stream);
        var analyser = audioCtx.createAnalyser();
        analyser.fftSize = 512;
        source.connect(analyser);
        var data = new Uint8Array(analyser.fftSize);
        var tick = function () {
          analyser.getByteTimeDomainData(data);
          var sum = 0;
          for (var i = 0; i < data.length; i++) {
            var v = (data[i] - 128) / 128;
            sum += v * v;
          }
          onRms(Math.sqrt(sum / data.length));
          raf = root.requestAnimationFrame(tick);
        };
        raf = root.requestAnimationFrame(tick);
      } catch (e) {}
    }

    function playFiller() {
      if (fillerSent || reduced()) {
        saySpeech("One moment.");
        fillerSent = true;
        return;
      }
      fillerSent = true;
      saySpeech("One moment.");
      var AC = root.AudioContext || root.webkitAudioContext;
      if (!AC) return;
      try {
        var ctx = new AC();
        var osc = ctx.createOscillator();
        var gain = ctx.createGain();
        osc.frequency.value = 440;
        gain.gain.value = 0.03;
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + 0.12);
        osc.onended = function () { try { ctx.close(); } catch (e) {} };
      } catch (e2) {}
    }

    function showVisual(svg) {
      var clean = sanitizeSvg(svg);
      var slot = doc.getElementById("visual-slot");
      if (!slot || !clean) return;
      var frame = doc.createElement("iframe");
      frame.setAttribute("sandbox", "");
      frame.setAttribute("title", "Room diagram");
      frame.style.width = "100%";
      frame.style.height = "8rem";
      frame.style.border = "0";
      frame.srcdoc = "<!DOCTYPE html><html><body style=\"margin:0\">" + clean + "</body></html>";
      slot.textContent = "";
      slot.appendChild(frame);
    }

    function showPenpot(raw) {
      var src = penpotSrc(raw);
      var slot = doc.getElementById("penpot-slot");
      if (!slot || !src) return;
      var frame = doc.createElement("iframe");
      frame.setAttribute("sandbox", "allow-scripts");
      frame.setAttribute("title", "PenPot prototype");
      frame.setAttribute("referrerpolicy", "no-referrer");
      frame.style.width = "100%";
      frame.style.height = "12rem";
      frame.style.border = "0";
      frame.src = src;
      slot.textContent = "";
      slot.appendChild(frame);
    }

    function onData(payload) {
      poke();
      var text = "";
      try {
        if (typeof payload === "string") text = payload;
        else text = new TextDecoder().decode(payload);
      } catch (e) { return; }
      var msg;
      try { msg = JSON.parse(text); } catch (e2) { return; }
      if (!msg || typeof msg !== "object") return;
      if (msg.state && floor.apply(msg.state)) {
        floorLine();
        setCard("agent-in-room");
        var cue = doc.getElementById("duplex-cue");
        if (msg.state === "speaking") {
          thinkingSince = 0;
          if (cue) cue.textContent = "Agent is speaking.";
          var agent = doc.getElementById("agent-level");
          if (agent) agent.setAttribute("width", "96");
          if (userStopAt) {
            var late = doc.getElementById("latency");
            var ms = Date.now() - userStopAt;
            if (late) late.textContent = "Last turn " + ms + " ms." + (ms > 800 ? " Past the 800 ms target." : " Inside the 800 ms target.");
          }
        } else if (msg.state === "thinking") {
          thinkingSince = Date.now();
          fillerSent = false;
          if (cue) cue.textContent = "Agent is thinking.";
          root.setTimeout(function () {
            if (fillerDue(thinkingSince, Date.now()) && floor.agentState() === "thinking") playFiller();
          }, FILLER_MS + 20);
        } else if (cue) {
          cue.textContent = "Agent is listening.";
        }
        if (msg.text) saySpeech(speechText(msg.text));
      }
      if (msg.type === "cutoff") {
        var cut = doc.getElementById("cutoff");
        if (cut) cut.hidden = false;
      }
      if (msg.mermaid) {
        var drawn = renderStateDiagram(msg.mermaid);
        if (drawn) showVisual(drawn);
      }
      if (msg.svg) showVisual(msg.svg);
      if (msg.penpot) showPenpot(msg.penpot);
    }

    function bindRoom(lk, room) {
      function listen(name, fn) {
        var ev = lk.RoomEvent && lk.RoomEvent[name];
        var fallback = name.charAt(0).toLowerCase() + name.slice(1);
        try { room.on(ev || fallback, fn); } catch (e) {}
      }
      listen("DataReceived", onData);
      listen("ParticipantConnected", function () {
        poke();
        setCard("agent-in-room");
        setRoomStatus("Agent in the room. One floor.");
      });
      listen("Reconnecting", function () { dropQueue(pending); });
      listen("Reconnected", function () { dropQueue(pending); });
      listen("Disconnected", function () {
        if (userLeft) return;
        dropQueue(pending);
        if (reconnects < 1 && tokenOk(roomToken)) {
          reconnects += 1;
          room.connect(roomUrl, roomToken).catch(function () {
            connected = false;
            setCard("idle");
            setRoomStatus("The room disconnected. Stale audio was dropped.");
          });
          return;
        }
        connected = false;
        setCard("idle");
        setRoomStatus("The room disconnected. Stale audio was dropped.");
      });
    }

    function connect(url, token) {
      if (!tokenOk(token) || !livekitUrlOk(url)) {
        setRoomStatus("The room token was refused. No room was allocated.");
        setCard("heard");
        return Promise.resolve(false);
      }
      roomUrl = url;
      roomToken = token;
      userLeft = false;
      var devices = root.navigator && root.navigator.mediaDevices;
      if (!devices || typeof devices.getUserMedia !== "function") {
        setRoomStatus("This browser has no microphone. No room was allocated.");
        return Promise.resolve(false);
      }
      return devices.getUserMedia({audio: audioConstraints(), video: false}).then(function (stream) {
        localStream = stream;
        startLevels(stream);
        return loadClient();
      }).then(function (lk) {
        if (!lk || typeof lk.Room !== "function") {
          stopStream();
          setRoomStatus("LiveKit client did not load. No room was allocated.");
          setCard("heard");
          return false;
        }
        var room = new lk.Room();
        roomRef = room;
        bindRoom(lk, room);
        return room.connect(url, token).then(function () {
          connected = true;
          reconnects = 0;
          setCard("room-open");
          setRoomStatus("Room open. One floor. Opus at 48 kHz requested.");
          var track = localStream.getAudioTracks()[0];
          publishGate(track);
          if (room.localParticipant && track && room.localParticipant.publishTrack) {
            return room.localParticipant.publishTrack(track, {dtx: true, red: true}).then(function () { return true; });
          }
          if (room.localParticipant && room.localParticipant.setMicrophoneEnabled) {
            return room.localParticipant.setMicrophoneEnabled(true, audioConstraints(), {dtx: true, red: true}).then(function () { return true; });
          }
          return true;
        });
      }).catch(function () {
        stopStream();
        connected = false;
        setCard("heard");
        setRoomStatus("The room did not open. No room is allocated.");
        return false;
      });
    }

    function admit(result) {
      poke();
      if (!result || result.ok !== true) {
        setRoomStatus("That code was not accepted.");
        return;
      }
      var shown = String(result.name || "").replace(/[<>]/g, " ").replace(/\s+/g, " ").trim();
      var role = shown && shown.length <= 80 ? shown : (result.role === "host" ? "Host" : "Guest");
      if (result.room_token && tokenOk(result.room_token) && livekitUrlOk(result.url)) {
        setRoomStatus(role + " admitted. Opening the room after the microphone is allowed.");
        requestConsent(function (ok) {
          if (!ok) {
            setCard("heard");
            setRoomStatus(role + " admitted. Microphone was not allowed. No room was allocated.");
            return;
          }
          connect(result.url, result.room_token);
        });
        return;
      }
      setCard("heard");
      setRoomStatus(role + " admitted. The gate did not issue a room token. No room was allocated.");
    }

    function toggleMute() {
      muted = !muted;
      var button = doc.getElementById("mute");
      if (button) button.setAttribute("aria-pressed", muted ? "true" : "false");
      var tracks = localStream && localStream.getAudioTracks ? localStream.getAudioTracks() : [];
      if (tracks[0]) publishGate(tracks[0]);
      var cue = doc.getElementById("duplex-cue");
      if (cue) cue.textContent = muted ? "Muted." : "Floor is open.";
    }

    var mute = doc.getElementById("mute");
    if (mute) mute.addEventListener("click", toggleMute);
    var hang = doc.getElementById("disconnect");
    if (hang) hang.addEventListener("click", function () { disconnect("user"); });

    doc.addEventListener("keydown", function (ev) {
      var target = ev.target;
      var tag = target && target.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || (target && target.isContentEditable)) return;
      if (ev.key === "Escape" && modal && !modal.hidden) {
        ev.preventDefault();
        if (deny) deny.click();
        return;
      }
      if (ev.key === "m" || ev.key === "M") {
        ev.preventDefault();
        toggleMute();
      } else if (ev.key === "Escape") {
        ev.preventDefault();
        disconnect("user");
      }
    });

    doc.addEventListener("conference-feedback", function (ev) {
      poke();
      if (ev && ev.detail === "heard") setCard("heard");
    });

    if (root.setInterval) {
      root.setInterval(function () {
        if (connected && idleDue(lastActive, Date.now())) disconnect("idle");
      }, 5000);
    }

    setCard("idle");
    floorLine();
    bridge.requestConsent = requestConsent;
    bridge.admit = admit;
    bridge.setCard = setCard;
  }

  return {
    IDLE_MS: IDLE_MS,
    FILLER_MS: FILLER_MS,
    SAMPLE_RATE: SAMPLE_RATE,
    audioConstraints: audioConstraints,
    idleDue: idleDue,
    fillerDue: fillerDue,
    lossRatio: lossRatio,
    lossHigh: lossHigh,
    dropQueue: dropQueue,
    nextCard: nextCard,
    createFloor: createFloor,
    vadOpen: vadOpen,
    sanitizeSvg: sanitizeSvg,
    sanitizeMermaid: sanitizeMermaid,
    renderStateDiagram: renderStateDiagram,
    penpotSrc: penpotSrc,
    tokenOk: tokenOk,
    livekitUrlOk: livekitUrlOk,
    speechText: speechText,
    loadClient: loadClient,
    requestConsent: function (next) {
      if (bridge.requestConsent) bridge.requestConsent(next);
      else if (typeof next === "function") next(false);
    },
    admit: function (result) {
      if (bridge.admit) bridge.admit(result);
    },
    setCard: function (name) {
      if (bridge.setCard) bridge.setCard(name);
    },
    mount: mount
  };
});
