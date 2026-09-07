const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "./tests",
  timeout: 15000,
  use: {
    browserName: "chromium",
    headless: true
  }
});
