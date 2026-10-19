// One phone journey for the stacked conferences page.
// Homepage, into /conferences/ by the SFDC24 teaser (pointer) or the
// header Menu (keyboard), then Host and Join, the labelled samples, the
// device check, and invite. The handoff href is the SFDC24 room.
// The test never follows it.
// Passes: 390x844, 375x667, landscape 844x390, reduced motion, keyboard only.
const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const LOCAL = 'http://site.test';
const ROOM = 'https://sfdc24.com/conferences/room/';
const SHOT = '/opt/cursor/artifacts/conferences_phone_journey_390.png';
const TYPES = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

const PASSES = [
  { name: '390x844', width: 390, height: 844, motion: 'no-preference', keyboard: false, shot: true },
  { name: '375x667', width: 375, height: 667, motion: 'no-preference', keyboard: false, shot: false },
  { name: '844x390 landscape', width: 844, height: 390, motion: 'no-preference', keyboard: false, shot: false },
  { name: 'reduced motion', width: 390, height: 844, motion: 'reduce', keyboard: false, shot: false },
  { name: 'keyboard only', width: 390, height: 844, motion: 'no-preference', keyboard: true, shot: false },
];

function serve(route, foreign) {
  const url = new URL(route.request().url());
  if (url.origin !== LOCAL) {
    foreign.push(url.href);
    return route.abort();
  }
  let rel = decodeURIComponent(url.pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.resolve(root, '.' + rel);
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    return route.fulfill({ status: 404, body: '' });
  }
  return route.fulfill({
    body: fs.readFileSync(file),
    contentType: TYPES[path.extname(file)] || 'text/plain',
  });
}

async function arm(page) {
  const bag = { foreign: [], errors: [], dialogs: [], offsite: [] };
  await page.addInitScript(() => {
    window.__copies = [];
    window.__blockedNav = [];
    window.__probes = { gum: 0, audio: 0, rtc: 0, perm: 0, enum: 0 };
    window.__srStarts = 0;
    window.__cls = 0;
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (!entry.hadRecentInput) window.__cls += entry.value;
        }
      }).observe({ type: 'layout-shift', buffered: true });
    } catch (err) {}

    function count(key) { window.__probes[key] += 1; }
    function wrapCtor(name, key) {
      var Orig = window[name];
      if (typeof Orig !== 'function') return;
      var Wrapped = function () {
        count(key);
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
        count('gum');
        return gum.apply(null, arguments);
      };
    }
    if (devices && typeof devices.enumerateDevices === 'function') {
      var listDevices = devices.enumerateDevices.bind(devices);
      devices.enumerateDevices = function () {
        count('enum');
        return listDevices.apply(null, arguments);
      };
    }
    if (navigator.permissions && typeof navigator.permissions.query === 'function') {
      var query = navigator.permissions.query.bind(navigator.permissions);
      navigator.permissions.query = function () {
        count('perm');
        return query.apply(null, arguments);
      };
    }
    class Rec {
      start() { window.__srStarts += 1; }
      stop() {}
      abort() {}
    }
    window.SpeechRecognition = Rec;
    window.webkitSpeechRecognition = Rec;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: function (text) {
          window.__copies.push(String(text));
          return Promise.resolve();
        },
      },
    });

    function roomAnchor(node) {
      var link = node && node.closest ? node.closest('a') : null;
      if (!link) return null;
      return link.getAttribute('href') === 'https://sfdc24.com/conferences/room/' ? link : null;
    }
    document.addEventListener('click', function (event) {
      if (!roomAnchor(event.target)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    }, true);
    document.addEventListener('keydown', function (event) {
      if (event.key !== 'Enter' || !roomAnchor(event.target)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    }, true);
    var assign = Location.prototype.assign;
    Location.prototype.assign = function (url) {
      var value = String(url || '');
      if (value.indexOf('sfdc24.com/conferences/room') !== -1) {
        window.__blockedNav.push(value);
        return;
      }
      return assign.call(this, url);
    };
  });
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    bag.errors.push(msg.text() + (msg.location() && msg.location().url ? ' @ ' + msg.location().url : ''));
  });
  page.on('pageerror', (error) => bag.errors.push(String(error)));
  page.on('dialog', (dialog) => {
    bag.dialogs.push(dialog.message());
    dialog.dismiss();
  });
  page.on('framenavigated', (frame) => {
    if (frame !== page.mainFrame()) return;
    const url = frame.url();
    if (url.startsWith('http') && !url.startsWith(LOCAL)) bag.offsite.push(url);
  });
  await page.route('**/*', (route) => serve(route, bag.foreign));
  return bag;
}

