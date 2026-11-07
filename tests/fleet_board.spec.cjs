const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const NOW = "2026-11-07T01:00:00Z";
const AGENTS = ["grok", "claude", "gemini", "copilot", "cursor", "aya"];

function live(agents, extra) {
  return Object.assign({
    schema: "sfdc24.fleet-public.v1",
    public_status: "live",
    transport: "poll",
    poll_seconds: 15,
    read_at: NOW,
    fresh_within_sec: 300,
    agents: agents
  }, extra || {});
}

test.beforeEach(async ({ page }) => {
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== "http://site.test") return route.abort();
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith("/")) rel += "index.html";
    const file = path.resolve(root, "." + rel);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) {
      return route.fulfill({ status: 404, body: "" });
    }
    const types = {
      ".html": "text/html",
      ".js": "application/javascript",
      ".css": "text/css",
      ".json": "application/json",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".ico": "image/x-icon"
    };
    return route.fulfill({
      body: fs.readFileSync(file),
      contentType: types[path.extname(file)] || "text/plain",
      headers: { "cache-control": "no-store" }
    });
  });
});

test("the homepage blocker is not a live status for the six agents", async ({ page }) => {
  await page.goto("http://site.test/", { waitUntil: "load" });
  const board = page.locator("#fleet-board");
  await expect(board).toHaveAttribute("data-feed-state", "unpublished");
  await expect(board).toHaveAttribute("data-feed-live", "0");
  await expect(board.locator("[data-fb='feed']")).toContainText("Not published");
  await expect(board.locator("[data-fb='feed']")).toContainText("not a live feed");
  await expect(board.locator(".fb-card")).toHaveCount(6);
  for (const id of AGENTS) {
    const card = board.locator(`[data-agent="${id}"]`);
    await expect(card.locator("[data-field='status']")).toHaveText("Unknown");
    await expect(card).toContainText("No pulse");
    await expect(card).not.toContainText("Idle");
    await expect(card).not.toContainText("Active");
    await expect(card).not.toContainText("Connected");
  }
  const calls = [];
  page.on("request", (req) => {
    if (req.url().includes("xp-live") || /redis|alphadb/i.test(req.url())) calls.push(req.url());
  });
  await page.waitForTimeout(200);
  expect(calls).toEqual([]);
});

test("a later projection arrives on its own without a reload", async ({ page }) => {
  let doc = JSON.parse(fs.readFileSync(path.join(root, "data", "fleet-public.json"), "utf8"));
  await page.clock.install({ time: new Date(NOW) });
  await page.route("**/data/fleet-public.json*", (route) => route.fulfill({
    contentType: "application/json",
    headers: { "cache-control": "no-store" },
    body: JSON.stringify(doc)
  }));
  await page.goto("http://site.test/", { waitUntil: "load" });
  await expect(page.locator("#fleet-board")).toHaveAttribute("data-feed-state", "unpublished");
  doc = live([
    { id: "claude", status: "blocked", pulse_at: "2026-11-07T00:59:30Z", task: "Homepage fleet board", owner: "Claude", gap: "Publisher not attached" },
    { id: "grok", status: "active", pulse_at: "2026-11-07T00:59:40Z", task: "Coordinate review", owner: "Grok", gap: null }
  ]);
  await page.clock.fastForward(61000);
  await expect(page.locator("#fleet-board")).toHaveAttribute("data-feed-state", "live");
  await expect(page.locator("[data-agent='claude']")).toHaveAttribute("data-blocked", "1");
  await expect(page.locator("[data-agent='claude'] [data-field='status']")).toHaveText("Blocked");
  await expect(page.locator("[data-agent='grok'] [data-field='status']")).toHaveText("Active");
  await expect(page.locator("[data-agent='aya'] [data-field='status']")).toHaveText("Unknown");
  await expect(page.locator("[data-agent='cursor']")).toContainText("No pulse");
  await expect(page.locator("#fleet-board")).not.toContainText("Connected");
});

