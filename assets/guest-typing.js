/* Guest seat: the soft typing sound while the presenter works.
   The call's chair sends {"on": true} or {"on": false} on the data topic
   conf.typing while the presenter is working on an answer, and again
   about every 10 seconds while it lasts. Only a participant that is an
   agent and has announced chair=ready is obeyed. The payload is a
   boolean and nothing else: no words ever arrive on this topic.
   The sound is made here, in the page, with Web Audio: short filtered
   noise clicks at a soft level (LEVEL). It is never published, never on
   the microphone, and never in the call's audio or recording.
   It is silent while anyone in the call is speaking (duck), it stops when
   the chair says off, when no word from the chair has come for STALE_MS,
   and when the seat leaves the call (reset).
*/
(function () {
  "use strict";

  var TOPIC = "conf.typing";
  var LEVEL = 0.08;
  var STALE_MS = 25000;
  var TICK_MS = 250;
  var AHEAD_S = 1.0;
  var NOISE_S = 0.5;

  function between(low, high) { return low + Math.random() * (high - low); }

  function Typing(makeContext) {
    this.makeContext = makeContext || function () {
      var AC = window.AudioContext || window.webkitAudioContext;
      return AC ? new AC() : null;
    };
    this.on = false;
    this.ducked = false;
    this.heard = 0;
    this.timer = 0;
    this.context = null;
    this.master = null;
    this.noise = null;
    this.next = 0;
  }

  Typing.prototype.set = function (on) {
    if (on) {
      this.heard = Date.now();
      if (!this.on) this._start();
    } else if (this.on) {
      this._stop();
    }
  };

  Typing.prototype.duck = function (ducked) {
    ducked = !!ducked;
    if (ducked === this.ducked) return;
    this.ducked = ducked;
    if (ducked && this.master && this.context) {
      this.master.disconnect();             // keys already scheduled are cut, at once
      this._output();
    }
  };

  Typing.prototype.reset = function () {
    this._stop();
    this.ducked = false;
    this.heard = 0;
  };

  Typing.prototype._start = function () {
    try {
      if (!this.context) {
        this.context = this.makeContext();
        if (!this.context) return;
        this.noise = this._noiseBuffer();
      }
      if (this.context.resume) this.context.resume();
      this._output();
    } catch (err) {
      return;                               // no audio here: nothing to do, and never an error in the call
    }
    this.on = true;
    this.next = this.context.currentTime + 0.1;
    var self = this;
    this.timer = window.setInterval(function () { self._tick(); }, TICK_MS);
  };

  Typing.prototype._stop = function () {
    this.on = false;
    if (this.timer) window.clearInterval(this.timer);
    this.timer = 0;
    if (this.master) {
      try { this.master.disconnect(); } catch (err) {}
      this.master = null;
    }
  };

  Typing.prototype._output = function () {
    this.master = this.context.createGain();
    this.master.gain.value = LEVEL;
    this.master.connect(this.context.destination);
  };

  Typing.prototype._noiseBuffer = function () {
    var rate = this.context.sampleRate;
    var buffer = this.context.createBuffer(1, Math.floor(rate * NOISE_S), rate);
    var data = buffer.getChannelData(0);
    for (var i = 0; i < data.length; i += 1) data[i] = Math.random() * 2 - 1;
    return buffer;
  };

  Typing.prototype._tick = function () {
    if (Date.now() - this.heard > STALE_MS) {
      this._stop();
      return;
    }
    var now = this.context.currentTime;
    if (this.next < now) this.next = now + 0.05;
    while (this.next < now + AHEAD_S) {
      var space = Math.random() < 0.16;
      this.next += Math.random() < 0.08 ? between(0.4, 1.4) : between(0.07, 0.17);
      if (this.ducked) continue;
      this._click(this.next, between(0.45, 1), space ? between(600, 1200) : between(1800, 4200),
        between(0.7, 2.5), space ? between(0.03, 0.06) : between(0.012, 0.035));
    }
  };

  Typing.prototype._click = function (at, gain, tone, q, decay) {
    var c = this.context;
    var source = c.createBufferSource();
    source.buffer = this.noise;
    var filter = c.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.value = tone;
    filter.Q.value = q;
    var envelope = c.createGain();
    envelope.gain.setValueAtTime(0.0001, at);
    envelope.gain.exponentialRampToValueAtTime(gain, at + 0.002);
    envelope.gain.exponentialRampToValueAtTime(0.0001, at + decay);
    source.connect(filter);
    filter.connect(envelope);
    envelope.connect(this.master);
    source.start(at, Math.random() * (NOISE_S - 0.1), decay + 0.01);
  };

  // The packet, read only from the chair: an agent participant that announced chair=ready. Anything else, or any payload
  // that is not exactly {"on": <boolean>}, is ignored.
  function fromChair(participant) {
    if (!participant || participant.isAgent !== true) return false;
    var attrs = participant.attributes || {};
    return attrs.chair === "ready";
  }

  function readOn(payload) {
    try {
      var text = typeof payload === "string" ? payload : new TextDecoder().decode(payload);
      var body = JSON.parse(text);
      if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.on !== "boolean") return null;
      if (Object.keys(body).length !== 1) return null;
      return body.on;
    } catch (err) {
      return null;
    }
  }

  window.SFDC24GuestTyping = {
    TOPIC: TOPIC,
    LEVEL: LEVEL,
    STALE_MS: STALE_MS,
    Typing: Typing,
    fromChair: fromChair,
    readOn: readOn
  };
})();
