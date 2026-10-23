const { test, expect } = require('@playwright/test');
const { install, open, expectPlain } = require('./conferences_plain_helper.cjs');

test.beforeEach(install);

test('nothing on the page opens a room', async ({ page }) => {
  await open(page);
  await expect(page.locator('a[href*="/conferences/room"]')).toHaveCount(0);
  await expect(page.locator('#conference-enter')).toHaveCount(0);
});
