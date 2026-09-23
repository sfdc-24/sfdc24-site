/*
  Streaming speech capture: the page side.

  WHAT THIS REPLACES AND WHY
    The voice page uses the browser's own SpeechRecognition. That is dictation,
    not streaming transcription: it stops on pauses, it varies by browser, and
    on a client call it is the thing that goes wrong in front of the client.
    This sends audio to a relay and renders transcripts as they come back.

  THE KEY NEVER COMES HERE
    The provider credential lives in the relay and nowhere else. A browser that
    holds a transcription key is a free transcription service for anyone who
    reads the page source. That is the entire reason there is a relay at all,
    and it is why this file has no provider name in it.

  WHAT IS TESTABLE, AND WHAT CANNOT BE
    Everything below the `pure` heading is arithmetic and a state machine, and
    tests/stt_capture.cjs exercises it with no browser. Everything under
    `browser` needs a real microphone and is therefore verified by a person
    clicking once, reported as a click rather than as a passing test.
*/
(function (root) {
  'use strict';

  var TARGET_RATE = 16000;   // what transcription providers want: 16 kHz mono

  /* ------------------------------------------------------------- pure ---- */

  // Nearest-neighbour decimation. Not the best resampler available, and that is
  // a deliberate trade: it is O(n), allocation-light and runs on every audio
  // quantum. Speech transcription is robust to it; a dropped quantum is not.
  function downsample(input, inRate, outRate) {
    outRate = outRate || TARGET_RATE;
    if (!input || !input.length) return new Float32Array(0);
    if (inRate === outRate) return input;
    if (inRate < outRate) return input;      // never upsample: it invents audio
    var ratio = inRate / outRate;
    var outLength = Math.floor(input.length / ratio);
    var out = new Float32Array(outLength);
    for (var i = 0; i < outLength; i++) out[i] = input[Math.floor(i * ratio)];
    return out;
  }

  // Float [-1,1] to signed 16-bit. CLAMPED, because a sample above 1.0 wraps to
  // a large negative on truncation and arrives as a click - which sounds like a
  // hardware fault and is not one.
  function toPcm16(input) {
    var out = new Int16Array(input.length);
    for (var i = 0; i < input.length; i++) {
      var s = input[i];
      if (s > 1) s = 1; else if (s < -1) s = -1;
      out[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    return out;
  }

  function encode(float32, inRate) {
    return toPcm16(downsample(float32, inRate, TARGET_RATE));
  }

  /*
    THE STATE MACHINE, AND WHY STOP IS THE IMPORTANT PART.

    The failure everyone ships is a Stop that stops the transcript and leaves
    the microphone indicator burning in the tab, because the track was never
    stopped - only the socket. On a client call that is the moment the demo
    stops being impressive. `stop` is therefore reachable from EVERY live state
    and always passes through `stopping`, which is where teardown happens.
  */
  var TRANSITIONS = {
    idle:       { start: 'permission' },
    permission: { granted: 'connecting', denied: 'blocked', stop: 'stopping' },
    connecting: { open: 'listening', failed: 'error', stop: 'stopping' },
    listening:  { failed: 'error', closed: 'stopping', stop: 'stopping' },
    stopping:   { done: 'idle' },
    blocked:    { start: 'permission', reset: 'idle' },
    error:      { start: 'permission', reset: 'idle' }
  };

  var LIVE = { permission: 1, connecting: 1, listening: 1 };

  function next(state, event) {
    var row = TRANSITIONS[state];
    if (!row) return null;                   // unknown state: refuse to guess
    return row[event] || null;               // unknown event: no move, no throw
  }

  function machine(onChange) {
    var state = 'idle';
    return {
      get: function () { return state; },
      isLive: function () { return !!LIVE[state]; },
      send: function (event) {
        var to = next(state, event);
        if (!to || to === state) return state;
        var from = state;
        state = to;
        if (onChange) onChange(state, from, event);
        return state;
      }
    };
  }

  /*
    THE THREE-MINUTE BUDGET.

    Asked for 2026-09-23: an open microphone on a public page is metered on the
    provider's clock, and the internet contains people who will hold it open for
    fun. So a spoken conversation gets three minutes to arrive at a problem
    somebody could actually be paid to solve, and the audio stops when it does
    not.

    TWO WAYS IT ENDS EARLY, AND ONLY ONE OF THEM IS THE CLOCK:
      satisfy()  a workable problem statement was reached. The clock stops
                 governing - a real prospect is never cut off mid-sentence.
      decline()  it became clear this is not work we could take. Ends it THEN,
                 rather than making an honest visitor sit out a timer.

    IT WARNS BEFORE IT ACTS. Cutting a microphone without notice reads as a
    fault, and a visitor who thinks the site broke does not come back.

    The clock is injected so this is testable without waiting three minutes.
  */
  var BUDGET_MS = 180000;   // three minutes of open microphone
  var WARN_MS = 30000;      // said out loud with this much left

  function budget(opts) {
    opts = opts || {};
    var limit = opts.limitMs == null ? BUDGET_MS : opts.limitMs;
    var warnAt = opts.warnMs == null ? WARN_MS : opts.warnMs;
    var now = opts.now || function () { return Date.now(); };
    var startedAt = null, satisfied = false, declined = false, warned = false;

    return {
      start: function () { startedAt = now(); satisfied = false; declined = false; warned = false; },
      started: function () { return startedAt !== null; },
      satisfy: function () { satisfied = true; },
      isSatisfied: function () { return satisfied; },
      decline: function () { declined = true; },
      remaining: function () {
        if (startedAt === null) return limit;
        if (satisfied) return Infinity;
        return Math.max(0, limit - (now() - startedAt));
      },
      // 'declined' | 'expired' | 'warn' | null. Reported once each, so a caller
      // polling every second does not announce the warning sixty times.
      check: function () {
        if (declined) { declined = false; return 'declined'; }
        if (startedAt === null || satisfied) return null;
        var left = limit - (now() - startedAt);
        if (left <= 0) return 'expired';
        if (left <= warnAt && !warned) { warned = true; return 'warn'; }
        return null;
      }
    };
  }

  /*
    IS THIS A WORKABLE PROBLEM STATEMENT?

    Deliberately NOT a new cleverness. The page already has a triage layer that
    decides whether something is real work, and a second opinion that disagrees
    with it would be a bug wearing a feature's clothes. This asks that layer,
    and answers a cautious "not yet" when the layer is absent.

    A statement counts when triage would send it to an agent rather than
    answering it locally as a greeting, a courtesy or a stock fact - that is
    exactly the line between chat and work.
  */
  function isWorkable(text, triage) {
    var t = String(text || '').trim();
    if (t.split(/\s+/).filter(Boolean).length < 6) return false;
    if (!triage || typeof triage.ask !== 'function') return false;
    var hit = triage.ask(t);
    if (!hit) return true;                       // nothing local claimed it: real work
    if (hit.handTo) return true;                 // triage sent it to an agent
    // A DOMAIN fact means they described our subject and got a correct answer
    // instantly. That is the best possible outcome and emphatically not
    // time-wasting - the Access Haiti question itself lands here. A trivia fact
    // or a courtesy line does not count.
    return !!hit.domain;
  }

  // The relay is chosen by the page, never compiled in, so the same page runs
  // against the local echo and against Cloud Run with one query parameter.
  function relayUrl(search, fallback) {
    var m = /[?&]relay=([^&]+)/.exec(String(search || ''));
    var url = m ? decodeURIComponent(m[1]) : (fallback || '');
    if (!/^wss?:\/\//i.test(url)) return '';
    return url;
  }

  /* ---------------------------------------------------------- browser ---- */

  function Session(opts) {
    opts = opts || {};
    this.url = opts.url;
    this.onState = opts.onState || function () {};
    this.onText = opts.onText || function () {};
    this.onEcho = opts.onEcho || function () {};
    this.fsm = machine(this.onState);
    this.stream = null;
    this.ctx = null;
    this.node = null;
    this.ws = null;
    this.sent = 0;
  }

  Session.prototype.state = function () { return this.fsm.get(); };

  Session.prototype.start = function () {
    var self = this;
    if (this.fsm.isLive()) return Promise.resolve(this.fsm.get());
    this.fsm.send('start');
    return navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }
    }).then(function (stream) {
      self.stream = stream;
      self.fsm.send('granted');
      return self._open();
    }).catch(function (err) {
      self.fsm.send('denied');
      self.stop();
      throw err;
    });
  };

  Session.prototype._open = function () {
    var self = this;
    return new Promise(function (resolve, reject) {
      var ws;
      try { ws = new WebSocket(self.url); } catch (e) { self.fsm.send('failed'); reject(e); return; }
      ws.binaryType = 'arraybuffer';
      self.ws = ws;
      ws.onopen = function () { self.fsm.send('open'); self._pipe(); resolve(true); };
      ws.onerror = function () { self.fsm.send('failed'); };
      ws.onclose = function () { if (self.fsm.get() === 'listening') self.fsm.send('closed'); self.stop(); };
      ws.onmessage = function (e) {
        var msg;
        try { msg = JSON.parse(e.data); } catch (err) { return; }
        if (msg.echo) self.onEcho(msg);
        if (msg.type === 'interim' || msg.type === 'final') {
          self.onText(msg.type, String(msg.text || ''), !!msg.echo);
        }
      };
    });
  };

  Session.prototype._pipe = function () {
    var self = this;
    var Ctx = root.AudioContext || root.webkitAudioContext;
    this.ctx = new Ctx();
    var rate = this.ctx.sampleRate;
    return this.ctx.audioWorklet.addModule('/assets/stt-worklet.js').then(function () {
      var src = self.ctx.createMediaStreamSource(self.stream);
      var node = new AudioWorkletNode(self.ctx, 'sfdc-capture');
      self.node = node;
      node.port.onmessage = function (e) {
        if (!self.ws || self.ws.readyState !== 1) return;
        var pcm = encode(e.data, rate);
        self.sent += pcm.byteLength;
        self.ws.send(pcm.buffer);
      };
      src.connect(node);
      // Deliberately NOT connected to ctx.destination: routing the microphone
      // to the speakers on a call is how a demo produces feedback howl.
    });
  };

  // Everything that can hold the microphone is released here, in this order,
  // and every step is guarded so one failure cannot skip the rest.
  Session.prototype.stop = function () {
    var was = this.fsm.get();
    if (was !== 'stopping' && was !== 'idle') this.fsm.send('stop');
    try { if (this.node) { this.node.port.postMessage({ type: 'stop' }); this.node.disconnect(); } } catch (e) {}
    this.node = null;
    try { if (this.ws && this.ws.readyState === 1) { this.ws.send(JSON.stringify({ type: 'stop' })); } } catch (e) {}
    try { if (this.ws) this.ws.close(); } catch (e) {}
    this.ws = null;
    // THE TRACKS. This is the line whose absence leaves the tab indicator on.
    try {
      if (this.stream) this.stream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) {} });
    } catch (e) {}
    this.stream = null;
    try { if (this.ctx && this.ctx.state !== 'closed') this.ctx.close(); } catch (e) {}
    this.ctx = null;
    this.fsm.send('done');
    return this.fsm.get();
  };

  root.__STT = {
    TARGET_RATE: TARGET_RATE,
    BUDGET_MS: BUDGET_MS,
    WARN_MS: WARN_MS,
    downsample: downsample,
    toPcm16: toPcm16,
    encode: encode,
    next: next,
    machine: machine,
    budget: budget,
    isWorkable: isWorkable,
    relayUrl: relayUrl,
    Session: Session
  };
})(typeof window !== 'undefined' ? window : this);
