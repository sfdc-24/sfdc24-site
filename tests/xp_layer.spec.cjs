const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const PAGE_FILES = [
  "xp/index.html",
  "assets/xp.css",
  "assets/xp-adapter.js",
  "assets/xp-view.js",
  "data/xp-fixture.json",
  "xp/allow.json"
];
// Ratchet down only. Measured weight of the fleet view and its data.
const PAGE_BUDGET = 52000;

async function serve(page) {
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== "http://site.test" && url.hostname !== "127.0.0.1") return route.abort();
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
      ".ico": "image/x-icon",
      ".png": "image/png"
    };
    return route.fulfill({
      body: fs.readFileSync(file),
      contentType: types[path.extname(file)] || "text/plain"
    });
  });
}

async function asOwner(page) {
  await page.addInitScript(() => {
    window.SFDC24_XP_IDENTITY = { role: "owner" };
  });
}

test.beforeEach(async ({ page }) => {
  await serve(page);
});

test("renders the supervisor above the fleet from the fixture", async ({ page }) => {
  await asOwner(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("http://site.test/xp/");
  await expect(page.locator("[data-xp-id='source-badge']")).toContainText("Fixture");
  await expect(page.locator("[data-xp-id='agent-pi1-cli']")).toBeVisible();
  await expect(page.locator("[data-xp-id='role-supervisor']")).toHaveText("Supervisor");
  const sup = await page.locator("[data-xp-id='agent-pi1-cli']").boundingBox();
  const claude = await page.locator("[data-xp-id='agent-claude']").boundingBox();
  expect(sup.y).toBeLessThan(claude.y);
  await expect(page.locator("[data-xp-id='watch-claude']")).toHaveCount(1);
  await expect(page.locator("[data-xp-id='watch-codex']")).toHaveCount(1);
  await expect(page.locator("[data-xp-id='agent-codex']")).toBeVisible();
  await expect(page.locator("[data-xp-id='inst-pi2-cli']")).toContainText("Pi");
  await expect(page.locator("[data-xp-id='agent-pi']")).toContainText("Unconfirmed");
  await expect(page.locator("[data-xp-id='feed-supervisor']")).toContainText("Flagged a stale beat");
  await expect(page.locator("[data-xp-id='metric-output-per-hour'] [data-xp-bar]")).toHaveCount(3);
  await expect(page.locator("[data-xp-id='flow-codex-claude']")).toHaveCount(1);
  const feed = page.locator("#xp-feed button");
  await expect(feed.first()).toContainText("Flagged a stale beat");
  await expect(feed.nth(1)).toContainText("Nudge the open task");
});

test("drill-down sets the focus address and shows only stored figures", async ({ page }) => {
  await asOwner(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("http://site.test/xp/?focus=agent-codex");
  await expect(page.locator("[data-xp-id='agent-codex']")).toHaveClass(/xp-focus/);
  await page.locator("[data-xp-id='agent-claude']").click();
  await expect(page.locator("#xp-detail")).toBeVisible();
  await expect(page).toHaveURL(/focus=agent-claude/);
  await expect(page.locator("#xp-detail")).toContainText("Review the gate");
  await page.keyboard.press("Escape");
  await expect(page.locator("#xp-detail")).toBeHidden();

  await page.locator("[data-xp-id='task-pr-52']").click();
  await expect(page.locator("#xp-detail")).toContainText("Waiting");
  await expect(page).toHaveURL(/focus=task-pr-52/);
  await page.keyboard.press("Escape");

  await page.locator("[data-xp-id='ms-site']").click();
  await expect(page.locator("#xp-detail")).toContainText("unknown");
  await page.keyboard.press("Escape");

  await page.locator("[data-xp-id='agent-pi1-cli']").click();
  const detail = page.locator("#xp-detail");
  await expect(detail).toContainText("Stalls caught");
  await expect(detail).toContainText("Waits unblocked");
  await expect(detail).toContainText("Duplicates cut");
  await expect(detail).toContainText("Checks run");
  await expect(detail).toContainText("unknown");
  await expect(detail).toContainText("not yet reported");
  await expect(detail).not.toContainText(/\b[1-9]\d*\b/);
  await page.keyboard.press("Escape");

  await page.locator("#xp-feed button").first().click();
  await expect(page.locator("#xp-detail")).toContainText("gemini");
  await expect(page.locator("#xp-detail")).toContainText("v1:bus:row:sup-stall");
  await page.keyboard.press("Escape");

  await page.locator("[data-xp-id='metric-output-per-hour']").click();
  await expect(page.locator("#xp-detail")).toContainText("codex");
  await expect(page.locator("#xp-detail")).toContainText("1 review");
  await expect(page.locator("#xp-detail")).toContainText("1 task");
  await expect(page.locator("#xp-detail")).toContainText("1 commit");
});

test("keyboard moves across agents and the phone layout does not scroll sideways", async ({ page }) => {
  await asOwner(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("http://site.test/xp/");
  await expect(page.locator("[data-xp-id='agent-pi1-cli']")).toBeVisible();
  const wide = await page.evaluate(() => {
    const el = document.scrollingElement;
    return el.scrollWidth - el.clientWidth;
  });
  expect(wide).toBeLessThanOrEqual(0);
  const main = await page.locator(".xp-main").boundingBox();
  expect(main.width).toBeLessThanOrEqual(390);
  await page.locator("[data-xp-id='agent-pi1-cli']").focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.locator("[data-xp-id='agent-claude']")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#xp-detail")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#xp-detail")).toBeHidden();
  await page.locator("[data-xp-id='inst-pi2-cli']").focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#xp-detail")).toContainText("unconfirmed");
});

test("stale, missing, and fixture labels stay honest", async ({ page }) => {
  await asOwner(page);
  await page.goto("http://site.test/xp/");
  await expect(page.locator("[data-xp-id='source-badge']")).toContainText("Fixture");
  await expect(page.locator("[data-xp-id='agent-gemini']")).toContainText("Stalled");
  await expect(page.locator("[data-xp-id='agent-cursor']")).toContainText("Waiting");
  await expect(page.locator("[data-xp-id='ms-site']")).toContainText("unknown");
  await expect(page.locator("[data-xp-id='ms-redis']")).toContainText("47%");
  const stepped = await page.locator("[data-xp-stepped]").count();
  const bars = await page.locator("[data-xp-bar]").count();
  expect(bars).toBe(3);
  expect(stepped).toBeGreaterThanOrEqual(bars);
  await expect(page.locator("[data-xp-bar]").first()).not.toHaveAttribute("data-count", "0");
});

test("an empty snapshot does not invent a feed or an hourly count", async ({ page }) => {
  await asOwner(page);
  const empty = {
    read_at: "2026-10-19T02:30:00Z",
    keys: {
      "v1:agent:family:claude": { name: "Claude", instances: "claude-code-cli" },
      "v1:agent:claude-code-cli": { family: "claude", runtime: "laptop", state: "active" },
      "fleet:worker:done:task-0123456789abcdef": "{\"by\":\"claude-code-cli\",\"state\":\"SUCCEEDED\",\"note\":\"done\",\"evidence\":\"\"}"
    }
  };
  await page.route("**/data/xp-fixture.json", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(empty)
  }));
  await page.goto("http://site.test/xp/?source=fixture");
  await expect(page.locator("[data-xp-id='feed-supervisor']")).toContainText("not yet reported");
  await expect(page.locator("[data-xp-id='metric-output-per-hour']")).toContainText("not yet reported");
  await expect(page.locator("[data-xp-bar]")).toHaveCount(0);
});

test("a dedicated supervisor stream wins, and a live snapshot can be stale", async ({ page }) => {
  await asOwner(page);
  const ruled = await page.evaluate(async () => {
    const adapter = window.SFDC24Xp;
    return null;
  }).catch(() => null);
  expect(ruled).toBeNull();
  await page.goto("http://site.test/xp/?source=fixture");
  const verdict = await page.evaluate(() => {
    const bundle = {
      source: "fixture",
      read_at: "2026-10-19T02:30:00Z",
      keys: {
        "fleet:supervisor:pi1-cli:events": [],
        "fleet:inbox:grok": [{ id: "1-0", by: "pi1-cli", text: "nudge: ignore this", at: "2026-10-19T00:50:00Z" }]
      }
    };
    const model = window.SFDC24Xp.normalize(bundle);
    const filled = window.SFDC24Xp.normalize({
      source: "fixture",
      read_at: "2026-10-19T02:30:00Z",
      keys: {
        "fleet:supervisor:pi1-cli:events": [
          { id: "5-0", at: "2026-10-19T01:40:00Z", kind: "check", target: "codex", action: "Extra check", outcome: "ran" }
        ],
        "fleet:inbox:grok": [{ id: "1-0", by: "pi1-cli", text: "nudge: ignore this", at: "2026-10-19T00:50:00Z" }]
      }
    });
    const counters = window.SFDC24Xp.normalize({
      source: "fixture",
      read_at: "2026-10-19T02:30:00Z",
      keys: { "fleet:supervisor:pi1-cli": { stalls: "4", watching: "codex" } }
    });
    return {
      empty: model.feed.length,
      only: filled.feed.map((entry) => entry.action),
      stalls: counters.supervisor.stalls,
      watching: counters.supervisor.watching
    };
  });
  expect(verdict.empty).toBe(0);
  expect(verdict.only).toEqual(["Extra check"]);
  expect(verdict.stalls).toBe("4");
  expect(verdict.watching).toEqual(["codex"]);

  await page.route("**/data/xp-live.json", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      read_at: "2020-01-01T00:00:00Z",
      keys: {
        "v1:agent:family:claude": { name: "Claude", instances: "claude-code-cli" },
        "v1:agent:claude-code-cli": { family: "claude", runtime: "laptop", state: "active" }
      }
    })
  }));
  await page.goto("http://site.test/xp/");
  await expect(page.locator("[data-xp-id='source-badge']")).toContainText("Live");
  await expect(page.locator("[data-xp-id='source-badge']")).toContainText("Stale");
});

