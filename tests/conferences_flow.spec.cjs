// /conferences/ shows the handoff in three steps, then a silent looping
// mock of the Converspan room: a speaking orb, objectives that tick off,
// and a diagram that draws a node and a link. After that mock, a sample
// recap assembles: the objectives collapse to Done, next-step chips slide
// in, and a small diagram settles. Both loops run only while on screen
// and the tab is visible. Reduced motion leaves a still finished frame.
// The page still has no microphone.
const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const ROOM = 'https://converspan.com/room';
const PHONES = [
  { width: 390, height: 844 },
  { width: 375, height: 667 },
];

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.__srBuilt = 0;
    window.__srStarts = 0;
    class Rec {
      constructor() { window.__srBuilt += 1; }
      start() { window.__srStarts += 1; }
      stop() {}
      abort() {}
    }
    window.SpeechRecognition = Rec;
    window.webkitSpeechRecognition = Rec;
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

async function settled(page) {
  const steps = page.locator('#conference-how .step');
  await expect(steps).toHaveCount(3);
  await steps.nth(2).evaluate(async (el) => {
    const pending = el.getAnimations().map((a) => a.finished);
    if (pending.length) await Promise.all(pending);
  });
}

test('the three-step visual renders and Start and Join stay on the room', async ({ page }) => {
  await page.setViewportSize(PHONES[0]);
  await page.goto('http://site.test/conferences/');
  const how = page.locator('#conference-how');
  await expect(how).toHaveAttribute('aria-label', 'How a conference works');
  await expect(how).toHaveClass(/is-in/);
  const steps = how.locator('.step');
  await settled(page);
  await expect(steps.nth(0)).toContainText('Start or join');
  await expect(steps.nth(1)).toContainText('Room opens');
  await expect(steps.nth(2)).toContainText('Summary after');
  await expect(how.locator('.glyph svg')).toHaveCount(3);
  for (const step of [0, 1, 2]) await expect(steps.nth(step).locator('.label')).toBeVisible();
  await expect(page.locator('#conference-start')).toHaveAttribute('href', ROOM);
  await expect(page.locator('#conference-join')).toHaveAttribute('href', ROOM);
  await expect(page.locator(`a[href="${ROOM}"]`)).toHaveCount(4);
  await expect(page.locator('.facts')).toContainText('PIPEDA and the CRTC require consent');
  await expect(page.locator('.facts')).toContainText('No microphone');
  await expect(page.locator('.facts')).toContainText('No transcript or recording');
  await expect(page.locator('.facts')).toContainText('Sends no name or company');
  await expect(page.getByText('Start and Join both open the Converspan room.')).toHaveCount(0);
  await expect(page.locator('#chrome-mic')).toHaveCount(0);
  await expect(page.locator('#chrome-ask, #chrome-ask-shell, #chrome-box')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /ask out loud|listening/i })).toHaveCount(0);
  expect(await page.evaluate(() => window.__srBuilt)).toBe(0);
  expect(await page.evaluate(() => window.__srStarts)).toBe(0);
  expect(await page.locator('body').innerHTML()).not.toMatch(/tel:/i);
  await expect(page.locator('.chrome-disclaimer')).toContainText('not affiliated with, endorsed by, or sponsored by Salesforce');
  const stage = page.locator('#conference-stage');
  await expect(stage).toBeVisible();
  await expect(stage).toHaveAttribute('aria-label', 'Converspan room. Objectives: Open the brief, Mark the aim, Draw the path.');
  await expect(stage).toHaveClass(/is-live/);
  await expect(stage.locator('.aim-label')).toHaveText(['Open the brief', 'Mark the aim', 'Draw the path']);
  await expect(stage.locator('.orb')).toBeVisible();
  await expect(stage.locator('.edge.draw')).toHaveCount(1);
  await expect(stage.locator('.node-new')).toHaveCount(1);
  await expect(stage.locator('audio, video')).toHaveCount(0);
  const motion = await stage.locator('.tick').first().evaluate((el) => {
    const anim = el.getAnimations().find((item) => item.animationName === 'tick');
    const timing = anim && anim.effect ? anim.effect.getTiming() : null;
    return { state: anim ? anim.playState : '', iterations: timing ? timing.iterations : 0 };
  });
  expect(motion.state).toBe('running');
  expect(motion.iterations).toBe(Infinity);
  const recap = page.locator('#conference-recap');
  await expect(recap).toBeVisible();
  await expect(recap).toHaveClass(/is-live/);
  const stageBox = await stage.boundingBox();
  const recapBox = await recap.boundingBox();
  const startBox = await page.locator('#conference-start').boundingBox();
  expect(recapBox.y).toBeGreaterThanOrEqual(stageBox.y + stageBox.height - 1);
  expect(recapBox.y - (stageBox.y + stageBox.height)).toBeLessThanOrEqual(28);
  expect(startBox.y).toBeGreaterThanOrEqual(recapBox.y + recapBox.height - 1);
  expect(startBox.y - (recapBox.y + recapBox.height)).toBeLessThanOrEqual(28);
  expect(await page.locator('#conference-start').getAttribute('target')).toBeNull();
  expect(await page.locator('#conference-join').getAttribute('target')).toBeNull();
});

