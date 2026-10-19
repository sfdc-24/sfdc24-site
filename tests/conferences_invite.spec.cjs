// /conferences/ invite. One button copies the Converspan room link.
// The chip fades in and out. A refused clipboard shows the link selected.
// Start and Join stay on the room. The page still has no microphone.
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
const shotDir = '/opt/cursor/artifacts';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.__srBuilt = 0;
    window.__srStarts = 0;
    window.__copies = [];
    window.__dialogs = [];
    window.__clipMode = 'ok';
    window.__probes = { gum: 0, audio: 0, rtc: 0, fetch: 0, ws: 0, xhr: 0, beacon: 0 };
    class Rec {
      constructor() { window.__srBuilt += 1; }
      start() { window.__srStarts += 1; }
      stop() {}
      abort() {}
    }
    window.SpeechRecognition = Rec;
    window.webkitSpeechRecognition = Rec;
    window.alert = function (message) { window.__dialogs.push(['alert', String(message)]); };
    window.confirm = function (message) { window.__dialogs.push(['confirm', String(message)]); return false; };
    window.prompt = function (message) { window.__dialogs.push(['prompt', String(message)]); return null; };

    function fromInvite() {
      var stack = '';
      try { stack = String(new Error().stack || ''); } catch (err) { stack = ''; }
      return stack.indexOf('invite.js') !== -1;
    }
    function wrapCtor(name, key) {
      var Orig = window[name];
      if (typeof Orig !== 'function') return;
      var Wrapped = function () {
        if (fromInvite()) window.__probes[key] += 1;
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
        if (fromInvite()) window.__probes.gum += 1;
        return gum.apply(null, arguments);
      };
    }
    if (typeof window.fetch === 'function') {
      var fetchOrig = window.fetch;
      window.fetch = function () {
        if (fromInvite()) window.__probes.fetch += 1;
        return fetchOrig.apply(this, arguments);
      };
    }
    if (typeof window.WebSocket === 'function') {
      var WS = window.WebSocket;
      var WrappedWS = function () {
        if (fromInvite()) window.__probes.ws += 1;
        return Reflect.construct(WS, arguments, WS);
      };
      WrappedWS.prototype = WS.prototype;
      window.WebSocket = WrappedWS;
    }
    if (typeof window.XMLHttpRequest === 'function') {
      var XHR = window.XMLHttpRequest;
      var WrappedXHR = function () {
        if (fromInvite()) window.__probes.xhr += 1;
        return Reflect.construct(XHR, arguments, XHR);
      };
      WrappedXHR.prototype = XHR.prototype;
      window.XMLHttpRequest = WrappedXHR;
    }
    if (typeof navigator.sendBeacon === 'function') {
      var beacon = navigator.sendBeacon.bind(navigator);
      navigator.sendBeacon = function () {
        if (fromInvite()) window.__probes.beacon += 1;
        return beacon.apply(null, arguments);
      };
    }

    window.__installClip = function () {
      var mode = window.__clipMode;
      if (mode === 'missing') {
        try {
          Object.defineProperty(navigator, 'clipboard', { configurable: true, writable: true, value: undefined });
        } catch (err) {}
        return;
      }
      var api = {};
      if (mode !== 'nofn') {
        api.writeText = function (text) {
          window.__copies.push(String(text));
          if (mode === 'throw') throw new Error('denied');
          if (mode === 'reject') return Promise.reject(new Error('denied'));
          return Promise.resolve();
        };
      }
      Object.defineProperty(navigator, 'clipboard', { configurable: true, writable: true, value: api });
    };
    window.__installClip();
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

function invite(page) {
  return page.locator('#conference-invite');
}
function toast(page) {
  return page.locator('#conference-invite-toast');
}
function chip(page) {
  return page.locator('#conference-invite-toast .invite-chip');
}
function field(page) {
  return page.locator('#conference-invite-link');
}

async function frameActions(page) {
  await page.evaluate(() => {
    const el = document.getElementById('conference-actions');
    const header = document.querySelector('header');
    const head = header ? Math.ceil(header.getBoundingClientRect().height) : 0;
    const top = el.getBoundingClientRect().top + window.scrollY - head - 16;
    window.scrollTo(0, Math.max(0, top));
  });
}

async function selectionOf(page) {
  return page.evaluate(() => {
    const el = document.getElementById('conference-invite-link');
    const sel = window.getSelection();
    return {
      text: sel ? String(sel.toString()) : '',
      active: document.activeElement === el,
      hidden: el.hasAttribute('hidden'),
    };
  });
}

