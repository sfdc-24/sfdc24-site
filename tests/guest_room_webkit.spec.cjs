// THE SOLO DEMO ON AN iPHONE-SIZED WebKit (the owner's iPhone test of 2026-11-27: the shared screen never showed).
// Playwright's WebKit is Safari's engine, not iOS Safari: it proves the page's own code path in WebKit at an iPhone
// size (one press, Rigel in, a real MediaStream screen video playing with no tap, End Demo in thumb reach), not the
// iPhone's autoplay, Low Power Mode or codec rules. Those need the real phone.
// The page is the one-file preview (tools/guest_preview.py): the real page with a stand-in room whose shared screen is
// a canvas stream. Skipped where WebKit or Python is not installed (npx playwright install webkit).
const { test, expect, devices, webkit } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const IN_DEMO = "You're in. Say hello to Rigel whenever you're ready.";

function webkitInstalled() {
  try { return fs.existsSync(webkit.executablePath()); } catch (err) { return false; }
}

let preview = '';
test.beforeAll(() => {
  if (!webkitInstalled()) return;
  const out = path.join(os.tmpdir(), 'sfdc24-guest-preview-' + process.pid + '.html');
  for (const python of ['python', 'python3']) {
    const run = spawnSync(python, [path.join(root, 'tools', 'guest_preview.py'), '--standalone', '--out', out], { encoding: 'utf8' });
    if (run.status === 0) { preview = fs.readFileSync(out, 'utf8'); break; }
  }
});

test.use({ ...devices['iPhone 13'], browserName: 'webkit' });

test.beforeEach(async ({ page }) => {
  test.skip(!webkitInstalled(), 'WebKit is not installed');
  test.skip(!preview, 'the preview could not be built (python)');
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === 'site.test' && url.pathname === '/preview.html') {
      return route.fulfill({ body: preview, contentType: 'text/html' });
    }
    return route.abort();
  });
});

test('WebKit at iPhone size: one press, Rigel in, the shared screen plays with no tap, End Demo ends it', async ({ page }) => {
  await page.goto('http://site.test/preview.html');
  await expect(page.locator('#guest-welcome')).toBeVisible();
  await page.getByRole('button', { name: 'Join', exact: true }).tap();
  await expect(page.locator('#guest-status')).toHaveText(IN_DEMO);
  await expect(page.locator('#guest-people')).toContainText('Rigel');
  const video = page.locator('#guest-screen-videos video');
  await expect(video).toHaveCount(1, { timeout: 8000 });
  await expect(video).toBeVisible();
  expect(await video.evaluate((v) => [v.muted, v.playsInline, v.hasAttribute('playsinline'), v.autoplay]))
    .toEqual([true, true, true, true]);
  // Playwright's WebKit on Windows has no canvas.captureStream, so there the stand-in screen is a still picture and
  // playback itself cannot be shown. Where it has one (Linux, macOS), the stream must play with no tap.
  if (await page.evaluate(() => typeof document.createElement('canvas').captureStream === 'function')) {
    await expect.poll(() => video.evaluate((v) => v.readyState >= 2 && !v.paused && v.videoWidth > 0),
      { timeout: 8000 }).toBe(true);
  } else {
    test.info().annotations.push({ type: 'note', description: 'no captureStream in this WebKit: playback not shown' });
  }
  const box = await video.boundingBox();
  expect(box.width).toBeGreaterThan(300);
  await page.waitForTimeout(4500);                      // past the page's own wait for a held screen
  await expect(page.locator('#guest-sound')).toBeHidden();
  const end = await page.getByRole('button', { name: 'End Demo' }).boundingBox();
  const height = page.viewportSize().height;
  expect(end.y).toBeGreaterThan(height * 0.8);
  expect(end.y + end.height).toBeLessThanOrEqual(height);
  await page.getByRole('button', { name: 'End Demo' }).tap();
  await expect(page.locator('#guest-status')).toHaveText('Thanks — the demo has ended.');
  await expect(page.locator('#guest-stage')).toBeHidden();
});
