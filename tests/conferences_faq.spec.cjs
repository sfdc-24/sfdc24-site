// /conferences/ questions. A short accordion: one panel open at a time,
// smooth height when motion is allowed, instant when reduced. Start and
// Join stay on the Converspan room. The page still has no microphone.
const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const ROOM = 'https://converspan.com/room';
const PHONES = [
  { width: 390, height: 844 },
  { width: 375, height: 667 },
  { width: 320, height: 700 },
];
const LABELS = [
  'Where is the room?',
  'Does this page listen?',
  'Who keeps a transcript?',
  'What is left after?',
];
const ANSWERS = [
  'The Converspan room.',
  'No microphone here.',
  'Converspan, with consent.',
  'The sample recap.',
];

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.__srBuilt = 0;
    window.__srStarts = 0;
    window.__probes = { gum: 0, audio: 0, rtc: 0, fetch: 0, ws: 0, xhr: 0, beacon: 0 };
    class Rec {
      constructor() { window.__srBuilt += 1; }
      start() { window.__srStarts += 1; }
      stop() {}
      abort() {}
    }
    window.SpeechRecognition = Rec;
    window.webkitSpeechRecognition = Rec;

    function fromFaq() {
      var stack = '';
      try { stack = String(new Error().stack || ''); } catch (err) { stack = ''; }
      return stack.indexOf('faq.js') !== -1;
    }
    function wrapCtor(name, key) {
      var Orig = window[name];
      if (typeof Orig !== 'function') return;
      var Wrapped = function () {
        window.__probes[key] += 1;
        return Reflect.construct(Orig, arguments, Orig);
      };
      Wrapped.prototype = Orig.prototype;
      Object.defineProperty(window, name, { configurable: true, writable: true, value: Wrapped });
    }
    wrapCtor('AudioContext', 'audio');
    wrapCtor('webkitAudioContext', 'audio');
    wrapCtor('RTCPeerConnection', 'rtc');
    wrapCtor('webkitRTCPeerConnection', 'rtc');
    var devices = navigator.mediaDevices;
    if (devices && typeof devices.getUserMedia === 'function') {
      var gum = devices.getUserMedia.bind(devices);
      devices.getUserMedia = function () {
        window.__probes.gum += 1;
        return gum.apply(null, arguments);
      };
    }
    if (typeof window.fetch === 'function') {
      var fetchOrig = window.fetch;
      window.fetch = function () {
        if (fromFaq()) window.__probes.fetch += 1;
        return fetchOrig.apply(this, arguments);
      };
    }
    if (typeof window.WebSocket === 'function') {
      var WS = window.WebSocket;
      var WrappedWS = function () {
        window.__probes.ws += 1;
        return Reflect.construct(WS, arguments, WS);
      };
      WrappedWS.prototype = WS.prototype;
      window.WebSocket = WrappedWS;
    }
    if (typeof window.XMLHttpRequest === 'function') {
      var XHR = window.XMLHttpRequest;
      var WrappedXHR = function () {
        if (fromFaq()) window.__probes.xhr += 1;
        return Reflect.construct(XHR, arguments, XHR);
      };
      WrappedXHR.prototype = XHR.prototype;
      window.XMLHttpRequest = WrappedXHR;
    }
    if (typeof navigator.sendBeacon === 'function') {
      var beacon = navigator.sendBeacon.bind(navigator);
      navigator.sendBeacon = function () {
        if (fromFaq()) window.__probes.beacon += 1;
        return beacon.apply(null, arguments);
      };
    }
  });
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://site.test') return route.abort();
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.resolve(root, '.' + rel);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) {
      return route.fulfill({ status: 404, body: '' });
    }
    const types = {
      '.html': 'text/html',
      '.js': 'application/javascript',
      '.css': 'text/css',
      '.json': 'application/json',
      '.png': 'image/png',
      '.ico': 'image/x-icon',
    };
    return route.fulfill({
      body: fs.readFileSync(file),
      contentType: types[path.extname(file)] || 'text/plain',
    });
  });
});

function button(page, n) {
  return page.locator(`#conference-faq-q${n}`);
}
function panel(page, n) {
  return page.locator(`#conference-faq-a${n}`);
}

async function heightOf(locator) {
  return locator.evaluate((el) => el.getBoundingClientRect().height);
}

async function settle(locator) {
  await locator.evaluate(async (el) => {
    const pending = el.getAnimations({ subtree: true }).map((anim) => anim.finished);
    if (pending.length) await Promise.all(pending);
  });
}