test('a click copies the room link and the chip fades in and out', async ({ page }) => {
  const dialogs = [];
  page.on('dialog', (dialog) => {
    dialogs.push(dialog.message());
    dialog.dismiss();
  });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.setViewportSize(PHONES[0]);
  await page.goto('http://site.test/conferences/');
  await expect(invite(page)).toHaveText('Invite');
  await expect(invite(page)).toHaveAccessibleName('Invite a guest');
  await expect(invite(page)).toHaveAttribute('type', 'button');
  await expect(toast(page)).toHaveAttribute('aria-live', 'polite');
  await expect(toast(page)).toHaveAttribute('role', 'status');
  await expect(field(page)).toBeHidden();
  await expect(chip(page)).toHaveText('');

  const first = await page.evaluate(() => new Promise((resolve) => {
    document.getElementById('conference-invite').click();
    requestAnimationFrame(() => {
      const node = document.querySelector('#conference-invite-toast .invite-chip');
      const pop = document.getElementById('conference-invite-toast');
      const anim = node.getAnimations().find((item) => item.animationName === 'invite-chip');
      const timing = anim && anim.effect ? anim.effect.getTiming() : null;
      resolve({
        text: node.textContent,
        running: !!(anim && anim.playState === 'running'),
        duration: timing ? timing.duration : 0,
        name: anim ? anim.animationName : '',
        rows: getComputedStyle(pop).transitionDuration,
        opacity: getComputedStyle(node).opacity,
      });
    });
  }));
  expect(first.text).toBe('Copied');
  expect(first.running).toBe(true);
  expect(first.name).toBe('invite-chip');
  expect(first.duration).toBe(2400);
  expect(first.duration * 0.1).toBe(240);
  expect(['0.24s', '240ms']).toContain(first.rows);
  expect(await page.evaluate(() => window.__copies)).toEqual([ROOM]);
  await expect(field(page)).toBeHidden();
  await expect(page.locator('#conference-start')).toHaveAttribute('href', ROOM);
  await expect(page.locator('#conference-join')).toHaveAttribute('href', ROOM);
  await expect(page.locator(`a[href="${ROOM}"]`)).toHaveCount(2);
  expect(dialogs).toEqual([]);
  expect(await page.evaluate(() => window.__dialogs)).toEqual([]);

  await chip(page).evaluate((node) => {
    const anim = node.getAnimations().find((item) => item.animationName === 'invite-chip');
    anim.finish();
  });
  await expect(chip(page)).toHaveText('');
  await expect(toast(page)).not.toHaveClass(/\bis-on\b/);
  await expect(page).toHaveURL(/\/conferences\/$/);
});

test('the keyboard focuses the button and Enter or Space copies the link', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize(PHONES[1]);
  await page.goto('http://site.test/conferences/');
  await page.locator('#conference-join').focus();
  await page.keyboard.press('Tab');
  await expect(invite(page)).toBeFocused();
  const outline = await invite(page).evaluate((el) => {
    const style = getComputedStyle(el);
    return { style: style.outlineStyle, width: parseFloat(style.outlineWidth) };
  });
  expect(outline.style).toBe('solid');
  expect(outline.width).toBeGreaterThanOrEqual(2);
  await page.keyboard.press('Enter');
  await expect(chip(page)).toHaveText('Copied');
  await expect(toast(page)).toHaveClass(/\bis-on\b/);
  expect(await page.evaluate(() => window.__copies)).toEqual([ROOM]);

  await page.keyboard.press('Space');
  await expect(chip(page)).toHaveText('Copied');
  expect(await page.evaluate(() => window.__copies)).toEqual([ROOM, ROOM]);
  await expect(field(page)).toBeHidden();
  await expect(page.locator('#conference-start')).toHaveAttribute('href', ROOM);
  await expect(page.locator('#conference-join')).toHaveAttribute('href', ROOM);
  await expect(page).toHaveURL(/\/conferences\/$/);
});

test('reduced motion shows the confirmation with no animation', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize(PHONES[0]);
  await page.goto('http://site.test/conferences/');
  const snap = await page.evaluate(async () => {
    const button = document.getElementById('conference-invite');
    const pop = document.getElementById('conference-invite-toast');
    const node = pop.querySelector('.invite-chip');
    button.click();
    await Promise.resolve();
    const popStyle = getComputedStyle(pop);
    const chipStyle = getComputedStyle(node);
    return {
      text: node.textContent,
      on: pop.classList.contains('is-on'),
      anims: pop.getAnimations({ subtree: true }).length,
      popDuration: popStyle.transitionDuration,
      popAnimation: popStyle.animationName,
      chipDuration: chipStyle.transitionDuration,
      chipAnimation: chipStyle.animationName,
      opacity: chipStyle.opacity,
      transform: chipStyle.transform,
      height: pop.getBoundingClientRect().height,
    };
  });
  expect(snap.text).toBe('Copied');
  expect(snap.on).toBe(true);
  expect(snap.anims).toBe(0);
  expect(snap.popDuration).toBe('0s');
  expect(snap.chipDuration).toBe('0s');
  expect(snap.popAnimation).toBe('none');
  expect(snap.chipAnimation).toBe('none');
  expect(snap.opacity).toBe('1');
  expect(['none', 'matrix(1, 0, 0, 1, 0, 0)']).toContain(snap.transform);
  expect(snap.height).toBeGreaterThan(24);
  expect(await page.evaluate(() => window.__copies)).toEqual([ROOM]);
  await expect(field(page)).toBeHidden();
});

