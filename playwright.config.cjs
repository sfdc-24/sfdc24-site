const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "./tests",
  // Only .spec.cjs files. tests/ also holds node:test suites
  // (site_positioning.cjs, homepage_recovery.cjs) and python ones; Playwright
  // must not try to run those.
  testMatch: /.*\.spec\.cjs$/,
  timeout: 15000,
  use: {
    browserName: "chromium",
    headless: true
  }
});
