// /conferences/ readiness row. Feature detect only: the chips light up
// after the card scrolls into view. Nothing may call getUserMedia, build a
// peer connection or an audio context, or open a network request.
const { test, expect } = require('@playwright/test');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const ROOM = 'https://converspan.com/room';
const PHONES = [
  { width: 390, height: 844 },
  { width: 375, height: 667 },
];
const shotDir = '/opt/cursor/artifacts';

test.use({ ignoreHTTPSErrors: true });

const TYPE_LABELS = { wifi: 'Wi-Fi', ethernet: 'Ethernet', cellular: 'Cellular', bluetooth: 'Bluetooth', wimax: 'WiMAX' };
const RATE_LABELS = { 'slow-2g': 'Slow 2G', '2g': '2G', '3g': '3G', '4g': '4G' };

function linkFrom(online, type, rate) {
  if (!online || type === 'none') return { ok: false, text: 'You look offline' };
  if (TYPE_LABELS[type]) return { ok: true, text: TYPE_LABELS[type] };
  if (RATE_LABELS[rate]) return { ok: true, text: RATE_LABELS[rate] };
  return { ok: true, text: 'Online' };
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.__srBuilt = 0;
    window.__srStarts = 0;
    window.__probes = { gum: 0, audio: 0, rtc: 0, fetch: 0, ws: 0, xhr: 0, beacon: 0, perm: 0, enum: 0 };
    window.__readyTimerStacks = [];
    class Rec {
      constructor() { window.__srBuilt += 1; }
      start() { window.__srStarts += 1; }
      stop() {}
      abort() {}
    }
    window.SpeechRecognition = Rec;
    window.webkitSpeechRecognition = Rec;

    function noteTimer(name) {
      var stack = '';
      try { stack = String(new Error().stack || ''); } catch (err) { stack = ''; }
      if (stack.indexOf('ready.js') !== -1) window.__readyTimerStacks.push(name);
    }
    var setTimeoutOrig = window.setTimeout;
    var setIntervalOrig = window.setInterval;
    var rafOrig = window.requestAnimationFrame;
    window.setTimeout = function () { noteTimer('setTimeout'); return setTimeoutOrig.apply(this, arguments); };
    window.setInterval = function () { noteTimer('setInterval'); return setIntervalOrig.apply(this, arguments); };
    window.requestAnimationFrame = function () { noteTimer('requestAnimationFrame'); return rafOrig.apply(this, arguments); };

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
    if (devices && typeof devices.enumerateDevices === 'function') {
      var listDevices = devices.enumerateDevices.bind(devices);
      devices.enumerateDevices = function () {
        window.__probes.enum += 1;
        return listDevices.apply(null, arguments);
      };
    }
    if (navigator.permissions && typeof navigator.permissions.query === 'function') {
      var query = navigator.permissions.query.bind(navigator.permissions);
      navigator.permissions.query = function () {
        window.__probes.perm += 1;
        return query.apply(null, arguments);
      };
    }
    function fromReady() {
      var stack = '';
      try { stack = String(new Error().stack || ''); } catch (err) { stack = ''; }
      return stack.indexOf('ready.js') !== -1;
    }
    if (typeof window.fetch === 'function') {
      var fetchOrig = window.fetch;
      window.fetch = function () {
        if (fromReady()) window.__probes.fetch += 1;
        return fetchOrig.apply(this, arguments);
      };
    }
    if (typeof window.WebSocket === 'function') {
      var WS = window.WebSocket;
      var WrappedWS = function () {
        if (fromReady()) window.__probes.ws += 1;
        return Reflect.construct(WS, arguments, WS);
      };
      WrappedWS.prototype = WS.prototype;
      window.WebSocket = WrappedWS;
    }
    if (typeof window.XMLHttpRequest === 'function') {
      var XHR = window.XMLHttpRequest;
      var WrappedXHR = function () {
        if (fromReady()) window.__probes.xhr += 1;
        return Reflect.construct(XHR, arguments, XHR);
      };
      WrappedXHR.prototype = XHR.prototype;
      window.XMLHttpRequest = WrappedXHR;
    }
    if (typeof navigator.sendBeacon === 'function') {
      var beacon = navigator.sendBeacon.bind(navigator);
      navigator.sendBeacon = function () {
        if (fromReady()) window.__probes.beacon += 1;
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

async function leaksOf(page) {
  return page.evaluate(() => window.__probes);
}

async function contrast(locator) {
  return locator.evaluate((el) => {
    const rgb = (s) => (s.match(/[\d.]+/g) || []).map(Number);
    const lum = ([r, g, b]) => {
      const c = [r, g, b].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
      return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    };
    const fg = rgb(getComputedStyle(el).color);
    let node = el, bg = null;
    while (node && !bg) {
      const c = rgb(getComputedStyle(node).backgroundColor);
      if (c.length >= 3 && (c.length === 3 || c[3] > 0.95)) bg = c;
      node = node.parentElement;
    }
    bg = bg || [255, 255, 255];
    let alpha = 1;
    for (let n = el; n; n = n.parentElement) alpha *= Number(getComputedStyle(n).opacity);
    const shown = fg.slice(0, 3).map((v, i) => alpha * v + (1 - alpha) * bg[i]);
    const [a, b] = [lum(shown), lum(bg)].sort((x, y) => y - x);
    return (a + 0.05) / (b + 0.05);
  });
}

async function shownIcon(chip) {
  return chip.evaluate((el) => {
    const shown = [];
    for (const svg of el.querySelectorAll('.ready-ico')) {
      if (getComputedStyle(svg).display === 'none') continue;
      shown.push((svg.getAttribute('class') || '').split(/\s+/).find((name) => name.indexOf('ico-') === 0));
    }
    return shown;
  });
}

async function settle(page) {
  const ready = page.locator('#conference-ready');
  await ready.scrollIntoViewIfNeeded();
  await expect(ready).toHaveClass(/is-in/);
  await expect(ready.locator('.ready-chip[data-state="pending"]')).toHaveCount(0);
  return ready;
}

test('the row reports this browser and does not ask, connect, or construct', async ({ page }) => {
  const outside = [];
  page.on('request', (req) => {
    if (!req.url().startsWith('http://site.test/')) outside.push(req.url());
  });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize(PHONES[0]);
  await page.goto('http://site.test/conferences/');
  const ready = await settle(page);
  await expect(ready).toHaveAttribute('aria-labelledby', 'conference-ready-title');
  await expect(page.locator('#conference-ready-title')).toHaveText('Ready to join?');
  await expect(ready.locator('.ready-note')).toHaveText('The Converspan room asks for the mic only after you choose to join.');
  await expect(ready.locator('.ready-list')).toHaveAttribute('aria-busy', 'false');
  const chips = ready.locator('.ready-chip');
  await expect(chips).toHaveCount(5);
  const states = await chips.evaluateAll((els) => els.map((el) => ({
    id: el.getAttribute('data-check'),
    state: el.getAttribute('data-state'),
    text: (el.querySelector('.ready-label').textContent || '').trim(),
  })));
  expect(states.map((row) => row.id)).toEqual(['https', 'webrtc', 'mic', 'audio', 'link']);
  expect(states[0]).toEqual({ id: 'https', state: 'fail', text: 'Use HTTPS' });
  expect(states[1]).toEqual({ id: 'webrtc', state: 'pass', text: 'Calls' });
  // This origin is http, so Chrome does not expose mediaDevices at all.
  expect(states[2]).toEqual({ id: 'mic', state: 'fail', text: 'No mic API' });
  expect(states[3]).toEqual({ id: 'audio', state: 'pass', text: 'Audio' });
  const live = await page.evaluate(() => {
    const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection || null;
    return {
      online: navigator.onLine !== false,
      type: conn && conn.type ? String(conn.type) : '',
      rate: conn && conn.effectiveType ? String(conn.effectiveType) : '',
    };
  });
  const link = linkFrom(live.online, live.type, live.rate);
  expect(states[4]).toEqual({ id: 'link', state: link.ok ? 'pass' : 'fail', text: link.text });
  expect(await shownIcon(chips.nth(0))).toEqual(['ico-fail']);
  expect(await shownIcon(chips.nth(1))).toEqual(['ico-pass']);
  expect(await shownIcon(chips.nth(2))).toEqual(['ico-fail']);
  expect(states[0].text).not.toBe(states[1].text);
  const httpsColor = await chips.nth(0).locator('.ready-label').evaluate((el) => getComputedStyle(el).color);
  const callColor = await chips.nth(1).locator('.ready-label').evaluate((el) => getComputedStyle(el).color);
  expect(httpsColor).toBe(callColor);
  for (const target of [page.locator('#conference-ready-title'), ready.locator('.ready-note'), chips.nth(0).locator('.ready-label'), chips.nth(1).locator('.ready-label')]) {
    expect(await contrast(target)).toBeGreaterThanOrEqual(4.5);
  }
  for (let i = 0; i < 5; i++) {
    const box = await chips.nth(i).boundingBox();
    expect(box.height).toBeGreaterThanOrEqual(48);
    expect(box.width).toBeGreaterThanOrEqual(48);
  }
  await expect(ready).toHaveAttribute('data-watching', '0');
  await expect(page.locator('#conference-start')).toHaveAttribute('href', ROOM);
  await expect(page.locator('#conference-join')).toHaveAttribute('href', ROOM);
  await expect(page.locator(`a[href="${ROOM}"]`)).toHaveCount(4);
  await expect(page.locator('.consent')).toContainText('This page has no microphone and does not take a transcript.');
  await expect(page.locator('.chrome-disclaimer')).toContainText('not affiliated with, endorsed by, or sponsored by Salesforce');
  await expect(page.locator('#chrome-mic')).toHaveCount(0);
  await expect(page.locator('#conference-ready audio, #conference-ready video')).toHaveCount(0);
  const probes = await leaksOf(page);
  expect(probes).toEqual({ gum: 0, audio: 0, rtc: 0, fetch: 0, ws: 0, xhr: 0, beacon: 0, perm: 0, enum: 0 });
  expect(await page.evaluate(() => window.__srStarts)).toBe(0);
  expect(await page.evaluate(() => window.__readyTimerStacks)).toEqual([]);
  // The shared header already asks for its font. The readiness script adds no host.
  expect(outside.filter((url) => !url.startsWith('https://fonts.googleapis.com/') && !url.startsWith('https://fonts.gstatic.com/'))).toEqual([]);
});

test('a secure context lights the HTTPS chip without opening anything', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'isSecureContext', { configurable: true, get: () => true });
  });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize(PHONES[1]);
  await page.goto('http://site.test/conferences/');
  const ready = await settle(page);
  const https = ready.locator('[data-check="https"]');
  await expect(https).toHaveAttribute('data-state', 'pass');
  await expect(https.locator('.ready-label')).toHaveText('Secure');
  expect(await shownIcon(https)).toEqual(['ico-pass']);
  // The flag does not invent a microphone API. This http browser still has none.
  await expect(ready.locator('[data-check="mic"]')).toHaveAttribute('data-state', 'fail');
  await expect(ready.locator('[data-check="mic"] .ready-label')).toHaveText('No mic API');
  expect(await leaksOf(page)).toMatchObject({ gum: 0, audio: 0, rtc: 0, fetch: 0, ws: 0 });
});