function reset(bag) {
  bag.foreign.length = 0;
  bag.errors.length = 0;
  bag.dialogs.length = 0;
  bag.offsite.length = 0;
  bag.onConferences = 0;
}

async function tabUntil(page, selector) {
  for (let i = 0; i < 40; i++) {
    const hit = await page.locator(selector).evaluate((el) => el === document.activeElement).catch(() => false);
    if (hit) return;
    await page.keyboard.press('Tab');
  }
  throw new Error('Tab never reached ' + selector);
}

async function reveal(page, selector, keyboard) {
  const locator = page.locator(selector);
  if (!keyboard) {
    await locator.scrollIntoViewIfNeeded();
    return locator;
  }
  for (let i = 0; i < 16; i++) {
    const onScreen = await locator.evaluate((el) => {
      const rect = el.getBoundingClientRect();
      return rect.height > 8 && rect.bottom > 72 && rect.top < window.innerHeight - 16;
    });
    if (onScreen) return locator;
    await page.keyboard.press('PageDown');
  }
  throw new Error('PageDown never reached ' + selector);
}

async function enterConferences(page, pass, bag) {
  await page.setViewportSize({ width: pass.width, height: pass.height });
  await page.emulateMedia({ reducedMotion: pass.motion });
  await page.goto(LOCAL + '/', { waitUntil: 'load' });
  const menu = page.locator('#chrome-menu');
  const conferences = menu.locator('nav a[href="/conferences/"]');
  await expect(conferences).toHaveCount(1);
  await expect(conferences).toHaveText('Conferences');
  if (pass.width <= 720) await expect(menu).toBeVisible();
  const teaser = page.locator('#host-tease-go');
  await expect(teaser).toHaveAttribute('href', '/conferences/');
  await expect(teaser).toHaveAccessibleName('Live conference room');

  if (pass.keyboard) {
    await tabUntil(page, '#chrome-menu summary');
    await page.keyboard.press('Enter');
    await expect(menu).toHaveAttribute('open', '');
    await tabUntil(page, '#chrome-menu nav a[href="/conferences/"]');
    await page.keyboard.press('Enter');
  } else {
    await teaser.scrollIntoViewIfNeeded();
    await teaser.click();
  }
  await page.waitForURL(/\/conferences\/?$/);
  await expect(page.locator('main h1')).toHaveText('Conferences');
  await expect(page.locator('#conference-how .label')).toHaveText(['Start', 'Room', 'Summary']);
  // Requests from here belong to /conferences/. The homepage's font sheet and
  // its hidden voice-panel health probe are already in bag.foreign.
  bag.onConferences = bag.foreign.length;
}

async function pickHostJoin(page, pass) {
  const start = page.locator('#conference-start');
  const join = page.locator('#conference-join');
  if (pass.keyboard) {
    await tabUntil(page, '#conference-start');
    await expect(start).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(start).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(join).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(join).toBeFocused();
  } else {
    await reveal(page, '#conference-actions', false);
    await expect(page.locator('#conference-host-name')).toHaveText('Host');
    await start.click();
    await expect(page.locator('#conference-join-name')).toHaveText('Join');
    await join.click();
  }
  await expect(start).toHaveAttribute('href', ROOM);
  await expect(join).toHaveAttribute('href', ROOM);
  expect(await start.getAttribute('target')).toBeNull();
  expect(await join.getAttribute('target')).toBeNull();
  await expect(start).toHaveAccessibleName('Host Open the room. Start');
  await expect(join).toHaveAccessibleName('Join Enter the room. Join');
  expect(await page.locator(`a[href="${ROOM}"]`).evaluateAll((els) => els.map((el) => el.id))).toEqual([
    'conference-start',
    'conference-join',
  ]);
  expect(page.url()).toMatch(/\/conferences\/?$/);
  expect(await page.evaluate(() => window.__blockedNav)).toEqual([]);
}

