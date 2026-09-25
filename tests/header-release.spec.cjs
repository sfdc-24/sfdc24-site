const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const releaseConfig = JSON.parse(fs.readFileSync(path.join(root, 'data', 'next-release.json'), 'utf8'));

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
    await expect(page.locator('#nextDeploy b')).toHaveText('Release');
    await expect(page.locator('#ndSentence')).toHaveText(releaseConfig.note);
    // DOM text can be complete while CSS ellipsis hides the milestone on phones.
    const sentenceWidth = await page.locator('#ndSentence').evaluate(el => ({
      content: el.scrollWidth, visible: el.clientWidth
    }));
    expect(sentenceWidth.content, 'release note must be fully visible, not ellipsized')
      .toBeLessThanOrEqual(sentenceWidth.visible + 1);
    await expect(page.locator('#ndRem')).toHaveText(releaseConfig.at === null ? '--:--' : /^\d{2}:\d{2}:\d{2}$/);
    const remainingBefore = await page.locator('#ndRem').textContent();
    await expect(page.locator('#ndViz svg.watch')).toBeVisible();
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
    if (releaseConfig.at === null) {
      await expect(page.locator('#ndRem')).toHaveText('--:--');
    } else {
      await expect(page.locator('#ndRem')).not.toHaveText(remainingBefore);
    }
    await expect(page.locator('#ndViz svg.watch')).toBeVisible();
    await expect(page.locator('#nextDeploy')).not.toContainText(/DELAYED/);
  });
}

test('countdown ticks only for an explicit next release', async ({page}) => {
  await page.addInitScript(() => {
    window.__SFDC24_NEXT_DEPLOY = '2026-09-21T04:10:00.000Z';
    window.__SFDC24_NEXT_NOTE = 'Clock returns on the rail';
  });
  await page.setViewportSize({width: 1280, height: 900});
  await page.goto('http://site.test/');
  await page.clock.pauseAt('2026-09-21T04:00:00.000Z');
  await expect(page.locator('#ndSentence')).toHaveText('Clock returns on the rail');
  await expect(page.locator('#ndRem')).toHaveText('00:10:00');
  await expect(page.locator('#ndViz svg.watch')).toBeVisible();
  await page.clock.fastForward(1000);
  await expect(page.locator('#ndRem')).toHaveText('00:09:59');
  await expect(page.locator('#nextDeploy')).not.toContainText(/DELAYED|ON TIME|EARLY/);
});

test('the next release names what ships, counts down to its stated time, and claims nothing is live', async ({page}) => {
  expect(typeof releaseConfig.note).toBe('string');
  expect(releaseConfig.note.trim().split(/\s+/).length).toBeLessThanOrEqual(9);
  if (releaseConfig.at !== null) {
    expect(Date.parse(releaseConfig.at)).toBeGreaterThan(Date.parse(releaseConfig.start));
  }
  await page.setViewportSize({width: 320, height: 900});
  await page.goto('http://site.test/');
  await expect(page.locator('#ndSentence')).toHaveText(releaseConfig.note);
  await expect(page.locator('#ndRem')).toHaveText(releaseConfig.at === null ? '--:--' : /^\d{2,3}:\d{2}:\d{2}$/);
  await expect(page.locator('#nextDeploy')).not.toContainText(/ON TIME|voice is live|Lead[- ]count is live|Salesforce is live/i);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
});

test('unknown release time stays unknown past a retired forecast', async ({page}) => {
  await page.route('**/data/next-release.json', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ note: 'Studio sign-in pending: client fixes and email delivery', at: null })
  }));
  await page.goto('http://site.test/');
  await expect(page.locator('#ndSentence')).toHaveText('Studio sign-in pending: client fixes and email delivery');
  await expect(page.locator('#ndRem')).toHaveText('--:--');
  await page.clock.fastForward(3 * 24 * 60 * 60 * 1000 + 5 * 60 * 60 * 1000);
  await expect(page.locator('#ndRem')).toHaveText('--:--');
  await expect(page.locator('#nextDeploy')).not.toContainText(/00:00:00|DELAYED|ON TIME|EARLY/);
  await expect(page.locator('#ndViz svg.watch')).toBeVisible();
});

test('data-next-deploy counts down without a stored promise', async ({page}) => {
  await page.route('**/data/next-release.json', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ note: 'Next release time is not set', at: null })
  }));
  await page.setViewportSize({width: 1280, height: 900});
  await page.goto('http://site.test/');
  await page.clock.pauseAt('2026-09-21T04:00:00.000Z');
  await expect(page.locator('#ndRem')).toHaveText('--:--');
  await page.locator('#nextDeploy').evaluate((el) => {
    el.setAttribute('data-next-deploy', '2026-09-21T04:00:30.000Z');
    el.setAttribute('data-next-note', 'Explicit attribute sets the time');
  });
  await page.clock.fastForward(1000);
  await expect(page.locator('#ndSentence')).toHaveText('Explicit attribute sets the time');
  await expect(page.locator('#ndRem')).toHaveText('00:00:29');
  await expect(page.locator('#ndViz svg.watch')).toBeVisible();
  await expect(page.locator('#nextDeploy')).not.toContainText(/DELAYED|ON TIME|EARLY/);
});

test('committed next-release config can start the countdown', async ({page}) => {
  await page.route('**/data/next-release.json', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ note: 'Config file sets the release', at: '2026-09-21T04:05:00.000Z' })
  }));
  await page.setViewportSize({width: 1280, height: 900});
  await page.goto('http://site.test/');
  await page.clock.pauseAt('2026-09-21T04:00:00.000Z');
  await expect(page.locator('#ndSentence')).toHaveText('Config file sets the release');
  await expect(page.locator('#ndRem')).toHaveText('00:05:00');
  await expect(page.locator('#ndViz svg.watch')).toBeVisible();
});

test('date is shared, release description stays homepage-only', async ({page}) => {
  await page.goto('http://site.test/method/');
  await expect(page.locator('header .header-calendar')).toBeVisible();
  await expect(page.locator('#nextDeploy')).toHaveCount(0);
});
