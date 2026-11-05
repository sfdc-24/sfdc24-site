const { test, expect } = require('@playwright/test');
const { install, open, expectPlain } = require('./conferences_plain_helper.cjs');

test.beforeEach(install);

test('the page says the live room is owner only', async ({ page }) => {
  await open(page);
  await expect(page.locator('#conference-status')).toBeVisible();
  await expect(page.locator('#conference-status')).toContainText('open to the owner only');
  await expect(page.locator('#conference-status')).not.toContainText('not open yet');
  await expect(page.locator('#conference-ready, .ready')).toHaveCount(0);
});
