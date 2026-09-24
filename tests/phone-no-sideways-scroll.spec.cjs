// No published page scrolls sideways on a phone. Found on 2026-09-24 by
// rendering every page on www: agents and stats overflowed by 64px at 320
// and 390 (the shared ask strip's padding was outside its 100% width), org
// by 35px at 320 (fixed-width funnel columns) and looks by 34px at 320 (a
// 330px minimum card column). The page list is read from the repository.
const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');

const pages = execFileSync('git', ['ls-files', '*.html'], { cwd: root, encoding: 'utf8' })
  .split('\n').filter((f) => f === 'index.html' || f === '404.html' || /^[a-z0-9-]+\/index\.html$/.test(f));

test.beforeEach(async ({ page }) => {
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://site.test') return route.abort();
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.resolve(root, '.' + rel);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
    const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };
    return route.fulfill({ body: fs.readFileSync(file), contentType: types[path.extname(file)] || 'application/octet-stream' });
  });
});

for (const width of [320, 390]) {
  for (const file of pages) {
    test(`${file} does not scroll sideways at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await page.goto('http://site.test/' + file.replace(/index\.html$/, ''));
      await page.waitForTimeout(400);
      const sideways = await page.evaluate(() => {
        const el = document.scrollingElement || document.documentElement;
        // A page whose body clips overflow cannot be scrolled sideways.
        const clips = getComputedStyle(document.body).overflowX === 'hidden' || getComputedStyle(document.documentElement).overflowX === 'hidden';
        return clips ? 0 : el.scrollWidth - el.clientWidth;
      });
      expect(sideways, `${file} is ${sideways}px wider than a ${width}px screen`).toBeLessThanOrEqual(0);
    });
  }
}

// The /org/ funnel's fixed columns left its bars 0px wide at 390px (and
// pushed the page sideways at 320px). On any width the bars must be visible
// and share one track width, so their lengths can be compared.
for (const width of [320, 390, 768, 1280]) {
  test(`the /org/ funnel bars are visible and comparable at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto('http://site.test/org/');
    const tracks = page.locator('#funnel .track');
    await expect(tracks.first()).toBeVisible();
    const widths = await tracks.evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().width)));
    expect(widths.length).toBeGreaterThan(3);
    expect(Math.min(...widths), 'every bar has room').toBeGreaterThanOrEqual(100);
    expect(new Set(widths).size, 'one shared track width').toBe(1);
    const cut = await page.locator('#funnel .nm').evaluateAll((els) => els.filter((e) => e.scrollWidth > e.clientWidth).length);
    expect(cut, 'no stage name is cut off').toBe(0);
  });
}
