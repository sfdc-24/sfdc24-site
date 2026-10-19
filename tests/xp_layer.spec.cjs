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
    // The test host normally exercises the local fixture. Live payloads are
    // supplied explicitly by tests that verify the live path.
    if (rel === "/data/xp-live.json") return route.fulfill({ status: 404, body: "" });
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

function operatorToken(scope, expSeconds) {
  const exp = expSeconds || Math.floor(Date.now() / 1000) + 3600;
  const payload = Buffer.from(JSON.stringify({ sid: "op", exp: exp, scope: scope || "operator", v: 1 })).toString("base64url");
  return payload + ".sig";
}

async function asOwner(page) {
  const token = operatorToken("operator");
  await page.addInitScript((tok) => {
    sessionStorage.setItem("studio.operator", JSON.stringify({ token: tok, expires_at: "" }));
  }, token);
  await page.route("**/v1/session", (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const auth = route.request().headers()["authorization"] || "";
    const ok = auth.indexOf(token) >= 0;
    return route.fulfill({
      status: ok ? 400 : 401,
      contentType: "application/json",
      body: ok ? "{\"detail\":\"session requires creation_id\"}" : "{\"detail\":\"unauthorized\"}"
    });
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
  for (const label of ["Checks run", "Waits unblocked", "Delivery gaps", "Escalations", "Open incidents", "Redis pending"]) {
    await expect(detail).toContainText(label);
  }
  await expect(detail).toContainText("unknown");
  await expect(detail).not.toContainText("Stalls caught");
  await expect(detail).not.toContainText("Duplicates cut");
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
  await page.keyboard.press("Escape");
  const order = await page.evaluate(() => {
    return Array.from(document.querySelectorAll("a, button")).filter((el) => {
      if (el.closest("dialog")) return false;
      if (el.closest("[hidden]")) return false;
      return el.getClientRects().length > 0;
    }).map((el) => el.getAttribute("data-xp-id") || el.className);
  });
  const at = (id) => order.indexOf(id);
  expect(at("agent-pi1-cli")).toBeGreaterThanOrEqual(0);
  expect(at("agent-pi1-cli")).toBeLessThan(at("agent-claude"));
  expect(at("agent-claude")).toBeLessThan(at("inst-pi2-cli") === -1 ? at("agent-pi") : at("ms-cloud"));
  expect(at("ms-cloud")).toBeLessThan(at("task-pr-52"));
  expect(at("task-pr-52")).toBeLessThan(at("metric-output-per-hour"));
  const feedAt = order.findIndex((id) => String(id).startsWith("act-"));
  expect(at("task-pr-52")).toBeLessThan(feedAt);
  expect(feedAt).toBeLessThan(at("metric-output-per-hour"));
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

test("withheld public snapshot shows unavailable without fleet data", async ({ page }) => {
  await asOwner(page);
  await page.route("**/data/xp-live.json", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: fs.readFileSync(path.join(root, "data/xp-live.json"))
  }));
  await page.goto("http://site.test/xp/");
  await expect(page.locator("[data-xp-id='source-badge']")).toHaveText("Unavailable");
  await expect(page.locator("[data-xp-id='stale-snapshot']")).toBeHidden();
  await expect(page.locator("[data-xp-id='empty-agents']")).toHaveText("not yet reported");
  await expect(page.locator("[data-xp-id='empty-feed']")).toHaveText("not yet reported");
  await expect(page.locator("[data-xp-id='empty-output']")).toHaveText("not yet reported");
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
      keys: {
        "fleet:supervisor:pi1-cli": {
          checks_run: "6",
          waits_unblocked: "2",
          open_incidents: "0",
          stalls: "4",
          watching: "codex"
        }
      }
    });
    return {
      empty: model.feed.length,
      only: filled.feed.map((entry) => entry.action),
      checks: counters.supervisor.checks_run,
      waits: counters.supervisor.waits_unblocked,
      incidents: counters.supervisor.open_incidents,
      gaps: counters.supervisor.delivery_gaps,
      stalls: counters.supervisor.stalls,
      watching: counters.supervisor.watching
    };
  });
  expect(verdict.empty).toBe(0);
  expect(verdict.only).toEqual(["Extra check"]);
  expect(verdict.checks).toBe("6");
  expect(verdict.waits).toBe("2");
  expect(verdict.incidents).toBe("0");
  expect(verdict.gaps).toBe("unknown");
  expect(verdict.stalls).toBeUndefined();
  expect(verdict.watching).toBeUndefined();

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

