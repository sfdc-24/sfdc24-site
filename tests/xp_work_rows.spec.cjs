// Work-row view on /xp/ (owner task 8794). Every value below is synthetic.
const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const LABELS = ["Lane", "Work", "Agent", "Status", "Blocker", "Waiting for", "Lease", "Evidence", "Stale", "Next", "Note"];

async function serve(page) {
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== "http://site.test") return route.abort();
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith("/")) rel += "index.html";
    if (rel === "/data/xp-live.json") return route.fulfill({ status: 404, body: "" });
    const file = path.resolve(root, "." + rel);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: "" });
    const types = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".json": "application/json" };
    return route.fulfill({ body: fs.readFileSync(file), contentType: types[path.extname(file)] || "text/plain" });
  });
}

async function asOwner(page) {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const token = Buffer.from(JSON.stringify({ sid: "op", exp: exp, scope: "operator", v: 1 })).toString("base64url") + ".sig";
  await page.addInitScript((tok) => {
    sessionStorage.setItem("studio.operator", JSON.stringify({ token: tok, expires_at: "" }));
  }, token);
  await page.route("**/v1/session", (route) => route.fulfill({
    status: (route.request().headers()["authorization"] || "").indexOf(token) >= 0 ? 400 : 401,
    contentType: "application/json",
    body: "{}"
  }));
}

async function rowsOf(page) {
  return page.locator("#xp-detail-body").evaluate((dl) => {
    const out = {};
    dl.querySelectorAll("dt").forEach((dt) => { out[dt.textContent] = dt.nextElementSibling.textContent; });
    return out;
  });
}

test.beforeEach(async ({ page }) => {
  await serve(page);
  await asOwner(page);
});

test("a reported task shows every work-row field from the snapshot", async ({ page }) => {
  await page.goto("http://site.test/xp/?source=fixture");
  await page.locator("[data-xp-id='task-done']").click();
  const rows = await rowsOf(page);
  expect(Object.keys(rows)).toEqual(LABELS);
  expect(rows).toMatchObject({
    Lane: "site", Work: "Sample gate review", Agent: "chatgpt-codex-desktop", Status: "SUCCEEDED",
    Blocker: "none", "Waiting for": "verifier", Next: "Sample next step", Note: "Gate reviewed",
    Evidence: "21:40 ET", Stale: "no", Lease: "closed"
  });
});

test("an accepted task with no done record says unknown, not an invented value", async ({ page }) => {
  await page.goto("http://site.test/xp/?source=fixture");
  await page.locator("[data-xp-id='task-gate']").click();
  const rows = await rowsOf(page);
  for (const label of ["Lane", "Work", "Blocker", "Waiting for", "Next", "Note"]) expect(rows[label]).toBe("unknown");
  expect(rows.Agent).toBe("claude-code-cli");
  expect(rows.Status).toBe("accepted");
  expect(rows.Evidence).toBe("22:29 ET");
  expect(rows.Stale).toBe("no");
  expect(rows.Lease).toBe("held");
});

test("stale and unknown evidence are labeled against the snapshot clock", async ({ page }) => {
  await page.goto("http://site.test/xp/?source=fixture");
  const out = await page.evaluate(() => {
    const X = window.SFDC24Xp;
    const keys = {
      "fleet:worker:accept:task-1111111111111111": "claude-code-cli:1792369800",
      "fleet:worker:accept:task-2222222222222222": "claude-code-cli:1792376400",
      "fleet:worker:done:task-3333333333333333": "{\"by\":\"codex\",\"state\":\"BLOCKED\"}"
    };
    const pick = (m) => m.tasks.map((t) => [t.id.slice(5, 9), t.evidence, t.stale]);
    return {
      timed: pick(X.normalize({ source: "fixture", read_at: "2026-10-19T02:30:00Z", keys: keys })),
      noClock: pick(X.normalize({ source: "fixture", keys: keys })),
      threshold: X.KEYS.workStaleSec
    };
  });
  expect(out.threshold).toBe(3600);
  expect(out.timed).toEqual([["1111", "20:30 ET", "yes"], ["2222", "22:20 ET", "no"], ["3333", "unknown", "unknown"]]);
  expect(out.noClock).toEqual([["1111", "20:30 ET", "unknown"], ["2222", "22:20 ET", "unknown"], ["3333", "unknown", "unknown"]]);
});

test("a stale row is flagged on its card", async ({ page }) => {
  const bundle = {
    read_at: "2026-10-19T02:30:00Z",
    keys: { "fleet:worker:accept:task-1111111111111111": "claude-code-cli:1792369800" }
  };
  await page.route("**/data/xp-fixture.json", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(bundle) }));
  await page.goto("http://site.test/xp/?source=fixture");
  await expect(page.locator(".xp-task small")).toHaveText("accepted · Stale");
});

