const { test, expect } = require('@playwright/test');
const { install, open, expectPlain } = require('./conferences_plain_helper.cjs');

test.beforeEach(install);

test('the contact link has a readable name', async ({ page }) => {
  await open(page, { width: 390, height: 844 });
  await expect(page.locator('#conference-contact')).toHaveAccessibleName('abdus@sfdc24.com');
  await expect(page.getByRole('heading', { level: 1, name: 'Conferences' })).toBeVisible();
});
