// The first-party recovery contract for the homepage chat.
//
// WHY THIS FILE EXISTS
//   chatgpt-codex-desktop returned NO-GO on PR #10 with a defect Copilot had
//   also seen: at the 12-second slow state the page offered "Try again", but
//   `busy` was still true, so submit() returned at its own guard. The panel
//   vanished, the question came back, the spinner stayed, and nothing was
//   sent. The visitor's only way out silently did nothing.
//
//   Removing the guard would have been worse: a retry cannot cancel an
//   in-flight JSONP call, so reception() would run — and bill — twice for one
//   question.
//
//   A browser timeout also cannot prove the backend stopped. The contract below
//   therefore permits retry only after an explicit terminal server response,
//   never after a client-only timeout or script-load error.
//
// HOW IT RUNS
//   Zero dependencies, like tests/intake.cjs: the served index.html is read,
//   its inline script is executed in a vm with a hand-rolled DOM and a fake
//   clock, and the assertions are made against the real source. No jsdom, no
//   browser, no network. `node --test tests/homepage_recovery.cjs`.

const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const assert = require('node:assert/strict');
const { test } = require('node:test');

// Reviewers can point HOMEPAGE_HTML at an older candidate for an explicit
// negative control; CI and ordinary local runs always exercise ../index.html.
const homepagePath = process.env.HOMEPAGE_HTML
  ? path.resolve(process.env.HOMEPAGE_HTML)
  : path.join(__dirname, '../index.html');
const html = fs.readFileSync(homepagePath, 'utf8');

const inline = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)]
  .filter(([, attrs]) => !/\bsrc\s*=/i.test(attrs) && !/type\s*=\s*"application\/ld\+json"/i.test(attrs))
  .map(([, , body]) => body);

