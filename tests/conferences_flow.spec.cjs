const { test, expect } = require('@playwright/test');
const { install, open, expectPlain } = require('./conferences_plain_helper.cjs');

test.beforeEach(install);

test('how it works is four plain steps on a desktop screen', async ({ page }) => {
  await open(page, { width: 1280, height: 900 });
  await expectPlain(page);
  await expect(page.locator('#conference-how')).toBeVisible();
});
