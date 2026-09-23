/* Wires the 3-minute panel. Continuous PCM over an authenticated socket.
   No browser speech-recognition API on this path. */
(function () {
  var stt = window.SFDC24Stt;
  if (!stt) return;
  var clockEl = document.getElementById("clock");
  var warnEl = document.getElementById("warn");
  var statusEl = document.getElementById("status");
  var startBtn = document.getElementById("start");
  var transcriptEl = document.getElementById("transcript");
  var partialEl = document.getElementById("partial");
  if (!clockEl || !startBtn) return;

  var clock = stt.createSessionClock();
  var phase = "idle";
  var relay = "";
  var token = "";
  var ws = null;
  var audio = null;
  var media = null;
  var node = null;
  var timer = null;
  var holdTimer = null;
  var capTimer = null;
  var posted = false;
  var committed = "";
  var interim = "";
  var receipt = "";
  var sink = null;
  var generation = 0;
  var sessionAbort = null;
  var startupTimer = null;
  var capSeen = false;
  var recoverTimer = null;
  var recovering = false;

  function value(id) {
    var el = document.getElementById(id);
    return el ? String(el.value || "").trim() : "";
  }

  function renderClock() {
    var snap = clock.snapshot(Date.now());
    clockEl.textContent = snap.label;
    if (snap.warn) {
      warnEl.textContent = "Thirty seconds left.";
      clockEl.classList.add("warn");
    }
    return snap;
  }

  function stopMedia() {
    releaseOwned({ node: node, sink: sink, media: media, audio: audio }, true);
    node = null;
    sink = null;
    media = null;
    audio = null;
  }

  function releaseOwned(owned, current) {
    if (!owned) return;
    var oldNode = owned.node;
    var oldSink = owned.sink;
    var oldMedia = owned.media;
    var oldAudio = owned.audio;
    if (oldNode && (current || oldNode !== node)) {
      try { if (oldNode.port) oldNode.port.onmessage = null; } catch (e0) {}
      try { oldNode.disconnect(); } catch (e1) {}
    }
    if (oldSink && (current || oldSink !== sink)) {
      try { oldSink.disconnect(); } catch (e2) {}
    }
    if (oldMedia && (current || oldMedia !== media)) {
      try { oldMedia.getTracks().forEach(function (track) { track.stop(); }); } catch (e3) {}
    }
    if (oldAudio && (current || oldAudio !== audio)) {
      try { if (oldAudio.close) oldAudio.close(); } catch (e4) {}
    }
  }

  function clearSpokenDraft() {
    committed = "";
    interim = "";
    receipt = "";
    token = "";
    if (transcriptEl) transcriptEl.textContent = "";
    if (partialEl) partialEl.textContent = "";
  }

  function closeSocket() {
    if (!ws) return;
    var socket = ws;
    ws = null;
    try { socket.onmessage = null; socket.onerror = null; socket.onclose = null; socket.close(); } catch (e) {}
  }

  function renderIdle() {
    clearSessionTimers();
    if (timer) { clearInterval(timer); timer = null; }
    if (holdTimer) { holdTimer = null; }
    clock.reset();
    clockEl.textContent = clock.snapshot(Date.now()).label;
    clockEl.classList.remove("warn");
    if (warnEl) warnEl.textContent = "";
    committed = "";
    interim = "";
    receipt = "";
    if (transcriptEl) transcriptEl.textContent = "";
    if (partialEl) partialEl.textContent = "";
    token = "";
    phase = "idle";
    posted = false;
    recovering = false;
    startBtn.disabled = false;
    startBtn.textContent = "Start";
  }

  function applyLeadStatus(gen, outcome) {
    if (gen !== generation) return;
    statusEl.textContent = stt.leadStatus(outcome);
  }

  function postLead() {
    var gen = generation;
    if (gen !== generation || posted || !token || !relay) return;
    posted = true;
    var savedToken = token;
    var savedReceipt = receipt;
    leadRequest(savedToken, savedReceipt).then(function (parsed) {
      applyLeadStatus(gen, stt.interpretLeadResponse(parsed.ok, parsed.body));
    }).catch(function () {
      applyLeadStatus(gen, "failed");
    });
  }

  function submitWhenRetained(gen, attempt) {
    if (gen !== generation || phase === "idle") return;
    if (posted || !token || !relay) return;
    posted = true;
    var savedToken = token;
    var savedReceipt = receipt;
    leadRequest(savedToken, savedReceipt).then(function (parsed) {
      if (gen !== generation) return;
      var body = parsed.body;
      var notRetained = !!(body && body.error === "session_not_retained");
      if (notRetained && attempt === 0 && !savedReceipt) {
        posted = false;
        if (recoverTimer) clearTimeout(recoverTimer);
        recoverTimer = setTimeout(function () {
          recoverTimer = null;
          if (gen !== generation) return;
          submitWhenRetained(gen, 1);
        }, stt.RECOVER_RETRY_MS);
        return;
      }
      recovering = false;
      applyLeadStatus(gen, stt.interpretLeadResponse(parsed.ok, parsed.body));
      armReset(gen);
    }).catch(function () {
      if (gen !== generation) return;
      recovering = false;
      applyLeadStatus(gen, "failed");
      armReset(gen);
    });
  }

  function clearSessionTimers() {
    if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
    if (capTimer) { clearTimeout(capTimer); capTimer = null; }
    if (recoverTimer) { clearTimeout(recoverTimer); recoverTimer = null; }
  }

  function leadRequest(savedToken, savedReceipt) {
    return fetch(relay + "/v1/leads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: savedToken,
        receipt: savedReceipt,
        visitor: {
          name: value("name"),
          company: value("company"),
          email: value("email"),
          phone: value("phone"),
        },
        need: value("need"),
      }),
    }).then(function (res) {
      return res.json().then(function (body) {
        return { ok: res.ok, body: body };
      }, function () {
        return { ok: false, body: null };
      });
    });
  }

  function armReset(gen) {
    if (holdTimer || gen !== generation) return;
    holdTimer = setTimeout(function () {
      holdTimer = null;
      if (gen !== generation) return;
      stopMedia();
      closeSocket();
      renderIdle();
    }, stt.RESET_HOLD_MS);
  }

  function postAndReset(gen) {
    if (gen !== generation) return;
    postLead();
    armReset(gen);
  }

  function sendFrame(data, gen, socket) {
    if (gen !== generation) return;
    if (!data || typeof data === "string") return;
    if (data && data.type) return;
    if (!socket || socket !== ws || socket.readyState !== 1) return;
    if (phase !== "live" && phase !== "ending") return;
    if (socket.bufferedAmount > 262144) return;
    socket.send(data);
  }

  function flushCapture(done) {
    var gen = generation;
    var socket = ws;
    var capture = node;
    if (!capture || !capture.port || !capture.port.postMessage) {
      done();
      return;
    }
    var finished = false;
    function complete() {
      if (finished) return;
      finished = true;
      if (flushTimer) clearTimeout(flushTimer);
      done();
    }
    var flushTimer = setTimeout(complete, stt.FLUSH_MS);
    capture.port.onmessage = function (ev) {
      if (gen !== generation || socket !== ws) return;
      var data = ev.data;
      if (data && data.type === "flushed") {
        complete();
        return;
      }
      sendFrame(data, gen, socket);
    };
    try { capture.port.postMessage({ type: "flush" }); }
    catch (e) { complete(); }
  }

  function finish(fromServer) {
    var gen = generation;
    if (phase !== "live") {
      if (phase === "ending" && fromServer && gen === generation) {
        capSeen = true;
        if (capTimer) { clearTimeout(capTimer); capTimer = null; }
        if (recoverTimer) { clearTimeout(recoverTimer); recoverTimer = null; }
        if (posted) return;
        recovering = false;
        startBtn.textContent = "Stop";
        postAndReset(gen);
      }
      return;
    }
    phase = "ending";
    if (timer) { clearInterval(timer); timer = null; }
    clockEl.textContent = "0:00";
    clockEl.classList.remove("warn");
    if (warnEl) warnEl.textContent = "";
    statusEl.textContent = "Thank you. That is enough for a call back.";
    flushCapture(function () {
      if (gen !== generation || phase === "idle") return;
      stopMedia();
      if (!fromServer && !capSeen && ws && ws.readyState === 1) {
        try { ws.send(JSON.stringify({ type: "stop" })); } catch (e) {}
        if (capTimer) clearTimeout(capTimer);
        capTimer = setTimeout(function () {
          if (gen !== generation || capSeen) return;
          postAndReset(gen);
        }, 2500);
        return;
      }
      postAndReset(gen);
    });
  }

  function recoverTransport() {
    var gen = generation;
    if (phase !== "live" || capSeen) return;
    phase = "ending";
    recovering = true;
    if (timer) { clearInterval(timer); timer = null; }
    clockEl.textContent = "0:00";
    clockEl.classList.remove("warn");
    if (warnEl) warnEl.textContent = "";
    statusEl.textContent = "Thank you. That is enough for a call back.";
    startBtn.disabled = false;
    startBtn.textContent = "Start";
    var owned = { node: node, sink: sink, media: media, audio: audio };
    flushCapture(function () {
      if (gen !== generation) {
        releaseOwned(owned, false);
        return;
      }
      if (phase === "idle") return;
      stopMedia();
      if (capSeen) {
        if (posted) return;
        recovering = false;
        startBtn.textContent = "Stop";
        postAndReset(gen);
        return;
      }
      if (recoverTimer) clearTimeout(recoverTimer);
      recoverTimer = setTimeout(function () {
        recoverTimer = null;
        if (gen !== generation || phase === "idle") return;
        if (capSeen) {
          if (posted) return;
          recovering = false;
          startBtn.textContent = "Stop";
          postAndReset(gen);
          return;
        }
        submitWhenRetained(gen, 0);
      }, stt.RECOVER_MS);
    });
  }

  function clearStartup() {
    if (startupTimer) { clearTimeout(startupTimer); startupTimer = null; }
    if (sessionAbort) {
      try { sessionAbort.abort(); } catch (e) {}
      sessionAbort = null;
    }
  }

  function stopTracks(stream) {
    if (!stream || !stream.getTracks) return;
    try { stream.getTracks().forEach(function (track) { track.stop(); }); } catch (e) {}
  }

  function abandonConnect(message) {
    generation += 1;
    capSeen = false;
    clearStartup();
    clearSessionTimers();
    stopTracks(media);
    abort(message);
  }

  function abort(message) {
    if (timer) { clearInterval(timer); timer = null; }
    if (capTimer) { clearTimeout(capTimer); capTimer = null; }
    if (recoverTimer) { clearTimeout(recoverTimer); recoverTimer = null; }
    stopMedia();
    closeSocket();
    clock.reset();
    clockEl.textContent = clock.snapshot(Date.now()).label;
    clockEl.classList.remove("warn");
    if (warnEl) warnEl.textContent = "";
    phase = "idle";
    posted = false;
    recovering = false;
    token = "";
    receipt = "";
    startBtn.disabled = false;
    startBtn.textContent = "Start";
    statusEl.textContent = message;
  }

  function showTranscript(text, isFinal) {
    if (isFinal) {
      committed = (committed + " " + text).trim();
      interim = "";
    } else {
      interim = text;
    }
    if (transcriptEl) transcriptEl.textContent = committed;
    if (partialEl) partialEl.textContent = interim;
  }

  function onMessage(ev) {
    var msg;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }
    if (!msg || !msg.type) return;
    if (msg.type === "ready" && phase === "connecting") {
      clearStartup();
      phase = "live";
      clock.start(msg.max_seconds, msg.warn_seconds, Date.now());
      startBtn.disabled = false;
      startBtn.textContent = "Stop";
      statusEl.textContent = "Listening.";
      timer = setInterval(function () {
        var snap = renderClock();
        if (snap.done) finish(false);
      }, 200);
      renderClock();
      return;
    }
    if (msg.type === "transcript") showTranscript(msg.text || "", !!msg.is_final);
    if (msg.type === "warn") {
      if (warnEl) warnEl.textContent = "Thirty seconds left.";
      clockEl.classList.add("warn");
    }
    if (msg.type === "cap") {
      if (msg.receipt) receipt = String(msg.receipt);
      capSeen = true;
      if (capTimer) { clearTimeout(capTimer); capTimer = null; }
      if (recoverTimer) { clearTimeout(recoverTimer); recoverTimer = null; }
      finish(true);
    }
    if (msg.type === "error" && phase !== "ending") {
      abort("The speech relay did not start.");
    }
  }

  function begin() {
    var cfg = window.SFDC24_STT_CONFIG || {};
    relay = String(cfg.relayUrl || "").replace(/\/+$/, "");
    if (!relay) {
      statusEl.textContent = "Streaming relay is not set on this host yet.";
      return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      statusEl.textContent = "This browser did not start the microphone.";
      return;
    }
    var AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) {
      statusEl.textContent = "This browser did not start the microphone.";
      return;
    }
    clearSessionTimers();
    stopMedia();
    generation += 1;
    capSeen = false;
    recovering = false;
    closeSocket();
    clearSpokenDraft();
    var mine = generation;
    phase = "connecting";
    posted = false;
    startBtn.disabled = false;
    startBtn.textContent = "Stop";
    statusEl.textContent = "Connecting.";
    clearStartup();
    sessionAbort = typeof AbortController === "function" ? new AbortController() : null;
    startupTimer = setTimeout(function () {
      if (mine !== generation || phase !== "connecting") return;
      abandonConnect("The speech relay did not start.");
    }, stt.STARTUP_MS);
    audio = new AudioCtx();
    function stillMine() {
      return mine === generation && phase === "connecting";
    }
    navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    }).then(function (stream) {
      if (!stillMine()) {
        stopTracks(stream);
        throw new Error("cancelled");
      }
      media = stream;
      return fetch(relay + "/v1/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
        signal: sessionAbort ? sessionAbort.signal : undefined,
      });
    }).then(function (res) {
      if (!stillMine()) throw new Error("cancelled");
      if (!res.ok) throw new Error("session");
      return res.json();
    }).then(function (session) {
      if (!stillMine()) throw new Error("cancelled");
      token = session.token;
      return audio.audioWorklet.addModule("/stream/pcm-worklet.js").then(function () {
        return session;
      });
    }).then(function (session) {
      if (!stillMine()) throw new Error("cancelled");
      if (audio && audio.resume) audio.resume();
      var source = audio.createMediaStreamSource(media);
      node = new AudioWorkletNode(audio, "pcm-downsampler");
      sink = audio.createGain();
      sink.gain.value = 0;
      source.connect(node);
      node.connect(sink);
      sink.connect(audio.destination);
      var socket = new WebSocket(stt.relayWsUrl(relay, session.stream_path || "/v1/stream"));
      ws = socket;
      var liveGen = generation;
      node.port.onmessage = function (ev) {
        if (liveGen !== generation || socket !== ws) return;
        sendFrame(ev.data, liveGen, socket);
      };
      socket.binaryType = "arraybuffer";
      socket.onopen = function () {
        if (liveGen !== generation || socket !== ws) return;
        if (!stillMine()) return;
        if (socket.readyState === 1) socket.send(JSON.stringify({ type: "auth", token: token }));
      };
      socket.onmessage = function (ev) {
        if (liveGen !== generation || socket !== ws) return;
        onMessage(ev);
      };
      socket.onerror = function () {
        if (liveGen !== generation || socket !== ws) return;
        if (phase === "connecting") abort("The speech relay did not accept this browser.");
        else if (phase === "live") recoverTransport();
      };
      socket.onclose = function () {
        if (liveGen !== generation || socket !== ws) return;
        if (phase === "live") recoverTransport();
        else if (phase === "connecting") abort("The speech relay did not accept this browser.");
      };
    }).catch(function (err) {
      if (!stillMine()) return;
      clearStartup();
      if (err && err.message === "session") {
        abort("The speech relay did not start.");
        return;
      }
      var denied = err && (err.name === "NotAllowedError" || err.name === "SecurityError");
      abort(denied ? "Microphone permission was refused." : "This browser did not start the microphone.");
    });
  }

  startBtn.addEventListener("click", function () {
    if (phase === "connecting") {
      abandonConnect("Stopped before the relay connected.");
      return;
    }
    if (phase === "live") {
      finish(false);
      return;
    }
    if (phase === "idle" || recovering) begin();
  });

  renderIdle();
})();
