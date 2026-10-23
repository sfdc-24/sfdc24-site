const { test, expect } = require('@playwright/test');
const { install, open, expectPlain } = require('./conferences_plain_helper.cjs');

test.beforeEach(install);

test('the plain page does not run a room animation', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await open(page, { width: 390, height: 844 });
  await expect(page.locator('#conference-stage, #conference-enter, .stage')).toHaveCount(0);
  await expectPlain(page);
});