test("private URLs, credentials, emails and phone numbers never render", async ({ page }) => {
  await page.goto("http://site.test/xp/?source=fixture");
  const task = await page.evaluate(() => window.SFDC24Xp.normalize({
    source: "fixture",
    read_at: "2026-10-19T02:30:00Z",
    keys: {
      "fleet:worker:accept:task-4444444444444444": "codex:1792376000",
      "fleet:worker:done:task-4444444444444444": JSON.stringify({
        by: "codex", state: "WAITING", lane: "https://internal.example.invalid/x", work: "use token abc",
        blocker: "gs://example-bucket/x", waiting_for: "someone@example.invalid", next: "call 555-010-0000"
      })
    }
  }).tasks[0]);
  expect([task.lane, task.work, task.blocker]).toEqual(["withheld", "withheld", "withheld"]);
  expect([task.waitingFor, task.next]).toEqual(["unknown", "unknown"]);
  const plain = await page.evaluate(() => window.SFDC24Xp.normalize({
    source: "fixture",
    keys: { "fleet:worker:accept:task-5555555555555555": "codex:1792376000", "fleet:worker:done:task-5555555555555555": "{\"by\":\"codex\",\"work\":\"Review task-pr-52 on the desk-side view\",\"blocker\":\"sk-abc\"}" }
  }).tasks[0]);
  expect([plain.work, plain.blocker]).toEqual(["Review task-pr-52 on the desk-side view", "withheld"]);
});

test("the withheld public snapshot shows no work rows", async ({ page }) => {
  await page.route("**/data/xp-live.json", (route) => route.fulfill({
    status: 200, contentType: "application/json", body: fs.readFileSync(path.join(root, "data/xp-live.json"))
  }));
  await page.goto("http://site.test/xp/");
  await expect(page.locator("[data-xp-id='source-badge']")).toHaveText("Unavailable");
  await expect(page.locator("[data-xp-id='empty-tasks']")).toHaveText("not yet reported");
  await expect(page.locator(".xp-task")).toHaveCount(0);
  expect(JSON.parse(fs.readFileSync(path.join(root, "data/xp-live.json"), "utf8"))).toEqual({ public_status: "withheld", keys: {} });
});

// Round 2 (review HOLD on 04c6db8). Synthetic inputs only.
function norm(page, keys, extra) {
  return page.evaluate(([k, e]) => window.SFDC24Xp.normalize(Object.assign({ source: "fixture", read_at: "2026-10-19T02:30:00Z", keys: k }, e || {})), [keys, extra || null]);
}

test("a done record with no accept key is still listed", async ({ page }) => {
  await page.goto("http://site.test/xp/?source=fixture");
  const m = await norm(page, { "fleet:worker:done:task-6666666666666666": JSON.stringify({ by: "grok", state: "BLOCKED", work: "Synthetic work", blocker: "Synthetic review" }) });
  expect(m.tasks.map((t) => [t.by, t.state, t.work, t.blocker, t.lease])).toEqual([["grok", "BLOCKED", "Synthetic work", "Synthetic review", "closed"]]);
  const other = await norm(page, { "fleet:inbox:cursor": [{ id: "pending-1", by: "grok", text: "Synthetic message" }] });
  expect(other.tasks).toEqual([]);
});

test("a named wait is not contradicted by the lease row", async ({ page }) => {
  const bundle = { read_at: "2026-10-19T02:30:00Z", keys: {
    "fleet:worker:accept:task-7777777777777777": "codex:1792376900:900",
    "fleet:worker:done:task-7777777777777777": JSON.stringify({ state: "WAITING", waiting_for: "Aya", blocker: "Approval", at: "2026-10-19T02:29:00Z" })
  } };
  await page.route("**/data/xp-fixture.json", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(bundle) }));
  await page.goto("http://site.test/xp/?source=fixture");
  await page.locator(".xp-task").first().click();
  const rows = await rowsOf(page);
  expect(rows["Waiting for"]).toBe("Aya");
  expect(rows.Lease).toBe("closed");
  expect(rows.Waiting).toBeUndefined();
});