test('reduced motion shows the steps statically', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize(PHONES[1]);
  await page.goto('http://site.test/conferences/');
  const steps = page.locator('#conference-how .step');
  await expect(steps).toHaveCount(3);
  await expect(steps.nth(0)).toBeVisible();
  await expect(steps.nth(1)).toBeVisible();
  await expect(steps.nth(2)).toBeVisible();
  const motion = await steps.evaluateAll((els) => els.map((el) => {
    const s = getComputedStyle(el);
    return { name: s.animationName, opacity: s.opacity, transform: s.transform };
  }));
  for (const step of motion) {
    expect(step.name).toBe('none');
    expect(step.opacity).toBe('1');
    expect(['none', 'matrix(1, 0, 0, 1, 0, 0)']).toContain(step.transform);
  }
  const line = await page.locator('#conference-how').evaluate((el) => {
    const s = getComputedStyle(el, '::before');
    return { name: s.animationName, transform: s.transform };
  });
  expect(line.name).toBe('none');
  expect(['none', 'matrix(1, 0, 0, 1, 0, 0)']).toContain(line.transform);
  const stage = page.locator('#conference-stage');
  await expect(stage).toBeVisible();
  await expect(stage).not.toHaveClass(/is-live/);
  const still = await stage.evaluate((el) => {
    const tick = el.querySelector('.tick');
    const link = el.querySelector('.edge.draw');
    const born = el.querySelector('.node-new');
    const ring = el.querySelector('.ring');
    const read = (node) => {
      const s = getComputedStyle(node);
      return { name: s.animationName, dash: s.strokeDashoffset, opacity: s.opacity };
    };
    return { tick: read(tick), link: read(link), born: read(born), ring: read(ring) };
  });
  for (const part of [still.tick, still.link, still.born, still.ring]) expect(part.name).toBe('none');
  expect(['0px', '0']).toContain(still.tick.dash);
  expect(['0px', '0']).toContain(still.link.dash);
  expect(still.born.opacity).toBe('1');
  const recap = page.locator('#conference-recap');
  await expect(recap).toBeVisible();
  await expect(recap).not.toHaveClass(/is-live/);
  await expect(recap).toHaveAttribute('aria-label', 'Sample recap. Three objectives done. Next: send the brief, book next, share the map.');
  const stillRecap = await recap.evaluate((el) => {
    const read = (sel) => {
      const node = el.querySelector(sel);
      const s = getComputedStyle(node);
      return { name: s.animationName, opacity: s.opacity, transform: s.transform };
    };
    return { fold: read('.fold'), done: read('.done'), chip: read('.chip'), node: read('.n'), link: read('.link') };
  });
  for (const part of Object.values(stillRecap)) expect(part.name).toBe('none');
  expect(stillRecap.fold.opacity).toBe('0');
  expect(stillRecap.done.opacity).toBe('1');
  expect(stillRecap.chip.opacity).toBe('1');
  expect(stillRecap.node.opacity).toBe('1');
  expect(stillRecap.link.opacity).toBe('1');
  expect(['none', 'matrix(1, 0, 0, 1, 0, 0)']).toContain(stillRecap.done.transform);
  expect(['none', 'matrix(1, 0, 0, 1, 0, 0)']).toContain(stillRecap.chip.transform);
  await expect(page.locator('#conference-start')).toHaveAttribute('href', ROOM);
  await expect(page.locator('#conference-join')).toHaveAttribute('href', ROOM);
  expect(await page.evaluate(() => window.__srStarts)).toBe(0);
  await expect(page.locator('#chrome-mic')).toHaveCount(0);
});

