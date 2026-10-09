// The voice-room handoff on /experience/: the page's own script, run against a
// small DOM stub (the pattern of tests/workroom_handoff.cjs in sfdc24-site PR 290).
// A logic test, not browser rendering; tests/experience_page.spec.cjs renders it.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../experience/index.html'), 'utf8');
const scripts = [...source.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)]
  .map(m => m[1]).filter(s => s.includes('function syncHandoff()'));
const GATEWAY = 'https://conference-gateway-yzet4vuplq-uc.a.run.app/';

function setup() {
  let active = false, changed;
  const voice = { classList: { contains: name => name === 'vc-live' && active } };
  const attributes = new Map([['href', GATEWAY]]);
  const link = {
    attributes,
    getAttribute: name => (attributes.has(name) ? attributes.get(name) : null),
    setAttribute: (name, value) => attributes.set(name, String(value)),
    removeAttribute: name => attributes.delete(name),
    set tabIndex(value) { attributes.set('tabindex', String(value)); },
  };
  const status = { textContent: '' };
  class MutationObserver {
    constructor(cb) { changed = cb; }
    observe(node, options) {
      assert.equal(node, voice);
      assert.equal(options.attributes, true);
      assert.equal(Array.from(options.attributeFilter).join(','), 'class');
    }
  }
  const document = {
    getElementById: id => ({ 'experience-voice': voice, 'experience-voice-room': link,
                             'experience-handoff-status': status })[id] || null,
  };
  assert.equal(scripts.length, 1);
  vm.runInNewContext(scripts[0], { document, MutationObserver }, { timeout: 1000 });
  return { link, status, setActive(v) { active = v; changed(); } };
}

test('the voice-room link starts enabled, pointing at the gateway', () => {
  const { link, status } = setup();
  assert.equal(link.attributes.get('href'), GATEWAY);
  assert.equal(link.attributes.has('aria-disabled'), false);
  assert.equal(link.attributes.has('tabindex'), false);
  assert.equal(status.textContent, '');
});

test('a live studio conversation switches the link off and says End first', () => {
  const s = setup();
  s.setActive(true);
  assert.equal(s.link.attributes.has('href'), false);
  assert.equal(s.link.attributes.get('aria-disabled'), 'true');
  assert.equal(s.link.attributes.get('tabindex'), '-1');
  assert.match(s.status.textContent, /End conversation/);
});

test('End restores the same gateway link; a new start switches it off again', () => {
  const s = setup();
  s.setActive(true); s.setActive(false);
  assert.equal(s.link.attributes.get('href'), GATEWAY);
  assert.equal(s.link.attributes.has('aria-disabled'), false);
  assert.equal(s.link.attributes.has('tabindex'), false);
  assert.equal(s.status.textContent, '');
  s.setActive(true);
  assert.equal(s.link.attributes.has('href'), false);
});
