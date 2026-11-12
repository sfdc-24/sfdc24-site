// The footer is rebuilt at runtime by assets/chrome.js on every page that
// loads it, so the footer a visitor sees is only proven by rendering it: a
// link added to static HTML alone is erased when chrome.js boots.
const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');

test.beforeEach(async ({ page }) => {
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://site.test') return route.abort();
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.resolve(root, '.' + rel);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
    const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json' };
    return route.fulfill({ body: fs.readFileSync(file), contentType: types[path.extname(file)] || 'text/plain' });
  });
});

// Owner: navigation left; the LinkedIn icon and existing email right; no History.
const EXPECTED = ['Method', 'Privacy', 'Terms', 'About', 'Ops', 'Delivery', 'Conferences', '', 'abdus@sfdc24.com'];
const HREFS = ['/method/', '/privacy/', '/terms/', '/about/', '/ops/', '/delivery/', '/conference/?room=workshop', 'https://www.linkedin.com/in/salams', 'mailto:abdus@sfdc24.com'];
const NAV_COUNT = 7;
// /ops stays on role titles: no personal contact, name or address (#260, assets/chrome.js footerLinks).
// Its footer is the navigation alone, rendered and static. This test still expected the contact
// links there; it went unseen on main because the phone-width step before it failed first.
const OPS_PAGES = ['/ops/'];

async function expectOpsFooter(nav) {
  await expect(nav).toHaveAttribute('aria-label', 'Footer');
  await expect(nav.locator('a')).toHaveText(EXPECTED.slice(0, NAV_COUNT));
  expect(await nav.locator('a').evaluateAll(links => links.map(a => a.getAttribute('href')))).toEqual(HREFS.slice(0, NAV_COUNT));
  await expect(nav.locator('.chrome-foot-contact a')).toHaveCount(0);
  await expect(nav.getByRole('link', { name: 'Converspan', exact: true })).toHaveCount(0);
}

async function expectFooter(nav) {
  if (OPS_PAGES.includes(new URL(nav.page().url()).pathname)) return expectOpsFooter(nav);
  await expect(nav).toHaveAttribute('aria-label', 'Footer');
  await expect(nav.locator('a')).toHaveText(EXPECTED);
  expect(await nav.locator('a').evaluateAll(links => links.map(a => a.getAttribute('href')))).toEqual(HREFS);
  await expect(nav.locator('.chrome-foot-main a')).toHaveText(EXPECTED.slice(0, NAV_COUNT));
  await expect(nav.getByRole('link', { name: 'Converspan', exact: true })).toHaveCount(0);
  await expect(nav.locator('.chrome-foot-contact a')).toHaveCount(2);
  const linkedin = nav.getByRole('link', { name: 'LinkedIn', exact: true });
  await expect(linkedin).toHaveAttribute('target', '_blank');
  await expect(linkedin).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(linkedin.locator('svg')).toHaveAttribute('aria-hidden', 'true');
  await expect(linkedin.locator('svg')).toHaveAttribute('focusable', 'false');
  await expect(nav.getByRole('link', { name: 'abdus@sfdc24.com' })).not.toHaveAttribute('target', '_blank');
}

for (const page_ of ['/', '/about/', '/delivery/', '/intake/', '/method/', '/history/', '/privacy/', '/terms/', '/projects/',
  '/org/', '/agents/', '/listen/', '/looks/', '/governor/', '/dashboard/', '/ops/', '/process/', '/conference/', '/conferences/', '/experience/', '/releases/', '/404.html']) {
  test(`the rendered footer on ${page_} keeps navigation left and contact links right`, async ({ page }) => {
    await page.goto('http://site.test' + page_);
    const nav = page.locator('footer.chrome-foot nav');
    await expectFooter(nav);
  });
}

