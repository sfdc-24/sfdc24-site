/* 16 kHz mono linear16 frames for the speech relay.
   The capture core is plain JS so tests can run it without a browser. */
var SFDC24Pcm = (function () {
  var FRAME = 1600;
  var TARGET_RATE = 16000;

  function createPcmCapture(sampleRate) {
    var rate = Number(sampleRate);
    if (!isFinite(rate) || rate <= 0) rate = TARGET_RATE;
    var state = {
      ratio: rate / TARGET_RATE,
      acc: 0,
      sum: 0,
      count: 0,
      out: new Int16Array(FRAME),
      n: 0,
    };

    function take(sample) {
      var clipped = Math.max(-1, Math.min(1, sample));
      var pcm = clipped < 0 ? clipped * 32768 : clipped * 32767;
      state.out[state.n++] = pcm | 0;
      if (state.n < state.out.length) return null;
      var buf = state.out.buffer;
      state.out = new Int16Array(FRAME);
      state.n = 0;
      return buf;
    }

    function push(channel) {
      var frames = [];
      if (!channel) return frames;
      for (var i = 0; i < channel.length; i++) {
        state.sum += channel[i];
        state.count += 1;
        state.acc += 1;
        if (state.acc >= state.ratio) {
          var mean = state.count ? state.sum / state.count : 0;
          var frame = take(mean);
          state.acc -= state.ratio;
          state.sum = 0;
          state.count = 0;
          if (frame) frames.push(frame);
        }
      }
      return frames;
    }

    function flush() {
      if (!state.n) return null;
      var partial = state.out.slice(0, state.n);
      state.n = 0;
      state.sum = 0;
      state.count = 0;
      state.acc = 0;
      return partial.buffer;
    }

    return { push: push, flush: flush };
  }

  return { FRAME: FRAME, TARGET_RATE: TARGET_RATE, createPcmCapture: createPcmCapture };
})();

var PcmProcessorBase = typeof AudioWorkletProcessor === "function" ? AudioWorkletProcessor : function () {};

class PcmDownsampler extends PcmProcessorBase {
  constructor() {
    super();
    var rate = typeof sampleRate === "number" ? sampleRate : SFDC24Pcm.TARGET_RATE;
    this.core = SFDC24Pcm.createPcmCapture(rate);
    var self = this;
    this.port.onmessage = function (ev) {
      var data = ev.data || {};
      if (data.type !== "flush") return;
      var tail = self.core.flush();
      if (tail && tail.byteLength) self.port.postMessage(tail, [tail]);
      self.port.postMessage({ type: "flushed" });
    };
  }

  process(inputs) {
    var ch = inputs[0] && inputs[0][0];
    var frames = this.core.push(ch);
    for (var i = 0; i < frames.length; i++) {
      this.port.postMessage(frames[i], [frames[i]]);
    }
    return true;
  }
}

if (typeof registerProcessor === "function") {
  registerProcessor("pcm-downsampler", PcmDownsampler);
}

if (typeof module === "object" && module.exports) {
  module.exports = SFDC24Pcm;
}
