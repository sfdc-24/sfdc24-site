const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');

// Execute the shipped page with fake speech, audio and JSONP boundaries.
// No microphone, audio device, backend or customer environment is contacted.
const html = fs.readFileSync(path.join(__dirname, '../voice/index.html'), 'utf8');
const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)];
assert.equal(scripts.length, 1, 'exercise the one shipped voice controller');

function harness({ synchronousAbort = false } = {}) {
  function element() {
    return {
      children: [], listeners: {}, className: '', value: '', textContent: '',
      addEventListener(name, fn) { this.listeners[name] = fn; },
      setAttribute(name, value) { this[name] = value; },
      appendChild(child) { child.parentNode = this; this.children.push(child); },
      removeChild(child) { this.children.splice(this.children.indexOf(child), 1); child.parentNode = null; },
      get lastElementChild() { return this.children.at(-1); },
      querySelector(selector) { return this.children.find(child => '.' + child.className === selector); },
      focus() {},
    };
  }
  const elements = Object.fromEntries([
    'app', 'tape', 'mic', 'warn', 'box', 'send', 'hint', 'bars',
    'state', 'stateword', 'statewho', 'statevoice', 'voices', 'voicebtn',
  ].map(id => [id, element()]));
  const head = element();
  const requests = [];
  const append = head.appendChild.bind(head);
  head.appendChild = script => { append(script); requests.push(new URL(script.src)); };
  const recognition = [];
  let starts = 0;
  class Recognition {
    constructor() { recognition.push(this); }
    start() { starts++; }
    abort() { if (synchronousAbort && this.onend) this.onend(); }
  }
  const spoken = [];
  const speechSynthesis = {
    getVoices: () => [], cancel() {}, speak: utterance => spoken.push(utterance),
  };
  let audio, neuralPlays = 0;
  class Audio {
    constructor() { audio = this; }
    play() { if (this.src !== undefined && this.src.endsWith('ZmFrZQ==')) neuralPlays++; return { catch() {} }; }
    pause() {}
  }
  const window = { SpeechRecognition: Recognition, speechSynthesis };
  const storage = { getItem: () => null, setItem() {} };
  let timerId = 0;
  const timers = new Map();
  vm.runInNewContext(scripts[0][1], {
    window, document: { head, getElementById: id => elements[id], createElement: element },
    Audio, SpeechSynthesisUtterance: function(text) { this.text = text; },
    localStorage: storage, sessionStorage: storage, location: { hash: '', pathname: '/voice/' },
    history: { replaceState() {} }, navigator: { userAgent: 'synthetic test' },
    setTimeout(fn) { const id = ++timerId; timers.set(id, fn); return id; },
    clearTimeout(id) { timers.delete(id); },
  });
  function respond(action, value) {
    const index = requests.findIndex(request => request.searchParams.get('action') === action);
    assert.notEqual(index, -1, `expected one ${action} request`);
    const request = requests.splice(index, 1)[0];
    window[request.searchParams.get('cb')](value);
  }
  return {
    get starts() { return starts; },
    get mode() { return elements.stateword.textContent; },
    get currentRecognition() { return recognition.at(-1); },
    get spokenCount() { return spoken.filter(utterance => utterance.text.trim()).length; },
    get neuralPlays() { return neuralPlays; },
    tapMic() { elements.mic.listeners.click(); },
    replay(index = 0) {
      const buttons = elements.tape.children.flatMap(turn => turn.children)
        .filter(child => child.className === 'replay');
      assert.ok(buttons[index], 'replay an existing answer');
      buttons[index].listeners.click();
      return spoken.at(-1).onend;
    },
    type(text) {
      elements.box.value = text;
      elements.box.listeners.input();
      assert.equal(elements.send.disabled, false);
      elements.send.listeners.click();
    },
    recognize(text) {
      const result = [{ transcript: text }]; result.isFinal = true;
      recognition.at(-1).onresult({ resultIndex: 0, results: [result] });
      recognition.at(-1).onend();
    },
    reply(neural = false, text = 'A synthetic answer.') {
      respond('say', { ok: true, reply: text, ...(neural ? { ak: 'fake-audio-key' } : {}) });
    },
    finishNeuralFetch() {
      respond('tts', { ok: true, b64: 'ZmFrZQ==', mime: 'audio/mpeg' });
    },
    answer(neural = false, text = 'A synthetic answer.') {
      const count = spoken.length;
      respond('say', { ok: true, reply: text, ...(neural ? { ak: 'fake-audio-key' } : {}) });
      if (neural) respond('tts', { ok: true, b64: 'ZmFrZQ==', mime: 'audio/mpeg' });
      return neural ? audio.onended : spoken.length > count ? spoken.at(-1).onend : undefined;
    },
  };
}