test('reduced motion switches the room mock to a static frame while the page is open', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.setViewportSize(PHONES[0]);
  await page.goto('http://site.test/conferences/');
  const stage = page.locator('#conference-stage');
  await expect(stage).toHaveClass(/is-live/);
  expect(await stage.locator('.tick').first().evaluate((el) => getComputedStyle(el).animationName)).not.toBe('none');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(stage).not.toHaveClass(/is-live/);
  const frozen = await stage.locator('.tick').first().evaluate((el) => {
    const s = getComputedStyle(el);
    return { name: s.animationName, dash: s.strokeDashoffset };
  });
  expect(frozen.name).toBe('none');
  expect(['0px', '0']).toContain(frozen.dash);
  expect(await stage.locator('.node-new').evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
  expect(['0px', '0']).toContain(await stage.locator('.edge.draw').evaluate((el) => getComputedStyle(el).strokeDashoffset));
  const recap = page.locator('#conference-recap');
  await expect(recap).not.toHaveClass(/is-live/);
  const recapFrozen = await recap.locator('.done').evaluate((el) => {
    const s = getComputedStyle(el);
    return { name: s.animationName, opacity: s.opacity };
  });
  expect(recapFrozen.name).toBe('none');
  expect(recapFrozen.opacity).toBe('1');
  expect(await recap.locator('.fold').evaluate((el) => getComputedStyle(el).opacity)).toBe('0');
  expect(await recap.locator('.chip').first().evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect(stage).toHaveClass(/is-live/);
  expect(await stage.locator('.tick').first().evaluate((el) => getComputedStyle(el).animationPlayState)).toBe('running');
  await expect(page.locator('#conference-recap')).toHaveClass(/is-live/);
  expect(await page.locator('#conference-recap .chip').first().evaluate((el) => getComputedStyle(el).animationPlayState)).toBe('running');
  await expect(page.locator('#conference-start')).toHaveAttribute('href', ROOM);
  await expect(page.locator('#conference-join')).toHaveAttribute('href', ROOM);
});

test('the room mock pauses off-screen and while the tab is hidden', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.setViewportSize({ width: 390, height: 220 });
  await page.goto('http://site.test/conferences/');
  const stage = page.locator('#conference-stage');
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect.poll(async () => stage.evaluate((el) => el.getBoundingClientRect().top)).toBeGreaterThan(220);
  await expect(stage).not.toHaveClass(/is-live/);
  expect(await stage.locator('.tick').first().evaluate((el) => getComputedStyle(el).animationPlayState)).toBe('paused');
  await stage.scrollIntoViewIfNeeded();
  await expect(stage).toHaveClass(/is-live/);
  expect(await stage.locator('.edge.draw').evaluate((el) => getComputedStyle(el).animationPlayState)).toBe('running');
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(stage).not.toHaveClass(/is-live/);
  expect(await stage.locator('.tick').first().evaluate((el) => getComputedStyle(el).animationPlayState)).toBe('paused');
  await stage.scrollIntoViewIfNeeded();
  await expect(stage).toHaveClass(/is-live/);
  await page.evaluate(() => {
    const desc = Object.getOwnPropertyDescriptor(Document.prototype, 'hidden');
    if (!desc || desc.configurable === false) throw new Error('document.hidden is not configurable');
    let hidden = true;
    Object.defineProperty(Document.prototype, 'hidden', { configurable: true, get: () => hidden });
    window.__setTabHidden = (value) => {
      hidden = value;
      document.dispatchEvent(new Event('visibilitychange'));
    };
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(stage).not.toHaveClass(/is-live/);
  expect(await stage.locator('.tick').first().evaluate((el) => getComputedStyle(el).animationPlayState)).toBe('paused');
  await page.evaluate(() => window.__setTabHidden(false));
  await expect(stage).toHaveClass(/is-live/);
  expect(await stage.locator('.core').evaluate((el) => getComputedStyle(el).animationPlayState)).toBe('running');
  await expect(page.locator('#conference-start')).toHaveAttribute('href', ROOM);
  await expect(page.locator('#conference-join')).toHaveAttribute('href', ROOM);
  await expect(page.locator(`a[href="${ROOM}"]`)).toHaveCount(4);
});

test('the sequence plays once when the steps scroll into view', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.setViewportSize({ width: 390, height: 120 });
  await page.goto('http://site.test/conferences/');
  const how = page.locator('#conference-how');
  await page.waitForTimeout(250);
  expect(await how.getAttribute('class') || '').not.toContain('is-in');
  await how.evaluate((el) => {
    window.__howStarts = 0;
    el.addEventListener('animationstart', (event) => {
      if (event.animationName === 'how-in' || event.animationName === 'how-line') window.__howStarts += 1;
    }, true);
  });
  await how.scrollIntoViewIfNeeded();
  await expect(how).toHaveClass(/is-in/);
  await page.waitForTimeout(900);
  expect(await page.evaluate(() => window.__howStarts)).toBe(4);
  const running = await how.locator('.step').nth(2).evaluate((el) => {
    const anim = el.getAnimations().find((a) => a.animationName === 'how-in');
    return anim ? { count: anim.effect.getTiming().iterations, state: anim.playState } : null;
  });
  expect(running.count).toBe(1);
  expect(running.state).toBe('finished');
  await page.evaluate(() => window.scrollTo(0, 0));
  await how.scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  expect(await page.evaluate(() => window.__howStarts)).toBe(4);
});

test('the sample recap renders, holds a still finished frame, and leaves Start and Join unchanged', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.setViewportSize(PHONES[0]);
  await page.goto('http://site.test/conferences/');
  const recap = page.locator('#conference-recap');
  const stage = page.locator('#conference-stage');
  await expect(recap).toBeVisible();
  await expect(recap).toHaveClass(/is-live/);
  await expect(recap).toHaveAttribute('aria-label', 'Sample recap. Three objectives done. Next: send the brief, book next, share the map.');
  await expect(recap.locator('.recap-in')).toHaveAttribute('aria-hidden', 'true');
  await expect(recap.locator('.kicker')).toHaveText('Sample recap');
  await expect(recap.locator('.done')).toHaveText('Done');
  await expect(recap.locator('.chip')).toHaveText(['Send brief', 'Book next', 'Share map']);
  await expect(recap.locator('.seal .n')).toHaveCount(3);
  await expect(recap.locator('.done svg')).toHaveCount(1);
  await expect(recap.locator('a, button, audio, video')).toHaveCount(0);
  const stageBox = await stage.boundingBox();
  const recapBox = await recap.boundingBox();
  const startBox = await page.locator('#conference-start').boundingBox();
  expect(recapBox.y).toBeGreaterThanOrEqual(stageBox.y + stageBox.height - 1);
  expect(recapBox.y - (stageBox.y + stageBox.height)).toBeLessThanOrEqual(28);
  expect(startBox.y).toBeGreaterThanOrEqual(recapBox.y + recapBox.height - 1);
  expect(startBox.y - (recapBox.y + recapBox.height)).toBeLessThanOrEqual(28);
  const running = await recap.locator('.done').evaluate((el) => {
    const anim = el.getAnimations().find((item) => item.animationName === 'rec-done');
    const timing = anim && anim.effect ? anim.effect.getTiming() : null;
    return { state: anim ? anim.playState : '', iterations: timing ? timing.iterations : 0 };
  });
  expect(running.state).toBe('running');
  expect(running.iterations).toBe(Infinity);
  const props = await recap.evaluate((el) => {
    const names = new Set();
    for (const node of [el, ...el.querySelectorAll('*')]) {
      for (const anim of node.getAnimations()) {
        if (!String(anim.animationName || '').startsWith('rec-')) continue;
        const frames = anim.effect && anim.effect.getKeyframes ? anim.effect.getKeyframes() : [];
        for (const frame of frames) {
          for (const key of Object.keys(frame)) {
            if (['offset', 'computedOffset', 'easing', 'composite'].includes(key)) continue;
            names.add(key);
          }
        }
      }
    }
    return [...names];
  });
  expect(props.length).toBeGreaterThan(0);
  for (const prop of props) expect(['transform', 'opacity', 'translate', 'scale']).toContain(prop);
  const before = await recap.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const start = document.querySelector('#conference-start').getBoundingClientRect();
    return { h: r.height, y: r.y, start: start.y };
  });
  await page.waitForTimeout(700);
  const after = await recap.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const start = document.querySelector('#conference-start').getBoundingClientRect();
    return { h: r.height, y: r.y, start: start.y };
  });
  expect(Math.abs(after.h - before.h)).toBeLessThan(0.6);
  expect(Math.abs(after.y - before.y)).toBeLessThan(0.6);
  expect(Math.abs(after.start - before.start)).toBeLessThan(0.6);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(recap).not.toHaveClass(/is-live/);
  const frozen = await recap.evaluate((el) => {
    const read = (sel) => {
      const node = el.querySelector(sel);
      const s = getComputedStyle(node);
      return { name: s.animationName, opacity: s.opacity, transform: s.transform };
    };
    return { fold: read('.fold'), done: read('.done'), chip: read('.chip'), node: read('.n'), link: read('.link'), halo: read('.halo') };
  });
  for (const part of Object.values(frozen)) expect(part.name).toBe('none');
  expect(frozen.fold.opacity).toBe('0');
  expect(frozen.done.opacity).toBe('1');
  expect(frozen.chip.opacity).toBe('1');
  expect(frozen.node.opacity).toBe('1');
  expect(frozen.link.opacity).toBe('1');
  expect(Number(frozen.halo.opacity)).toBeGreaterThan(0.5);
  for (const part of [frozen.done, frozen.chip, frozen.node, frozen.link]) {
    expect(['none', 'matrix(1, 0, 0, 1, 0, 0)']).toContain(part.transform);
  }
  await expect(recap.locator('.done')).toBeVisible();
  await expect(recap.locator('.chip')).toHaveCount(3);
  await expect(page.locator('#conference-start')).toHaveAttribute('href', ROOM);
  await expect(page.locator('#conference-join')).toHaveAttribute('href', ROOM);
  expect(await page.locator('#conference-start').getAttribute('target')).toBeNull();
  expect(await page.locator('#conference-join').getAttribute('target')).toBeNull();
  await expect(page.locator(`a[href="${ROOM}"]`)).toHaveCount(4);
  await expect(page.locator('body')).toHaveAttribute('data-chrome-ask', 'off');
  await expect(page.locator('.facts')).toContainText('PIPEDA and the CRTC require consent');
});

