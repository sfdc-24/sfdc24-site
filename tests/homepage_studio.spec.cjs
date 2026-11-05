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
    // Jev joined as the gatekeeper that scores and ranks the competing versions.
    await expect(page.locator('.sh-hero .hero-sub')).toContainText('Jev, the gatekeeper, scores and ranks their competing versions');
    await expect(page.locator('.sh-hero .hero-sub')).toContainText('The line is owner only');
    await expect(page.locator('.sh-hero .hero-sub')).not.toContainText('You talk');

    const art = page.locator('.sh-art img');
    await expect(art).toBeVisible();
    await expect(art).toHaveAttribute('alt', /Claude, Greg, Gemini and Cody/);
    await expect(art).toHaveAttribute('alt', /gatekeeper chip for Jev/);
    await expect(art).toHaveAttribute('alt', /microphone marked Owner/);
    expect(await art.evaluate((img) => img.complete && img.naturalWidth > 0)).toBe(true);

    const panels = page.locator('#capabilities .poster-grid > li.pp');
    await expect(panels).toHaveCount(4);
    for (let i = 0; i < 4; i++) await expect(panels.nth(i)).toBeVisible();
    await expect(panels.locator('h3')).toHaveText([
      'The owner talks, the team answers',
      'Ask for a change, the same card updates',
      'Every agent’s version, side by side',
      'Pros, cons and a summary',
    ]);
    await expect(page.locator('#capabilities .pp-focus')).toContainText('OmniScripts, FlexCards and Data Mappers');
    await expect(page.locator('#capabilities .pp-soon')).toContainText('Coming soon');
    await expect(page.locator('#capabilities .pp-soon li')).toHaveText(['Screen-share walkthroughs', 'Projects']);

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

test('both hero drawings show the Jev gatekeeper chip the alt text promises', () => {
  for (const f of ['studio-hero.svg', 'studio-hero-portrait.svg']) {
    const svg = fs.readFileSync(path.join(root, 'assets', f), 'utf8');
    expect(svg, f).toMatch(/<text class="nm"[^>]*>Jev<\/text>/);
    expect(svg, f).toMatch(/>GATEKEEPER</);
    expect(svg, f).toMatch(/<desc id="d">[^<]*Jev/);
  }
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  expect(html).toContain('srcset="/assets/studio-hero-portrait.svg" width="360" height="516"');
});

// Owner, 2026-11-04: the independent-community paragraph moved to /about/. The
// homepage footer keeps the link row and contact; chrome.js must not re-add the
// paragraph at runtime (it rebuilds the footer on boot, so only rendering proves it).
const DISCLAIMER =
  'sfdc24.com is an independent community resource for Salesforce customers, consultants and developers, ' +
  'run by Abdus Salam, a certified Salesforce Sales Cloud Consultant, with help from AI agents. It is not ' +
  'affiliated with, endorsed by, or sponsored by Salesforce, Inc., and does not represent or speak for ' +
  'Salesforce. Salesforce, Sales Cloud and related marks are trademarks of Salesforce, Inc.';

test('the trademark notice is off the homepage and lives on About, word for word', async ({ page }) => {
  expect(fs.readFileSync(path.join(root, 'index.html'), 'utf8')).not.toContain(DISCLAIMER);
  expect(fs.readFileSync(path.join(root, 'about', 'index.html'), 'utf8')).toContain(DISCLAIMER);

  await page.goto('http://site.test/', { waitUntil: 'load' });
  await page.waitForTimeout(1200); // chrome.js rebuilds the footer after load
  await expect(page.locator('footer .chrome-disclaimer')).toHaveCount(0);
  expect(await page.locator('body').innerText()).not.toContain('trademarks of Salesforce, Inc.');
  // The link row and contact stayed.
  await expect(page.locator('footer.chrome-foot nav a')).toHaveText(
    ['Method', 'Privacy', 'Terms', 'About', 'Ops', 'Conferences', '', 'abdus@sfdc24.com']);

  await page.goto('http://site.test/about/', { waitUntil: 'load' });
  await expect(page.locator('body')).toContainText(DISCLAIMER);
});

// ── The delivery-model piece (owner, 2026-11-04) ────────────────────────────
// One animated section between the hero and the capability poster: five slides
// on a fixed cadence, dots to steer, paused by hover, and fully off under
// prefers-reduced-motion.

const SLIDE_HEADINGS = [
  'Intent is captured before anything is built',
  'The work is decomposed into release trains',
  'A timeline is committed and the fleet stands up',
  'Agents drive parallel workstreams',
  'Fixed-cadence trains compress time to value',
];