test('switching on reduced motion makes the next confirmation instant', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.setViewportSize(PHONES[0]);
  await page.goto('http://site.test/conferences/');
  await invite(page).click();
  await expect(chip(page)).toHaveText('Copied');
  const running = await chip(page).evaluate((node) => {
    const anim = node.getAnimations().find((item) => item.animationName === 'invite-chip');
    return !!(anim && anim.playState === 'running');
  });
  expect(running).toBe(true);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const again = await page.evaluate(async () => {
    const button = document.getElementById('conference-invite');
    const pop = document.getElementById('conference-invite-toast');
    const node = pop.querySelector('.invite-chip');
    pop.classList.remove('is-on');
    node.textContent = '';
    button.click();
    await Promise.resolve();
    const style = getComputedStyle(node);
    return {
      text: node.textContent,
      anims: pop.getAnimations({ subtree: true }).length,
      duration: style.transitionDuration,
      animation: style.animationName,
      opacity: style.opacity,
      height: pop.getBoundingClientRect().height,
    };
  });
  expect(again.text).toBe('Copied');
  expect(again.anims).toBe(0);
  expect(again.duration).toBe('0s');
  expect(again.animation).toBe('none');
  expect(again.opacity).toBe('1');
  expect(again.height).toBeGreaterThan(24);
  expect(await page.evaluate(() => window.__copies)).toEqual([ROOM, ROOM]);
});

for (const mode of ['reject', 'throw', 'missing', 'nofn']) {
  test(`a ${mode} clipboard selects the visible room link and raises no dialog`, async ({ page }) => {
    const dialogs = [];
    page.on('dialog', (dialog) => {
      dialogs.push(dialog.message());
      dialog.dismiss();
    });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize(PHONES[2]);
    await page.goto('http://site.test/conferences/');
    await page.evaluate((next) => {
      window.__clipMode = next;
      window.__copies = [];
      window.__dialogs = [];
      window.__installClip();
    }, mode);
    await invite(page).click();
    await expect(field(page)).toBeVisible();
    await expect(field(page)).toHaveAttribute('role', 'textbox');
    await expect(field(page)).toHaveAttribute('aria-readonly', 'true');
    await expect(field(page)).toHaveText(ROOM);
    await expect(chip(page)).toHaveText('');
    await expect(toast(page)).not.toHaveClass(/\bis-on\b/);
    const selected = await selectionOf(page);
    expect(selected.hidden).toBe(false);
    expect(selected.active).toBe(true);
    expect(selected.text).toBe(ROOM);
    expect(dialogs).toEqual([]);
    expect(await page.evaluate(() => window.__dialogs)).toEqual([]);
    const copies = await page.evaluate(() => window.__copies);
    if (mode === 'missing' || mode === 'nofn') expect(copies).toEqual([]);
    else expect(copies).toEqual([ROOM]);
    await expect(page.locator('#conference-start')).toHaveAttribute('href', ROOM);
    await expect(page.locator('#conference-join')).toHaveAttribute('href', ROOM);
    await expect(page.locator(`a[href="${ROOM}"]`)).toHaveCount(2);
    const sideways = await page.evaluate(() => {
      const el = document.scrollingElement || document.documentElement;
      return el.scrollWidth - el.clientWidth;
    });
    expect(sideways).toBeLessThanOrEqual(0);
  });
}