test('the sample recap pauses off-screen and while the tab is hidden', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.setViewportSize({ width: 390, height: 220 });
  await page.goto('http://site.test/conferences/');
  const recap = page.locator('#conference-recap');
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect.poll(async () => recap.evaluate((el) => el.getBoundingClientRect().top)).toBeGreaterThan(220);
  await expect(recap).not.toHaveClass(/is-live/);
  expect(await recap.locator('.chip').first().evaluate((el) => getComputedStyle(el).animationPlayState)).toBe('paused');
  await recap.scrollIntoViewIfNeeded();
  await expect(recap).toHaveClass(/is-live/);
  expect(await recap.locator('.n').first().evaluate((el) => getComputedStyle(el).animationPlayState)).toBe('running');
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(recap).not.toHaveClass(/is-live/);
  await recap.scrollIntoViewIfNeeded();
  await expect(recap).toHaveClass(/is-live/);
  await page.evaluate(() => {
    const desc = Object.getOwnPropertyDescriptor(Document.prototype, 'hidden');
    if (!desc || desc.configurable === false) throw new Error('document.hidden is not configurable');
    let hidden = true;
    Object.defineProperty(Document.prototype, 'hidden', { configurable: true, get: () => hidden });
    window.__setTabHidden = (value) => {
      hidden = value;
      document.dispatchEvent(new Event('visibilitychange'));
    };
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(recap).not.toHaveClass(/is-live/);
  expect(await recap.locator('.done').evaluate((el) => getComputedStyle(el).animationPlayState)).toBe('paused');
  await page.evaluate(() => window.__setTabHidden(false));
  await expect(recap).toHaveClass(/is-live/);
  expect(await recap.locator('.halo').evaluate((el) => getComputedStyle(el).animationPlayState)).toBe('running');
  await expect(page.locator('#conference-start')).toHaveAttribute('href', ROOM);
  await expect(page.locator('#conference-join')).toHaveAttribute('href', ROOM);
  await expect(page.locator(`a[href="${ROOM}"]`)).toHaveCount(4);
});

for (const phone of PHONES) {
  test(`phone layout at ${phone.width}x${phone.height} keeps the steps, the room links, and the mic off`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize(phone);
    await page.goto('http://site.test/conferences/');
    const how = page.locator('#conference-how');
    await expect(how).toBeVisible();
    const steps = how.locator('.step');
    await expect(steps).toHaveCount(3);
    const boxes = await steps.evaluateAll((els) => els.map((el) => {
      const r = el.getBoundingClientRect();
      const label = el.querySelector('.label');
      const glyph = el.querySelector('.glyph');
      const g = glyph.getBoundingClientRect();
      const lr = label.getBoundingClientRect();
      return {
        x: r.x, y: r.y, w: r.width, h: r.height,
        text: label.textContent,
        labelCut: label.scrollWidth > label.clientWidth + 1,
        labelPast: lr.right > r.right + 1 || lr.left < r.left - 1,
        gw: g.width, gh: g.height,
      };
    }));
    expect(Math.max(...boxes.map((b) => b.y)) - Math.min(...boxes.map((b) => b.y))).toBeLessThanOrEqual(2);
    for (const box of boxes) {
      expect(box.x).toBeGreaterThanOrEqual(-1);
      expect(box.x + box.w).toBeLessThanOrEqual(phone.width + 1);
      expect(box.labelCut, box.text).toBe(false);
      expect(box.labelPast, box.text).toBe(false);
      expect(box.gw).toBeGreaterThanOrEqual(48);
      expect(box.gh).toBeGreaterThanOrEqual(48);
    }
    expect(boxes[0].x).toBeLessThan(boxes[1].x);
    expect(boxes[1].x).toBeLessThan(boxes[2].x);
    const stage = page.locator('#conference-stage');
    await expect(stage).toBeVisible();
    await expect(stage).not.toHaveClass(/is-live/);
    const bits = await stage.locator('.stage-name, .aims-h, .aim-label').evaluateAll((els) => els.map((el) => {
      const r = el.getBoundingClientRect();
      return { text: (el.textContent || '').trim(), x: r.x, right: r.right, cut: el.scrollWidth > el.clientWidth + 1 };
    }));
    expect(bits.map((bit) => bit.text)).toEqual(['Converspan', 'Objectives', 'Open the brief', 'Mark the aim', 'Draw the path']);
    for (const bit of bits) {
      expect(bit.x, bit.text).toBeGreaterThanOrEqual(-1);
      expect(bit.right, bit.text).toBeLessThanOrEqual(phone.width + 1);
      expect(bit.cut, bit.text).toBe(false);
    }
    const orb = await stage.locator('.orb').boundingBox();
    expect(orb.width).toBeGreaterThanOrEqual(44);
    expect(orb.height).toBeGreaterThanOrEqual(44);
    const web = await stage.locator('.web').boundingBox();
    expect(web.x).toBeGreaterThanOrEqual(-1);
    expect(web.x + web.width).toBeLessThanOrEqual(phone.width + 1);
    expect(web.width).toBeGreaterThan(120);
    expect(web.height).toBeGreaterThan(24);
    const stageBox = await stage.boundingBox();
    expect(stageBox.x).toBeGreaterThanOrEqual(-1);
    expect(stageBox.x + stageBox.width).toBeLessThanOrEqual(phone.width + 1);
    const recap = page.locator('#conference-recap');
    await expect(recap).toBeVisible();
    await expect(recap).not.toHaveClass(/is-live/);
    const recapBits = await recap.locator('.kicker, .done, .chip').evaluateAll((els) => els.map((el) => {
      const r = el.getBoundingClientRect();
      return {
        text: (el.textContent || '').trim(),
        x: r.x,
        right: r.right,
        y: r.y,
        cut: el.scrollWidth > el.clientWidth + 1,
        opacity: getComputedStyle(el).opacity,
      };
    }));
    expect(recapBits.map((bit) => bit.text)).toEqual(['Sample recap', 'Done', 'Send brief', 'Book next', 'Share map']);
    for (const bit of recapBits) {
      expect(bit.x, bit.text).toBeGreaterThanOrEqual(-1);
      expect(bit.right, bit.text).toBeLessThanOrEqual(phone.width + 1);
      expect(bit.cut, bit.text).toBe(false);
      expect(bit.opacity, bit.text).toBe('1');
    }
    const chipYs = recapBits.slice(2).map((bit) => bit.y);
    expect(Math.max(...chipYs) - Math.min(...chipYs)).toBeLessThanOrEqual(2);
    const seal = await recap.locator('.seal').boundingBox();
    expect(seal.x).toBeGreaterThanOrEqual(-1);
    expect(seal.x + seal.width).toBeLessThanOrEqual(phone.width + 1);
    const recapBox = await recap.boundingBox();
    expect(recapBox.x).toBeGreaterThanOrEqual(-1);
    expect(recapBox.x + recapBox.width).toBeLessThanOrEqual(phone.width + 1);
    for (const id of ['#conference-start', '#conference-join']) {
      const button = await page.locator(id).boundingBox();
      expect(button.height).toBeGreaterThanOrEqual(48);
      expect(button.width).toBeGreaterThanOrEqual(48);
      await expect(page.locator(id)).toHaveAttribute('href', ROOM);
    }
    const sideways = await page.evaluate(() => {
      const el = document.scrollingElement || document.documentElement;
      return el.scrollWidth - el.clientWidth;
    });
    expect(sideways).toBeLessThanOrEqual(0);
    await expect(page.locator('#chrome-mic')).toHaveCount(0);
    await expect(page.locator('#chrome-ask, #chrome-ask-shell')).toHaveCount(0);
    expect(await page.locator('body').innerHTML()).not.toMatch(/tel:/i);
  });
}

