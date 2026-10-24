const { test, expect } = require('@playwright/test');
const { install, open, expectPlain } = require('./conferences_plain_helper.cjs');

test.beforeEach(install);

test('the only action is the email address', async ({ page }) => {
  await open(page);
  await expect(page.locator('#conference-invite, .invite')).toHaveCount(0);
  await expect(page.locator('#conference-contact')).toHaveText('abdus@sfdc24.com');
});