test("real supervisor records keep delivery gaps, practice mode, and the older log", async ({ page }) => {
  await asOwner(page);
  const sample = {
    read_at: "2026-10-19T04:20:00Z",
    keys: {
      "fleet:supervisor:pi1-cli": {
        at: "2026-10-19T04:09:01Z",
        role: "supervisor",
        mode: "practice",
        checks_run: "6",
        waits_unblocked: "2",
        delivery_gaps: "10",
        escalations: "2",
        open_incidents: "0",
        redis_pending: "1",
        stalls: "99",
        watching: "nobody"
      },
      "fleet:supervisor:pi1-cli:events": [
        {"id":"pi1-20261019T032702Z-08e825","at":"2026-10-19T03:27:02Z","kind":"delivery_gap","target":"claude-code-cli","action":"DELIVERY_GAP","outcome":"logged (practice)","ref":"GROK-PR-ESCALATE-20261019T0226Z","mode":"practice"},
        {"id":"pi1-20261019T040001Z-677772","at":"2026-10-19T04:00:01Z","kind":"escalation","target":"wa-outbox","action":"ANDON","outcome":"logged (practice)","ref":"storm","mode":"practice"},
        {"id":"pi1-20261019T040901Z-899f3c","at":"2026-10-19T04:09:01Z","kind":"check","target":"owner-trigger","action":"OT_UPDATED","outcome":"logged (practice)","ref":"547d7f1700838a7e","mode":"practice"},
        {"id":"pi1-20261019T041500Z-abc123","at":"2026-10-19T04:15:00Z","kind":"not_a_kind","target":"grok","action":"PING","outcome":"noted","ref":"mystery-1","mode":"practice"},
        {"id":"pi1-20261019T041600Z-bad","at":"2026-10-19T04:16:00Z","kind":{"nested":true},"target":"grok","action":"PING2","outcome":"noted","ref":"mystery-2","mode":"practice"}
      ],
      "fleet:supervisor:events": [
        {"ts":"2026-10-19T03:11:00Z","mode":"practice","agent":"pi1-cli","action":"ONLINE","outcome":"supervisor role confirmed","ref":"GROK-PI1-SUPERVISOR-20261019T0243Z"},
        {"ts":"2026-10-19T03:04:37Z","mode":"practice","agent":"wa-outbox","action":"ANDON","outcome":"logged","ref":"stall-claude-code-cli"},
        {"ts":"2026-10-19T04:00:01Z","mode":"practice","agent":"wa-outbox","action":"ANDON","outcome":"logged (practice)","ref":"storm"}
      ],
      "v1:bus:row:out-1": {
        row_id: "out-1",
        ts: "2026-10-19T02:15:00Z",
        source_tag: "claude-code-cli",
        target_surface: "site",
        action_type: "DONE",
        gist: "Task done"
      }
    }
  };
  await page.route("**/data/xp-fixture.json", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(sample)
  }));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("http://site.test/xp/?source=fixture");
  const wide = await page.evaluate(() => document.scrollingElement.scrollWidth - document.scrollingElement.clientWidth);
  expect(wide).toBeLessThanOrEqual(0);
  await expect(page.locator("[data-xp-id='mode-practice']")).toHaveText("practice mode");
  await expect(page.locator("[data-xp-id='feed-practice']")).toHaveText("practice mode");
  await expect(page.locator("#xp-feed")).toContainText("DELIVERY_GAP");
  await expect(page.locator("#xp-feed")).toContainText("PING");
  await expect(page.locator("#xp-feed")).toContainText("PING2");
  await expect(page.locator("#xp-feed")).toContainText("ONLINE");
  await expect(page.locator("[data-xp-stepped='2026-10-19T03:00:00Z']")).toHaveCount(1);
  await expect(page.locator("[data-xp-stepped='2026-10-19T04:00:00Z']")).toHaveCount(1);
  await expect(page.locator("[data-xp-bar='2026-10-19T03:00:00Z']")).toHaveCount(0);
  await expect(page.locator("[data-xp-bar='2026-10-19T02:00:00Z']")).toHaveCount(1);

  const gap = page.locator("#xp-feed button", { hasText: "DELIVERY_GAP" });
  await gap.click();
  const detail = page.locator("#xp-detail");
  await expect(detail).toContainText("delivery_gap");
  await expect(detail).toContainText("claude-code-cli");
  await expect(detail).toContainText("GROK-PR-ESCALATE-20261019T0226Z");
  await expect(detail).toContainText("practice");
  await page.keyboard.press("Escape");

  await page.locator("#xp-feed b", { hasText: /^PING$/ }).click();
  await expect(page.locator("#xp-detail")).toContainText("action");
  await expect(page.locator("#xp-detail")).toContainText("mystery-1");
  await page.keyboard.press("Escape");

  await page.locator("[data-xp-id='agent-pi1-cli']").click();
  const pairs = await detail.evaluate((el) => {
    const dts = Array.from(el.querySelectorAll("dt")).map((node) => node.textContent);
    const dds = Array.from(el.querySelectorAll("dd")).map((node) => node.textContent);
    return Object.fromEntries(dts.map((name, i) => [name, dds[i]]));
  });
  expect(pairs["Checks run"]).toBe("6");
  expect(pairs["Waits unblocked"]).toBe("2");
  expect(pairs["Delivery gaps"]).toBe("10");
  expect(pairs["Escalations"]).toBe("2");
  expect(pairs["Open incidents"]).toBe("0");
  expect(pairs["Redis pending"]).toBe("1");
  expect(pairs["Mode"]).toBe("practice");
  expect(JSON.stringify(pairs)).not.toContain("99");
  expect(JSON.stringify(pairs)).not.toContain("Stalls caught");
  await page.keyboard.press("Escape");

  const read = await page.evaluate((keys) => {
    const model = window.SFDC24Xp.normalize({ source: "fixture", read_at: "2026-10-19T04:20:00Z", keys });
    const odd = window.SFDC24Xp.normalize({
      source: "fixture",
      read_at: "2026-10-19T04:20:00Z",
      keys: {
        "fleet:supervisor:pi1-cli:events": [null, "not-json", { kind: "nope", action: "PING", at: "2026-10-19T04:15:30Z", target: "grok", outcome: "noted", ref: "mystery-3", mode: "practice" }],
        "fleet:supervisor:pi1-cli": { checks_run: "six", redis_pending: "" }
      }
    });
    const mixed = window.SFDC24Xp.normalize({
      source: "fixture",
      read_at: "2026-10-19T04:20:00Z",
      keys: {
        "fleet:supervisor:pi1-cli:events": [
          { id: "a", at: "2026-10-19T04:01:00Z", kind: "check", target: "grok", action: "CHECK", outcome: "ran", ref: "r1", mode: "live" }
        ]
      }
    });
    return {
      feed: model.feed.map((entry) => ({ kind: entry.kind, action: entry.action, target: entry.target, ref: entry.ref, mode: entry.mode, key: entry.key })),
      practice: model.practiceMode,
      fleetMode: model.fleetMode,
      checks: model.supervisor.checks_run,
      gaps: model.supervisor.delivery_gaps,
      incidents: model.supervisor.open_incidents,
      pending: model.supervisor.redis_pending,
      escalations: model.supervisor.escalations,
      role: model.supervisor.roleReported,
      mode: model.supervisor.mode,
      stalls: model.supervisor.stalls,
      stepped: model.output.stepped,
      oddCount: odd.feed.length,
      oddKinds: odd.feed.map((entry) => entry.kind),
      oddChecks: odd.supervisor.checks_run,
      oddPending: odd.supervisor.redis_pending,
      mixed: mixed.practiceMode,
      mixedFleet: mixed.fleetMode
    };
  }, sample.keys);
  expect(read.feed.filter((entry) => entry.ref === "storm")).toHaveLength(2);
  expect(read.feed.find((entry) => entry.action === "ONLINE").target).toBe("pi1-cli");
  expect(read.feed.find((entry) => entry.action === "ONLINE").key).toBe("fleet:supervisor:events");
  expect(read.feed.find((entry) => entry.kind === "delivery_gap").ref).toBe("GROK-PR-ESCALATE-20261019T0226Z");
  expect(read.feed.filter((entry) => entry.action === "ANDON")).toHaveLength(3);
  expect(read.feed.some((entry) => entry.action === "PING" && entry.kind === "action")).toBe(true);
  expect(read.practice).toBe(true);
  expect(read.fleetMode).toBe("practice");
  expect(read.checks).toBe("6");
  expect(read.gaps).toBe("10");
  expect(read.incidents).toBe("0");
  expect(read.pending).toBe("1");
  expect(read.escalations).toBe("2");
  expect(read.role).toBe("supervisor");
  expect(read.mode).toBe("practice");
  expect(read.stalls).toBeUndefined();
  expect(read.stepped).toEqual(expect.arrayContaining(["2026-10-19T03:00:00Z", "2026-10-19T04:00:00Z"]));
  expect(read.oddCount).toBe(3);
  expect(read.oddKinds).toEqual(["action", "action", "action"]);
  expect(read.oddChecks).toBe("unknown");
  expect(read.oddPending).toBe("unknown");
  expect(read.mixed).toBe(false);
  expect(read.mixedFleet).toBe("live");
});