test('a present getUserMedia function is named and never called', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: function () {
          window.__probes.gum += 1;
          return Promise.reject(new Error('should not run'));
        },
      },
    });
  });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize(PHONES[0]);
  await page.goto('http://site.test/conferences/');
  const ready = await settle(page);
  const mic = ready.locator('[data-check="mic"]');
  await expect(mic).toHaveAttribute('data-state', 'pass');
  await expect(mic.locator('.ready-label')).toHaveText('Mic API');
  expect(await shownIcon(mic)).toEqual(['ico-pass']);
  expect(await leaksOf(page)).toMatchObject({ gum: 0, enum: 0, perm: 0, audio: 0, rtc: 0 });
});

test('a browser with WebRTC missing shows a tip and still does not touch the mic', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'RTCPeerConnection', { configurable: true, writable: true, value: undefined });
    Object.defineProperty(window, 'webkitRTCPeerConnection', { configurable: true, writable: true, value: undefined });
  });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize(PHONES[0]);
  await page.goto('http://site.test/conferences/');
  const ready = await settle(page);
  const calls = ready.locator('[data-check="webrtc"]');
  await expect(calls).toHaveAttribute('data-state', 'fail');
  await expect(calls.locator('.ready-label')).toHaveText('No call support');
  expect(await shownIcon(calls)).toEqual(['ico-fail']);
  await expect(ready.locator('[data-check="mic"]')).toHaveAttribute('data-state', 'fail');
  await expect(ready.locator('[data-check="mic"] .ready-label')).toHaveText('No mic API');
  await expect(ready.locator('[data-check="audio"]')).toHaveAttribute('data-state', 'pass');
  const probes = await leaksOf(page);
  expect(probes.gum).toBe(0);
  expect(probes.rtc).toBe(0);
  expect(probes.audio).toBe(0);
  expect(await page.evaluate(() => window.__readyTimerStacks)).toEqual([]);
});