assert.ok(inline.length >= 1, 'the homepage must carry an inline chat script');
const script = inline[inline.length - 1];
assert.match(script, /function submit\(/, 'the last inline script must be the chat script');

// ---------------------------------------------------------------------------
// A DOM small enough to read and faithful enough to catch the bug.
// ---------------------------------------------------------------------------

function makeNode(tag) {
  const node = {
    tagName: String(tag || '').toLowerCase(),
    children: [],
    handlers: {},
    parentNode: null,
    className: '',
    id: '',
    textContent: '',
    hidden: false,
    disabled: false,
    value: '',
    scrollTop: 0,
    scrollHeight: 0,
    style: {},
    setAttribute() {},
    getAttribute() { return null; },
    focus() {},
    // Enough selector support for the page's own usage: it only ever asks for
    // a class (".chip"). Anything else should fail loudly rather than quietly
    // return nothing and let a test pass for the wrong reason.
    querySelectorAll(selector) {
      const m = /^\.([\w-]+)$/.exec(String(selector));
      if (!m) throw new Error(`harness does not implement selector ${selector}`);
      return descendants(this).filter((n) => String(n.className).split(/\s+/).includes(m[1]));
    },
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
    addEventListener(name, fn) { (this.handlers[name] = this.handlers[name] || []).push(fn); },
    removeEventListener() {},
    appendChild(child) { child.parentNode = this; this.children.push(child); return child; },
    removeChild(child) {
      const i = this.children.indexOf(child);
      if (i >= 0) this.children.splice(i, 1);
      child.parentNode = null;
      return child;
    },
    click() {
      if (this.disabled) return;
      (this.handlers.click || []).forEach((fn) => fn({ preventDefault() {} }));
    },
  };
  return node;
}

function descendants(node, out = []) {
  for (const c of node.children) { out.push(c); descendants(c, out); }
  return out;
}

function harness() {
  const clock = { now: 0, timers: new Map(), next: 1 };
  const requests = [];          // every JSONP script the page actually injected
  const named = new Map();      // id -> node

  for (const id of ['tape', 'box', 'send', 'mic', 'state', 'chips']) {
    const n = makeNode('div'); n.id = id; named.set(id, n);
  }
  named.get('box').value = '';

  const head = makeNode('head');
  const win = { __SFDC_VARIANT: 'b' };

  const document = {
    head,
    getElementById(id) {
      if (named.has(id)) return named.get(id);
      // "recovery" is created at runtime; find it wherever it was appended.
      const hit = descendants(named.get('tape')).find((n) => n.id === id);
      return hit || null;
    },
    createElement(tag) {
      const n = makeNode(tag);
      if (n.tagName === 'script') {
        let src = '';
        Object.defineProperty(n, 'src', {
          get: () => src,
          set(v) {
            src = v;
            // The page assigns .src and then appends to head; record on append
            // so we count only scripts that were actually issued.
          },
        });
      }
      return n;
    },
  };

  head.appendChild = function (child) {
    child.parentNode = this;
    this.children.push(child);
    if (child.tagName === 'script' && child.src) {
      const cb = new URLSearchParams(child.src.split('?')[1] || '').get('cb');
      requests.push({ src: child.src, cb, node: child });
    }
    return child;
  };

  const sandbox = {
    document,
    window: win,
    localStorage: {
      store: {},
      getItem(k) { return Object.prototype.hasOwnProperty.call(this.store, k) ? this.store[k] : null; },
      setItem(k, v) { this.store[k] = String(v); },
    },
    URL,
    URLSearchParams,
    Date,
    Math,
    console,
    setTimeout(fn, ms) {
      const id = clock.next++;
      clock.timers.set(id, { fn, at: clock.now + (ms || 0) });
      return id;
    },
    clearTimeout(id) { clock.timers.delete(id); },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  // The script says `window[cb] = ...`, so callbacks land on the window object.
  vm.runInContext(script, sandbox);

  function tick(ms) {
    const target = clock.now + ms;
    let guard = 0;
    for (;;) {
      let due = null, dueId = null;
      for (const [id, t] of clock.timers) {
        if (t.at <= target && (due === null || t.at < due.at)) { due = t; dueId = id; }
      }
      if (!due) break;
      if (++guard > 1000) throw new Error('timer storm');
      clock.now = due.at;
      clock.timers.delete(dueId);
      due.fn();
    }
    clock.now = target;
  }

  return {
    tick,
    requests,
    win,
    box: named.get('box'),
    state: named.get('state'),
    tape: named.get('tape'),
    recovery: () => descendants(named.get('tape')).find((n) => n.id === 'recovery') || null,
    ask(text) {
      const box = named.get('box');
      box.value = text;
      (box.handlers.input || []).forEach((fn) => fn({}));
      const send = named.get('send');
      // submit() is reachable through the send button's click handler.
      send.click();
    },
    reply(cb, res) {
      const fn = win[cb];
      assert.equal(typeof fn, 'function', `callback ${cb} must still be registered`);
      fn(res);
    },
    fail(cb) {
      const request = requests.find((r) => r.cb === cb);
      assert.ok(request, `request ${cb} must exist`);
      assert.equal(typeof request.node.onerror, 'function', `request ${cb} must have an error handler`);
      request.node.onerror();
    },
    callbackAlive(cb) { return typeof win[cb] === 'function'; },
  };
}

// ---------------------------------------------------------------------------
// The contract
// ---------------------------------------------------------------------------

test('12s: the slow panel offers email only, never a retry that cannot fire', () => {
  const h = harness();
  h.ask('what does stage duration actually measure');
  assert.equal(h.requests.length, 1, 'asking issues exactly one request');

  h.tick(12000);

  const panel = h.recovery();
  assert.ok(panel, 'the 12s state must show a way out');

  const buttons = descendants(panel).filter((n) => n.tagName === 'button');
  assert.equal(buttons.length, 0,
    'no button at 12s: busy is still true, so a retry would clear the panel and do nothing');

  const mail = descendants(panel).find((n) => n.tagName === 'a');
  assert.ok(mail && String(mail.href).startsWith('mailto:'),
    'the 12s state must still offer the email exit');

  assert.equal(h.requests.length, 1, 'showing the slow panel must not issue a second request');
});

test('12s: a late reply still arrives and clears the panel', () => {
  const h = harness();
  h.ask('eleven flows on Opportunity, where do I start');
  const first = h.requests[0].cb;

  h.tick(12000);
  assert.ok(h.recovery(), 'panel is up');

  h.reply(first, { ok: true, reply: 'Start with what breaks if you switch one off.' });

  assert.equal(h.recovery(), null, 'a late reply clears the recovery panel');
  assert.equal(h.requests.length, 1, 'the late reply does not cause a retry');
  const said = descendants(h.tape).map((n) => n.textContent).join(' ');
  assert.match(said, /breaks if you switch one off/, 'the late answer is displayed, not discarded');
});

test('45s: an unknown outcome offers email only and never sends twice', () => {
  const h = harness();
  h.ask('can you look at our lead routing');
  assert.equal(h.requests.length, 1);
  const first = h.requests[0].cb;

  h.tick(45000);

  const panel = h.recovery();
  assert.ok(panel, 'the unknown-outcome state must show a way out');
  const buttons = descendants(panel).filter((n) => n.tagName === 'button');
  assert.equal(buttons.length, 0,
    'a client timeout cannot prove backend termination, so it must not expose retry');
  const mail = descendants(panel).find((n) => n.tagName === 'a');
  assert.ok(mail && String(mail.href).startsWith('mailto:'),
    'an unknown outcome must retain the email exit');
  assert.equal(h.callbackAlive(first), true,
    'the original callback stays alive so a genuinely slow answer can still arrive');

  h.ask('can you look at our lead routing');
  assert.equal(h.requests.length, 1,
    'the chat remains busy and will not issue a duplicate while outcome is unknown');
});

test('45s: the original answer can still arrive after the uncertainty notice', () => {
  const h = harness();
  h.ask('what is our omnistudio situation');
  const first = h.requests[0].cb;

  h.tick(45000);
  assert.equal(h.callbackAlive(first), true);
  h.reply(first, { ok: true, reply: 'The original request finished safely.' });

  assert.equal(h.recovery(), null, 'a confirmed late result clears the uncertainty panel');
  assert.equal(h.requests.length, 1, 'the late result never creates another request');
  const said = descendants(h.tape).map((n) => n.textContent).join(' ');
  assert.match(said, /original request finished safely/i);
});

test('an explicit terminal server failure may offer one real retry', () => {
  const h = harness();
  h.ask('which flow should I inspect');
  const first = h.requests[0].cb;

  h.reply(first, { ok: false, error: 'provider unavailable' });

  const panel = h.recovery();
  assert.ok(panel, 'a terminal server failure shows recovery');
  const buttons = descendants(panel).filter((n) => n.tagName === 'button');
  assert.equal(buttons.length, 1,
    'retry is allowed only because the server returned a terminal response');
  buttons[0].click();
  assert.equal(h.requests.length, 2, 'one click issues exactly one new request');
  assert.notEqual(h.requests[0].cb, h.requests[1].cb, 'the retry uses a fresh callback');
});

test('a script-load error is also unknown and cannot enable a duplicate', () => {
  const h = harness();
  h.ask('show me our assignment rules');
  const first = h.requests[0].cb;

  h.fail(first);

  const panel = h.recovery();
  assert.ok(panel, 'a transport error must show the email recovery path');
  assert.equal(descendants(panel).filter((n) => n.tagName === 'button').length, 0,
    'transport failure does not prove the backend stopped and must not expose retry');
  assert.equal(h.callbackAlive(first), false, 'a failed script load is cleaned up');
  h.ask('show me our assignment rules');
  assert.equal(h.requests.length, 1, 'the busy guard prevents a duplicate after transport uncertainty');
});

test('a transport error after 45s withdraws the promise that waiting can still help', () => {
  const h = harness();
  h.ask('explain our entitlement checks');
  const first = h.requests[0].cb;

  h.tick(45000);
  let copy = descendants(h.recovery()).map((n) => n.textContent).join(' ');
  assert.match(copy, /keep waiting/i,
    'while the callback is alive, the visitor may still wait for the original answer');
  assert.equal(h.callbackAlive(first), true);

  h.fail(first);

  const panel = h.recovery();
  copy = descendants(panel).map((n) => n.textContent).join(' ');
  assert.equal(h.callbackAlive(first), false, 'the failed transport removes the callback');
  assert.doesNotMatch(copy, /keep waiting/i,
    'the page must not promise an answer after it can no longer receive one');
  assert.match(copy, /can no longer receive the original answer/i);
  assert.equal(descendants(panel).filter((n) => n.tagName === 'button').length, 0,
    'the original backend outcome is still unknown, so retry remains forbidden');
  assert.ok(descendants(panel).find((n) => n.tagName === 'a' && String(n.href).startsWith('mailto:')),
    'email remains the honest recovery path');
  h.ask('explain our entitlement checks');
  assert.equal(h.requests.length, 1, 'the transition never issues a second request');
});

test('the page works with no JavaScript at all', () => {
  const noscript = html.match(/<noscript>([\s\S]*?)<\/noscript>/i);
  assert.ok(noscript, 'the homepage must carry a noscript fallback');
  assert.match(noscript[1], /mailto:[^"']+/,
    'with scripting off, the only way to reach a human must still be on the page');
});
