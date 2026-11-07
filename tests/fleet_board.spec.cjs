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
  await expect(board.locator("[data-fb='feed']")).toHaveText("Process illustration · live status unavailable");
  await expect(board.locator("[data-agent='cursor'] .fb-role")).toHaveText("Build");
  await expect(board.locator("[data-agent='claude'] .fb-role")).toHaveText("Integrate + release");
  await expect(board.locator("[data-agent='aya'] .fb-role")).toHaveText("Research");
  await expect(board.locator("[data-agent='copilot'] .fb-role")).toHaveText("Paired review");
  await expect(board.locator("[data-agent='grok'] .fb-role")).toHaveText("Coordinate");
  await expect(board.locator("[data-agent='gemini'] .fb-role")).toHaveText("Architecture");
  await expect(board.locator("h2")).toHaveText("How they work together");
  await expect(board.locator(".fb-node")).toHaveCount(6);
  await expect(board.locator(".fb-guide")).toHaveCount(1);
  await expect(board.locator(".fb-link")).toHaveCount(1);
  await expect(board).not.toContainText("Connected");
  await expect(board.locator(".fb-dot:not([hidden])")).toHaveCount(0);
  for (const id of AGENTS) {
    const node = board.locator(`[data-agent="${id}"]`);
    await expect(node).toHaveCount(1);
    await expect(node.locator("[data-field='status']")).toHaveText("");
    await expect(node).not.toContainText("No pulse");
    await expect(node).not.toContainText("Unknown");
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
  await expect(page.locator("[data-agent='claude'] .fb-dot")).toBeVisible();
  await expect(page.locator("[data-agent='claude'] [data-field='status']")).toHaveText("Blocked");
  await expect(page.locator("[data-agent='grok'] [data-field='status']")).toHaveText("Active");
  await expect(page.locator("[data-agent='aya'] .fb-dot")).toBeHidden();
  await expect(page.locator("[data-agent='cursor'] .fb-dot")).toBeHidden();
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
    await expect(page.locator(`[data-agent="${id}"] .fb-dot`)).toBeHidden();
  }
  doc = live([{ id: "copilot", status: "idle", pulse_at: "2026-11-07T00:59:50Z", task: "Review notes", owner: "Copilot" }]);
  await page.evaluate(() => window.__SFDC24_FLEET.refresh());
  await expect(page.locator("[data-agent='copilot'] [data-field='status']")).toHaveText("Idle");
  await expect(page.locator("[data-agent='gemini'] .fb-dot")).toBeHidden();
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
  await expect(page.locator("[data-agent='claude'] .fb-dot")).toBeHidden();
  await expect(page.locator("#fleet-board [data-fb='feed']")).toContainText("feed stale");
  mode = "fail";
  await page.evaluate(() => window.__SFDC24_FLEET.refresh());
  await expect(page.locator("#fleet-board")).toHaveAttribute("data-feed-state", "offline");
  await expect(page.locator("[data-agent='claude'] .fb-dot")).toBeHidden();
  await expect(page.locator("#fleet-board [data-fb='feed']")).toContainText("offline");
  mode = "recovered";
  await page.evaluate(() => window.__SFDC24_FLEET.refresh());
  await expect(page.locator("#fleet-board")).toHaveAttribute("data-feed-state", "live");
  await expect(page.locator("[data-agent='claude'] [data-field='status']")).toHaveText("Active");
  await expect(page.locator("[data-agent='claude']")).not.toContainText("Recovered task");
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
    await expect(board.locator(".fb-node")).toHaveCount(6);
    const box = await board.boundingBox();
    expect(box.height).toBeLessThanOrEqual(700);
    if (width < 700) expect(box.height).toBeLessThanOrEqual(900);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    for (const id of AGENTS) {
      const node = await page.locator(`[data-agent="${id}"]`).boundingBox();
      expect(node.width).toBeGreaterThan(40);
      expect(node.x).toBeGreaterThanOrEqual(-1);
      expect(node.x + node.width).toBeLessThanOrEqual(width + 1);
    }
    const owner = await page.locator("[data-human='owner']").boundingBox();
    expect(owner.x).toBeGreaterThanOrEqual(-1);
    expect(owner.x + owner.width).toBeLessThanOrEqual(width + 1);
    const crossed = await page.evaluate(() => {
      const stage = document.querySelector(".fb-stage").getBoundingClientRect();
      const blockers = [...document.querySelectorAll(".fb-node")].map((node) => ({
        id: node.getAttribute("data-agent"),
        box: node.getBoundingClientRect()
      }));
      const hits = [];
      for (const path of document.querySelectorAll(".fb-wa, .fb-conf")) {
        const len = path.getTotalLength();
        for (let i = 0; i <= 32; i++) {
          const point = path.getPointAtLength((len * i) / 32);
          const x = stage.left + (point.x / 100) * stage.width;
          const y = stage.top + (point.y / 78) * stage.height;
          for (const blocker of blockers) {
            const box = blocker.box;
            if (x >= box.left - 1 && x <= box.right + 1 && y >= box.top - 1 && y <= box.bottom + 1) {
              hits.push(path.getAttribute("class") + ":" + blocker.id);
            }
          }
        }
      }
      return hits;
    });
    expect(crossed).toEqual([]);
  });
}

