const { test, expect } = require('@playwright/test');
const { install, open, expectPlain } = require('./conferences_plain_helper.cjs');

test.beforeEach(install);

test('the phone menu and the footer both list Conferences and Ops', async ({ page }) => {
  await open(page, { width: 390, height: 844 });
  await expectPlain(page);
  await page.locator('#chrome-menu summary').click();
  await expect(page.locator('#chrome-menu nav a[href="/conference/?room=workshop"]')).toBeVisible();
  await expect(page.locator('#chrome-menu nav a[href="/ops/"]')).toBeVisible();
});
