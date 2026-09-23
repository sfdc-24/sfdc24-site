/* 16 kHz mono linear16 frames for the speech relay. */
class PcmDownsampler extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000;
    this.acc = 0;
    this.sum = 0;
    this.count = 0;
    this.out = new Int16Array(1600);
    this.n = 0;
  }

  process(inputs) {
    var ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (var i = 0; i < ch.length; i++) {
      this.sum += ch[i];
      this.count += 1;
      this.acc += 1;
      if (this.acc >= this.ratio) {
        var mean = this.count ? this.sum / this.count : 0;
        var clipped = Math.max(-1, Math.min(1, mean));
        var sample = clipped < 0 ? clipped * 32768 : clipped * 32767;
        this.out[this.n++] = sample | 0;
        this.acc -= this.ratio;
        this.sum = 0;
        this.count = 0;
        if (this.n === this.out.length) {
          var buf = this.out.buffer;
          this.port.postMessage(buf, [buf]);
          this.out = new Int16Array(1600);
          this.n = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor("pcm-downsampler", PcmDownsampler);
