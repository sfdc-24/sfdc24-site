// Execute the actual page-only handoff script against a bounded DOM stub.
// This is a logic test, not browser rendering or proof of voice shutdown.
// No network, media, timers or provider interfaces are available here.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../workroom/index.html'), 'utf8');
const scripts = [...source.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)]
  .map(match => match[1]).filter(script => script.includes('function syncHandoff()'));
const target = '/#owner-conference-start';

function setup() {
  let active = false, changed;
  const voice = { classList: { contains: name => name === 'vc-live' && active } };
  const count = [...source.matchAll(/<a\b[^>]*href="\/#owner-conference-start"[^>]*>/g)].length;
  assert.ok(count > 0);
  const links = Array.from({ length: count }, () => {
    const attributes = new Map([['href', target]]);
    return { attributes,
      setAttribute: (name, value) => attributes.set(name, String(value)),
      removeAttribute: name => attributes.delete(name),
      set tabIndex(value) { attributes.set('tabindex', String(value)); },
    };
  });
  const status = { textContent: '' };
  class MutationObserver {
    constructor(callback) { changed = callback; }
    observe(node, options) {
      assert.equal(node, voice);
      assert.equal(options.attributes, true);
      assert.equal(Array.from(options.attributeFilter).join(','), 'class');
    }
  }
  const document = {
    getElementById: id => id === 'voice-conversation' ? voice : id === 'handoff-status' ? status : null,
    querySelectorAll: selector => {
      assert.equal(selector, 'a[href="/#owner-conference-start"]'); return links;
    },
  };
  assert.equal(scripts.length, 1);
  vm.runInNewContext(scripts[0], { document, MutationObserver }, { timeout: 1000 });
  return { links, status, setActive(value) { active = value; changed(); } };
}

test('all owner handoff links initially navigate to Home in this tab', () => {
  const { links, status } = setup();
  for (const link of links) {
    assert.equal(link.attributes.get('href'), target);
    assert.equal(link.attributes.has('aria-disabled'), false);
    assert.equal(link.attributes.has('tabindex'), false);
  }
  assert.equal(status.textContent, '');
  const tags = [...source.matchAll(/<a\b[^>]*href="\/#owner-conference-start"[^>]*>/g)].map(m => m[0]);
  assert.ok(tags.every(tag => !/target=/.test(tag) || /target="_self"/.test(tag)));
});

test('active Studio removes every handoff destination and announces End first', () => {
  const state = setup();
  state.setActive(true);
  for (const link of state.links) {
    assert.equal(link.attributes.has('href'), false);
    assert.equal(link.attributes.get('aria-disabled'), 'true');
    assert.equal(link.attributes.get('tabindex'), '-1');
  }
  assert.match(state.status.textContent, /End conversation/);
});

test('ending and restarting restores then disables all handoff links', () => {
  const state = setup();
  state.setActive(true); state.setActive(false);
  for (const link of state.links) {
    assert.equal(link.attributes.get('href'), target);
    assert.equal(link.attributes.has('aria-disabled'), false);
    assert.equal(link.attributes.has('tabindex'), false);
  }
  assert.equal(state.status.textContent, '');
  state.setActive(true);
  assert.ok(state.links.every(link => !link.attributes.has('href')));
});
