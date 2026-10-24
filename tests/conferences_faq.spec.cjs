const { test, expect } = require('@playwright/test');
const { install, open, expectPlain } = require('./conferences_plain_helper.cjs');

test.beforeEach(install);

test('the old question accordion is gone', async ({ page }) => {
  await open(page);
  await expect(page.locator('#conference-faq, .faq-btn')).toHaveCount(0);
  await expect(page.locator('#conference-how li')).toHaveCount(4);
});