test('missing mic and audio APIs show tips and are not invoked', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {} });
    Object.defineProperty(window, 'AudioContext', { configurable: true, writable: true, value: undefined });
    Object.defineProperty(window, 'webkitAudioContext', { configurable: true, writable: true, value: undefined });
  });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize(PHONES[0]);
  await page.goto('http://site.test/conferences/');
  const ready = await settle(page);
  await expect(ready.locator('[data-check="mic"]')).toHaveAttribute('data-state', 'fail');
  await expect(ready.locator('[data-check="mic"] .ready-label')).toHaveText('No mic API');
  expect(await shownIcon(ready.locator('[data-check="mic"]'))).toEqual(['ico-fail']);
  await expect(ready.locator('[data-check="audio"]')).toHaveAttribute('data-state', 'fail');
  await expect(ready.locator('[data-check="audio"] .ready-label')).toHaveText('No audio support');
  expect(await shownIcon(ready.locator('[data-check="audio"]'))).toEqual(['ico-fail']);
  expect(await leaksOf(page)).toMatchObject({ gum: 0, audio: 0, enum: 0, perm: 0 });
});

test('connection text stays inside what the browser exposes', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize(PHONES[0]);

  async function openWith(options) {
    await page.addInitScript((opts) => {
      Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => opts.online !== false });
      const hide = !!opts.hide;
      const conn = hide ? undefined : {};
      if (!hide) {
        if (opts.type != null) conn.type = opts.type;
        if (opts.rate != null) conn.effectiveType = opts.rate;
      }
      Object.defineProperty(navigator, 'connection', { configurable: true, get: () => conn });
      Object.defineProperty(navigator, 'mozConnection', { configurable: true, get: () => undefined });
      Object.defineProperty(navigator, 'webkitConnection', { configurable: true, get: () => undefined });
    }, options);
    await page.goto('http://site.test/conferences/');
    const ready = await settle(page);
    const chip = ready.locator('[data-check="link"]');
    return {
      state: await chip.getAttribute('data-state'),
      text: (await chip.locator('.ready-label').textContent()).trim(),
    };
  }

  expect(await openWith({ online: false, hide: true })).toEqual({ state: 'fail', text: 'You look offline' });
  expect(await openWith({ online: true, type: 'wifi' })).toEqual({ state: 'pass', text: 'Wi-Fi' });
  expect(await openWith({ online: true, type: 'ethernet' })).toEqual({ state: 'pass', text: 'Ethernet' });
  expect(await openWith({ online: true, type: 'cellular', rate: '4g' })).toEqual({ state: 'pass', text: 'Cellular' });
  expect(await openWith({ online: true, rate: '4g' })).toEqual({ state: 'pass', text: '4G' });
  expect(await openWith({ online: true, rate: 'slow-2g' })).toEqual({ state: 'pass', text: 'Slow 2G' });
  expect(await openWith({ online: true, type: 'none' })).toEqual({ state: 'fail', text: 'You look offline' });
  expect(await openWith({ online: true, hide: true })).toEqual({ state: 'pass', text: 'Online' });
  expect(await openWith({ online: true, type: 'unknown' })).toEqual({ state: 'pass', text: 'Online' });
  expect(await leaksOf(page)).toMatchObject({ gum: 0, fetch: 0, ws: 0, xhr: 0, beacon: 0 });
});