test("future, blank and malformed evidence is unknown, not fresh", async ({ page }) => {
  await page.goto("http://site.test/xp/?source=fixture");
  const m = await norm(page, {
    "fleet:worker:done:task-8888888888888881": JSON.stringify({ state: "DONE", at: "2099-01-01T00:00:00Z" }),
    "fleet:worker:accept:task-8888888888888882": "codex::900",
    "fleet:worker:accept:task-8888888888888883": "codex:1792376900:10",
    "fleet:worker:done:task-8888888888888883": "[]"
  });
  const t = m.tasks.map((x) => [x.id.slice(-1), x.evidence, x.stale, x.waiting, x.lease]);
  expect(t).toEqual([["1", "unknown", "unknown", false, "closed"], ["2", "unknown", "unknown", false, "unknown"], ["3", "22:28 ET", "no", true, "lapsed"]]);
});

test("protocol-relative URLs and notes are withheld", async ({ page }) => {
  await page.goto("http://site.test/xp/?source=fixture");
  const t = (await norm(page, { "fleet:worker:done:task-9999999999999999": JSON.stringify({ work: "//private.example.invalid/p", note: "https://private.example.invalid/n" }) })).tasks[0];
  expect([t.work, t.note]).toEqual(["withheld", "withheld"]);
});

test("a withheld snapshot renders no tasks even when it carries keys", async ({ page }) => {
  await page.route("**/data/xp-live.json", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
    public_status: "withheld", keys: { "fleet:worker:done:task-abababababababab": JSON.stringify({ work: "Should not show", state: "WAITING" }) }
  }) }));
  await page.goto("http://site.test/xp/");
  await expect(page.locator("[data-xp-id='empty-tasks']")).toHaveText("not yet reported");
  await expect(page.locator(".xp-task")).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText("Should not show");
});

test("the overview row shows work, agent, blocker, waiting for and next", async ({ page }) => {
  await page.goto("http://site.test/xp/?source=fixture");
  await expect(page.locator("[data-xp-id='wr-task-done']")).toHaveText("Work: Sample gate review · Agent: chatgpt-codex-desktop · Blocker: none · Waiting for: verifier · Next: Sample next step");
  await expect(page.locator("[data-xp-id='wr-task-gate']")).toHaveText("Work: unknown · Agent: claude-code-cli · Blocker: unknown · Waiting for: unknown · Next: unknown");
});

test("a rejected future done time is not counted as output", async ({ page }) => {
  await page.goto("http://site.test/xp/?source=fixture");
  const m = await norm(page, {
    "fleet:worker:accept:task-5555555555555551": "codex:1792376900:900",
    "fleet:worker:done:task-5555555555555551": JSON.stringify({ state: "SUCCEEDED", at: "2026-10-19T02:40:00Z" }),
    "v1:bus:row:synthetic-future": { action_type: "commit", ts: "2026-10-19T02:45:00Z", source_tag: "codex" }
  });
  expect([m.tasks[0].evidence, m.tasks[0].at, m.tasks[0].output, m.output.reported]).toEqual(["unknown", null, "", false]);
});

test("actor ids in done and accept records are sanitized in the overview and detail", async ({ page }) => {
  await page.route("**/data/xp-fixture.json", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ read_at: "2026-10-19T02:30:00Z", keys: {
    "fleet:worker:done:task-4444444444444441": JSON.stringify({ by: "synthetic-person@example.invalid", state: "BLOCKED", work: "Synthetic task" }),
    "fleet:worker:done:task-4444444444444442": JSON.stringify({ by: { id: "x" }, state: "BLOCKED" }),
    "fleet:worker:accept:task-4444444444444443": "ghp_synthetic:1792376900:900"
  } }) }));
  await page.goto("http://site.test/xp/?source=fixture");
  await expect(page.locator(".xp-task")).toHaveCount(3);
  await expect(page.locator("body")).not.toContainText("example.invalid");
  await expect(page.locator("body")).not.toContainText("ghp_");
  await expect(page.locator("[data-xp-id='wr-task-4444444444444441']")).toContainText("Agent: unknown");
  await page.locator("[data-xp-id='task-4444444444444441']").first().click();
  expect((await rowsOf(page)).Agent).toBe("unknown");
});

test("a legacy done marker of 1 is settled, not a lapsed lease or a success", async ({ page }) => {
  await page.goto("http://site.test/xp/?source=fixture");
  const m = await norm(page, {
    "fleet:worker:done:task-3333333333333331": "1",
    "fleet:worker:accept:task-3333333333333332": "claude-code-cli:1792376900:10",
    "fleet:worker:done:task-3333333333333332": "1"
  });
  const t = m.tasks.map((x) => [x.by, x.state, x.lease, x.waiting, x.evidence, x.stale, x.at, x.output]);
  expect(t).toEqual([["", "unknown", "settled", false, "unknown", "unknown", null, ""], ["claude-code-cli", "unknown", "settled", false, "unknown", "unknown", null, ""]]);
  expect(m.output.reported).toBe(false);
});