test("empty regions say not yet reported and a stale snapshot is labeled", async ({ page }) => {
  await asOwner(page);
  await page.route("**/data/xp-fixture.json", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ read_at: "2026-10-19T04:20:00Z", keys: {} })
  }));
  await page.goto("http://site.test/xp/?source=fixture");
  await expect(page.locator("[data-xp-id='source-badge']")).toContainText("Fixture");
  await expect(page.locator("[data-xp-id='source-badge']")).not.toContainText("Missing");
  await expect(page.locator("[data-xp-id='agent-pi1-cli']")).toContainText("not yet reported");
  await expect(page.locator("[data-xp-id='empty-agents']")).toHaveText("not yet reported");
  await expect(page.locator("[data-xp-id='empty-milestones']")).toHaveText("not yet reported");
  await expect(page.locator("[data-xp-id='empty-tasks']")).toHaveText("not yet reported");
  await expect(page.locator("[data-xp-id='empty-feed']")).toHaveText("not yet reported");
  await expect(page.locator("[data-xp-id='empty-output']")).toHaveText("not yet reported");
  await expect(page.locator("[data-xp-bar]")).toHaveCount(0);

  await page.route("**/data/xp-live.json", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ read_at: "2020-01-01T00:00:00Z", keys: {} })
  }));
  await page.goto("http://site.test/xp/");
  await expect(page.locator("[data-xp-id='source-badge']")).toContainText("Stale");
  await expect(page.locator("[data-xp-id='stale-snapshot']")).toHaveText("stale snapshot");

  await page.unroute("**/data/xp-fixture.json").catch(() => {});
  await page.unroute("**/data/xp-live.json").catch(() => {});
  await page.route("**/data/xp-live.json", (route) => route.fulfill({ status: 404, body: "" }));
  await page.route("**/data/xp-fixture.json", (route) => route.fulfill({ status: 404, body: "" }));
  await page.goto("http://site.test/xp/");
  await expect(page.locator("[data-xp-id='source-badge']")).toHaveText("Missing");
});

test("a conf:auth:roles entry cannot unlock the view", async ({ page }) => {
  const poisoned = {
    read_at: "2026-10-19T04:20:00Z",
    keys: {
      "conf:auth:roles": { Abdus: "owner", "pi1-cli": "owner", "claude-code-cli": "owner" },
      "fleet:supervisor:pi1-cli": { role: "owner", mode: "owner" },
      "v1:agent:pi1-cli": { family: "pi", role: "owner", runtime: "Raspberry Pi", state: "active" },
      "v1:agent:family:pi": { name: "Pi", role: "owner", instances: "pi1-cli" }
    }
  };
  const body = JSON.stringify(poisoned);
  await page.route("**/data/xp-live.json", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body
  }));
  await page.route("**/data/xp-fixture.json", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body
  }));
  await page.goto("http://site.test/xp/?preview=owner");
  await expect(page.locator("#xp-lock")).toBeVisible();
  await expect(page.locator("#xp-app")).toBeHidden();
  await expect(page.locator("[data-xp-id='agent-pi1-cli']")).toBeHidden();
  await expect(page.locator("[data-xp-id='agent-codex']")).toHaveCount(0);
  const leaked = await page.evaluate((keys) => {
    const model = window.SFDC24Xp.normalize({ source: "live", read_at: "2026-10-19T04:20:00Z", keys });
    const gate = window.SFDC24Xp.allow({ role: model.role || "" }, { roles: ["owner"] });
    const dumped = JSON.stringify(model);
    return {
      ok: gate.ok,
      named: dumped.indexOf("Abdus") >= 0,
      auth: dumped.indexOf("conf:auth:roles") >= 0,
      ownerRole: model.supervisor && model.supervisor.roleReported
    };
  }, poisoned.keys);
  expect(leaked.ok).toBe(false);
  expect(leaked.named).toBe(false);
  expect(leaked.auth).toBe(false);
  expect(leaked.ownerRole).toBe("owner");
  const adapter = fs.readFileSync(path.join(root, "assets/xp-adapter.js"), "utf8");
  const view = fs.readFileSync(path.join(root, "assets/xp-view.js"), "utf8");
  expect(adapter + view).not.toContain("conf:auth:roles");
  expect(view).not.toContain("SFDC24_XP_IDENTITY");
  expect(view).toContain("studio.operator");
  expect(view).toContain("fixtureFallback");
});

test("an injected role or a non-operator session cannot unlock the view", async ({ page }) => {
  await page.addInitScript((pilot) => {
    window.SFDC24_XP_IDENTITY = { role: "owner" };
    sessionStorage.setItem("studio.operator", JSON.stringify({ token: pilot, expires_at: "" }));
  }, operatorToken("pilot"));
  let probed = 0;
  await page.route("**/v1/session", (route) => {
    probed += 1;
    return route.fulfill({ status: 400, contentType: "application/json", body: "{}" });
  });
  await page.goto("http://site.test/xp/");
  await expect(page.locator("#xp-lock")).toBeVisible();
  await expect(page.locator("#xp-app")).toBeHidden();
  expect(probed).toBe(0);

  await page.addInitScript((tok) => {
    sessionStorage.setItem("studio.operator", JSON.stringify({ token: tok, expires_at: "" }));
  }, operatorToken("operator"));
  await page.route("**/v1/session", (route) => route.fulfill({
    status: 401, contentType: "application/json", body: "{\"detail\":\"unauthorized\"}"
  }));
  await page.goto("http://site.test/xp/");
  await expect(page.locator("#xp-lock")).toBeVisible();
  await expect(page.locator("#xp-app")).toBeHidden();
});

test("a signed-in public host reads live redis and does not fall back to the fixture", async ({ page }) => {
  await page.goto("http://site.test/xp/");
  const plan = await page.evaluate(() => ({
    live: window.SFDC24Xp.sourcePlan({ role: "owner", session: true }, "www.sfdc24.com", "fixture"),
    dev: window.SFDC24Xp.sourcePlan({ role: "owner", session: true }, "site.test", ""),
    preview: window.SFDC24Xp.sourcePlan({ role: "owner", preview: true }, "www.sfdc24.com", "")
  }));
  expect(plan.live).toEqual({ prefer: "", fixtureFallback: false });
  expect(plan.dev.fixtureFallback).toBe(true);
  expect(plan.preview.fixtureFallback).toBe(true);
  const outcome = await page.evaluate(async () => {
    let fixtureHits = 0;
    const fetch = function (url) {
      if (String(url).indexOf("xp-fixture") >= 0) fixtureHits += 1;
      return Promise.resolve({ ok: false, json: function () { return Promise.resolve({}); } });
    };
    let failed = false;
    try {
      await window.SFDC24Xp.load({
        fetch: fetch,
        liveUrl: "/data/xp-live.json",
        fixtureUrl: "/data/xp-fixture.json",
        prefer: "",
        fixtureFallback: false
      });
    } catch (e) { failed = true; }
    return { failed: failed, fixtureHits: fixtureHits };
  });
  expect(outcome.failed).toBe(true);
  expect(outcome.fixtureHits).toBe(0);
});