test('reduced motion shows every chip at once, still, with the result', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize(PHONES[1]);
  await page.goto('http://site.test/conferences/');
  const ready = await settle(page);
  const motion = await ready.locator('.ready-chip').evaluateAll((els) => els.map((el) => {
    const style = getComputedStyle(el);
    return { name: style.animationName, opacity: style.opacity, transform: style.transform, shadow: style.boxShadow };
  }));
  expect(motion).toHaveLength(5);
  for (const chip of motion) {
    expect(chip.name).toBe('none');
    expect(chip.opacity).toBe('1');
    expect(['none', 'matrix(1, 0, 0, 1, 0, 0)']).toContain(chip.transform);
    expect(chip.shadow === 'none' || chip.shadow === '').toBe(true);
  }
  await expect(ready.locator('.ready-chip[data-state="pending"]')).toHaveCount(0);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect(ready.locator('.ready-chip').first()).not.toHaveCSS('animation-name', 'none');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const again = await ready.locator('.ready-chip').first().evaluate((el) => {
    const style = getComputedStyle(el);
    return { name: style.animationName, opacity: style.opacity, text: el.querySelector('.ready-label').textContent };
  });
  expect(again.name).toBe('none');
  expect(again.opacity).toBe('1');
  expect(again.text).not.toBe('Checking');
});