test('a question opens and closes, and only one stays open', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.setViewportSize(PHONES[0]);
  await page.goto('http://site.test/conferences/');
  const faq = page.locator('#conference-faq');
  await expect(faq).toHaveAttribute('aria-labelledby', 'conference-faq-title');
  await expect(page.locator('#conference-faq-title')).toHaveText('Questions');
  const buttons = faq.locator('.faq-btn');
  await expect(buttons).toHaveCount(4);
  await expect(buttons).toHaveText(LABELS);
  for (let i = 1; i <= 4; i++) {
    await expect(button(page, i)).toHaveAttribute('aria-expanded', 'false');
    await expect(panel(page, i)).toHaveAttribute('aria-hidden', 'true');
    await expect(panel(page, i)).toHaveAttribute('inert', '');
    expect(await heightOf(panel(page, i))).toBeLessThan(1);
  }

  const first = await page.evaluate(() => new Promise((resolve) => {
    const btn = document.getElementById('conference-faq-q1');
    const pane = document.getElementById('conference-faq-a1');
    const before = pane.getBoundingClientRect().height;
    btn.click();
    requestAnimationFrame(() => {
      const anims = pane.getAnimations();
      resolve({
        before,
        height: pane.getBoundingClientRect().height,
        expanded: btn.getAttribute('aria-expanded'),
        running: anims.some((anim) => anim.playState === 'running'),
        duration: getComputedStyle(pane).transitionDuration,
      });
    });
  }));
  expect(first.expanded).toBe('true');
  expect(['0.24s', '240ms']).toContain(first.duration);
  expect(first.running).toBe(true);
  expect(first.height).toBeGreaterThanOrEqual(first.before);
  await settle(panel(page, 1));
  expect(await heightOf(panel(page, 1))).toBeGreaterThan(24);
  await expect(panel(page, 1)).not.toHaveAttribute('aria-hidden');
  await expect(panel(page, 1)).not.toHaveAttribute('inert');
  await expect(panel(page, 1).locator('p')).toHaveText(ANSWERS[0]);
  const openChevron = await button(page, 1).locator('.faq-chev').evaluate((el) => getComputedStyle(el).transform);
  expect(openChevron).not.toBe('none');

  await button(page, 2).click();
  await settle(faq);
  await expect(button(page, 1)).toHaveAttribute('aria-expanded', 'false');
  await expect(button(page, 2)).toHaveAttribute('aria-expanded', 'true');
  expect(await heightOf(panel(page, 1))).toBeLessThan(1);
  expect(await heightOf(panel(page, 2))).toBeGreaterThan(24);
  await expect(panel(page, 2).locator('p')).toHaveText(ANSWERS[1]);

  await button(page, 2).click();
  await settle(panel(page, 2));
  await expect(button(page, 2)).toHaveAttribute('aria-expanded', 'false');
  expect(await heightOf(panel(page, 2))).toBeLessThan(1);
  const shut = await button(page, 2).locator('.faq-chev').evaluate((el) => getComputedStyle(el).transform);
  expect(['none', 'matrix(1, 0, 0, 1, 0, 0)']).toContain(shut);

  await expect(page.locator('#conference-start')).toHaveAttribute('href', ROOM);
  await expect(page.locator('#conference-join')).toHaveAttribute('href', ROOM);
  expect(await page.locator('#conference-start').getAttribute('target')).toBeNull();
  expect(await page.locator('#conference-join').getAttribute('target')).toBeNull();
  await expect(page.locator(`a[href="${ROOM}"]`)).toHaveCount(4);
  await expect(page.locator('#conference-flow .flowbar-go')).toHaveAttribute('href', '#conference-actions');
});

