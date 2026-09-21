const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');

test.beforeEach(async ({ page }) => {
  await page.clock.install({ time: new Date('2026-09-21T03:59:00Z') });
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://site.test') return route.abort();
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.resolve(root, '.' + rel);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) return route.fulfill({status:404,body:''});
    const types = {'.html':'text/html', '.js':'application/javascript', '.css':'text/css', '.json':'application/json'};
    return route.fulfill({body:fs.readFileSync(file),contentType:types[path.extname(file)] || 'text/plain'});
  });
  await page.addInitScript(() => {
    sessionStorage.setItem('sfdc24_next_deploy_iso', '2026-09-19T00:00:00Z');
    sessionStorage.setItem('sfdc24_eta_auto_delta', 'old');
  });
});

for (const width of [320, 390, 1280]) {
  test(`date and readable release fit the ${width}px header`, async ({page}) => {
    await page.setViewportSize({width, height:900});
    await page.goto('http://site.test/');
    const date = page.locator('header .header-calendar');
    await expect(date).toBeVisible();
    await expect(date).toHaveAttribute('datetime','2026-09-20');
    await expect(date).toContainText('20');
    await expect(page.locator('#ndSentence')).toHaveText('Readable header and current date');
    await expect(page.locator('#nextDeploy')).not.toContainText(/Cobalt|DELAYED|ON TIME|EARLY/);
    const colors = await page.locator('#ndSentence').evaluate(el => {
      const channel = n => (n /= 255) <= .04045 ? n/12.92 : ((n+.055)/1.055)**2.4;
      const lum = c => {
        const a = c.match(/[\d.]+/g).slice(0,3).map(Number).map(channel);
        return a[0]*.2126+a[1]*.7152+a[2]*.0722;
      };
      const fg = lum(getComputedStyle(el).color);
      const bg = lum(getComputedStyle(el.closest('header')).backgroundColor);
      return (Math.max(fg,bg)+.05)/(Math.min(fg,bg)+.05);
    });
    expect(colors).toBeGreaterThanOrEqual(4.5);
    const boxes = [];
    for (const selector of ['header .chrome-mark', 'header .header-calendar', '#nextDeploy']) {
      const box = await page.locator(selector).boundingBox();
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      boxes.push(box);
    }
    for (let i=0; i<boxes.length; i++) for (let j=i+1; j<boxes.length; j++) {
      const a=boxes[i], b=boxes[j];
      expect(a.x+a.width <= b.x || b.x+b.width <= a.x || a.y+a.height <= b.y || b.y+b.height <= a.y).toBe(true);
    }
    await page.clock.fastForward(120000);
    await expect(date).toHaveAttribute('datetime','2026-09-21');
    await expect(date).toContainText('21');
    await expect(page.locator('#nextDeploy')).not.toContainText(/DELAYED/);
  });
}

test('date is shared, release description stays homepage-only', async ({page}) => {
  await page.goto('http://site.test/method/');
  await expect(page.locator('header .header-calendar')).toBeVisible();
  await expect(page.locator('#nextDeploy')).toHaveCount(0);
});