test('chips light up one by one only after the row scrolls into view', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.setViewportSize({ width: 390, height: 220 });
  await page.goto('http://site.test/conferences/');
  const ready = page.locator('#conference-ready');
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(ready).toHaveAttribute('data-watching', '1');
  await expect.poll(async () => ready.evaluate((el) => el.getBoundingClientRect().top)).toBeGreaterThan(220);
  await expect(ready).not.toHaveClass(/is-in/);
  await expect(ready.locator('.ready-label')).toHaveText(['Checking', 'Checking', 'Checking', 'Checking', 'Checking']);
  const hidden = await ready.locator('.ready-chip').first().evaluate((el) => getComputedStyle(el).opacity);
  expect(hidden).toBe('0');
  await ready.evaluate((el) => {
    window.__readyStarts = 0;
    el.addEventListener('animationstart', (event) => {
      if (event.animationName === 'ready-lit') window.__readyStarts += 1;
    }, true);
  });
  await ready.scrollIntoViewIfNeeded();
  await expect(ready).toHaveClass(/is-in/);
  await expect(ready).toHaveAttribute('data-watching', '0');
  const timing = await ready.locator('.ready-chip').evaluateAll((els) => els.map((el) => {
    const anim = el.getAnimations().find((item) => item.animationName === 'ready-lit');
    const spec = anim && anim.effect ? anim.effect.getTiming() : null;
    const frames = anim && anim.effect && anim.effect.getKeyframes ? anim.effect.getKeyframes() : [];
    const props = new Set();
    for (const frame of frames) {
      for (const key of Object.keys(frame)) {
        if (['offset', 'computedOffset', 'easing', 'composite'].includes(key)) continue;
        props.add(key);
      }
    }
    return {
      delay: spec ? spec.delay : null,
      iterations: spec ? spec.iterations : null,
      props: [...props],
    };
  }));
  expect(timing.map((row) => row.delay)).toEqual([0, 140, 280, 420, 560]);
  for (const row of timing) {
    expect(row.iterations).toBe(1);
    expect(row.props.length).toBeGreaterThan(0);
    for (const prop of row.props) expect(['opacity', 'transform', 'boxShadow']).toContain(prop);
  }
  await expect.poll(async () => page.evaluate(() => window.__readyStarts)).toBe(5);
  await page.evaluate(() => window.scrollTo(0, 0));
  await ready.scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => window.__readyStarts)).toBe(5);
  expect(await page.evaluate(() => window.__probes.gum)).toBe(0);
  expect(await page.evaluate(() => window.__readyTimerStacks)).toEqual([]);
});

test('pagehide releases the watcher and pageshow does not leak a timer', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.setViewportSize({ width: 390, height: 220 });
  await page.goto('http://site.test/conferences/');
  const ready = page.locator('#conference-ready');
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(ready).toHaveAttribute('data-watching', '1');
  await expect(ready).not.toHaveClass(/is-in/);
  await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
  });
  await expect(ready).toHaveAttribute('data-watching', '0');
  await expect(ready.locator('.ready-label').first()).toHaveText('Checking');
  await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  });
  await expect(ready).toHaveAttribute('data-watching', '1');
  await expect(ready).not.toHaveClass(/is-in/);
  await page.evaluate(() => {
    window.__readyStarts = 0;
    document.getElementById('conference-ready').addEventListener('animationstart', (event) => {
      if (event.animationName === 'ready-lit') window.__readyStarts += 1;
    }, true);
  });
  await ready.scrollIntoViewIfNeeded();
  await expect(ready).toHaveClass(/is-in/);
  await expect(ready).toHaveAttribute('data-watching', '0');
  await expect(ready.locator('[data-check="webrtc"] .ready-label')).toHaveText('Calls');
  // The five chips start up to 560ms apart. Wait out that first wave so a
  // late animationstart is not mistaken for a pageshow replay.
  await expect.poll(async () => page.evaluate(() => window.__readyStarts)).toBe(5);
  await page.evaluate(() => {
    window.__readyStarts = 0;
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  });
  await expect(ready.locator('[data-check="webrtc"]')).toHaveAttribute('data-state', 'pass');
  await expect(ready).toHaveAttribute('data-watching', '0');
  expect(await page.evaluate(() => window.__readyStarts)).toBe(0);
  expect(await page.evaluate(() => window.__readyTimerStacks)).toEqual([]);
  expect(await leaksOf(page)).toMatchObject({ gum: 0, audio: 0, rtc: 0, fetch: 0, ws: 0 });
});

