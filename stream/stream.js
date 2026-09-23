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
  var answerEl = document.getElementById("answer");
  var EXEC = "https://script.google.com/macros/s/AKfycbx0D-5DAnMqOm9YbN3iKDwuiBApEi_xex60f6pwdvObEyQBF5jcOK715pl1mN-Nzn6gng/exec";
  var workable = false;
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
  var answered = false;
  var answerRequestId = 0;
  var pendingAnswerCancel = null;

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
    workable = false;
    answered = false;
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

  /*
    ANSWER THEM. This page captured a transcript and posted a lead, and never
    told the visitor anything - three minutes of talking for "we will call you
    back". The site already has a question path and its newest page walked past
    it, so a visitor got less from speaking than from typing.

    TRIAGE FIRST, exactly as the homepage does: a grounded question is answered
    locally, correctly, with no model call and no bill. Only what the local
    layer cannot answer goes to the desk.

    AND THE OTHER HALF OF HIS RULE: if the desk says it cannot serve them, say
    so plainly here. "We realize we cannot serve them" is the desk's judgement,
    and this is where it becomes visible.
  */
  function answerVisitor(text, gen) {
    if (!answerEl || gen !== generation) return;
    var asked = String(text || "").trim();
    if (!asked) return;

    var local = null;
    try {
      local = (window.__TRIAGE && window.__TRIAGE.ask) ? window.__TRIAGE.ask(asked) : null;
    } catch (e) { local = null; }
    if (local && local.answer) {
      if (gen !== generation) return;
      answerEl.textContent = local.answer + "  (answered here, with no model call)";
      return;
    }
    if (local && local.handTo) {
      if (gen !== generation) return;
      answerEl.textContent = "That interactive is available from the main question bar.  (answered here, with no model call)";
      return;
    }
    var agent = local && /^(?:codex|claude)$/.test(String(local.routeTo || "").toLowerCase())
      ? String(local.routeTo).toLowerCase() : "";

    answerEl.textContent = "Asking…";
    answerRequestId += 1;
    var cb = "sttans" + Date.now().toString(36) + answerRequestId.toString(36);
    var tag = document.createElement("script");
    var settled = false;
    var timeout = null;
    var ct = "";
    try { ct = localStorage.getItem("sfdc_conv") || ""; } catch (e) {}

    function settle() {
      if (settled) return false;
      settled = true;
      if (timeout) { clearTimeout(timeout); timeout = null; }
      try { delete window[cb]; } catch (e) { window[cb] = undefined; }
      if (tag.parentNode) tag.parentNode.removeChild(tag);
      if (pendingAnswerCancel === cancel) pendingAnswerCancel = null;
      return true;
    }
    function cancel() { settle(); }
    pendingAnswerCancel = cancel;

    window[cb] = function (res) {
      if (!settle() || gen !== generation) return;
      if (res && res.ct) { try { localStorage.setItem("sfdc_conv", res.ct); } catch (e) {} }
      if (!res || !res.ok || !res.reply) { answerEl.textContent = "No answer came back."; return; }
      answerEl.textContent = res.reply + (res.by ? "  (answered by " + res.by + ")" : "");
      if (stt.isRefusal(res.reply)) {
        workable = false;
        answerEl.textContent = res.reply
          + "  The microphone is off rather than running the clock down.";
      }
    };
    tag.onerror = function () {
      if (!settle() || gen !== generation) return;
      answerEl.textContent = "The question path could not be reached.";
    };
    /* The endpoint reads `cb`, not `callback`. With the wrong name it answers
       with plain JSON, the callback never fires, and the panel waits for ever -
       which is exactly what happened on the bench this was folded in from. */
    tag.src = EXEC + "?action=say&cb=" + cb
            + "&ct=" + encodeURIComponent(ct)
            + "&q=" + encodeURIComponent(asked.slice(0, 1000))
            + (agent ? "&agent=" + encodeURIComponent(agent) : "");
    timeout = setTimeout(function () {
      if (!settle() || gen !== generation) return;
      answerEl.textContent = "No answer came back within 45 seconds.";
    }, 45000);
    document.body.appendChild(tag);
  }

  function answerOnce(gen) {
    if (gen !== generation || answered) return;
    answered = true;
    answerVisitor(committed, gen);
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
        answerOnce(gen);
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
          answerOnce(gen);
          postAndReset(gen);
        }, 2500);
        return;
      }
      answerOnce(gen);
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
        answerOnce(gen);
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
          answerOnce(gen);
          postAndReset(gen);
          return;
        }
        answerOnce(gen);
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
    workable = false;
    answered = false;
    recovering = false;
    token = "";
    receipt = "";
    startBtn.disabled = false;
    startBtn.textContent = "Start";
    statusEl.textContent = message;
  }

  function noteWorkable() {
    /* HIS RULE: three minutes to reach a problem somebody could be paid to
       solve. Reaching one is the outcome the clock exists to protect, so say so
       the moment it happens rather than only counting down at them. */
    if (workable || !committed) return;
    if (stt.isWorkable(committed, window.__TRIAGE) !== true) return;
    workable = true;
    clock.satisfy(Date.now());
    if (timer) { clearInterval(timer); timer = null; }
    renderClock();
    clockEl.classList.remove("warn");
    if (warnEl) warnEl.textContent = "";
    if (answerEl) answerEl.textContent = "That is something workable. Keep going.";
  }

  function showTranscript(text, isFinal) {
    if (isFinal) {
      committed = (committed + " " + text).trim();
      interim = "";
      noteWorkable();
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
    if (pendingAnswerCancel) pendingAnswerCancel();
    capSeen = false;
    workable = false;
    answered = false;
    recovering = false;
    closeSocket();
    clearSpokenDraft();
    if (answerEl) answerEl.textContent = "";
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