for (const neural of [false, true]) {
  test(`typed input stays microphone-free after ${neural ? 'neural' : 'local'} speech completes`, () => {
    const h = harness();
    assert.equal(h.starts, 0);
    h.type('Please explain the service.');
    assert.equal(h.mode, 'thinking');
    const finish = h.answer(neural);
    assert.equal(h.mode, 'speaking');
    finish();
    assert.equal(h.mode, 'ready');
    assert.equal(h.starts, 0, 'typing must never opt into microphone capture');
  });
}

test('Start talking preserves continuous conversation and silent recognition retry', () => {
  const h = harness();
  h.tapMic();
  assert.equal(h.starts, 1);
  h.currentRecognition.onend();
  assert.equal(h.starts, 2, 'an explicitly started conversation may keep listening');
  h.recognize('A spoken question.');
  h.answer()();
  assert.equal(h.mode, 'listening');
  assert.equal(h.starts, 3, 'a spoken reply should resume explicitly requested listening');
});

test('Stop prevents a late speech-completion callback from restarting recognition', () => {
  const h = harness();
  h.tapMic();
  h.recognize('A spoken question.');
  const finish = h.answer();
  h.tapMic();
  finish();
  assert.equal(h.mode, 'ready');
  assert.equal(h.starts, 1);
});

test('Stop while awaiting a reply keeps late reply completion microphone-free', () => {
  const h = harness();
  h.tapMic();
  h.recognize('A spoken question.');
  h.tapMic();
  assert.equal(h.answer(), undefined, 'a stopped pending reply must not begin speaking');
  assert.equal(h.mode, 'ready');
  assert.equal(h.starts, 1);
  assert.equal(h.spokenCount, 0);
});

test('switching an active conversation to typed input revokes automatic listening', () => {
  const h = harness();
  h.tapMic();
  h.type('I want to type now.');
  h.answer()();
  assert.equal(h.mode, 'ready');
  assert.equal(h.starts, 1);
});

test('a stale speech completion cannot finish or restart a newer typed exchange', () => {
  const h = harness();
  h.tapMic();
  h.recognize('A spoken question.');
  const oldFinish = h.answer();
  h.type('A newer typed question.');
  const newFinish = h.answer();
  oldFinish();
  assert.equal(h.mode, 'speaking');
  assert.equal(h.starts, 1);
  newFinish();
  assert.equal(h.mode, 'ready');
  assert.equal(h.starts, 1);
});

test('Stop prevents the next local speech chunk after a late completion callback', () => {
  const h = harness();
  h.type('A typed question.');
  const firstChunk = h.answer(false, 'A long synthetic sentence '.repeat(10) + '. Another sentence.');
  assert.equal(h.spokenCount, 1);
  h.tapMic();
  firstChunk();
  assert.equal(h.spokenCount, 1);
  assert.equal(h.mode, 'ready');
  assert.equal(h.starts, 0);
});

test('Stop while neural speech is fetching prevents late audio playback', () => {
  const h = harness();
  h.tapMic();
  h.recognize('A spoken question.');
  h.reply(true);
  h.tapMic();
  h.finishNeuralFetch();
  assert.equal(h.neuralPlays, 0);
  assert.equal(h.mode, 'ready');
  assert.equal(h.starts, 1);
});

test('a stopped recognizer cannot restart a newly requested listening session', () => {
  const h = harness();
  h.tapMic();
  const oldRecognition = h.currentRecognition;
  h.tapMic();
  h.tapMic();
  oldRecognition.onend();
  assert.equal(h.starts, 2);
  assert.equal(h.mode, 'listening');
});

test('replaying an old answer cancels a pending newer exchange', () => {
  const h = harness();
  h.type('The first question.');
  h.answer()();
  h.type('A newer question.');
  const replayFinish = h.replay();
  assert.equal(h.answer(), undefined, 'the cancelled newer reply must not interrupt replay');
  assert.equal(h.mode, 'speaking');
  replayFinish();
  assert.equal(h.mode, 'ready');
  assert.equal(h.starts, 0);
});

test('a late replay completion cannot stop a newly requested listening session', () => {
  const h = harness();
  h.type('The first question.');
  h.answer()();
  const replayFinish = h.replay();
  h.tapMic();
  h.tapMic();
  replayFinish();
  assert.equal(h.mode, 'listening');
  assert.equal(h.starts, 1);
});

test('replay clears listening intent before synchronous recognition abort events', () => {
  const h = harness({ synchronousAbort: true });
  h.type('The first question.');
  h.answer()();
  h.tapMic();
  const replayFinish = h.replay();
  assert.equal(h.starts, 1, 'aborting for replay must not restart recognition');
  assert.equal(h.mode, 'speaking');
  replayFinish();
  assert.equal(h.mode, 'ready');
});
