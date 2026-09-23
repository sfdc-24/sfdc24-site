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
    if (node) {
      try { node.disconnect(); } catch (e) {}
      node = null;
    }
    if (sink) {
      try { sink.disconnect(); } catch (e1) {}
      sink = null;
    }
    if (media) {
      try { media.getTracks().forEach(function (track) { track.stop(); }); } catch (e2) {}
      media = null;
    }
    if (audio) {
      var ctx = audio;
      audio = null;
      try { if (ctx.close) ctx.close(); } catch (e3) {}
    }
  }

  function closeSocket() {
    if (!ws) return;
    var socket = ws;
    ws = null;
    try { socket.onmessage = null; socket.onerror = null; socket.onclose = null; socket.close(); } catch (e) {}
  }

  function renderIdle() {
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
    startBtn.disabled = false;
    startBtn.textContent = "Start";
  }

  function applyLeadStatus(gen, outcome) {
    if (gen !== generation) return;
    statusEl.textContent = stt.leadStatus(outcome);
  }

  function postLead() {
    if (posted || !token || !relay) return;
    posted = true;
    var gen = generation;
    var savedToken = token;
    var savedReceipt = receipt;
    fetch(relay + "/v1/leads", {
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
    }).then(function (parsed) {
      applyLeadStatus(gen, stt.interpretLeadResponse(parsed.ok, parsed.body));
    }).catch(function () {
      applyLeadStatus(gen, "failed");
    });
  }

  function armReset() {
    if (holdTimer) return;
    holdTimer = setTimeout(function () {
      stopMedia();
      closeSocket();
      renderIdle();
    }, stt.RESET_HOLD_MS);
  }

  function postAndReset() {
    postLead();
    armReset();
  }

  function sendFrame(data) {
    if (!data || typeof data === "string") return;
    if (data && data.type) return;
    if (!ws || ws.readyState !== 1) return;
    if (phase !== "live" && phase !== "ending") return;
    if (ws.bufferedAmount > 262144) return;
    ws.send(data);
  }

  function flushCapture(done) {
    if (!node || !node.port || !node.port.postMessage) {
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
    node.port.onmessage = function (ev) {
      var data = ev.data;
      if (data && data.type === "flushed") {
        complete();
        return;
      }
      sendFrame(data);
    };
    try { node.port.postMessage({ type: "flush" }); }
    catch (e) { complete(); }
  }

  function finish(fromServer) {
    if (phase !== "live") {
      if (phase === "ending" && fromServer) postAndReset();
      return;
    }
    phase = "ending";
    if (timer) { clearInterval(timer); timer = null; }
    clockEl.textContent = "0:00";
    clockEl.classList.remove("warn");
    if (warnEl) warnEl.textContent = "";
    statusEl.textContent = "Thank you. That is enough for a call back.";
    flushCapture(function () {
      stopMedia();
      if (!fromServer && ws && ws.readyState === 1) {
        try { ws.send(JSON.stringify({ type: "stop" })); } catch (e) {}
        capTimer = setTimeout(postAndReset, 2500);
        return;
      }
      postAndReset();
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
    clearStartup();
    stopTracks(media);
    abort(message);
  }

  function abort(message) {
    if (timer) { clearInterval(timer); timer = null; }
    if (capTimer) { clearTimeout(capTimer); capTimer = null; }
    stopMedia();
    closeSocket();
    clock.reset();
    clockEl.textContent = clock.snapshot(Date.now()).label;
    clockEl.classList.remove("warn");
    if (warnEl) warnEl.textContent = "";
    phase = "idle";
    posted = false;
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
      if (capTimer) { clearTimeout(capTimer); capTimer = null; }
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
    generation += 1;
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
      node.port.onmessage = function (ev) {
        sendFrame(ev.data);
      };
      sink = audio.createGain();
      sink.gain.value = 0;
      source.connect(node);
      node.connect(sink);
      sink.connect(audio.destination);
      ws = new WebSocket(stt.relayWsUrl(relay, session.stream_path || "/v1/stream"));
      ws.binaryType = "arraybuffer";
      ws.onopen = function () {
        if (!stillMine()) return;
        if (ws) ws.send(JSON.stringify({ type: "auth", token: token }));
      };
      ws.onmessage = onMessage;
      ws.onerror = function () {
        if (phase === "connecting") abort("The speech relay did not accept this browser.");
        else if (phase === "live") finish(true);
      };
      ws.onclose = function () {
        if (phase === "live") finish(true);
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
    if (phase === "idle") begin();
  });

  renderIdle();
})();
