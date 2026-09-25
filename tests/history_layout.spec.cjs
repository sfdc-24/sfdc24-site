const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const timeline = JSON.parse(fs.readFileSync(path.join(root, 'data/history-timeline.json'), 'utf8'));

test.beforeEach(async ({ page }) => {
  // Exercise committed History, its shared chrome and the real timeline data.
  // External analytics/fonts are blocked; no microphone or form is used.
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
});

for (const width of [320, 390, 768, 1280]) {
  test(`History content and controls fit the ${width}px viewport without clipping`, async ({ page }) => {
    await page.setViewportSize({width, height:900});
    await page.goto('http://site.test/history/');
    await expect(page.locator('#chrome-ask')).toBeVisible();
    await expect(page.locator('.hist-row')).toHaveCount(timeline.events.length);
    await expect(page.locator('.hist-offsite')).toHaveCount(timeline.events.filter(event => !event.sha).length);
    const measure = await page.evaluate(() => {
      const width = document.documentElement.clientWidth;
      const overflow = [];
      for (const el of document.body.querySelectorAll('*')) {
        if (!el.checkVisibility()) continue;
        const box = el.getBoundingClientRect();
        if (box.width && (box.left < -1 || box.right > width + 1)) {
          overflow.push({element:el.id || el.className || el.tagName,left:box.left,right:box.right});
        }
      }
      return {
        width, scrollWidth:document.documentElement.scrollWidth, overflow,
        narrowestSubject:Math.min(...Array.from(document.querySelectorAll('.hist-sub'), el => el.getBoundingClientRect().width)),
        clippedSubjects:Array.from(document.querySelectorAll('.hist-sub')).filter(el =>
          el.scrollWidth > el.clientWidth + 1 || ['hidden','clip'].includes(getComputedStyle(el).overflowX)).length,
        clippedShells:[document.documentElement, document.body,
          document.querySelector('.wrap'), document.querySelector('#history-mount'),
          document.querySelector('#chrome-ask-shell')].filter(el =>
            ['hidden','clip'].includes(getComputedStyle(el).overflowX)).map(el => el.id || el.className || el.tagName)
      };
    });
    expect(measure.overflow.length, JSON.stringify({...measure,overflow:measure.overflow.slice(0,12)})).toBe(0);
    expect(measure.scrollWidth).toBeLessThanOrEqual(width);
    expect(measure.clippedShells).toEqual([]);
    expect(measure.clippedSubjects).toBe(0);
    // A column of one-word lines can fit without clipping and still be
    // unreadable. Protect the mobile subject row, not just overall overflow.
    if (width <= 600) expect(measure.narrowestSubject).toBeGreaterThanOrEqual(200);
    // The fit must preserve the timeline and citation/link distinction.
    expect((await page.locator('.hist-sub').allTextContents()).sort()).toEqual(timeline.events.map(event => event.subject || '').sort());
    const links = await page.locator('.hist-row').evaluateAll(rows => rows.map(row => ({
      subject:row.querySelector('.hist-sub').textContent, href:row.getAttribute('href')
    })).map(row => JSON.stringify(row)).sort());
    expect(links).toEqual(timeline.events.map(event => JSON.stringify({subject:event.subject || '',
      href:event.sha ? `https://github.com/sfdc-24/sfdc24-site/commit/${encodeURIComponent(event.sha)}` : null})).sort());
    await expect(page.locator('footer nav a', {hasText:'abdus@sfdc24.com'})).toHaveAttribute('href','mailto:abdus@sfdc24.com');
  });
}