test('without IntersectionObserver the check still finishes and stays local', async ({ page }) => {
  await page.addInitScript(() => {
    window.IntersectionObserver = undefined;
  });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 390, height: 220 });
  await page.goto('http://site.test/conferences/');
  const ready = page.locator('#conference-ready');
  await expect(ready).toHaveClass(/is-in/);
  await expect(ready).toHaveAttribute('data-watching', '0');
  await expect(ready.locator('[data-check="mic"] .ready-label')).toHaveText('No mic API');
  await expect(ready.locator('[data-check="webrtc"] .ready-label')).toHaveText('Calls');
  expect(await leaksOf(page)).toMatchObject({ gum: 0, audio: 0, rtc: 0 });
});

for (const phone of PHONES.concat([{ width: 320, height: 700 }])) {
  test(`phone layout at ${phone.width}x${phone.height} keeps the chips inside the screen`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize(phone);
    await page.goto('http://site.test/conferences/');
    const ready = await settle(page);
    await expect(ready.locator('[data-check="https"] .ready-label')).toHaveText('Use HTTPS');
    await expect(ready.locator('[data-check="mic"] .ready-label')).toHaveText('No mic API');
    const bits = await ready.locator('.ready-title, .ready-label, .ready-note').evaluateAll((els) => els.map((el) => {
      const rect = el.getBoundingClientRect();
      return {
        text: (el.textContent || '').trim(),
        x: rect.x,
        right: rect.right,
        cut: el.scrollWidth > el.clientWidth + 1,
      };
    }));
    expect(bits[0].text).toBe('Ready to join?');
    for (const bit of bits) {
      expect(bit.x, bit.text).toBeGreaterThanOrEqual(-1);
      expect(bit.right, bit.text).toBeLessThanOrEqual(phone.width + 1);
      expect(bit.cut, bit.text).toBe(false);
    }
    const box = await ready.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(-1);
    expect(box.x + box.width).toBeLessThanOrEqual(phone.width + 1);
    const sideways = await page.evaluate(() => {
      const el = document.scrollingElement || document.documentElement;
      return el.scrollWidth - el.clientWidth;
    });
    expect(sideways).toBeLessThanOrEqual(0);
    for (const id of ['#conference-start', '#conference-join']) {
      const button = await page.locator(id).boundingBox();
      expect(button.height).toBeGreaterThanOrEqual(48);
      await expect(page.locator(id)).toHaveAttribute('href', ROOM);
    }
    const stage = await page.locator('#conference-stage').boundingBox();
    const recap = await page.locator('#conference-recap').boundingBox();
    const start = await page.locator('#conference-start').boundingBox();
    expect(start.y).toBeGreaterThanOrEqual(recap.y + recap.height - 1);
    expect(start.y - (recap.y + recap.height)).toBeLessThanOrEqual(28);
    expect(recap.y).toBeGreaterThanOrEqual(stage.y + stage.height - 1);
  });
}

let httpsServer;
let httpsPort;

test.beforeAll(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ready-cert-'));
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048',
    '-keyout', path.join(dir, 'key.pem'),
    '-out', path.join(dir, 'cert.pem'),
    '-days', '1', '-nodes', '-subj', '/CN=127.0.0.1',
  ], { stdio: 'ignore' });
  httpsServer = https.createServer({
    key: fs.readFileSync(path.join(dir, 'key.pem')),
    cert: fs.readFileSync(path.join(dir, 'cert.pem')),
  }, (req, res) => {
    let rel = decodeURIComponent((req.url || '/').split('?')[0]);
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.resolve(root, '.' + rel);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) {
      res.writeHead(404);
      res.end('');
      return;
    }
    const types = {
      '.html': 'text/html',
      '.js': 'application/javascript',
      '.css': 'text/css',
      '.json': 'application/json',
      '.png': 'image/png',
      '.ico': 'image/x-icon',
    };
    res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((resolve) => httpsServer.listen(0, '127.0.0.1', resolve));
  httpsPort = httpsServer.address().port;
});