test('host and join cards stack at 360 and sit side by side on a desktop', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto('http://site.test/conferences/');
  const host = page.locator('.pick-host');
  const join = page.locator('.pick-join');
  await expect(host.locator('.pick-label')).toHaveText('Host');
  await expect(join.locator('.pick-label')).toHaveText('Join');
  await expect(host.locator('.pick-hint')).toHaveText('Open the room.');
  await expect(join.locator('.pick-hint')).toHaveText('Enter the room.');
  await expect(page.locator('#conference-start')).toHaveAttribute('href', ROOM);
  await expect(page.locator('#conference-join')).toHaveAttribute('href', ROOM);
  await expect(page.locator(`a[href="${ROOM}"]`)).toHaveCount(4);
  const stacked = async () => {
    const a = await host.boundingBox();
    const b = await join.boundingBox();
    return { a, b };
  };
  let boxes = await stacked();
  expect(boxes.b.y).toBeGreaterThanOrEqual(boxes.a.y + boxes.a.height - 1);
  expect(boxes.a.x).toBeGreaterThanOrEqual(-1);
  expect(boxes.a.x + boxes.a.width).toBeLessThanOrEqual(361);
  expect(boxes.b.x + boxes.b.width).toBeLessThanOrEqual(361);
  const still = await host.evaluate((el) => {
    const read = (node) => {
      const s = getComputedStyle(node);
      return { name: s.animationName, transform: s.transform, transition: s.transitionProperty };
    };
    return { card: read(el), hovered: null };
  });
  expect(still.card.name).toBe('none');
  expect(['none', 'matrix(1, 0, 0, 1, 0, 0)']).toContain(still.card.transform);
  await host.hover();
  const held = await host.evaluate((el) => getComputedStyle(el).transform);
  expect(['none', 'matrix(1, 0, 0, 1, 0, 0)']).toContain(held);
  const running = await page.evaluate(() => {
    const names = [];
    document.querySelectorAll('.pick, .pick *').forEach((el) => {
      if (!el.getAnimations) return;
      el.getAnimations().forEach((anim) => {
        if (anim.playState === 'running') names.push(anim.animationName || 'transition');
      });
    });
    return names;
  });
  expect(running).toEqual([]);

  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.mouse.move(0, 0);
  boxes = await stacked();
  expect(boxes.b.x).toBeGreaterThanOrEqual(boxes.a.x + boxes.a.width - 1);
  expect(Math.abs(boxes.b.y - boxes.a.y)).toBeLessThanOrEqual(2);
  const before = await host.evaluate((el) => getComputedStyle(el).transform);
  await host.hover();
  await page.waitForTimeout(220);
  const after = await host.evaluate((el) => getComputedStyle(el).transform);
  expect(before === 'none' || before === 'matrix(1, 0, 0, 1, 0, 0)').toBe(true);
  expect(after).not.toBe(before);
  const loops = await host.evaluate((el) => {
    const found = [];
    for (const node of [el, ...el.querySelectorAll('*')]) {
      for (const anim of node.getAnimations()) {
        const timing = anim.effect && anim.effect.getTiming ? anim.effect.getTiming() : {};
        if (timing.iterations === Infinity) found.push(anim.animationName || 'transition');
      }
    }
    return found;
  });
  expect(loops).toEqual([]);
  const sideways = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(sideways).toBeLessThanOrEqual(0);
  await expect(page.locator('.chrome-disclaimer')).toContainText('not affiliated with, endorsed by, or sponsored by Salesforce');
});
