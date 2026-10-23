const { test, expect } = require('@playwright/test');
const { install, open, expectPlain } = require('./conferences_plain_helper.cjs');

test.beforeEach(install);

test('the plain page stays within the shift budget on a phone', async ({ page }) => {
  await page.addInitScript(() => {
    window.__cls = 0;
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (!entry.hadRecentInput) window.__cls += entry.value;
        }
      }).observe({ type: 'layout-shift', buffered: true });
    } catch (err) {}
  });
  await open(page, { width: 390, height: 844 });
  await expectPlain(page);
  expect(await page.evaluate(() => window.__cls || 0)).toBeLessThan(0.05);
});
