const { test, expect } = require('@playwright/test');
const { install, open, expectPlain } = require('./conferences_plain_helper.cjs');

test.beforeEach(install);

test('one explanation, four steps, one email', async ({ page }) => {
  await open(page);
  await expect(page.locator('h1')).toHaveCount(1);
  await expect(page.locator('#conference-how li')).toHaveCount(4);
  await expect(page.locator('main a')).toHaveCount(1);
});
