// The studio homepage (draft, 2026-11-04): a hero and a four-panel capability
// poster, served the way GitHub Pages serves it (absolute /assets/ paths work,
// so chrome.js runs and could rename the agents if data-keep-names were lost).
const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

test.beforeEach(async ({ page }) => {
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
      '.svg': 'image/svg+xml',
      '.webmanifest': 'application/manifest+json',
    };
    return route.fulfill({
      body: fs.readFileSync(file),
      contentType: types[path.extname(file)] || 'text/plain',
    });
  });
});

for (const width of [1280, 390]) {
  test(`hero and four poster panels render at ${width}px, and the old picker is gone`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('http://site.test/', { waitUntil: 'load' });

    await expect(page.locator('h1#quote')).toHaveText('Salesforce Design and Training Studio');
    await expect(page.locator('.sh-hero .hero-sub')).toContainText('multi-agent framework');
    // chrome.js renames some agents unless the copy opts out; these are their own names.
    await expect(page.locator('.sh-hero .hero-sub')).toContainText('Claude, Greg, Gemini and Cody');

    const art = page.locator('.sh-art img');
    await expect(art).toBeVisible();
    await expect(art).toHaveAttribute('alt', /Claude, Greg, Gemini and Cody/);
    expect(await art.evaluate((img) => img.complete && img.naturalWidth > 0)).toBe(true);

    const panels = page.locator('#capabilities .poster-grid > li.pp');
    await expect(panels).toHaveCount(4);
    for (let i = 0; i < 4; i++) await expect(panels.nth(i)).toBeVisible();
    await expect(panels.locator('h3')).toHaveText([
      'You talk, the team answers',
      'Ask for a change, the same card updates',
      'Every agent’s version, side by side',
      'Pros, cons and a summary',
    ]);
    await expect(page.locator('#capabilities .pp-focus')).toContainText('OmniScripts, FlexCards and Data Mappers');
    await expect(page.locator('#capabilities .pp-soon')).toContainText('Coming soon');
    await expect(page.locator('#capabilities .pp-soon li')).toHaveText(['Screen-share walkthroughs', 'Projects', 'Agent ranking']);

    // The technical middle section is gone: no topic picker, no step guide, no CI/CD line.
    await expect(page.locator('#voice-conversation, #prototype-canvas, [data-vc-topic], [data-vc-steps]')).toHaveCount(0);
    const text = await page.locator('body').innerText();
    for (const gone of ['CI/CD', 'Design a logo', 'Build a website', 'Develop an app', 'Wrap up']) {
      expect(text).not.toContain(gone);
    }
    expect(text).not.toMatch(/\bGrok\b|\bCodex\b|\bJenny\b|\bAya\b/);

    // Nothing pokes out sideways, and the poster panels do not overlap.
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    const boxes = [];
    for (let i = 0; i < 4; i++) boxes.push(await panels.nth(i).boundingBox());
    for (let a = 0; a < 4; a++) {
      for (let b = a + 1; b < 4; b++) {
        const A = boxes[a], B = boxes[b];
        const apart = A.x + A.width <= B.x + 0.5 || B.x + B.width <= A.x + 0.5 ||
                      A.y + A.height <= B.y + 0.5 || B.y + B.height <= A.y + 0.5;
        expect(apart, `panels ${a + 1} and ${b + 1} overlap`).toBe(true);
      }
    }
  });
}

test('the footer and its trademark notice are unchanged', async ({ page }) => {
  await page.goto('http://site.test/', { waitUntil: 'load' });
  await expect(page.locator('footer .chrome-disclaimer')).toHaveText(
    'sfdc24.com is an independent community resource for Salesforce customers, consultants and developers, ' +
    'run by Abdus Salam, a certified Salesforce Sales Cloud Consultant, with help from AI agents. It is not ' +
    'affiliated with, endorsed by, or sponsored by Salesforce, Inc., and does not represent or speak for ' +
    'Salesforce. Salesforce, Sales Cloud and related marks are trademarks of Salesforce, Inc.');
});
