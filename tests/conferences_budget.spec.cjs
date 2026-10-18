// /conferences/ phone budget after the speed pass.
// 390x844, reduced motion, no CPU throttle (the throttle numbers live in
// the PR notes). Page weight is the same accounting as conferences_weight():
// HTML plus linked conferences assets, including the share image.
const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const PAGE_WEIGHT = 188202;
const ASSET_EXT = new Set(['.css', '.js', '.png', '.svg', '.jpg', '.jpeg', '.webp', '.gif', '.ico']);

function conferencesWeight() {
  const htmlPath = path.join(root, 'conferences', 'index.html');
  const html = fs.readFileSync(htmlPath, 'utf8');
  const parts = [['conferences/index.html', fs.statSync(htmlPath).size]];
  const seen = new Set();
  const re = /(?:href|src|content)\s*=\s*"([^"]+)"/g;
  let match;
  while ((match = re.exec(html))) {
    let url = match[1];
    if (url.startsWith('https://sfdc24.com/')) url = url.slice('https://sfdc24.com'.length);
    else if (/^(https?:)?\/\//.test(url)) continue;
    if (!url.startsWith('/conferences/')) continue;
    const rel = url.split('?')[0].split('#')[0];
    if (rel.endsWith('/') || seen.has(rel)) continue;
    seen.add(rel);
    const file = path.join(root, rel.slice(1));
    if (!fs.existsSync(file) || !ASSET_EXT.has(path.extname(file).toLowerCase())) continue;
    parts.push([rel.slice(1), fs.statSync(file).size]);
  }
  return parts.reduce((sum, item) => sum + item[1], 0);
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.__cls = 0;
    window.__longAfter = [];
    window.__loadEnd = 0;
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (!entry.hadRecentInput) window.__cls += entry.value;
        }
      }).observe({ type: 'layout-shift', buffered: true });
    } catch (err) {}
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (window.__loadEnd && entry.startTime >= window.__loadEnd) {
            window.__longAfter.push(entry.duration);
          }
        }
      }).observe({ type: 'longtask', buffered: true });
    } catch (err) {}
    window.addEventListener('load', () => {
      const nav = performance.getEntriesByType('navigation')[0];
      window.__loadEnd = nav ? nav.loadEventEnd : performance.now();
    });
  });
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
      '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon',
    };
    return route.fulfill({
      body: fs.readFileSync(file),
      contentType: types[path.extname(file)] || 'text/plain',
    });
  });
});

test('phone load stays inside the measured weight, shift, and long-task budget', async ({ page }) => {
  expect(conferencesWeight()).toBe(PAGE_WEIGHT);

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('http://site.test/conferences/', { waitUntil: 'load' });
  await page.waitForTimeout(600);

  const report = await page.evaluate(() => {
    const blocking = performance.getEntriesByType('resource')
      .filter((entry) => entry.renderBlockingStatus === 'blocking' && entry.name.includes('/conferences/'))
      .map((entry) => entry.name);
    const parserScripts = [...document.scripts].filter((node) => !node.src && node.type !== 'module').length;
    return {
      cls: window.__cls || 0,
      longAfter: window.__longAfter || [],
      blocking,
      parserScripts,
    };
  });

  expect(report.cls).toBeLessThan(0.05);
  expect(report.longAfter.filter((dur) => dur > 50)).toEqual([]);
  expect(report.blocking.map((name) => name.split('/conferences/')[1])).toEqual(['flow.css']);
  expect(report.parserScripts).toBe(1);
});
