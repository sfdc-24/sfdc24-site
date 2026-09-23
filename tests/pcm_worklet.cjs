const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const pcm = require(path.join(__dirname, '..', 'stream', 'pcm-worklet.js'));

function tone(n, value) {
  const samples = new Float32Array(n);
  samples.fill(value);
  return samples;
}

function sampleCount(frames) {
  return frames.reduce((sum, buf) => sum + new Int16Array(buf).length, 0);
}

function pushAll(capture, samples) {
  const frames = [];
  const chunk = 128;
  for (let i = 0; i < samples.length; i += chunk) {
    frames.push(...capture.push(samples.subarray(i, i + chunk)));
  }
  return frames;
}

test('16 kHz clips to int16 and emits one full frame', () => {
  const capture = pcm.createPcmCapture(16000);
  const mixed = tone(1600, 0);
  mixed[0] = 2;
  mixed[1] = -2;
  const frames = pushAll(capture, mixed);
  assert.equal(frames.length, 1);
  const view = new Int16Array(frames[0]);
  assert.equal(view.length, 1600);
  assert.equal(view[0], 32767);
  assert.equal(view[1], -32768);
  assert.equal(capture.flush(), null);
});

test('48 kHz 150 ms keeps the 50 ms tail instead of dropping it', () => {
  const capture = pcm.createPcmCapture(48000);
  const frames = pushAll(capture, tone(7200, 0.25));
  assert.equal(sampleCount(frames), 1600);
  const tail = capture.flush();
  assert.ok(tail);
  assert.equal(new Int16Array(tail).length, 800);
  assert.equal(sampleCount(frames) + new Int16Array(tail).length, 2400);
});

test('44.1 kHz one second emits 16000 samples by the integer rate', () => {
  // 44100 and 16000 share an integer relationship: 441 inputs become 160 outputs.
  // This checks that count. It is not a microphone recording or a provider result.
  const capture = pcm.createPcmCapture(44100);
  const frames = pushAll(capture, tone(44100, 0.1));
  const emitted = sampleCount(frames);
  assert.equal(capture.flush(), null);
  assert.equal(emitted, 16000);
  assert.equal(frames.length, 10);
  for (const buf of frames) {
    assert.equal(new Int16Array(buf).length, 1600);
  }
});