test('the Delivery page renders the hour-by-hour ledger without leaking vendor, schedule hours, or blueprint internals', async ({ page }) => {
  const ledgerRaw = fs.readFileSync(path.join(root, 'data', 'delivery-ledger.json'), 'utf8');
  const measuredRaw = fs.readFileSync(path.join(root, 'data', 'delivery-metrics-measured.json'), 'utf8');
  const indexRaw = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const htmlRaw = fs.readFileSync(path.join(root, 'delivery', 'index.html'), 'utf8');
  const fbMatch = htmlRaw.match(/<script id="delivery-fallback" type="application\/json">([\s\S]*?)<\/script>/);
  expect(fbMatch, 'delivery-fallback JSON block present').toBeTruthy();
  const ledgerObj = JSON.parse(ledgerRaw);
  const measuredObj = JSON.parse(measuredRaw);
  const fallbackObj = JSON.parse(fbMatch[1]);
  expect(fallbackObj, 'fallback JSON stays synced with delivery-ledger.json').toEqual(ledgerObj);
  expect(ledgerObj.historical_run_chart.weeks, 'ledger weekly metrics trace identically to delivery-metrics-measured.json').toEqual(measuredObj.weeks);
  expect(ledgerObj.historical_run_chart.generated_utc).toBe(measuredObj.generated_utc);
  expect(indexRaw).not.toContain('(owner, 2026-10-24 1:00 PM)');

  const bannedScheduleAndVendors = [
    'OpenAI', 'Claude', 'Codex', 'Gemini', 'Grok', 'Qwen', 'ElevenLabs',
    'Blackboard', 'Tailscale', 'Two-Vendor', 'Five-Pillar', 'Four-Beat',
    'Calendar Invite', 'Invite #', '11:00', '15:00', '17:00', '5:00 PM', '3:00 PM'
  ];
  for (const forbidden of bannedScheduleAndVendors) {
    expect(ledgerRaw).not.toContain(forbidden);
    expect(fbMatch[1]).not.toContain(forbidden);
  }

  await page.goto('http://site.test/delivery/');
  await expect(page.getByRole('heading', { name: /Hour-by-hour delivery ledger/i })).toBeVisible();
  await expect(page.locator('.ledger-row').first()).toBeVisible();
  const visibleText = await page.locator('main').innerText();
  const trackerText = await page.locator('#v6-tracker').innerText();
  const legacyText = visibleText.replace(trackerText, '');
  for (const forbidden of bannedScheduleAndVendors) {
    expect(legacyText).not.toContain(forbidden);
  }
  expect(visibleText).toContain('not tracked yet');
  expect(visibleText).toContain('154');
  expect(visibleText).toContain('0.43x');
});

// The Projects page is "a list of what is actually built and running, kept
// current": it lists the studio, and says plainly what a visitor can and
// cannot do in it today.
test('the Projects page lists the studio with its limits stated', async ({ page }) => {
  await page.goto('http://site.test/projects/');
  const entry = page.locator('article', { has: page.getByRole('heading', { name: /The studio/ }) });
  await expect(entry).toHaveCount(1);
  await expect(entry).toContainText('scripted walkthrough');
  await expect(entry).toContainText('invited email');
  await expect(entry).toContainText('voice is not on for visitors yet');
});