test("the allowlist fails closed and preview is local only", async ({ page }) => {
  await page.goto("http://site.test/xp/?preview=owner");
  await expect(page.locator("#xp-lock")).toBeVisible();
  await expect(page.locator("#xp-app")).toBeHidden();
  await expect(page.locator("[data-xp-id='agent-codex']")).toHaveCount(0);
  const decision = await page.evaluate(() => ({
    guest: window.SFDC24Xp.allow({ role: "guest" }, { roles: ["owner"] }).ok,
    owner: window.SFDC24Xp.allow({ role: "owner" }, { roles: ["owner"] }).ok,
    none: window.SFDC24Xp.allow(null, { roles: ["owner"] }).ok
  }));
  expect(decision).toEqual({ guest: false, owner: true, none: false });
  const home = fs.readFileSync(path.join(root, "index.html"), "utf8");
  const chrome = fs.readFileSync(path.join(root, "assets/chrome.js"), "utf8");
  expect(home).not.toContain("/xp/");
  expect(chrome).not.toContain("/xp/");
  expect(fs.readFileSync(path.join(root, "xp/index.html"), "utf8")).toContain('content="noindex, nofollow"');
});

test("page weight stays at or under the budget", () => {
  const total = PAGE_FILES.reduce((sum, rel) => sum + fs.statSync(path.join(root, rel)).size, 0);
  expect(total).toBeLessThanOrEqual(PAGE_BUDGET);
});
