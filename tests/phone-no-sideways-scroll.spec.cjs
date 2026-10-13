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

// Draft notes sit a directory deeper than the top-level pages above, and a
// phone can be any width from 320 to 414. Clipping overflow is not a pass:
// the page has to fit.
const blogPages = execFileSync('git', ['ls-files', '*.html'], { cwd: root, encoding: 'utf8' })
  .split('\n').filter((f) => f.startsWith('blog/') && f.endsWith('.html'));

for (const width of [320, 360, 375, 390, 414]) {
  for (const file of blogPages) {
    test(`${file} does not scroll sideways at ${width}px, menu open`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await page.goto('http://site.test/' + file.replace(/index\.html$/, ''));
      await page.waitForTimeout(400);
      const menu = page.locator('#chrome-menu summary');
      if (await menu.isVisible()) await menu.click();
      const sideways = await page.evaluate(() => {
        const el = document.scrollingElement || document.documentElement;
        const clips = getComputedStyle(document.body).overflowX === 'hidden'
          || getComputedStyle(document.documentElement).overflowX === 'hidden';
        if (clips) return 999;
        return el.scrollWidth - el.clientWidth;
      });
      expect(sideways, `${file} is ${sideways}px wider than a ${width}px screen`).toBeLessThanOrEqual(0);
      await expect(page.locator('.chrome-disclaimer')).toBeVisible();
      await expect(page.locator('.chrome-disclaimer')).toContainText('not affiliated with');
      await expect(page.getByText('[Placeholder:', { exact: false }).first()).toBeAttached();
    });
  }
}

test('a phone can open a draft note and return to the shelf', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto('http://site.test/blog/');
  await page.getByRole('link', { name: /A quiet note/ }).click();
  await expect(page).toHaveURL(/\/blog\/a-quiet-note\/?$/);
  await expect(page.locator('h1')).toHaveText('A quiet note');
  await expect(page.locator('.chrome-disclaimer')).toContainText('not affiliated with');
  await page.getByRole('link', { name: 'Notes', exact: true }).click();
  await expect(page).toHaveURL(/\/blog\/?$/);
  await expect(page.locator('h1')).toHaveText('Notes');
});

test('the phone menu on a note does not list the draft', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await page.goto('http://site.test/blog/a-figure/');
  await page.locator('#chrome-menu summary').click();
  const menu = page.locator('#chrome-menu nav');
  await expect(menu.locator('a[href="/about/"]')).toBeVisible();
  await expect(menu.locator('a[href="/blog/"]')).toHaveCount(0);
});