test('the keyboard opens, closes, and moves between questions', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize(PHONES[1]);
  await page.goto('http://site.test/conferences/');
  await button(page, 1).focus();
  await expect(button(page, 1)).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(button(page, 1)).toHaveAttribute('aria-expanded', 'true');
  expect(await heightOf(panel(page, 1))).toBeGreaterThan(24);
  await expect(panel(page, 1).locator('p')).toHaveText(ANSWERS[0]);

  await page.keyboard.press('ArrowDown');
  await expect(button(page, 2)).toBeFocused();
  await expect(button(page, 2)).toHaveAttribute('aria-expanded', 'false');
  await page.keyboard.press('Space');
  await expect(button(page, 2)).toHaveAttribute('aria-expanded', 'true');
  await expect(button(page, 1)).toHaveAttribute('aria-expanded', 'false');
  expect(await heightOf(panel(page, 1))).toBeLessThan(1);
  expect(await heightOf(panel(page, 2))).toBeGreaterThan(24);

  await page.keyboard.press('ArrowDown');
  await expect(button(page, 3)).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(button(page, 4)).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(button(page, 4)).toBeFocused();
  await page.keyboard.press('End');
  await expect(button(page, 4)).toBeFocused();
  await page.keyboard.press('Home');
  await expect(button(page, 1)).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(button(page, 1)).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(button(page, 1)).toHaveAttribute('aria-expanded', 'true');
  await expect(button(page, 2)).toHaveAttribute('aria-expanded', 'false');
  await page.keyboard.press('Enter');
  await expect(button(page, 1)).toHaveAttribute('aria-expanded', 'false');
  expect(await heightOf(panel(page, 1))).toBeLessThan(1);

  await expect(page.locator('#conference-start')).toHaveAttribute('href', ROOM);
  await expect(page.locator('#conference-join')).toHaveAttribute('href', ROOM);
  await expect(page.locator(`a[href="${ROOM}"]`)).toHaveCount(4);
});

test('reduced motion opens and closes with no transition', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize(PHONES[0]);
  await page.goto('http://site.test/conferences/');
  const snap = await page.evaluate(() => {
    const btn = document.getElementById('conference-faq-q3');
    const pane = document.getElementById('conference-faq-a3');
    const inner = pane.querySelector('.faq-panel-in');
    const chev = btn.querySelector('.faq-chev');
    const read = (node) => {
      const style = getComputedStyle(node);
      return {
        duration: style.transitionDuration,
        animation: style.animationName,
        opacity: style.opacity,
      };
    };
    const closed = pane.getBoundingClientRect().height;
    btn.click();
    return {
      closed,
      open: pane.getBoundingClientRect().height,
      expanded: btn.getAttribute('aria-expanded'),
      anims: pane.getAnimations({ subtree: true }).length,
      pane: read(pane),
      inner: read(inner),
      chev: read(chev),
      transform: getComputedStyle(chev).transform,
    };
  });
  expect(snap.closed).toBeLessThan(1);
  expect(snap.open).toBeGreaterThan(24);
  expect(snap.expanded).toBe('true');
  expect(snap.anims).toBe(0);
  for (const part of [snap.pane, snap.inner, snap.chev]) {
    expect(part.duration).toBe('0s');
    expect(part.animation).toBe('none');
  }
  expect(snap.inner.opacity).toBe('1');
  expect(snap.transform).not.toBe('none');

  const shut = await page.evaluate(() => {
    const btn = document.getElementById('conference-faq-q3');
    const pane = document.getElementById('conference-faq-a3');
    btn.click();
    return {
      height: pane.getBoundingClientRect().height,
      expanded: btn.getAttribute('aria-expanded'),
      anims: pane.getAnimations({ subtree: true }).length,
      transform: getComputedStyle(btn.querySelector('.faq-chev')).transform,
    };
  });
  expect(shut.height).toBeLessThan(1);
  expect(shut.expanded).toBe('false');
  expect(shut.anims).toBe(0);
  expect(['none', 'matrix(1, 0, 0, 1, 0, 0)']).toContain(shut.transform);
  await expect(panel(page, 3).locator('p')).toHaveText(ANSWERS[2]);
});

test('switching on reduced motion makes the next toggle instant', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.setViewportSize(PHONES[0]);
  await page.goto('http://site.test/conferences/');
  await button(page, 4).click();
  await settle(panel(page, 4));
  expect(await heightOf(panel(page, 4))).toBeGreaterThan(24);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const shut = await page.evaluate(() => {
    const btn = document.getElementById('conference-faq-q4');
    const pane = document.getElementById('conference-faq-a4');
    btn.click();
    const style = getComputedStyle(pane);
    return {
      height: pane.getBoundingClientRect().height,
      duration: style.transitionDuration,
      anims: pane.getAnimations({ subtree: true }).length,
    };
  });
  expect(shut.duration).toBe('0s');
  expect(shut.anims).toBe(0);
  expect(shut.height).toBeLessThan(1);
  const again = await page.evaluate(() => {
    const btn = document.getElementById('conference-faq-q4');
    const pane = document.getElementById('conference-faq-a4');
    btn.click();
    return pane.getBoundingClientRect().height;
  });
  expect(again).toBeGreaterThan(24);
});