test("the owner routes and an agent detail stay unavailable until the projection says otherwise", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("http://site.test/", { waitUntil: "load" });
  const stage = page.locator(".fb-stage");
  await stage.scrollIntoViewIfNeeded();
  const before = await stage.boundingBox();
  await page.locator("[data-human='owner']").click();
  const board = page.locator("[data-fb='board']");
  await expect(board).toBeVisible();
  const after = await stage.boundingBox();
  expect(Math.abs(after.x - before.x)).toBeLessThan(2);
  expect(Math.abs(after.y - before.y)).toBeLessThan(2);
  await expect(board).toContainText("Owner");
  await expect(board).toContainText("Final call");
  await expect(board).toContainText("WhatsApp status unavailable");
  await expect(board).toContainText("Conference status unavailable");
  await expect(board).not.toContainText("connected");
  await expect(board).not.toContainText("416");
  await page.keyboard.press("Escape");
  await expect(board).toBeHidden();
  await page.locator("[data-agent='claude']").focus();
  await page.keyboard.press("Enter");
  await expect(board.locator("[data-fb='role']")).toHaveText("Integrate + release");
  await expect(board.locator("[data-fb='task']")).toHaveText("Unavailable");
  await expect(board.locator("[data-fb='wait']")).toHaveText("Unavailable");
  await expect(board).not.toContainText("not waiting");
});

test("a fresh projection can show a task, who is waited on, and a dated WhatsApp status", async ({ page }) => {
  await page.clock.install({ time: new Date(NOW) });
  await page.route("**/data/fleet-public.json*", (route) => route.fulfill({
    contentType: "application/json",
    headers: { "cache-control": "no-store" },
    body: JSON.stringify(live([
      { id: "aya", status: "blocked", pulse_at: "2026-11-07T00:59:20Z", task: "Check the diagram", waiting_on: "Grok" }
    ], {
      whatsapp_status: { source: "whatsapp", text: "Diagram is up for review", at: "2026-11-07T00:59:00Z" }
    }))
  }));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("http://site.test/", { waitUntil: "load" });
  await page.locator("[data-agent='aya']").click();
  await expect(page.locator("[data-fb='task']")).toHaveText("Check the diagram");
  await expect(page.locator("[data-fb='wait']")).toHaveText("Greg");
  await page.locator("[data-human='owner']").click();
  await expect(page.locator("[data-fb='routes']")).toContainText("WhatsApp status");
  await expect(page.locator("[data-fb='routes']")).toContainText("Diagram is up for review");
  await expect(page.locator("[data-fb='routes']")).not.toContainText("connected");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});

test("motion pauses offscreen, on hover, and on focus, and reduced motion is a still diagram", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("http://site.test/", { waitUntil: "load" });
  const board = page.locator("#fleet-board");
  await board.scrollIntoViewIfNeeded();
  await expect(board).not.toHaveClass(/is-off/);
  const paused = () => page.locator(".fb-draw").evaluate((el) => el.animationsPaused());
  await expect.poll(paused).toBe(false);
  await board.hover();
  await expect.poll(paused).toBe(true);
  await page.locator(".fb-stage").focus();
  await expect.poll(paused).toBe(true);
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(board).toHaveClass(/is-off/);
  await expect.poll(paused).toBe(true);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.reload({ waitUntil: "load" });
  await expect(page.locator(".fb-token")).toBeHidden();
  await expect(page.locator("#fleet-board")).toContainText("Jemma");
  await expect(page.locator("#fleet-board")).toContainText("Aya");
  await expect(page.locator(".bq-roles")).toHaveCount(0);
});