function canonicalBytes(rel) {
  const text = fs.readFileSync(path.join(root, rel), "utf8");
  return Buffer.byteLength(text.replace(/\r\n/g, "\n").replace(/\r/g, "\n"), "utf8");
}

test("distinct actions that share a ref both stay on the feed", async ({ page }) => {
  await asOwner(page);
  await page.setViewportSize({ width: 390, height: 844 });
  const ref = "GROK-ACK-AYA-0351-0358-20261019T0423Z";
  const keys = {
    "fleet:supervisor:pi1-cli": { mode: "practice", role: "supervisor" },
    "fleet:supervisor:pi1-cli:events": [
      { id: "pi1-20261019T042300Z-a", at: "2026-10-19T04:23:00Z", kind: "unblock", target: "claude-code-cli", action: "REROUTE", outcome: "logged (practice)", ref, mode: "practice" },
      { id: "pi1-20261019T042300Z-b", at: "2026-10-19T04:23:00Z", kind: "check", target: "claude-code-cli", action: "GUIDANCE", outcome: "logged (practice)", ref, mode: "practice" },
      { id: "pi1-20261019T042400Z-c", at: "2026-10-19T04:24:00Z", kind: "delivery_gap", target: "claude-code-cli", action: "DELIVERY_GAP", outcome: "logged (practice)", ref: "GROK-GAP-SHARED", mode: "practice" },
      { id: "pi1-20261019T042400Z-d", at: "2026-10-19T04:24:00Z", kind: "delivery_gap", target: "grok", action: "DELIVERY_GAP", outcome: "logged (practice)", ref: "GROK-GAP-SHARED", mode: "practice" },
      { id: "pi1-20261019T042500Z-e", at: "2026-10-19T04:25:00Z", kind: "escalation", target: "wa-outbox", action: "ANDON", outcome: "logged (practice)", ref: "storm-2", mode: "practice" },
      { id: "pi1-20261019T042300Z-a", at: "2026-10-19T04:23:00Z", kind: "unblock", target: "claude-code-cli", action: "REROUTE-COPY", outcome: "logged (practice)", ref, mode: "practice" },
      { id: "pi1-20261019T042300Z-f", at: "2026-10-19T04:23:00Z", kind: "unblock", target: "claude-code-cli", action: "REROUTE", outcome: "other", ref, mode: "live" }
    ]
  };
  await page.route("**/data/xp-fixture.json", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ read_at: "2026-10-19T04:30:00Z", keys })
  }));
  await page.goto("http://site.test/xp/?source=fixture");
  const wide = await page.evaluate(() => document.scrollingElement.scrollWidth - document.scrollingElement.clientWidth);
  expect(wide).toBeLessThanOrEqual(0);
  await expect(page.locator("#xp-feed button", { hasText: "REROUTE" })).toHaveCount(1);
  await expect(page.locator("#xp-feed button", { hasText: "GUIDANCE" })).toHaveCount(1);
  await expect(page.locator("#xp-feed button", { hasText: "DELIVERY_GAP" })).toHaveCount(2);
  await expect(page.locator("#xp-feed")).not.toContainText("REROUTE-COPY");
  await expect(page.locator("[data-xp-id='mode-practice']")).toHaveText("practice mode");

  const read = await page.evaluate((sample) => {
    const model = window.SFDC24Xp.normalize({ source: "fixture", read_at: "2026-10-19T04:30:00Z", keys: sample });
    return {
      rows: model.feed.map((entry) => ({ id: entry.id, kind: entry.kind, target: entry.target, action: entry.action, ref: entry.ref })),
      fleetMode: model.fleetMode
    };
  }, keys);
  const ack = read.rows.filter((entry) => entry.ref === ref).map((entry) => entry.action).sort();
  expect(ack).toEqual(["GUIDANCE", "REROUTE"]);
  expect(read.rows.find((entry) => entry.action === "REROUTE").kind).toBe("unblock");
  expect(read.rows.find((entry) => entry.action === "GUIDANCE").kind).toBe("check");
  const gaps = read.rows.filter((entry) => entry.kind === "delivery_gap").map((entry) => entry.target).sort();
  expect(gaps).toEqual(["claude-code-cli", "grok"]);
  expect(read.rows.find((entry) => entry.kind === "escalation").action).toBe("ANDON");
  expect(read.rows.some((entry) => entry.action === "REROUTE-COPY")).toBe(false);
  expect(read.rows.filter((entry) => entry.action === "REROUTE")).toHaveLength(1);
  expect(read.fleetMode).toBe("practice");
  expect(read.rows).toHaveLength(5);
});

