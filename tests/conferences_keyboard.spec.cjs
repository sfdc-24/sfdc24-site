const { test, expect } = require('@playwright/test');
const { install, open, expectPlain } = require('./conferences_plain_helper.cjs');

test.beforeEach(install);

test('the email can take keyboard focus', async ({ page }) => {
  await open(page);
  await page.locator('#conference-contact').focus();
  await expect(page.locator('#conference-contact')).toBeFocused();
});
