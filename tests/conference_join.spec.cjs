// Owner join on a short phone: the control is on screen, the gateway stays
// honest, and a join click beacons without opening a microphone.
const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.__gum = 0;
    const deny = () => {
      window.__gum += 1;
      const err = new Error("denied");
      err.name = "NotAllowedError";
      return Promise.reject(err);
    };
    const devices = navigator.mediaDevices || {};
    devices.getUserMedia = deny;
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: devices });
  });
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== "http://site.test") return route.abort();
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith("/")) rel += "index.html";
    const file = path.resolve(root, "." + rel);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: "" });
    const types = {
      ".html": "text/html",
      ".js": "application/javascript",
      ".css": "text/css",
      ".json": "application/json",
      ".svg": "image/svg+xml",
      ".ico": "image/x-icon",
      ".png": "image/png"
    };
    return route.fulfill({ body: fs.readFileSync(file), contentType: types[path.extname(file)] || "application/octet-stream" });
  });
});

for (const size of [{ width: 320, height: 568 }, { width: 390, height: 640 }]) {
  test(`join stays on screen at ${size.width}x${size.height}`, async ({ page }) => {
    await page.setViewportSize(size);
    await page.goto("http://site.test/conference/");
    const join = page.getByRole("button", { name: "Join" });
    await expect(join).toBeVisible();
    await expect(page.locator("#join-status")).toHaveText("Join unavailable — waiting on gateway token");
    await expect(page.locator("#record-opt-in")).not.toBeChecked();
    const fit = await page.evaluate(() => {
      const el = document.scrollingElement || document.documentElement;
      const button = document.getElementById("join-conference");
      const box = button.getBoundingClientRect();
      return {
        overflowY: el.scrollHeight - el.clientHeight,
        overflowX: el.scrollWidth - el.clientWidth,
        buttonBottom: box.bottom
      };
    });
    expect(fit.overflowX).toBeLessThanOrEqual(0);
    expect(fit.overflowY).toBeLessThanOrEqual(1);
    expect(fit.buttonBottom).toBeLessThanOrEqual(size.height);
    await expect(page.getByRole("region", { name: "Roles" })).toContainText("Not duplex");
    await expect(page.locator("body")).not.toContainText("Yasmine");
  });
}

test("join click beacons the attempt and does not open the microphone", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 700 });
  await page.goto("http://site.test/conference/");
  await page.getByRole("button", { name: "Join" }).click();
  await expect(page.locator("#join-status")).toHaveText("Join unavailable — waiting on gateway token");
  const seen = await page.evaluate(() => ({
    gum: window.__gum,
    events: JSON.parse(sessionStorage.getItem("sfdc24_conf_events") || "[]")
  }));
  expect(seen.gum).toBe(0);
  expect(seen.events.some((e) => e.type === "viewport" && e.viewport && e.viewport.w > 0)).toBe(true);
  expect(seen.events.some((e) => e.type === "join_attempt" && e.record_opt_in === false)).toBe(true);
  expect(JSON.stringify(seen.events)).not.toMatch(/token|@|Yasmine/i);
  await page.locator("#record-opt-in").check();
  await page.getByRole("button", { name: "Join" }).click();
  const opted = await page.evaluate(() => JSON.parse(sessionStorage.getItem("sfdc24_conf_events") || "[]"));
  expect(opted.some((e) => e.type === "join_attempt" && e.record_opt_in === true)).toBe(true);
  expect(await page.evaluate(() => window.__gum)).toBe(0);
});