test('inviting never arms a microphone, a call, a socket, or a fetch', async ({ page }) => {
  const outside = [];
  page.on('request', (req) => {
    if (!req.url().startsWith('http://site.test/')) outside.push(req.url());
  });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize(PHONES[0]);
  await page.goto('http://site.test/conferences/');
  await invite(page).click();
  await expect(chip(page)).toHaveText('Copied');
  await page.evaluate(() => {
    window.__clipMode = 'reject';
    window.__installClip();
  });
  await invite(page).click();
  await expect(field(page)).toBeVisible();
  const js = fs.readFileSync(path.join(root, 'conferences', 'invite.js'), 'utf8');
  for (const needle of [
    'getUserMedia', 'RTCPeerConnection', 'AudioContext', 'WebSocket',
    'fetch(', 'XMLHttpRequest', 'sendBeacon', 'EventSource', 'SpeechRecognition',
    'readText', 'alert(',
  ]) {
    expect(js).not.toContain(needle);
  }
  expect(js.match(/https:\/\/converspan\.com\/room/g)).toEqual([ROOM]);
  await expect(page.locator('body')).toHaveAttribute('data-chrome-ask', 'off');
  await expect(page.locator('.facts')).toContainText('Consent first');
  await expect(page.locator('.facts')).toContainText('Recording and transcription need consent before either starts');
  await expect(page.locator('.facts')).toContainText('No microphone');
  await expect(page.locator('.facts')).toContainText('No mic');
  await expect(page.locator('.facts')).toContainText('No transcript or recording');
  await expect(page.locator('.facts')).toContainText('No transcript');
  await expect(page.locator('.facts')).toContainText('Sends no name or company');
  await expect(page.locator('.chrome-disclaimer')).toContainText('sfdc24.com is an independent community resource');
  await expect(page.locator('.chrome-disclaimer')).toContainText('not affiliated with, endorsed by, or sponsored by Salesforce');
  await expect(page.locator('#chrome-mic')).toHaveCount(0);
  await expect(page.locator('#conference-start')).toHaveAttribute('href', ROOM);
  await expect(page.locator('#conference-join')).toHaveAttribute('href', ROOM);
  await expect(page.locator(`a[href="${ROOM}"]`)).toHaveCount(2);
  expect(await page.evaluate(() => window.__srBuilt)).toBe(0);
  expect(await page.evaluate(() => window.__srStarts)).toBe(0);
  expect(await page.evaluate(() => window.__probes)).toEqual({
    gum: 0, audio: 0, rtc: 0, fetch: 0, ws: 0, xhr: 0, beacon: 0,
  });
  expect(await page.evaluate(() => window.__copies)).toEqual([ROOM, ROOM]);
  expect(outside.filter((url) => !url.startsWith('https://fonts.googleapis.com/') && !url.startsWith('https://fonts.gstatic.com/'))).toEqual([]);
});

for (const phone of PHONES) {
  test(`invite fits the phone at ${phone.width}x${phone.height}`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize(phone);
    await page.goto('http://site.test/conferences/');
    const button = invite(page);
    await button.scrollIntoViewIfNeeded();
    const box = await button.boundingBox();
    expect(box.height).toBeGreaterThanOrEqual(48);
    expect(box.width).toBeGreaterThanOrEqual(48);
    expect(box.x).toBeGreaterThanOrEqual(-1);
    expect(box.x + box.width).toBeLessThanOrEqual(phone.width + 1);
    const label = button.locator('.invite-label');
    const cut = await label.evaluate((el) => el.scrollWidth > el.clientWidth + 1);
    expect(cut).toBe(false);
    await expect(label).toHaveText('Invite');
    fs.mkdirSync(shotDir, { recursive: true });
    await frameActions(page);
    await page.screenshot({ path: path.join(shotDir, `invite_control_${phone.width}x${phone.height}.png`) });

    await button.click();
    await expect(chip(page)).toHaveText('Copied');
    await frameActions(page);
    const shown = await chip(page).boundingBox();
    expect(shown.height).toBeGreaterThanOrEqual(36);
    expect(shown.x).toBeGreaterThanOrEqual(-1);
    expect(shown.x + shown.width).toBeLessThanOrEqual(phone.width + 1);
    const sideways = await page.evaluate(() => {
      const el = document.scrollingElement || document.documentElement;
      return el.scrollWidth - el.clientWidth;
    });
    expect(sideways).toBeLessThanOrEqual(0);
    await page.screenshot({ path: path.join(shotDir, `invite_copied_${phone.width}x${phone.height}.png`) });
    await expect(page.locator('#conference-start')).toHaveAttribute('href', ROOM);
    await expect(page.locator('#conference-join')).toHaveAttribute('href', ROOM);

    await page.evaluate(() => {
      window.__clipMode = 'missing';
      window.__installClip();
    });
    await button.click();
    await expect(field(page)).toBeVisible();
    await expect(field(page)).toHaveText(ROOM);
    const link = await field(page).boundingBox();
    expect(link.x).toBeGreaterThanOrEqual(-1);
    expect(link.x + link.width).toBeLessThanOrEqual(phone.width + 1);
    expect(link.height).toBeGreaterThanOrEqual(48);
    const after = await page.evaluate(() => {
      const el = document.scrollingElement || document.documentElement;
      return el.scrollWidth - el.clientWidth;
    });
    expect(after).toBeLessThanOrEqual(0);
    if (phone.width === 390) {
      await frameActions(page);
      await page.screenshot({ path: path.join(shotDir, 'invite_fallback_390x844.png') });
    }
  });
}