// The STATIC footer every page ships, read from the file: what a visitor sees
// without script, and on pages that never load chrome.js (/listen/ redirects
// before it would). Every one ends with LinkedIn and the email; none has Board
// or Studio (Cursor NO-GO on 29a3eff: /listen/ was missed and the rendered test
// could not see it). Static and dynamic footers use the same grouped layout.
test('every static footer matches the ordered navigation and accessible contact icon', () => {
  const pages = fs.readdirSync(root, { recursive: true })
    .filter(f => /(^|[\\/])index\.html$|^404\.html$/.test(f) && !/node_modules|test-results/.test(f));
  let checked = 0;
  for (const rel of pages) {
    const html = fs.readFileSync(path.join(root, rel), 'utf8');
    const foot = (html.match(/<footer class="chrome-foot"[^>]*>[\s\S]*?<\/footer>/) || [''])[0];
    if (!foot) continue;
    checked += 1;
    if (/^ops[\\/]index\.html$/.test(rel)) {
      expect([...foot.matchAll(/<a\s+href="([^"]+)"/g)].map(m => m[1]), rel).toEqual(HREFS.slice(0, NAV_COUNT));
      expect(foot, rel).not.toMatch(/chrome-foot-contact|mailto:|linkedin/i);
      continue;
    }
    expect([...foot.matchAll(/<a\s+href="([^"]+)"/g)].map(m => m[1]), rel).toEqual(HREFS);
    expect(foot, rel).toContain('<nav aria-label="Footer">');
    expect(foot, rel).toContain('<span class="chrome-foot-main">');
    expect(foot, rel).toContain('<span class="chrome-foot-contact">');
    expect(foot, rel).toContain('aria-label="LinkedIn"');
    expect(foot, rel).toContain('<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">');
    expect(foot, rel).not.toMatch(/>History<\/a>|>Board<\/a>|>Studio<\/a>|>LinkedIn<\/a>/);
  }
  expect(checked).toBeGreaterThanOrEqual(18);
});

// One list. chrome-footer-polish.js rebuilds the nav on some pages after
// chrome.js has; with its own copy of the links, a link added to one file
// appeared on one pass and vanished on the next. It now reuses chrome.js's.
test('the footer list and renderer live only in chrome.js', () => {
  const chrome = fs.readFileSync(path.join(root, 'assets', 'chrome.js'), 'utf8');
  const polish = fs.readFileSync(path.join(root, 'assets', 'chrome-footer-polish.js'), 'utf8');
  expect(chrome).toContain('window.__SFDC24_FOOTER_LINKS = footerLinks');
  expect(chrome).toContain('window.__SFDC24_RENDER_FOOTER = ensureFooter');
  expect(polish).toContain('window.__SFDC24_RENDER_FOOTER');
  expect(polish).not.toContain('createElement');
  for (const label of ['"Board"', '"Studio"', '"Method"', '"History"', '"Privacy"', '"Terms"', '"Ops"', '"LinkedIn"']) {
    expect(polish, `chrome-footer-polish.js keeps its own ${label}`).not.toContain(label);
  }
});

// Owner, 2026-11-05: no narrative in any footer, on any page. The footer is the
// link row and the contact (LinkedIn and the email address). chrome.js rebuilds
// the footer at runtime, so only the rendered page proves no paragraph comes back.
const NARRATIVE = /independent community resource|not affiliated with|trademarks of Salesforce/i;

for (const route of ['/', '/index.html', '/about/', '/history/', '/method/', '/conferences/', '/releases/', '/experience/', '/404.html']) {
  test(`the rendered footer on ${route} has no narrative paragraph`, async ({ page }) => {
    await page.goto('http://site.test' + route);
    await page.waitForTimeout(1500);   // chrome.js and the polish pass have both run
    const foot = page.locator('footer.chrome-foot');
    await expect(foot.locator('.chrome-disclaimer')).toHaveCount(0);
    await expect(foot.locator('p')).toHaveCount(0);
    expect(await foot.innerText()).not.toMatch(NARRATIVE);
    await expectFooter(foot.locator('nav'));
  });
}

test('chrome.js adds no footer paragraph, even where the markup has no footer', async ({ page }) => {
  // A bare page: chrome.js creates the footer itself. It must be links only.
  const html = '<!DOCTYPE html><html><head><link rel="stylesheet" href="/assets/chrome.css"></head>' +
    '<body><main><h1>Bare</h1></main><script src="/assets/chrome.js" defer></script></body></html>';
  await page.route('http://site.test/bare/', r => r.fulfill({ body: html, contentType: 'text/html' }));
  await page.goto('http://site.test/bare/');
  await page.waitForTimeout(1500);
  const foot = page.locator('footer.chrome-foot');
  await expect(foot).toHaveCount(1);
  await expect(foot.locator('.chrome-disclaimer, p')).toHaveCount(0);
  expect(await foot.innerText()).not.toMatch(NARRATIVE);
  await expect(foot.getByRole('link', { name: 'abdus@sfdc24.com' })).toHaveAttribute('href', 'mailto:abdus@sfdc24.com');
});

test('the homepage footer is still right after the polish pass has run', async ({ page }) => {
  await page.goto('http://site.test/');
  await page.waitForTimeout(1500);   // polish runs after chrome.js, on a timer
  await expectFooter(page.locator('footer.chrome-foot nav'));
});

for (const width of [320, 390, 1280]) {
  for (const route of ['/', '/history/', '/ops/']) {
    test(`footer groups fit ${width}px on ${route}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await page.goto('http://site.test' + route);
      const nav = page.locator('footer.chrome-foot nav');
      await expectFooter(nav);
      if (OPS_PAGES.includes(route)) {
        // Navigation only: every link on screen and a full tap target.
        const links = await nav.locator('a').evaluateAll(els => els.map(a => a.getBoundingClientRect())
          .map(r => ({ left: r.left, right: r.right, height: r.height })));
        for (const link of links) {
          expect(link.left).toBeGreaterThanOrEqual(0);
          expect(link.right).toBeLessThanOrEqual(width);
          expect(link.height).toBeGreaterThanOrEqual(44);
        }
        return;
      }
      const layout = await nav.evaluate(node => {
        const rect = el => { const r = el.getBoundingClientRect(); return {left:r.left,right:r.right,top:r.top,height:r.height}; };
        return { nav:rect(node), main:rect(node.querySelector('.chrome-foot-main')), contact:rect(node.querySelector('.chrome-foot-contact')),
          links:[...node.querySelectorAll('a')].map(rect) };
      });
      expect(Math.abs(layout.main.left - layout.nav.left)).toBeLessThanOrEqual(1);
      expect(Math.abs(layout.contact.right - layout.nav.right)).toBeLessThanOrEqual(1);
      for (const link of layout.links) {
        expect(link.left).toBeGreaterThanOrEqual(0);
        expect(link.right).toBeLessThanOrEqual(width);
        expect(link.height).toBeGreaterThanOrEqual(44);
      }
      if (width === 1280) {
        expect(Math.abs(layout.main.top - layout.contact.top)).toBeLessThanOrEqual(1);
        expect(layout.contact.left).toBeGreaterThan(layout.main.right);
      } else {
        expect(layout.contact.top).toBeGreaterThanOrEqual(layout.main.top);
      }
    });
  }
}

test('footer keyboard order follows the visible navigation then accessible contact links', async ({ page }) => {
  await page.goto('http://site.test/history/');
  const nav = page.locator('footer.chrome-foot nav');
  await expectFooter(nav);
  const links = nav.locator('a');
  await links.first().focus();
  for (let i = 0; i < HREFS.length; i++) {
    await expect(links.nth(i)).toBeFocused();
    if (i + 1 < HREFS.length) await page.keyboard.press('Tab');
  }
});
