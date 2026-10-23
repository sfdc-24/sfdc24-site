const { test, expect } = require('@playwright/test');
const { install, open, expectPlain } = require('./conferences_plain_helper.cjs');

test.beforeEach(install);

test('a phone can read the page without sideways scroll', async ({ page }) => {
  await open(page, { width: 390, height: 844 });
  await expectPlain(page);
  await expect(page.locator('#conference-status')).toBeInViewport();
});
