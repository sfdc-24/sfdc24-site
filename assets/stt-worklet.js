/*
  The capture end of the streaming pipeline.

  WHY AN AudioWorklet AND NOT ScriptProcessorNode
    ScriptProcessorNode runs on the main thread. Every layout, every paint and
    every model reply competes with it, and when it loses, the audio it drops is
    gone - there is no retry for a microphone. AudioWorkletProcessor runs on the
    audio thread, so a busy page cannot starve it.

  WHY IT DOES ALMOST NOTHING
    Resampling and 16-bit encoding happen on the page side, where they can be
    unit tested without an AudioContext. This file is the part that MUST run on
    the audio thread, and nothing else, because anything in here is untestable
    outside a browser.
*/
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.stopped = false;
    this.port.onmessage = (e) => {
      if (e && e.data && e.data.type === 'stop') this.stopped = true;
    };
  }

  process(inputs) {
    if (this.stopped) return false;          // false tears the node down
    const input = inputs[0];
    if (!input || !input.length) return true;
    const channel = input[0];
    if (!channel || !channel.length) return true;
    // A copy, not the view: the underlying buffer is reused by the audio thread
    // on the very next render quantum, so posting the view would deliver
    // whatever happened to be in it by the time the page read it.
    this.port.postMessage(new Float32Array(channel), []);
    return true;
  }
}

registerProcessor('sfdc-capture', CaptureProcessor);