test("supervisor mode reconciles the hash with the feed", async ({ page }) => {
  await asOwner(page);
  async function show(keys) {
    await page.unroute("**/data/xp-fixture.json").catch(() => {});
    await page.route("**/data/xp-fixture.json", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ read_at: "2026-10-19T04:20:00Z", keys })
    }));
    await page.goto("http://site.test/xp/?source=fixture");
  }

  await show({
    "fleet:supervisor:pi1-cli": { mode: "live", role: "supervisor" },
    "fleet:supervisor:pi1-cli:events": [
      { id: "1", at: "2026-10-19T04:01:00Z", kind: "check", target: "grok", action: "CHECK", outcome: "ran", ref: "r1", mode: "practice" }
    ]
  });
  await expect(page.locator("[data-xp-id='mode-mixed']")).toHaveText("mixed mode");
  await expect(page.locator("[data-xp-id='feed-mixed']")).toHaveText("mixed mode");
  await expect(page.locator("[data-xp-id='mode-practice']")).toHaveCount(0);
  await expect(page.locator("[data-xp-id='mode-live']")).toHaveCount(0);
  await page.locator("[data-xp-id='agent-pi1-cli']").click();
  await expect(page.locator("#xp-detail")).toContainText("mixed");
  await page.keyboard.press("Escape");

  await show({
    "fleet:supervisor:pi1-cli": { mode: "practice", role: "supervisor", open_incidents: "0" },
    "fleet:supervisor:pi1-cli:events": []
  });
  await expect(page.locator("[data-xp-id='mode-practice']")).toHaveText("practice mode");
  await expect(page.locator("[data-xp-id='feed-practice']")).toHaveText("practice mode");
  await expect(page.locator("[data-xp-id='empty-feed']")).toHaveText("not yet reported");
  await expect(page.locator("[data-xp-id='mode-mixed']")).toHaveCount(0);
  const practiceDetail = await page.evaluate(() => {
    return window.SFDC24Xp.normalize({
      source: "fixture",
      read_at: "2026-10-19T04:20:00Z",
      keys: {
        "fleet:supervisor:pi1-cli": { mode: "practice" },
        "fleet:supervisor:pi1-cli:events": []
      }
    }).fleetMode;
  });
  expect(practiceDetail).toBe("practice");

  await show({
    "fleet:supervisor:pi1-cli:events": [
      { id: "1", at: "2026-10-19T04:01:00Z", kind: "check", target: "grok", action: "CHECK", outcome: "ran", ref: "r1", mode: "practice" },
      { id: "2", at: "2026-10-19T04:02:00Z", kind: "check", target: "grok", action: "CHECK2", outcome: "ran", ref: "r2", mode: "live" }
    ]
  });
  await expect(page.locator("[data-xp-id='mode-mixed']")).toHaveText("mixed mode");
  await expect(page.locator("[data-xp-id='feed-mixed']")).toHaveText("mixed mode");
  await expect(page.locator("[data-xp-id='mode-practice']")).toHaveCount(0);

  await show({ "fleet:supervisor:pi1-cli:events": [] });
  await expect(page.locator("[data-xp-id='mode-practice']")).toHaveCount(0);
  await expect(page.locator("[data-xp-id='mode-live']")).toHaveCount(0);
  await expect(page.locator("[data-xp-id='mode-mixed']")).toHaveCount(0);
  await expect(page.locator("[data-xp-id='feed-practice']")).toHaveCount(0);
  await expect(page.locator("[data-xp-id='empty-feed']")).toHaveText("not yet reported");
  await expect(page.locator("[data-xp-id='agent-pi1-cli']")).toContainText("not yet reported");
  await page.locator("[data-xp-id='agent-pi1-cli']").click();
  const pairs = await page.locator("#xp-detail").evaluate((el) => {
    const dts = Array.from(el.querySelectorAll("dt")).map((node) => node.textContent);
    const dds = Array.from(el.querySelectorAll("dd")).map((node) => node.textContent);
    return Object.fromEntries(dts.map((name, i) => [name, dds[i]]));
  });
  expect(pairs.Mode).toBe("unknown");
  const nothing = await page.evaluate(() => window.SFDC24Xp.normalize({
    source: "fixture",
    read_at: "2026-10-19T04:20:00Z",
    keys: {}
  }).fleetMode);
  expect(nothing).toBe("unknown");
});

function wide(page) {
  return page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const offenders = [];
    for (const el of document.querySelectorAll("body *")) {
      const rect = el.getBoundingClientRect();
      if (rect.width < 1 && rect.height < 1) continue;
      if (rect.right > vw + 1 || rect.left < -1) {
        offenders.push(el.id || el.getAttribute("data-xp-id") || el.className);
      }
    }
    return {
      scroll: document.scrollingElement.scrollWidth - document.scrollingElement.clientWidth,
      offenders: offenders.slice(0, 8)
    };
  });
}

async function detailPairs(page) {
  return page.locator("#xp-detail").evaluate((el) => {
    const dts = Array.from(el.querySelectorAll("dt")).map((node) => node.textContent);
    const dds = Array.from(el.querySelectorAll("dd")).map((node) => node.textContent);
    return Object.fromEntries(dts.map((name, i) => [name, dds[i]]));
  });
}

const REDIS_EVENTS = [
  {"id":"pi1-20261019T032702Z-08e825","at":"2026-10-19T03:27:02Z","kind":"delivery_gap","target":"claude-code-cli","action":"DELIVERY_GAP","outcome":"logged (practice)","ref":"GROK-PR-ESCALATE-20261019T0226Z","mode":"practice"},
  {"id":"pi1-20261019T032810Z-grok","at":"2026-10-19T03:28:10Z","kind":"delivery_gap","target":"grok","action":"DELIVERY_GAP","outcome":"logged (practice)","ref":"GROK-PR-ESCALATE-20261019T0226Z","mode":"practice"},
  {"id":"pi1-20261019T032920Z-aya","at":"2026-10-19T03:29:20Z","kind":"delivery_gap","target":"aya","action":"DELIVERY_GAP","outcome":"logged (practice)","ref":"GROK-PR-ESCALATE-20261019T0226Z","mode":"practice"},
  {"id":"pi1-20261019T040001Z-677772","at":"2026-10-19T04:00:01Z","kind":"escalation","target":"wa-outbox","action":"ANDON","outcome":"logged (practice)","ref":"storm","mode":"practice"},
  {"id":"pi1-20261019T040901Z-899f3c","at":"2026-10-19T04:09:01Z","kind":"check","target":"owner-trigger","action":"OT_UPDATED","outcome":"logged (practice)","ref":"547d7f1700838a7e","mode":"practice"},
  {"id":"pi1-20261019T042300Z-a","at":"2026-10-19T04:23:00Z","kind":"unblock","target":"claude-code-cli","action":"REROUTE","outcome":"logged (practice)","ref":"GROK-ACK-AYA-0351-0358-20261019T0423Z","mode":"practice"},
  {"id":"pi1-20261019T042300Z-b","at":"2026-10-19T04:23:00Z","kind":"check","target":"claude-code-cli","action":"GUIDANCE","outcome":"logged (practice)","ref":"GROK-ACK-AYA-0351-0358-20261019T0423Z","mode":"practice"},
  {"id":"pi1-20261019T042300Z-a","at":"2026-10-19T04:23:00Z","kind":"unblock","target":"claude-code-cli","action":"REROUTE-COPY","outcome":"logged (practice)","ref":"GROK-ACK-AYA-0351-0358-20261019T0423Z","mode":"practice"}
];

