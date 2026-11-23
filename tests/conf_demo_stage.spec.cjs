// Agent Demo on /conference/: the room frame says the chair's meeting mode, and in Agent Demo the card canvas beside the
// room starts closed, so the presenter's share in the room takes the stage. Only the room frame, from its own origin
// (room.sfdc24.com), can say so.
const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const ROOM = 'https://room.sfdc24.com';

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.context().route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === ROOM) return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>room</title><p>room fixture</p>' });
    if (url.origin !== 'http://site.test') return route.abort();
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.resolve(root, '.' + rel);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
    const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json' };
    return route.fulfill({ body: fs.readFileSync(file), contentType: types[path.extname(file)] || 'application/octet-stream' });
  });
});

async function openRoom(page) {
  await page.goto('http://site.test/conference/?room=workshop', { waitUntil: 'load' });
  await page.locator('#conf-room-toggle').click();
  await expect.poll(() => Boolean(page.frames().find((f) => f.url().startsWith(ROOM)))).toBe(true);
  const frame = page.frames().find((f) => f.url().startsWith(ROOM));
  await frame.waitForLoadState('load');
  return frame;
}

const say = (frame, mode) => frame.evaluate((m) => window.parent.postMessage({ source: 'sfdc24-room', meeting_mode: m }, '*'), mode);
const canvas = (page) => page.locator('#proto-canvas');
const roomPane = (page) => page.locator('#conf-room');
const button = (page) => page.locator('#conf-canvas-toggle');

test('before Agent Demo the room and the canvas share the stage, as before', async ({ page }) => {
  await openRoom(page);
  await expect(roomPane(page)).toBeVisible();
  await expect(canvas(page)).toBeVisible();
  await expect(button(page)).toHaveText('Close the canvas');
});

test('Agent Demo closes the canvas and the room takes the full width', async ({ page }) => {
  const frame = await openRoom(page);
  await say(frame, 'demo');
  await expect(canvas(page)).toBeHidden();
  await expect(roomPane(page)).toBeVisible();
  const stage = await page.locator('.conf-stage').boundingBox();
  const pane = await roomPane(page).boundingBox();
  expect(pane.width).toBeGreaterThan(stage.width - 2);
  await expect(button(page)).toHaveText('Open the canvas');
  await expect(button(page)).toHaveAttribute('aria-expanded', 'false');
});

test('in Agent Demo the canvas button opens the canvas beside the room and closes it; the room stays', async ({ page }) => {
  const frame = await openRoom(page);
  await say(frame, 'demo');
  await button(page).click();
  await expect(canvas(page)).toBeVisible();
  await expect(roomPane(page)).toBeVisible();
  await expect(button(page)).toHaveText('Close the canvas');
  await button(page).click();
  await expect(canvas(page)).toBeHidden();
  await expect(roomPane(page)).toBeVisible();
  await expect(button(page)).toHaveText('Open the canvas');
});

test('each new Agent Demo starts closed; out of it the page is as it was', async ({ page }) => {
  const frame = await openRoom(page);
  await say(frame, 'demo');
  await button(page).click();
  await expect(canvas(page)).toBeVisible();
  await say(frame, '');
  await expect(canvas(page)).toBeVisible();
  await expect(button(page)).toHaveText('Close the canvas');
  await say(frame, 'brainstorm');
  await expect(canvas(page)).toBeVisible();
  await say(frame, 'demo');
  await expect(canvas(page)).toBeHidden();
  // A repeat of the same mode keeps what he chose.
  await button(page).click();
  await say(frame, 'demo');
  await expect(canvas(page)).toBeVisible();
});

test('only the room frame, from its own origin, can close the canvas', async ({ page }) => {
  const frame = await openRoom(page);
  await page.evaluate(() => window.postMessage({ source: 'sfdc24-room', meeting_mode: 'demo' }, '*'));
  await frame.evaluate(() => window.parent.postMessage({ source: 'someone-else', meeting_mode: 'demo' }, '*'));
  await frame.evaluate(() => window.parent.postMessage({ source: 'sfdc24-room', meeting_mode: 7 }, '*'));
  await frame.evaluate(() => window.parent.postMessage('demo', '*'));
  await page.waitForTimeout(200);
  await expect(canvas(page)).toBeVisible();
  await expect(page.locator('body')).not.toHaveClass(/conf-demo/);
});

test('with the room hidden, Agent Demo leaves the canvas alone and its button works as before', async ({ page }) => {
  const frame = await openRoom(page);
  await say(frame, 'demo');
  await page.locator('#conf-room-toggle').click();          // Hide the room
  await expect(roomPane(page)).toBeHidden();
  await expect(canvas(page)).toBeVisible();
  await expect(button(page)).toHaveText('Close the canvas');
});