async function stepSamples(page, pass) {
  const recap = await reveal(page, '#conference-recap', pass.keyboard);
  await expect(recap.locator('.kicker')).toHaveText('Sample recap');
  await expect(recap).toHaveAttribute('aria-label', 'Sample recap. Three objectives done. Next: send the brief, book next, share the map.');
  await expect(recap.locator('.chip')).toHaveText(['Brief', 'Next', 'Map']);
  await expect(recap.locator('a, button, audio, video')).toHaveCount(0);

  const lobby = await reveal(page, '#conference-lobby', pass.keyboard);
  await expect(lobby.locator('.lobby-kicker')).toHaveText('Sample lobby');
  await expect(lobby.locator('#conference-lobby-status')).toHaveText('Waiting');
  await expect(lobby.locator('#conference-lobby-status')).toHaveAccessibleName('Waiting for your host');
  const tips = lobby.locator('.lobby-tip');
  await expect(tips).toHaveText(['Host opens', 'Preview only', 'Not recorded']);
  const tipNames = ['Your host opens the room.', 'This preview does not join.', 'Nothing here is recorded.'];
  for (let i = 0; i < tipNames.length; i++) {
    await expect(tips.nth(i)).toHaveAttribute('aria-label', tipNames[i]);
    if ((await tips.nth(i).getAttribute('aria-hidden')) !== 'true') {
      await expect(tips.nth(i)).toHaveAccessibleName(tipNames[i]);
    }
  }
  await expect(lobby.locator('.lobby-clock')).toHaveText(/^\d+:\d{2}$/);
  await expect(lobby.locator('a, button, audio, video')).toHaveCount(0);

  const goals = await reveal(page, '#conference-goals', pass.keyboard);
  await expect(goals.locator('.goals-kicker')).toContainText('Sample objectives');
  const names = await goals.locator('.goal').evaluateAll((els) => els.map((el) => {
    const copy = el.cloneNode(true);
    copy.querySelectorAll('.sr').forEach((node) => node.remove());
    return (copy.textContent || '').trim();
  }));
  expect(names).toEqual(['Scope', 'Owner', 'Next step', 'Outcome']);
  await expect(page.locator('#conference-goals-num')).toHaveText(/^[0-4]$/);

  if (pass.motion === 'reduce') {
    await expect(recap).not.toHaveClass(/\bis-live\b/);
    await expect(lobby).not.toHaveClass(/\bis-live\b/);
    await expect(lobby.locator('.lobby-clock')).toHaveText('0:00');
    await expect(goals.locator('.goal.is-done')).toHaveCount(4);
    await expect(page.locator('#conference-goals-num')).toHaveText('4');
  } else {
    await expect(lobby).toHaveClass(/\bis-live\b/);
  }
}

async function useInvite(page, pass) {
  const button = page.locator('#conference-invite');
  if (pass.keyboard) {
    await tabUntil(page, '#conference-invite');
    await expect(button).toBeFocused();
    await page.keyboard.press('Enter');
  } else {
    await reveal(page, '#conference-invite', false);
    await button.click();
  }
  await expect.poll(() => page.evaluate(() => window.__copies)).toEqual([ROOM]);
  await expect(page.locator('#conference-invite-toast .invite-chip')).toHaveText('Copied');
  await expect(page.locator('#conference-invite-link')).toBeHidden();
  await expect(button).toHaveText('Invite');
  await expect(button).toHaveAccessibleName('Invite a guest');
}

async function useDeviceCheck(page, pass) {
  const ready = await reveal(page, '#conference-ready', pass.keyboard);
  await expect(ready).toHaveClass(/is-in/);
  await expect(ready.locator('.ready-chip[data-state="pending"]')).toHaveCount(0);
  await expect(page.locator('#conference-ready-title')).toHaveText('Ready');
  await expect(page.locator('#conference-ready-title')).toHaveAccessibleName('Ready to join?');
  await expect(ready.locator('.ready-note')).toHaveText('Mic after join.');
  await expect(ready.locator('.ready-note')).toHaveAccessibleName('Mic only after you join.');
  const states = await ready.locator('.ready-chip').evaluateAll((els) => els.map((el) => ({
    id: el.getAttribute('data-check'),
    state: el.getAttribute('data-state'),
    text: (el.querySelector('.ready-label').textContent || '').trim(),
  })));
  expect(states.map((row) => row.id)).toEqual(['https', 'webrtc', 'mic', 'audio', 'link']);
  expect(states[0]).toEqual({ id: 'https', state: 'fail', text: 'Use HTTPS' });
  expect(states[1]).toEqual({ id: 'webrtc', state: 'pass', text: 'Calls' });
  expect(states[2]).toEqual({ id: 'mic', state: 'fail', text: 'No mic API' });
  expect(states[3]).toEqual({ id: 'audio', state: 'pass', text: 'Audio' });
  expect(['pass', 'fail']).toContain(states[4].state);
  expect(states[4].text.length).toBeGreaterThan(0);
  await expect(ready.locator('audio, video')).toHaveCount(0);
  expect(await page.evaluate(() => window.__probes)).toEqual({ gum: 0, audio: 0, rtc: 0, perm: 0, enum: 0 });
  expect(await page.evaluate(() => window.__srStarts)).toBe(0);
}