test("redis list strings keep one gap per target when the counters hash is missing", async ({ page }) => {
  await asOwner(page);
  await page.setViewportSize({ width: 390, height: 844 });
  const ref = "GROK-ACK-AYA-0351-0358-20261019T0423Z";
  const gapRef = "GROK-PR-ESCALATE-20261019T0226Z";
  const strings = REDIS_EVENTS.map((entry) => JSON.stringify(entry));
  const keys = {
    "v1:agent:canon": { aya: "chatgpt-codex-desktop" },
    "fleet:supervisor:pi1-cli:events": strings
  };
  await page.route("**/data/xp-fixture.json", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ read_at: "2026-10-19T04:30:00Z", keys })
  }));
  await page.goto("http://site.test/xp/?source=fixture");
  const fit = await wide(page);
  expect(fit.scroll).toBeLessThanOrEqual(0);
  expect(fit.offenders).toEqual([]);
  await expect(page.locator("[data-xp-id='mode-practice']")).toHaveText("practice mode");
  await expect(page.locator("#xp-feed button", { hasText: "DELIVERY_GAP" })).toHaveCount(3);
  await expect(page.locator("#xp-feed button", { hasText: "REROUTE" })).toHaveCount(1);
  await expect(page.locator("#xp-feed button", { hasText: "GUIDANCE" })).toHaveCount(1);
  await expect(page.locator("#xp-feed")).toContainText("ANDON");
  await expect(page.locator("#xp-feed")).toContainText("OT_UPDATED");
  await expect(page.locator("#xp-feed")).not.toContainText("REROUTE-COPY");
  await expect(page.locator("[data-xp-bar]")).toHaveCount(0);
  await expect(page.locator("[data-xp-id='empty-output']")).toHaveText("not yet reported");
  await expect(page.locator("[data-xp-stepped]")).toHaveCount(2);

  await page.locator("#xp-feed button", { hasText: "aya" }).click();
  let pairs = await detailPairs(page);
  expect(pairs.Target).toBe("aya");
  expect(pairs.Kind).toBe("delivery_gap");
  expect(pairs.Ref).toBe(gapRef);
  expect(pairs.Mode).toBe("practice");
  await page.keyboard.press("Escape");

  await page.locator("#xp-feed button", { hasText: "REROUTE" }).click();
  pairs = await detailPairs(page);
  expect(pairs.Kind).toBe("unblock");
  expect(pairs.Ref).toBe(ref);
  expect(pairs.Mode).toBe("practice");
  await page.keyboard.press("Escape");

  await page.locator("#xp-feed button", { hasText: "GUIDANCE" }).click();
  pairs = await detailPairs(page);
  expect(pairs.Kind).toBe("check");
  expect(pairs.Ref).toBe(ref);
  await page.keyboard.press("Escape");

  await page.locator("[data-xp-id='agent-pi1-cli']").click();
  pairs = await detailPairs(page);
  for (const label of ["Checks run", "Waits unblocked", "Delivery gaps", "Escalations", "Open incidents", "Redis pending"]) {
    expect(pairs[label]).toBe("unknown");
  }
  expect(pairs.Mode).toBe("practice");
  expect(pairs.Role).toBe("unknown");
  expect(JSON.stringify(pairs)).not.toMatch(/\b[1-9]\d*\b/);
  await page.keyboard.press("Escape");
  const open = await wide(page);
  expect(open.scroll).toBeLessThanOrEqual(0);

  const read = await page.evaluate((sample) => {
    const missing = window.SFDC24Xp.normalize({
      source: "fixture",
      read_at: "2026-10-19T04:30:00Z",
      keys: {
        "v1:agent:canon": { aya: "chatgpt-codex-desktop" },
        "fleet:supervisor:pi1-cli:events": sample.strings
      }
    });
    const partial = window.SFDC24Xp.normalize({
      source: "fixture",
      read_at: "2026-10-19T04:30:00Z",
      keys: {
        "fleet:supervisor:pi1-cli": {
          at: "2026-10-19T04:09:01Z",
          role: "supervisor",
          mode: "practice",
          checks_run: "6",
          waits_unblocked: " 2 ",
          open_incidents: "0"
        },
        "fleet:supervisor:pi1-cli:events": sample.strings
      }
    });
    const blob = window.SFDC24Xp.normalize({
      source: "fixture",
      read_at: "2026-10-19T04:30:00Z",
      keys: {
        "fleet:supervisor:pi1-cli": JSON.stringify({
          mode: "practice",
          checks_run: "4",
          waits_unblocked: "02",
          open_incidents: "0",
          delivery_gaps: "10",
          escalations: "n/a",
          redis_pending: ""
        }),
        "fleet:supervisor:pi1-cli:events": JSON.stringify(sample.events)
      }
    });
    const numbers = window.SFDC24Xp.normalize({
      source: "fixture",
      read_at: "2026-10-19T04:30:00Z",
      keys: {
        "fleet:supervisor:pi1-cli": { checks_run: 6, open_incidents: 0, waits_unblocked: "2", delivery_gaps: "" }
      }
    });
    return {
      targets: missing.feed.filter((entry) => entry.kind === "delivery_gap").map((entry) => entry.target).sort(),
      ack: missing.feed.filter((entry) => entry.ref === sample.ref).map((entry) => entry.action).sort(),
      copy: missing.feed.some((entry) => entry.action === "REROUTE-COPY"),
      gaps: missing.supervisor.delivery_gaps,
      checks: missing.supervisor.checks_run,
      incidents: missing.supervisor.open_incidents,
      mode: missing.fleetMode,
      hashMode: missing.supervisor.mode,
      partial: {
        checks: partial.supervisor.checks_run,
        waits: partial.supervisor.waits_unblocked,
        incidents: partial.supervisor.open_incidents,
        gaps: partial.supervisor.delivery_gaps,
        escalations: partial.supervisor.escalations,
        pending: partial.supervisor.redis_pending,
        mode: partial.fleetMode
      },
      blob: {
        checks: blob.supervisor.checks_run,
        waits: blob.supervisor.waits_unblocked,
        incidents: blob.supervisor.open_incidents,
        gaps: blob.supervisor.delivery_gaps,
        escalations: blob.supervisor.escalations,
        pending: blob.supervisor.redis_pending,
        feed: blob.feed.length
      },
      numbers: {
        checks: numbers.supervisor.checks_run,
        incidents: numbers.supervisor.open_incidents,
        waits: numbers.supervisor.waits_unblocked,
        gaps: numbers.supervisor.delivery_gaps
      }
    };
  }, { strings, events: REDIS_EVENTS, ref });
  expect(read.targets).toEqual(["aya", "claude-code-cli", "grok"]);
  expect(read.ack).toEqual(["GUIDANCE", "REROUTE"]);
  expect(read.copy).toBe(false);
  expect(read.gaps).toBe("unknown");
  expect(read.checks).toBe("unknown");
  expect(read.incidents).toBe("unknown");
  expect(read.mode).toBe("practice");
  expect(read.hashMode).toBe("unknown");
  expect(read.partial).toEqual({
    checks: "6",
    waits: "2",
    incidents: "0",
    gaps: "unknown",
    escalations: "unknown",
    pending: "unknown",
    mode: "practice"
  });
  expect(read.blob).toEqual({
    checks: "4",
    waits: "2",
    incidents: "0",
    gaps: "10",
    escalations: "unknown",
    pending: "unknown",
    feed: 7
  });
  expect(read.numbers).toEqual({ checks: "6", incidents: "0", waits: "2", gaps: "unknown" });

  await page.unroute("**/data/xp-fixture.json").catch(() => {});
  await page.route("**/data/xp-fixture.json", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      read_at: "2026-10-19T04:30:00Z",
      keys: {
        "fleet:supervisor:pi1-cli": {
          role: "supervisor",
          mode: "practice",
          checks_run: "6",
          waits_unblocked: " 2 ",
          open_incidents: "0"
        },
        "fleet:supervisor:pi1-cli:events": strings
      }
    })
  }));
  await page.goto("http://site.test/xp/?source=fixture");
  await page.locator("[data-xp-id='agent-pi1-cli']").click();
  pairs = await detailPairs(page);
  expect(pairs["Checks run"]).toBe("6");
  expect(pairs["Waits unblocked"]).toBe("2");
  expect(pairs["Open incidents"]).toBe("0");
  expect(pairs["Delivery gaps"]).toBe("unknown");
  expect(pairs["Escalations"]).toBe("unknown");
  expect(pairs["Redis pending"]).toBe("unknown");
  expect(pairs.Mode).toBe("practice");
});

