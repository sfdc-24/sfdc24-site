const { test, expect } = require('@playwright/test');
test.use({ timezoneId: 'America/Toronto' });
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const releaseConfig = JSON.parse(fs.readFileSync(path.join(root, 'data', 'next-release.json'), 'utf8'));
const latestRelease = JSON.parse(fs.readFileSync(path.join(root, 'data', 'latest-release.json'), 'utf8'));
const milestones = JSON.parse(fs.readFileSync(path.join(root, 'data', 'release-milestones.json'), 'utf8'));
const currentMilestone = milestones.milestones.find((row) => row && row.status !== 'passed');

function torontoRelease(iso) {
  const parts = {};
  new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Toronto',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'short',
  }).formatToParts(new Date(iso)).forEach((part) => {
    if (part.type !== 'literal') parts[part.type] = part.value;
  });
  const hour = String(parts.hour).padStart(2, '0');
  const minute = String(parts.minute).padStart(2, '0');
  return `${parts.month} ${parts.day}, ${parts.year}, ${hour}:${minute} ${parts.timeZoneName}`;
}

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
  test(`live Toronto clock and release clock fit the ${width}px header`, async ({page}) => {
    await page.setViewportSize({width, height:900});
    await page.goto('http://site.test/');
    const date = page.locator('header .header-calendar');
    await expect(date).toBeVisible();
    await expect(date).toHaveAttribute('data-release-clock', '1');
    await expect(date.locator('.rel-label')).toHaveText(currentMilestone.label);
    if (currentMilestone.at) {
      await expect(date).toHaveAttribute('datetime', currentMilestone.at);
      await expect(date.locator('.rel-count')).toHaveText(/^\d+d \d{2}:\d{2}:\d{2}$/);
    } else {
      await expect(date.locator('.rel-count')).toBeHidden();
    }
    await expect(date.locator('.rel-live')).toHaveAttribute('aria-live', 'polite');
    await expect(date).not.toContainText(latestRelease.latest.title);
    for (const item of latestRelease.next.contains) await expect(date).not.toContainText(item);
    await expect(date).not.toContainText('Sep 20, 2026');
    await expect(page.locator('header .chrome-clock')).toHaveText('23:59 EDT');
    const releaseBefore = currentMilestone.at ? await date.locator('.rel-count').innerText() : '';
    expect(await date.innerText()).not.toContain('23:59');
    await expect(page.locator('#nextDeploy b')).toHaveText('Release');
    await expect(page.locator('#ndSentence')).toHaveText(releaseConfig.note);
    // DOM text can be complete while CSS ellipsis hides the milestone on phones.
    const sentenceWidth = await page.locator('#ndSentence').evaluate(el => ({
      content: el.scrollWidth, visible: el.clientWidth
    }));
    expect(sentenceWidth.content, 'release note must be fully visible, not ellipsized')
      .toBeLessThanOrEqual(sentenceWidth.visible + 1);
    await expect(page.locator('#ndRem')).toHaveText(releaseConfig.at === null ? '--:--' : /^\d{2,3}:\d{2}:\d{2}$/);
    const remainingBefore = await page.locator('#ndRem').textContent();
    // 2026-10-23, owner: no release time, no rail in the homepage header.
    const railShown = releaseConfig.at !== null && Date.parse(releaseConfig.at) > Date.parse('2026-09-21T03:59:00Z');
    if (railShown) await expect(page.locator('#ndViz svg.watch')).toBeVisible();
    else await expect(page.locator('#nextDeploy')).toBeHidden();
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
    for (const selector of ['header .chrome-mark', 'header .header-calendar'].concat(railShown ? ['#nextDeploy'] : [])) {
      const box = await page.locator(selector).boundingBox();
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      boxes.push(box);
    }
    for (let i=0; i<boxes.length; i++) for (let j=i+1; j<boxes.length; j++) {
      const a=boxes[i], b=boxes[j];
      expect(a.x+a.width <= b.x || b.x+b.width <= a.x || a.y+a.height <= b.y || b.y+b.height <= a.y).toBe(true);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    await page.clock.fastForward(120000);
    if (currentMilestone.at) await expect(date).toHaveAttribute('datetime', currentMilestone.at);
    await expect(date.locator('.rel-label')).toHaveText(currentMilestone.label);
    await expect(date.locator('.rel-live')).toHaveText(currentMilestone.label);
    if (currentMilestone.at) expect(await date.locator('.rel-count').innerText()).not.toBe(releaseBefore);
    await expect(page.locator('header .chrome-clock')).toHaveText('00:01 EDT');
    if (releaseConfig.at === null) {
      await expect(page.locator('#ndRem')).toHaveText('--:--');
    } else {
      await expect(page.locator('#ndRem')).not.toHaveText(remainingBefore);
    }
    if (railShown) await expect(page.locator('#ndViz svg.watch')).toBeVisible();
    else await expect(page.locator('#nextDeploy')).toBeHidden();
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

test('a passed release checkpoint hides the homepage rail and keeps a truthful elapsed timer', async ({page}) => {
  await page.addInitScript(() => {
    window.__SFDC24_NEXT_DEPLOY = '2026-09-21T03:58:55.000Z';
    window.__SFDC24_NEXT_NOTE = 'Guided flow checkpoint';
  });
  await page.setViewportSize({width: 1280, height: 900});
  await page.goto('http://site.test/');
  await expect(page.locator('#ndSentence')).toHaveText('Guided flow checkpoint');
  await expect(page.locator('#ndRem')).toHaveText(/^\+\d{2}:\d{2}:\d{2}$/);
  const elapsedSeconds = async () => {
    const parts = (await page.locator('#ndRem').textContent()).slice(1).split(':').map(Number);
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  };
  const elapsedBefore = await elapsedSeconds();
  expect(elapsedBefore).toBeGreaterThanOrEqual(5);
  await expect(page.locator('#ndRem')).toHaveAttribute('role', 'timer');
  await expect(page.locator('#ndRem')).toHaveAttribute('aria-atomic', 'true');
  await expect(page.locator('#nextDeploy')).toHaveAttribute('data-release-phase', 'elapsed');
  await expect(page.locator('#nextDeploy')).toBeHidden();
  await expect(page.locator('#ndRem')).toHaveAttribute('aria-label', 'Time since the stated release checkpoint');
  await expect(page.locator('#ndViz svg.watch')).toHaveAttribute('aria-hidden', 'true');
  await expect(page.locator('#ndViz svg.watch')).not.toHaveAttribute('aria-label', /.+/);
  await page.clock.fastForward(2000);
  await expect.poll(elapsedSeconds).toBeGreaterThanOrEqual(elapsedBefore + 2);
  await expect(page.locator('#nextDeploy')).not.toContainText(/DELAYED|ON TIME|EARLY|released|deployed/i);
});

test('the open page refreshes release configuration and can retire an expired target', async ({page}) => {
  let reads = 0;
  await page.route('**/data/next-release.json', route => {
    reads += 1;
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(reads === 1
        ? {note: 'Old checkpoint', at: '2026-09-21T03:58:55.000Z'}
        : {note: 'Next release time is not set', at: null})
    });
  });
  await page.setViewportSize({width: 1280, height: 900});
  await page.goto('http://site.test/');
  await expect(page.locator('#ndSentence')).toHaveText('Old checkpoint');
  await expect(page.locator('#ndRem')).toHaveText('+00:00:05');
  await page.clock.fastForward(60000);
  await expect.poll(() => reads).toBeGreaterThanOrEqual(2);
  await expect(page.locator('#ndSentence')).toHaveText('Next release time is not set');
  await expect(page.locator('#ndRem')).toHaveText('--:--');
  await expect(page.locator('#nextDeploy')).toHaveAttribute('data-release-phase', 'unset');
  await expect(page.locator('#nextDeploy')).toBeHidden();
});

test('a config refresh clears a stale start while retaining the target', async ({page}) => {
  let reads = 0;
  await page.route('**/data/next-release.json', route => {
    reads += 1;
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(reads === 1
        ? {note: 'Current checkpoint', at: '2026-09-21T04:03:00.000Z', start: '2026-09-21T03:55:00.000Z'}
        : {note: 'Current checkpoint', at: '2026-09-21T04:03:00.000Z', start: null})
    });
  });
  await page.setViewportSize({width: 1280, height: 900});
  await page.goto('http://site.test/');
  await expect(page.locator('#ndViz svg line').nth(1)).toHaveAttribute('y2', '19.40');
  await page.clock.fastForward(60000);
  await expect.poll(() => reads).toBeGreaterThanOrEqual(2);
  await expect.poll(async () => Number(await page.locator('#ndViz svg line').nth(1).getAttribute('y2')))
    .toBeLessThan(10);
  await expect(page.locator('#ndRem')).toHaveText(/^00:0[23]:\d{2}$/);
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
  if (releaseConfig.at === null) await expect(page.locator('#nextDeploy')).toBeHidden();
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
  await expect(page.locator('#nextDeploy')).toBeHidden();
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
  await expect(page.locator('#nextDeploy')).toBeHidden();
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

test('the Release control opens Ops', async ({page}) => {
  await page.addInitScript(() => { if (location.pathname === '/') window.__SFDC24_NEXT_DEPLOY = '2026-09-21T04:30:00.000Z'; });
  await page.setViewportSize({width: 1280, height: 900});
  await page.goto('http://site.test/');
  const release = page.locator('#nextDeploy');
  await expect(release).toBeVisible();
  await expect(release).toHaveAttribute('href', '/ops/');
  await expect(release.locator('b')).toHaveText('Release');
  await release.click();
  await expect(page).toHaveURL(/\/ops\/?$/);
  await expect(page.locator('#release')).toBeVisible();
  await expect(page.locator('#release')).toContainText('DEV');
  await expect(page.locator('#release')).toContainText('STAGING');
  await expect(page.locator('#release')).toContainText('PROD');
  await expect(page.locator('header #nextDeploy')).toHaveCount(0);
  const clock = page.locator('#release-clock #nextDeploy');
  await expect(clock).toBeVisible();
  await expect(clock).not.toHaveAttribute('href');
  await expect(clock.locator('b')).toHaveText('Release');
  await expect(page.locator('#ndSentence')).toHaveText(releaseConfig.note);
  await expect(page.locator('#ndViz svg.watch')).toBeVisible();
  await expect(page.locator('#ndRem')).toHaveText(releaseConfig.at === null ? '--:--' : /^\+?\d{2,3}:\d{2}:\d{2}$/);
});

test('the release countdown is in the header on every page', async ({page}) => {
  await page.goto('http://site.test/method/');
  const date = page.locator('header .header-calendar');
  await expect(date).toBeVisible();
  await expect(date).toHaveAttribute('data-release-clock', '1');
  await expect(date.locator('.rel-label')).toHaveText(currentMilestone.label);
  await expect(page.locator('header .chrome-clock')).toHaveText('23:59 EDT');
  await expect(date).not.toContainText(latestRelease.latest.title);
  await expect(page.locator('#nextDeploy')).toHaveCount(0);
});

test('release facts are rendered from the data file, not typed into the page', async () => {
  const home = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const clock = fs.readFileSync(path.join(root, 'assets', 'home-release-clock.js'), 'utf8');
  const chrome = fs.readFileSync(path.join(root, 'assets', 'chrome.js'), 'utf8');
  expect(home).toContain('/assets/home-release-clock.js');
  expect(home).toContain('/assets/release-milestones.js');
  expect(clock).toContain('/data/release-milestones.json');
  expect(chrome).toContain('data-release-clock');
  for (const src of [home, clock, chrome]) {
    expect(src).not.toContain(latestRelease.latest.merged_at);
    expect(src).not.toContain(latestRelease.latest.title);
    for (const item of latestRelease.next.contains) expect(src).not.toContain(item);
  }
});

test('a bad release record does not fall back to the live clock', async ({page}) => {
  await page.route('**/data/release-milestones.json', route => route.fulfill({
    contentType: 'application/json',
    body: 'null',
  }));
  await page.setViewportSize({width: 1280, height: 900});
  await page.goto('http://site.test/');
  const date = page.locator('header .header-calendar');
  await expect(date).toContainText('Release record did not load.');
  await expect(date).not.toContainText('Sep 20, 2026');
  await expect(page.locator('header .chrome-clock')).toHaveText('23:59 EDT');
});

// 2026-10-23, owner: nothing on the homepage that cannot be measured. The
// homepage "Next release" block exists only while a real future time is set.
test('homepage Next release block renders nothing without a future time', async ({page}) => {
  await page.route('**/data/next-release.json', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ note: 'Next release time is not set', at: null })
  }));
  await page.setViewportSize({width: 1280, height: 900});
  await page.goto('http://site.test/');
  await expect(page.locator('#ndRem')).toHaveText('--:--');
  await expect(page.locator('#next-release')).toBeHidden();
  await expect(page.locator('body')).not.toContainText(/being scheduled|time reached/i);
});

test('homepage Next release block counts down to a real time, then disappears', async ({page}) => {
  await page.route('**/data/next-release.json', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ note: 'Config file sets the release', at: '2026-09-21T04:05:00.000Z' })
  }));
  await page.setViewportSize({width: 1280, height: 900});
  await page.goto('http://site.test/');
  await page.clock.pauseAt('2026-09-21T04:00:00.000Z');
  const block = page.locator('#next-release');
  await expect(block).toBeVisible();
  await expect(page.locator('#nr-when')).toHaveText('Next release: Mon, Sep 21, 12:05 AM ET');
  await expect(page.locator('#nr-count')).toContainText(/0\s*days\s*00\s*hours\s*0[45]\s*minutes/);
  await expect(block.locator('a')).toHaveAttribute('href', '/ops/');
  await page.clock.fastForward(6 * 60 * 1000);
  await expect(block).toBeHidden();
  await expect(page.locator('body')).not.toContainText(/being scheduled|time reached/i);
});