async function disclaimer(page, pass) {
  const note = page.locator('footer.chrome-foot .chrome-disclaimer');
  if (pass.keyboard) await page.keyboard.press('End');
  else await note.scrollIntoViewIfNeeded();
  await expect(note).toBeVisible();
  await expect(note).toContainText('sfdc24.com');
  await expect(note).toContainText('not affiliated with, endorsed by, or sponsored by Salesforce');
}

async function landOnHandoff(page, pass) {
  const start = page.locator('#conference-start');
  const join = page.locator('#conference-join');
  if (pass.keyboard) {
    await tabUntil(page, '#conference-start');
    await expect(start).toBeFocused();
  } else {
    await page.evaluate(() => {
      const el = document.getElementById('conference-actions');
      const header = document.querySelector('header');
      const head = header ? Math.ceil(header.getBoundingClientRect().height) : 0;
      const top = el.getBoundingClientRect().top + window.scrollY - head - 16;
      window.scrollTo(0, Math.max(0, top));
    });
    await expect(start).toBeVisible();
    await expect(join).toBeVisible();
  }
  await expect(start).toHaveAttribute('href', ROOM);
  await expect(join).toHaveAttribute('href', ROOM);
  expect(page.url()).toMatch(/\/conferences\/?$/);
  expect(page.url()).not.toContain('sfdc24.com/conferences/room');
  const sideways = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(sideways).toBeLessThanOrEqual(0);
  await expect(page.locator('#chrome-mic, #chrome-ask, #chrome-ask-shell')).toHaveCount(0);
  await expect(page.locator('audio, video')).toHaveCount(0);
  if (pass.shot) {
    fs.mkdirSync(path.dirname(SHOT), { recursive: true });
    await page.screenshot({ path: SHOT, fullPage: false });
  }
}

const HOME_HEALTH = 'https://sfdc24-studio-controller-96522051727.us-central1.run.app/health';

function fontOnly(url) {
  return url.startsWith('https://fonts.googleapis.com/') || url.startsWith('https://fonts.gstatic.com/');
}

function fontNoise(text) {
  if (/fonts\.(googleapis|gstatic)\.com/.test(text)) return true;
  // Aborting the homepage's one health probe is reported by Chromium as a
  // failed resource. The page itself does not log it.
  if (text.indexOf(HOME_HEALTH) !== -1 && text.indexOf('ERR_FAILED') !== -1) return true;
  return false;
}

async function finish(page, bag) {
  const cls = await page.evaluate(() => window.__cls || 0);
  expect(cls).toBeLessThan(0.05);
  expect(bag.offsite).toEqual([]);
  expect(bag.dialogs).toEqual([]);
  expect(await page.evaluate(() => window.__blockedNav)).toEqual([]);
  const during = bag.foreign.slice(bag.onConferences || 0);
  expect(during.filter((url) => !fontOnly(url)), during.join('\n')).toEqual([]);
  // The homepage already asks for its font sheet and, while the voice panel is
  // hidden, one controller health probe. Both are aborted. Anything else fails.
  const leftover = bag.foreign.filter((url) => !fontOnly(url) && url !== HOME_HEALTH);
  expect(leftover, bag.foreign.join('\n')).toEqual([]);
  expect(bag.foreign.filter((url) => url === HOME_HEALTH).length).toBeLessThanOrEqual(1);
  const errors = bag.errors.filter((text) => !fontNoise(text));
  expect(errors).toEqual([]);
}

test('a phone walks from the homepage to the SFDC24 handoff', async ({ page }) => {
  test.setTimeout(180000);
  const bag = await arm(page);
  for (const pass of PASSES) {
    await test.step(pass.name, async () => {
      reset(bag);
      await enterConferences(page, pass, bag);
      await pickHostJoin(page, pass);
      await stepSamples(page, pass);
      await useInvite(page, pass);
      await useDeviceCheck(page, pass);
      await disclaimer(page, pass);
      await landOnHandoff(page, pass);
      await finish(page, bag);
    });
  }
});