test("missing live data, empty regions, zero instances, and bad JSON stay calm", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("http://127.0.0.1:8765/xp/?preview=owner");
  await expect(page.locator("#xp-lock")).toBeHidden();
  await expect(page.locator("#xp-app")).toBeVisible();
  await expect(page.locator("[data-xp-id='source-badge']")).toContainText("Fixture");
  await expect(page.locator("[data-xp-id='source-badge']")).toContainText("Local preview");
  await expect(page.locator("[data-xp-id='source-badge']")).not.toContainText("Missing");
  await expect(page.locator("[data-xp-id='agent-claude']")).toBeVisible();
  const preview = await wide(page);
  expect(preview.scroll).toBeLessThanOrEqual(0);
  expect(preview.offenders).toEqual([]);

  await asOwner(page);
  const degraded = {
    read_at: "2026-10-19T04:30:00Z",
    keys: {
      "v1:agent:family:copilot": { name: "Copilot", role: "Assist" },
      "v1:agent:family:grok": { name: "Grok", role: "Board", instances: "grok" },
      "v1:agent:grok": { family: "grok", runtime: "box", state: "active", redis_read: "false" },
      "fleet:supervisor:pi1-cli:events": []
    }
  };
  await page.route("**/data/xp-fixture.json", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(degraded)
  }));
  await page.goto("http://site.test/xp/?source=fixture");
  await expect(page.locator("[data-xp-id='source-badge']")).toContainText("Fixture");
  await expect(page.locator("[data-xp-id='source-badge']")).not.toContainText("Missing");
  await expect(page.locator("[data-xp-id='empty-feed']")).toHaveText("not yet reported");
  await expect(page.locator("[data-xp-id='empty-output']")).toHaveText("not yet reported");
  await expect(page.locator("[data-xp-id='empty-milestones']")).toHaveText("not yet reported");
  await expect(page.locator("[data-xp-id='empty-tasks']")).toHaveText("not yet reported");
  await expect(page.locator("[data-xp-bar]")).toHaveCount(0);
  await expect(page.locator("[data-xp-stepped]")).toHaveCount(0);
  await expect(page.locator("[data-xp-id='empty-copilot']")).toHaveText("not yet reported");
  await expect(page.locator(".xp-card").filter({ has: page.locator("[data-xp-id='agent-copilot']") }).locator(".xp-chip")).toHaveCount(0);
  await expect(page.locator("[data-xp-id='inst-grok']")).toContainText("box");
  const degradedFit = await wide(page);
  expect(degradedFit.scroll).toBeLessThanOrEqual(0);
  expect(degradedFit.offenders).toEqual([]);

  await page.locator("[data-xp-id='empty-copilot']").click();
  let pairs = await detailPairs(page);
  expect(pairs.Instances).toBe("0");
  expect(pairs.Environment).toBe("unknown");
  expect(pairs.Doing).toBe("unknown");
  expect(JSON.stringify(pairs)).not.toMatch(/laptop|Cloud|Pi|box/);
  await page.keyboard.press("Escape");

  await page.locator("[data-xp-id='agent-pi1-cli']").click();
  pairs = await detailPairs(page);
  for (const label of ["Checks run", "Waits unblocked", "Delivery gaps", "Escalations", "Open incidents", "Redis pending"]) {
    expect(pairs[label]).toBe("unknown");
  }
  expect(pairs.Mode).toBe("unknown");
  expect(JSON.stringify(pairs)).not.toMatch(/\b[1-9]\d*\b/);
  await page.keyboard.press("Escape");

  await page.locator("[data-xp-id='inst-grok']").click();
  await expect(page.locator("#xp-detail")).toContainText("box");
  await page.keyboard.press("Escape");

  await page.unroute("**/data/xp-fixture.json").catch(() => {});
  await page.route("**/data/xp-live.json", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: "{not json"
  }));
  await page.route("**/data/xp-fixture.json", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: "{not json"
  }));
  await page.goto("http://site.test/xp/");
  await expect(page.locator("[data-xp-id='source-badge']")).toHaveText("Missing");
  for (const id of ["empty-agents", "empty-milestones", "empty-tasks", "empty-feed", "empty-output"]) {
    await expect(page.locator(`[data-xp-id='${id}']`)).toHaveText("not yet reported");
  }
  await expect(page.locator("[data-xp-id='agent-pi1-cli']")).toContainText("not yet reported");
  await expect(page.locator("[data-xp-bar]")).toHaveCount(0);
  await expect(page.locator("#xp-app")).not.toContainText("NaN");
  await expect(page.locator("#xp-app")).not.toContainText("undefined");
  const broken = await wide(page);
  expect(broken.scroll).toBeLessThanOrEqual(0);
  expect(broken.offenders).toEqual([]);
  await page.locator("[data-xp-id='agent-pi1-cli']").click();
  pairs = await detailPairs(page);
  expect(pairs["Delivery gaps"]).toBe("unknown");
  expect(pairs["Open incidents"]).toBe("unknown");
  await page.keyboard.press("Escape");

  await page.unroute("**/data/xp-fixture.json").catch(() => {});
  await page.goto("http://site.test/xp/");
  await expect(page.locator("[data-xp-id='source-badge']")).toContainText("Fixture");
  await expect(page.locator("[data-xp-id='source-badge']")).not.toContainText("Missing");
  await expect(page.locator("[data-xp-id='agent-claude']")).toBeVisible();
});

function contrastRatio(fg, bg) {
  const parse = (value) => {
    const match = String(value).match(/rgba?\(([^)]+)\)/);
    if (!match) return null;
    return match[1].split(",").map((part) => Number(part));
  };
  const lum = (channel) => {
    const s = channel / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const L = (rgb) => 0.2126 * lum(rgb[0]) + 0.7152 * lum(rgb[1]) + 0.0722 * lum(rgb[2]);
  const f = parse(fg);
  const b = parse(bg);
  if (!f || !b) return 0;
  const alpha = f.length > 3 ? f[3] : 1;
  const blended = [0, 1, 2].map((i) => alpha * f[i] + (1 - alpha) * b[i]);
  const hi = Math.max(L(blended), L(b));
  const lo = Math.min(L(blended), L(b));
  return (hi + 0.05) / (lo + 0.05);
}