test("active without a pulse stays unknown while a real change still propagates", async ({ page }) => {
  let doc = live(AGENTS.map((id) => ({ id: id, status: "active" })));
  await page.route("**/data/fleet-public.json*", (route) => route.fulfill({
    contentType: "application/json",
    headers: { "cache-control": "no-store" },
    body: JSON.stringify(doc)
  }));
  await page.clock.install({ time: new Date(NOW) });
  await page.goto("http://site.test/", { waitUntil: "load" });
  for (const id of AGENTS) {
    await expect(page.locator(`[data-agent="${id}"] [data-field="status"]`)).toHaveText("Unknown");
  }
  doc = live([{ id: "copilot", status: "idle", pulse_at: "2026-11-07T00:59:50Z", task: "Review notes", owner: "Copilot" }]);
  await page.evaluate(() => window.__SFDC24_FLEET.refresh());
  await expect(page.locator("[data-agent='copilot'] [data-field='status']")).toHaveText("Idle");
  await expect(page.locator("[data-agent='gemini'] [data-field='status']")).toHaveText("Unknown");
});

test("a stale feed keeps a blocked task, then a failed read can recover", async ({ page }) => {
  let mode = "stale";
  await page.clock.install({ time: new Date(NOW) });
  await page.route("**/data/fleet-public.json*", (route) => {
    if (mode === "fail") return route.fulfill({ status: 503, body: "" });
    if (mode === "recovered") {
      return route.fulfill({
        contentType: "application/json",
        headers: { "cache-control": "no-store" },
        body: JSON.stringify(live([
          { id: "claude", status: "active", pulse_at: "2026-11-07T00:59:55Z", task: "Recovered task", owner: "Claude", gap: null }
        ]))
      });
    }
    return route.fulfill({
      contentType: "application/json",
      headers: { "cache-control": "no-store" },
      body: JSON.stringify(live([
        { id: "claude", status: "blocked", pulse_at: "2026-11-07T00:40:00Z", task: "Release gate", owner: "Claude", gap: "Review waiting" }
      ], { read_at: "2026-11-07T00:40:00Z" }))
    });
  });
  await page.goto("http://site.test/", { waitUntil: "load" });
  await expect(page.locator("#fleet-board")).toHaveAttribute("data-feed-state", "stale");
  await expect(page.locator("[data-agent='claude'] [data-field='status']")).toHaveText("Blocked");
  await expect(page.locator("#fleet-board [data-fb='feed']")).toContainText("Feed stale");
  mode = "fail";
  await page.evaluate(() => window.__SFDC24_FLEET.refresh());
  await expect(page.locator("#fleet-board")).toHaveAttribute("data-feed-state", "offline");
  await expect(page.locator("[data-agent='claude'] [data-field='status']")).toHaveText("Blocked");
  await expect(page.locator("#fleet-board [data-fb='feed']")).toContainText("Offline");
  mode = "recovered";
  await page.evaluate(() => window.__SFDC24_FLEET.refresh());
  await expect(page.locator("#fleet-board")).toHaveAttribute("data-feed-state", "live");
  await expect(page.locator("[data-agent='claude'] [data-field='status']")).toHaveText("Active");
  await expect(page.locator("[data-agent='claude']")).toContainText("Recovered task");
});

test("unsafe task text is not executed", async ({ page }) => {
  await page.clock.install({ time: new Date(NOW) });
  await page.route("**/data/fleet-public.json*", (route) => route.fulfill({
    contentType: "application/json",
    headers: { "cache-control": "no-store" },
    body: JSON.stringify(live([{
      id: "gemini",
      status: "blocked",
      pulse_at: "2026-11-07T00:59:00Z",
      task: "<img src=x onerror=\"window.__pwned=1\"><script>window.__pwned=1</script>",
      owner: "someone@example.com",
      gap: "fleet:inbox:gemini"
    }]))
  }));
  await page.goto("http://site.test/", { waitUntil: "load" });
  const card = page.locator("[data-agent='gemini']");
  await expect(card.locator("[data-field='status']")).toHaveText("Blocked");
  await expect(card).toContainText("Not shown");
  await expect(card).not.toContainText("onerror");
  await expect(card).not.toContainText("fleet:inbox");
  await expect(card).not.toContainText("someone@example.com");
  expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
  expect(await page.locator("[data-agent='gemini'] img, [data-agent='gemini'] script").count()).toBe(0);
});

for (const width of [320, 390, 1280]) {
  test(`six cards fit a ${width}px homepage without sideways scroll`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("http://site.test/", { waitUntil: "load" });
    const board = page.locator("#fleet-board");
    await board.scrollIntoViewIfNeeded();
    await expect(board.locator(".fb-card")).toHaveCount(6);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    for (const id of AGENTS) {
      const box = await page.locator(`[data-agent="${id}"]`).boundingBox();
      expect(box.width).toBeGreaterThan(40);
      expect(box.x).toBeGreaterThanOrEqual(-1);
      expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
    }
  });
}
