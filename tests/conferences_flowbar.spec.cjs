const { test, expect } = require('@playwright/test');
const { install, open, expectPlain } = require('./conferences_plain_helper.cjs');

test.beforeEach(install);

test('there is no start or join bar', async ({ page }) => {
  await open(page, { width: 390, height: 844 });
  await expect(page.locator('#conference-flow, .flowbar, #conference-actions')).toHaveCount(0);
  await expectPlain(page);
});