test("every item opens, and the phone layout stays readable", async ({ page }) => {
  test.setTimeout(30000);
  await asOwner(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("http://site.test/xp/");
  await expect(page.locator("[data-xp-id='agent-pi1-cli']")).toBeVisible();
  const fit = await wide(page);
  expect(fit.scroll).toBeLessThanOrEqual(0);
  expect(fit.offenders).toEqual([]);

  const words = await page.evaluate(() => {
    const count = (el) => (el.innerText || "").trim().split(/\s+/).filter(Boolean).length;
    const maxOf = (sel) => Math.max(0, ...Array.from(document.querySelectorAll(sel)).map(count));
    return {
      sup: count(document.querySelector(".xp-sup")),
      hit: maxOf(".xp-hit"),
      chip: maxOf(".xp-chip"),
      ms: maxOf(".xp-ms"),
      task: maxOf(".xp-task"),
      feed: maxOf(".xp-feed button")
    };
  });
  expect(words.sup).toBeLessThanOrEqual(8);
  expect(words.hit).toBeLessThanOrEqual(8);
  expect(words.chip).toBeLessThanOrEqual(3);
  expect(words.ms).toBeLessThanOrEqual(4);
  expect(words.task).toBeLessThanOrEqual(6);
  expect(words.feed).toBeLessThanOrEqual(12);

  const ratios = await page.evaluate(() => {
    function bgOf(el) {
      let node = el;
      while (node) {
        const color = getComputedStyle(node).backgroundColor;
        const match = color.match(/rgba?\(([^)]+)\)/);
        if (match) {
          const parts = match[1].split(",").map(Number);
          const alpha = parts.length > 3 ? parts[3] : 1;
          if (alpha > 0.5) return color;
        }
        node = node.parentElement;
      }
      return "rgb(7, 11, 18)";
    }
    return [".xp-foot", ".xp-legend", ".xp-feed em", ".xp-card p", ".xp-axis", ".xp-flag.is-quiet", ".xp-task small", ".xp-block h2", ".xp-feed time", ".xp-where", ".xp-badge span"].map((sel) => {
      const el = document.querySelector(sel);
      const cs = getComputedStyle(el);
      return { sel, color: cs.color, bg: bgOf(el) };
    });
  });
  for (const sample of ratios) expect(contrastRatio(sample.color, sample.bg), sample.sel).toBeGreaterThanOrEqual(4.5);

  await page.locator("body").click({ position: { x: 4, y: 4 } });
  const tabbed = [];
  for (let i = 0; i < 30; i += 1) {
    await page.keyboard.press("Tab");
    tabbed.push(await page.evaluate(() => {
      const el = document.activeElement;
      return el ? (el.getAttribute("data-xp-id") || el.className) : "";
    }));
  }
  expect(tabbed).not.toContain("xp-close");
  const at = (id) => tabbed.indexOf(id);
  expect(at("agent-pi1-cli")).toBeGreaterThanOrEqual(0);
  expect(at("agent-pi1-cli")).toBeLessThan(at("agent-claude"));
  expect(at("agent-claude")).toBeLessThan(at("inst-claude-code-cli"));
  expect(at("ms-cloud")).toBeLessThan(at("task-pr-52"));
  expect(at("task-done")).toBeLessThan(at("act-sup-stall-1"));
  expect(at("act-sup-stall-1")).toBeLessThan(at("metric-output-per-hour"));

  await page.locator("[data-xp-id='agent-pi1-cli']").focus();
  await page.keyboard.press("ArrowLeft");
  await expect(page.locator("[data-xp-id='agent-pi']")).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(page.locator("[data-xp-id='agent-pi1-cli']")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(page.locator("[data-xp-id='agent-claude']")).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(page.locator("[data-xp-id='agent-pi1-cli']")).toBeFocused();

  await page.locator("[data-xp-id='ms-site']").focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#xp-detail")).toBeVisible();
  await expect(page.locator("#xp-detail")).toContainText("unknown");
  const trapped = await page.evaluate(() => document.activeElement.closest("#xp-detail") != null);
  expect(trapped).toBe(true);
  await page.keyboard.press("Tab");
  const still = await page.evaluate(() => document.activeElement.closest("#xp-detail") != null);
  expect(still).toBe(true);
  await page.keyboard.press("Escape");
  await expect(page.locator("#xp-detail")).toBeHidden();

  const openers = await page.locator("[data-xp-open]").evaluateAll((els) => els.map((el) => el.getAttribute("data-xp-open")));
  expect(openers.length).toBeGreaterThan(20);
  for (const id of openers) {
    await page.locator(`[data-xp-open="${id}"]`).click();
    await expect(page.locator("#xp-detail")).toBeVisible();
    await expect(page.locator("#xp-detail-title")).not.toHaveText("");
    await page.keyboard.press("Escape");
    await expect(page.locator("#xp-detail")).toBeHidden();
  }

  const detailInk = await page.evaluate(() => {
    document.querySelector("[data-xp-open='agent-pi1-cli']").click();
    const dt = document.querySelector("#xp-detail dt");
    const dd = document.querySelector("#xp-detail dd");
    const close = document.querySelector(".xp-close");
    const bg = getComputedStyle(document.getElementById("xp-detail")).backgroundColor;
    return {
      dt: getComputedStyle(dt).color,
      dd: getComputedStyle(dd).color,
      close: getComputedStyle(close).color,
      bg
    };
  });
  expect(contrastRatio(detailInk.dt, detailInk.bg)).toBeGreaterThanOrEqual(4.5);
  expect(contrastRatio(detailInk.dd, detailInk.bg)).toBeGreaterThanOrEqual(4.5);
  expect(contrastRatio(detailInk.close, detailInk.bg)).toBeGreaterThanOrEqual(4.5);
  await page.keyboard.press("Escape");

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.waitForTimeout(50);
  const desk = await wide(page);
  expect(desk.scroll).toBeLessThanOrEqual(0);
  expect(desk.offenders).toEqual([]);
});

test("page weight stays at or under the budget", () => {
  const total = PAGE_FILES.reduce((sum, rel) => sum + canonicalBytes(rel), 0);
  expect(total).toBeLessThanOrEqual(PAGE_BUDGET);
  const attrs = fs.readFileSync(path.join(root, ".gitattributes"), "utf8");
  for (const rel of PAGE_FILES) expect(attrs).toContain(rel + " text eol=lf");
  const sample = "a\r\nb\r";
  expect(Buffer.byteLength(sample.replace(/\r\n/g, "\n").replace(/\r/g, "\n"), "utf8")).toBe(4);
});
