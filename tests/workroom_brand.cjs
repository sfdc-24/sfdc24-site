// Pure clock logic from the actual workroom script, with bounded DOM/timer
// stubs. No browser, network, voice session, or analytics bootstrap runs.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../workroom/index.html'), 'utf8');
const script = source.match(/<script data-workroom-brand>([\s\S]*?)<\/script>/)[1];

function setup(iso) {
  let now = new Date(iso), tick;
  const mark = { innerHTML: '' }, calendar = { textContent: '', dateTime: '' };
  const document = {
    querySelectorAll(selector) {
      if (selector === 'a.chrome-mark[data-live-brand], a.mark[data-live-brand]') return [mark];
      if (selector === '.header-calendar') return [calendar];
      throw new Error('Unexpected selector: ' + selector);
    },
    getElementById(id) { assert.equal(id, 'today'); return null; },
  };
  class ClockDate extends Date { constructor() { super(now); } }
  vm.runInNewContext(script, { document, Intl, Date: ClockDate,
    setInterval(fn, ms) { assert.equal(ms, 1000); tick = fn; },
  }, { timeout: 1000 });
  return { mark, calendar, advance(iso) { now = new Date(iso); tick(); } };
}

test('brand shows SFDC and Toronto 24-hour time without a second wordmark', () => {
  const state = setup('2026-10-09T03:30:00Z');
  assert.equal(state.mark.innerHTML, 'SFDC<span class="chrome-clock">23:30</span>');
  assert.equal(state.calendar.dateTime, '2026-10-08');
});

test('clock and Toronto date advance across midnight', () => {
  const state = setup('2026-10-09T03:59:00Z');
  state.advance('2026-10-09T04:00:00Z');
  assert.equal(state.mark.innerHTML, 'SFDC<span class="chrome-clock">00:00</span>');
  assert.equal(state.calendar.dateTime, '2026-10-09');
});