test('opening questions never arms a microphone, a call, or a socket', async ({ page }) => {
  const outside = [];
  page.on('request', (req) => {
    if (!req.url().startsWith('http://site.test/')) outside.push(req.url());
  });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize(PHONES[0]);
  await page.goto('http://site.test/conferences/');
  for (let i = 1; i <= 4; i++) {
    await button(page, i).click();
    await expect(panel(page, i).locator('p')).toHaveText(ANSWERS[i - 1]);
  }
  await button(page, 4).click();
  const js = fs.readFileSync(path.join(root, 'conferences', 'faq.js'), 'utf8');
  for (const needle of [
    'getUserMedia', 'RTCPeerConnection', 'AudioContext', 'WebSocket',
    'fetch(', 'XMLHttpRequest', 'sendBeacon', 'EventSource', 'SpeechRecognition',
  ]) {
    expect(js).not.toContain(needle);
  }
  await expect(page.locator('body')).toHaveAttribute('data-chrome-ask', 'off');
  await expect(page.locator('.facts')).toContainText('PIPEDA and the CRTC require consent');
  await expect(page.locator('.facts')).toContainText('No microphone');
  await expect(page.locator('.facts')).toContainText('No transcript or recording');
  await expect(page.locator('.facts')).toContainText('Sends no name or company');
  await expect(page.locator('.chrome-disclaimer')).toContainText('sfdc24.com is an independent community resource');
  await expect(page.locator('.chrome-disclaimer')).toContainText('not affiliated with, endorsed by, or sponsored by Salesforce');
  await expect(page.locator('#chrome-mic')).toHaveCount(0);
  await expect(page.locator('#chrome-ask, #chrome-ask-shell, #chrome-box')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /ask out loud|listening/i })).toHaveCount(0);
  await expect(page.locator('#conference-faq audio, #conference-faq video')).toHaveCount(0);
  await expect(page.locator('#conference-start')).toHaveAttribute('href', ROOM);
  await expect(page.locator('#conference-join')).toHaveAttribute('href', ROOM);
  await expect(page.locator(`a[href="${ROOM}"]`)).toHaveCount(4);
  expect(await page.evaluate(() => window.__srBuilt)).toBe(0);
  expect(await page.evaluate(() => window.__srStarts)).toBe(0);
  expect(await page.evaluate(() => window.__probes)).toEqual({
    gum: 0, audio: 0, rtc: 0, fetch: 0, ws: 0, xhr: 0, beacon: 0,
  });
  expect(await page.locator('body').innerHTML()).not.toMatch(/tel:/i);
  expect(outside.filter((url) => !url.startsWith('https://fonts.googleapis.com/') && !url.startsWith('https://fonts.gstatic.com/'))).toEqual([]);
});

for (const phone of PHONES) {
  test(`questions fit the phone at ${phone.width}x${phone.height}`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize(phone);
    await page.goto('http://site.test/conferences/');
    const faq = page.locator('#conference-faq');
    await faq.scrollIntoViewIfNeeded();
    const box = await faq.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(-1);
    expect(box.x + box.width).toBeLessThanOrEqual(phone.width + 1);
    await button(page, 1).click();
    const bits = await faq.locator('.faq-label, .faq-item.is-open .faq-panel p').evaluateAll((els) => els.map((el) => {
      const rect = el.getBoundingClientRect();
      return {
        text: (el.textContent || '').trim(),
        x: rect.x,
        right: rect.right,
        cut: el.scrollWidth > el.clientWidth + 1,
      };
    }));
    expect(bits.map((bit) => bit.text)).toEqual([LABELS[0], ANSWERS[0], LABELS[1], LABELS[2], LABELS[3]]);
    for (const bit of bits) {
      expect(bit.x, bit.text).toBeGreaterThanOrEqual(-1);
      expect(bit.right, bit.text).toBeLessThanOrEqual(phone.width + 1);
      expect(bit.cut, bit.text).toBe(false);
    }
    for (let i = 1; i <= 4; i++) {
      const hit = await button(page, i).boundingBox();
      expect(hit.height).toBeGreaterThanOrEqual(48);
      expect(hit.width).toBeGreaterThanOrEqual(48);
    }
    const sideways = await page.evaluate(() => {
      const el = document.scrollingElement || document.documentElement;
      return el.scrollWidth - el.clientWidth;
    });
    expect(sideways).toBeLessThanOrEqual(0);
    await expect(page.locator('#conference-start')).toHaveAttribute('href', ROOM);
    await expect(page.locator('#conference-join')).toHaveAttribute('href', ROOM);
  });
}