for (const width of [1280, 390]) {
  test(`the delivery model renders between hero and poster at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('http://site.test/', { waitUntil: 'load' });

    const section = page.locator('#delivery-model');
    await expect(section).toHaveAttribute('aria-roledescription', 'carousel');
    await expect(section.locator('h2')).toHaveText('From intent to release, on a fixed cadence');

    // It sits in the old picker's slot: after the hero, before the poster.
    const order = await page.evaluate(() => {
      const hero = document.querySelector('.sh-hero');
      const dm = document.getElementById('delivery-model');
      const poster = document.getElementById('capabilities');
      return {
        heroThenDm: !!(hero.compareDocumentPosition(dm) & Node.DOCUMENT_POSITION_FOLLOWING),
        dmThenPoster: !!(dm.compareDocumentPosition(poster) & Node.DOCUMENT_POSITION_FOLLOWING),
      };
    });
    expect(order.heroThenDm).toBe(true);
    expect(order.dmThenPoster).toBe(true);

    const slides = section.locator('.dm-slide');
    await expect(slides).toHaveCount(5);
    await expect(slides.locator('h3')).toHaveText(SLIDE_HEADINGS);
    await expect(slides.first()).toBeVisible();
    for (let i = 1; i < 5; i++) await expect(slides.nth(i)).not.toBeVisible();

    // The script built the controls: one dot per slide plus the pause toggle.
    const dots = section.locator('.dm-dot');
    await expect(dots).toHaveCount(5);
    await expect(dots.first()).toHaveAttribute('aria-current', 'true');
    await expect(section.locator('.dm-pause')).toHaveCount(1);

    // Nothing pokes out sideways.
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);

    // The slide's art and copy do not overlap each other.
    const art = await slides.first().locator('.dm-art').boundingBox();
    const copy = await slides.first().locator('.dm-copy').boundingBox();
    const apart = art.x + art.width <= copy.x + 0.5 || copy.x + copy.width <= art.x + 0.5 ||
                  art.y + art.height <= copy.y + 0.5 || copy.y + copy.height <= art.y + 0.5;
    expect(apart, 'slide art and copy overlap').toBe(true);
  });
}

test('the slides auto-advance on the cadence and pause on hover', async ({ page }) => {
  await page.clock.install();
  await page.goto('http://site.test/', { waitUntil: 'load' });
  const section = page.locator('#delivery-model');
  const slides = section.locator('.dm-slide');
  await expect(slides.first()).toBeVisible();

  await page.clock.fastForward(5000);
  await expect(slides.nth(1)).toBeVisible();
  await expect(slides.first()).not.toBeVisible();
  await expect(section.locator('.dm-dot').nth(1)).toHaveAttribute('aria-current', 'true');

  // Hover holds the current slide.
  await section.locator('.dm-stage').hover();
  await page.clock.fastForward(10000);
  await expect(slides.nth(1)).toBeVisible();
});

test('a dot steers to its slide and stops the rotation', async ({ page }) => {
  await page.clock.install();
  await page.goto('http://site.test/', { waitUntil: 'load' });
  const section = page.locator('#delivery-model');
  const dots = section.locator('.dm-dot');
  await expect(dots).toHaveCount(5);

  await dots.nth(3).click();
  await expect(section.locator('.dm-slide').nth(3)).toBeVisible();
  await expect(dots.nth(3)).toHaveAttribute('aria-current', 'true');
  await expect(section.locator('.dm-pause')).toHaveAttribute('aria-pressed', 'true');

  // Picking a slide by hand stops the clock.
  await page.mouse.move(0, 0);
  await page.clock.fastForward(10000);
  await expect(section.locator('.dm-slide').nth(3)).toBeVisible();
});

test('reduced motion shows the first slide with no auto-advance, dots still work', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.clock.install();
  await page.goto('http://site.test/', { waitUntil: 'load' });
  const section = page.locator('#delivery-model');
  const slides = section.locator('.dm-slide');
  await expect(slides.first()).toBeVisible();

  await page.clock.fastForward(15000);
  await expect(slides.first()).toBeVisible();
  await expect(slides.nth(1)).not.toBeVisible();
  await expect(section.locator('.dm-pause')).toHaveCount(0); // nothing rotates, nothing to pause

  await section.locator('.dm-dot').nth(2).click();
  await expect(slides.nth(2)).toBeVisible();
  await expect(section.locator('.dm-dot').nth(2)).toHaveAttribute('aria-current', 'true');
});

test('the dots are keyboard-reachable and the old picker text is still absent', async ({ page }) => {
  await page.goto('http://site.test/', { waitUntil: 'load' });
  const section = page.locator('#delivery-model');
  await section.locator('.dm-dot').first().focus();
  await page.keyboard.press('ArrowRight');
  await expect(section.locator('.dm-dot').nth(1)).toBeFocused();
  await expect(section.locator('.dm-slide').nth(1)).toBeVisible();

  const text = await page.locator('body').innerText();
  for (const gone of ['CI/CD', 'Design a logo', 'Build a website', 'Develop an app', 'Wrap up', 'Start conversation']) {
    expect(text).not.toContain(gone);
  }
});
