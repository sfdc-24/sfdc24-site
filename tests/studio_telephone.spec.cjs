/* The telephone trail panel on /studio/ (step 4 of the broken-telephone fix).

   What it must do: stay hidden and silent unless a live session has a doc to show; render what the
   controller hands it as TEXT (states, who, when, the answer lines, the live state); say plainly
   when the trail is off, unreadable or empty; never fetch anything in fixture or walkthrough mode.
   Runs against ?script=fixture: a synthetic controller, no network at all. */
const { test, expect } = require("@playwright/test");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const REPO = path.join(__dirname, "..");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml" };

function startServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith("/")) rel += "index.html";
    const file = path.join(REPO, rel.replace(/^\/+/, ""));
    if (!file.startsWith(REPO) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404); res.end("missing"); return;
    }
    res.writeHead(200, { "content-type": TYPES[path.extname(file).toLowerCase()] || "application/octet-stream" });
    res.end(fs.readFileSync(file));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () =>
    resolve({ server, origin: `http://127.0.0.1:${server.address().port}` })));
}

let srv;
test.beforeAll(async () => {
  srv = process.env.STUDIO_BASE
    ? { server: null, origin: process.env.STUDIO_BASE.replace(/\/+$/, "") }
    : await startServer();
});
test.afterAll(async () => { srv && srv.server && srv.server.close(); });

async function open(page, query = "?script=fixture") {
  const external = [];
  page.on("request", (r) => { if (!r.url().startsWith(srv.origin)) external.push(r.url()); });
  await page.goto(srv.origin + "/studio/" + query);
  await expect(page.locator("#studio-artifact")).toHaveAttribute("data-artifact-version", "1");
  return external;
}

const DOC = "1pKWJYbJzMqxSA9Vy_PSR93BU2OAAgP-N3WBEkCj7oj4";
const TRAIL = {
  enabled: true, status: "ok", doc: DOC, task: "task-0123456789abcdef", request: "OT-20261010",
  entries: [
    { state: "REQUESTED", by: "drive-intake", at: "2026-10-11T04:00:00Z", detail: "", result: [] },
    { state: "DISPATCHED", by: "drive-intake", at: "2026-10-11T04:00:01Z",
      detail: "on fleet:inbox:claude-api, which the worker polls; no wake rung", result: [] },
    { state: "ACCEPTED", by: "claude-api", at: "2026-10-11T04:05:00Z", detail: "attempt 1", result: [] },
    { state: "SUCCEEDED", by: "claude-api", at: "2026-10-11T04:05:09Z", detail: "model x - 1 cents CAD",
      result: ["The answer.", "FOR THE LAPTOP:", "nothing"] }
  ],
  live: { laptop: "offline", api_worker: "online", intake: "dispatched", pending: true }
};

test("hidden and silent in fixture mode, even with a doc in the URL; the hook exists", async ({ page }) => {
  const external = await open(page, "?script=fixture&doc=" + DOC);
  await expect(page.locator("[data-studio-telephone]")).toBeHidden();
  expect(await page.evaluate(() => typeof window.__studio.telephone)).toBe("function");
  await page.waitForTimeout(300);
  expect(external, "fixture mode must not touch the network").toEqual([]);
});

test("renders the trail as text: every line in order, the answer under its line, the live state", async ({ page }) => {
  const external = await open(page);
  await page.evaluate((payload) => window.__studio.telephone(payload), TRAIL);
  const panel = page.locator("[data-studio-telephone]");
  await expect(panel).toBeVisible();
  const items = panel.locator("[data-studio-telephone-lines] li");
  await expect(items).toHaveCount(4);
  await expect(items.nth(0)).toContainText("REQUESTED");
  await expect(items.nth(0)).toContainText("by drive-intake at 2026-10-11T04:00:00Z");
  await expect(items.nth(1)).toContainText("which the worker polls");
  await expect(items.nth(3)).toHaveAttribute("data-telephone-state", "SUCCEEDED");
  const answer = panel.locator("[data-studio-telephone-answer]");
  await expect(answer).toBeVisible();
  await expect(answer).toContainText("The answer under SUCCEEDED:");
  await expect(answer.locator("p")).toHaveCount(4);
  await expect(answer.locator("p").nth(1)).toHaveText("The answer.");
  await expect(panel.locator("[data-studio-telephone-live]")).toHaveText(
    "Laptop offline, cloud worker online, intake dispatched, another pass due.");
  await expect(panel.locator("[data-studio-telephone-status]")).toBeHidden();
  expect(external).toEqual([]);
});

test("typed data only: a detail or an answer that looks like HTML is shown as text", async ({ page }) => {
  await open(page);
  await page.evaluate((payload) => window.__studio.telephone(payload), {
    status: "ok", entries: [{ state: "SUCCEEDED", by: "<b>x</b>", at: "t", detail: "<img src=x onerror=alert(1)>",
      result: ["<script>alert(1)</script>"] }], live: null
  });
  const panel = page.locator("[data-studio-telephone]");
  await expect(panel.locator("[data-studio-telephone-lines] b, [data-studio-telephone-lines] img, [data-studio-telephone-answer] script")).toHaveCount(0);
  await expect(panel.locator("[data-studio-telephone-lines] small")).toHaveText("<img src=x onerror=alert(1)>");
  await expect(panel.locator("[data-studio-telephone-answer] p").nth(1)).toHaveText("<script>alert(1)</script>");
});

test("says plainly when the trail is off, unreadable, or empty, and clears a stale trail", async ({ page }) => {
  await open(page);
  const panel = page.locator("[data-studio-telephone]");
  const status = panel.locator("[data-studio-telephone-status]");
  await page.evaluate((payload) => window.__studio.telephone(payload), TRAIL);
  await expect(panel.locator("[data-studio-telephone-lines] li")).toHaveCount(4);
  await page.evaluate(() => window.__studio.telephone({ enabled: false }));
  await expect(status).toHaveText("The trail is not switched on for this studio.");
  await expect(panel.locator("[data-studio-telephone-lines] li")).toHaveCount(0);   // the stale trail is gone
  await expect(panel.locator("[data-studio-telephone-answer]")).toBeHidden();
  await page.evaluate(() => window.__studio.telephone({ status: "read_error", entries: [] }));
  await expect(status).toHaveText("The trail says: read error.");
  await page.evaluate(() => window.__studio.telephone({ status: "ok", entries: [] }));
  await expect(status).toHaveText("No receipts yet. The first one lands within two minutes of the doc.");
  await page.evaluate(() => window.__studio.telephone(null));
  await expect(status).toHaveText("The trail could not be read.");
  await page.evaluate(() => window.__studio.telephone({ status: "ok", entries: [null, "junk", { state: "QUEUED", by: "drive-intake", at: "t" }] }));
  await expect(panel.locator("[data-studio-telephone-lines] li")).toHaveCount(1);   // junk entries are skipped
});

test("no first person in the panel's own words", async ({ page }) => {
  await open(page);
  await page.evaluate((payload) => window.__studio.telephone(payload), { status: "ok", entries: [] });
  const words = await page.locator("[data-studio-telephone]").innerText();
  expect(words).not.toMatch(/\b(I|I'm|I've|my|me)\b/);
});