test.afterAll(async () => {
  if (httpsServer) await new Promise((resolve) => httpsServer.close(resolve));
});

test('a real secure page reports the mic API without calling it', async ({ page }) => {
  await page.unroute('**/*');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  fs.mkdirSync(shotDir, { recursive: true });
  for (const phone of PHONES) {
    await page.setViewportSize(phone);
    await page.goto(`https://127.0.0.1:${httpsPort}/conferences/`);
    const ready = await settle(page);
    await expect(ready.locator('[data-check="https"]')).toHaveAttribute('data-state', 'pass');
    await expect(ready.locator('[data-check="https"] .ready-label')).toHaveText('Secure');
    await expect(ready.locator('[data-check="webrtc"] .ready-label')).toHaveText('Calls');
    await expect(ready.locator('[data-check="mic"]')).toHaveAttribute('data-state', 'pass');
    await expect(ready.locator('[data-check="mic"] .ready-label')).toHaveText('Mic API');
    await expect(ready.locator('[data-check="audio"] .ready-label')).toHaveText('Audio');
    expect(await shownIcon(ready.locator('[data-check="mic"]'))).toEqual(['ico-pass']);
    const live = await page.evaluate(() => {
      const conn = navigator.connection || null;
      return {
        online: navigator.onLine !== false,
        type: conn && conn.type ? String(conn.type) : '',
        rate: conn && conn.effectiveType ? String(conn.effectiveType) : '',
      };
    });
    const link = linkFrom(live.online, live.type, live.rate);
    await expect(ready.locator('[data-check="link"] .ready-label')).toHaveText(link.text);
    expect(await leaksOf(page)).toMatchObject({ gum: 0, audio: 0, rtc: 0, fetch: 0, ws: 0, perm: 0, enum: 0 });
    expect(await page.evaluate(() => window.__readyTimerStacks)).toEqual([]);
    const bits = await ready.locator('.ready-title, .ready-label, .ready-note').evaluateAll((els) => els.map((el) => {
      const rect = el.getBoundingClientRect();
      return { text: (el.textContent || '').trim(), x: rect.x, right: rect.right, cut: el.scrollWidth > el.clientWidth + 1 };
    }));
    for (const bit of bits) {
      expect(bit.x, bit.text).toBeGreaterThanOrEqual(-1);
      expect(bit.right, bit.text).toBeLessThanOrEqual(phone.width + 1);
      expect(bit.cut, bit.text).toBe(false);
    }
    await ready.evaluate((el) => el.scrollIntoView({ block: 'start', inline: 'nearest' }));
    await page.screenshot({ path: path.join(shotDir, `ready_${phone.width}x${phone.height}.png`) });
  }

  await page.addInitScript(() => {
    Object.defineProperty(window, 'RTCPeerConnection', { configurable: true, writable: true, value: undefined });
    Object.defineProperty(window, 'webkitRTCPeerConnection', { configurable: true, writable: true, value: undefined });
  });
  await page.setViewportSize(PHONES[0]);
  await page.goto(`https://127.0.0.1:${httpsPort}/conferences/`);
  const ready = await settle(page);
  await expect(ready.locator('[data-check="webrtc"]')).toHaveAttribute('data-state', 'fail');
  await expect(ready.locator('[data-check="webrtc"] .ready-label')).toHaveText('No call support');
  expect(await shownIcon(ready.locator('[data-check="webrtc"]'))).toEqual(['ico-fail']);
  await expect(ready.locator('[data-check="https"] .ready-label')).toHaveText('Secure');
  await expect(ready.locator('[data-check="mic"] .ready-label')).toHaveText('Mic API');
  expect(await leaksOf(page)).toMatchObject({ gum: 0, rtc: 0, audio: 0 });
  await ready.evaluate((el) => el.scrollIntoView({ block: 'start', inline: 'nearest' }));
  await page.screenshot({ path: path.join(shotDir, 'ready_no_webrtc_390x844.png') });
});
