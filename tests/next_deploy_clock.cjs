// Release clock promise. A checkpoint more than 12 hours past is not a count-up.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../assets/next-deploy.js'), 'utf8');
const sandbox = {
  window: {},
  document: {
    readyState: 'loading',
    addEventListener() {},
    getElementById() { return null; },
    createElement() { return {style: {}, appendChild() {}, setAttribute() {}}; },
    querySelector() { return null; },
    head: {appendChild() {}},
    body: {appendChild() {}},
    documentElement: {appendChild() {}}
  },
  location: {pathname: '/method/'},
  setInterval() {},
  setTimeout() {},
  fetch() { return Promise.resolve({ok: false}); }
};
vm.runInNewContext(source, sandbox, {filename: 'next-deploy.js'});
const clock = sandbox.window.Sfdc24Release;
const HOUR = 60 * 60 * 1000;

test('unset, countdown, a short overrun, and a stale checkpoint', () => {
  assert.equal(clock.EXPIRED_MS, 12 * HOUR);
  const noon = Date.parse('2026-10-07T16:00:00Z');
  assert.equal(clock.releasePromise('', noon), 'unset');
  assert.equal(clock.releasePromise(null, noon), 'unset');
  assert.equal(clock.releasePromise('not-a-time', noon), 'unset');
  assert.equal(clock.releasePromise('2026-10-07T18:00:00Z', noon), 'countdown');
  assert.equal(clock.releasePromise('2026-10-07T15:00:00Z', noon), 'elapsed');
  assert.equal(clock.releasePromise(new Date(noon - 12 * HOUR).toISOString(), noon), 'elapsed');
  assert.equal(clock.releasePromise(new Date(noon - 12 * HOUR - 1).toISOString(), noon), 'expired');
  assert.equal(clock.releasePromise('2026-09-29T13:00:00Z', Date.parse('2026-10-07T17:00:00Z')), 'expired');
});
