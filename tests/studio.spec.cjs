// Acceptance for /studio/ - one conversation, one evolving prototype.
// The contract is studio/contract/. This file IS the spec the page is built to:
// every rule in studio/contract/README.md has at least one assertion here.
// Runs against ?script=fixture: a synthetic controller, no network at all.
//
// Test hooks the page must expose (stable, not styling):
//   #studio-artifact[data-artifact-version]      the rendered prototype
//   [data-node-id=<id>][data-highlight=true]     one artifact node, highlighted when in focus
//   [data-studio-card][data-question-id][data-status][data-active]
//     [data-card-scope] [data-card-reason] [data-card-prompt]
//     option buttons by accessible name; the recommended one has [data-recommended]
//   [data-studio-batch=<batch_id>]               a decision form; one radio group per question
//   [data-studio-confirm]                        the latest confirmation text
//   #studio-live[aria-live=polite]               the only announcer
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

// STUDIO_BASE=https://www.sfdc24.com runs the same acceptance against the
// PUBLISHED bytes instead of a local server - the release check. Unset in CI.
let srv;
test.beforeAll(async () => {
  srv = process.env.STUDIO_BASE
    ? { server: null, origin: process.env.STUDIO_BASE.replace(/\/+$/, "") }
    : await startServer();
});
test.afterAll(async () => { srv && srv.server && srv.server.close(); });

async function open(page, opts = {}) {
  const external = [];
  page.on("request", (r) => { if (!r.url().startsWith(srv.origin)) external.push(r.url()); });
  if (opts.viewport) await page.setViewportSize(opts.viewport);
  await page.goto(srv.origin + "/studio/?script=fixture");
  await expect(page.locator("#studio-artifact")).toHaveAttribute("data-artifact-version", "1");
  return external;
}
const node = (page, id) => page.locator(`[data-node-id="${id}"]`);
const card = (page, qid) => page.locator(`[data-studio-card][data-question-id="${qid}"]`);
const version = (page) => page.locator("#studio-artifact");

test("ask and point: one active card, its scope highlighted, nothing else", async ({ page }) => {
  const external = await open(page);
  await expect(page.locator("[data-studio-card][data-active=true]")).toHaveCount(1);
  const c = card(page, "q-cta");
  await expect(c).toHaveAttribute("data-active", "true");
  await expect(c.locator("[data-card-scope]")).toHaveText("Homepage > Hero > Primary action");
  await expect(c.locator("[data-card-reason]")).toContainText("first screen");
  await expect(c.locator("[data-card-prompt]")).toHaveText("What should the main action be?");
  await expect(node(page, "hero-cta")).toHaveAttribute("data-highlight", "true");
  await expect(page.locator("[data-highlight=true]")).toHaveCount(1);
  for (const extra of ["Say it your way", "Decide later"]) {
    await expect(c.getByRole("button", { name: extra })).toBeVisible();
  }
  expect(external, "fixture mode must not touch the network").toEqual([]);
});

test("recommended is marked, explained, listed first, and never pre-selected", async ({ page }) => {
  await open(page);
  const c = card(page, "q-cta");
  const rec = c.locator("[data-recommended]");
  await expect(rec).toHaveCount(1);
  await expect(rec).toContainText("Describe a problem");
  await expect(rec).toContainText("Recommended");
  await expect(c).toContainText("this turns it into a lead");
  const firstOption = c.locator("[data-option-id]").first();
  await expect(firstOption).toHaveAttribute("data-option-id", "describe");
  await expect(version(page)).toHaveAttribute("data-artifact-version", "1");
  await expect(node(page, "hero-cta")).toContainText("Get started");
});

test("change and confirm: a tap changes only the affected node and says what changed", async ({ page }) => {
  await open(page);
  await card(page, "q-cta").getByRole("button", { name: /Describe a problem/ }).click();
  await expect(version(page)).toHaveAttribute("data-artifact-version", "2");
  await expect(node(page, "hero-cta")).toContainText("Describe a problem");
  await expect(node(page, "hero-heading")).toHaveText(/Your Salesforce, working/);
  await expect(page.locator("[data-studio-confirm]")).toHaveText(
    "Using Describe a problem. The hero action now opens guided intake.");
  await expect(page.locator("#studio-live")).toHaveAttribute("aria-live", "polite");
  await expect(page.locator("#studio-live")).toContainText("guided intake");
  await expect(card(page, "q-cta")).toHaveAttribute("data-status", "answered");
});

test("versions only move forward: a stale patch never renders", async ({ page }) => {
  await open(page);
  await card(page, "q-cta").getByRole("button", { name: /Describe a problem/ }).click();
  await expect(version(page)).toHaveAttribute("data-artifact-version", "2");
  await expect(page.locator("body")).not.toContainText("STALE");
});

test("decision form: answer together, submit once, recommended not pre-picked", async ({ page }) => {
  await open(page);
  await card(page, "q-cta").getByRole("button", { name: /Describe a problem/ }).click();
  const form = page.locator('[data-studio-batch="b-voice"]');
  await expect(form).toBeVisible();
  const submit = form.getByRole("button", { name: "Submit decisions" });
  await expect(submit).toBeDisabled();
  await expect(form.getByRole("radio", { checked: true })).toHaveCount(0);
  await expect(form.locator("[data-recommended]")).toHaveCount(2);
  await form.getByRole("radio", { name: /Salesforce admins/ }).check();
  await expect(submit).toBeDisabled();
  await form.getByRole("radio", { name: /One line/ }).check();
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(version(page)).toHaveAttribute("data-artifact-version", "3");
  await expect(node(page, "hero-heading")).toContainText("Clear your Salesforce backlog");
  await expect(node(page, "hero-text")).toContainText("Admin help, this week.");
  await expect(page.locator("[data-studio-confirm]")).toContainText("speaks to admins");
});

test("corrections keep history and old revisions cannot render", async ({ page }) => {
  await open(page);
  await card(page, "q-cta").getByRole("button", { name: /Describe a problem/ }).click();
  const form = page.locator('[data-studio-batch="b-voice"]');
  await form.getByRole("radio", { name: /Salesforce admins/ }).check();
  await form.getByRole("radio", { name: /One line/ }).check();
  await form.getByRole("button", { name: "Submit decisions" }).click();
  await expect(version(page)).toHaveAttribute("data-artifact-version", "3");

  await card(page, "q-cta").getByRole("button", { name: "Change this decision" }).click();
  await expect(card(page, "q-cta")).toHaveAttribute("data-status", "superseded");
  await expect(card(page, "q-cta")).toContainText("Describe a problem");
  await expect(card(page, "q-cta-2")).toHaveAttribute("data-active", "true");
  await expect(node(page, "hero-cta")).toHaveAttribute("data-highlight", "true");

  await card(page, "q-cta-2").getByRole("button", { name: /Book a consultation/ }).click();
  await expect(version(page)).toHaveAttribute("data-artifact-version", "4");
  await expect(node(page, "hero-cta")).toContainText("Book a consultation");
  await expect(page.locator("body")).not.toContainText("OLD REVISION");
});

test("typed data only: a label that looks like HTML is shown as text", async ({ page }) => {
  await open(page);
  await expect(node(page, "proof-quote")).toContainText('<img src=x onerror="window.__xss=1">');
  await expect(page.locator("#studio-artifact img")).toHaveCount(0);
  expect(await page.evaluate(() => window.__xss)).toBeUndefined();
});

test("never steals focus", async ({ page }) => {
  await open(page);
  const before = await page.evaluate(() => document.activeElement && document.activeElement.tagName);
  await page.evaluate(() => new Promise((r) => setTimeout(r, 300)));
  const after = await page.evaluate(() => document.activeElement && document.activeElement.tagName);
  expect(after).toBe(before);
  await expect(page.locator("[aria-live]")).toHaveCount(1);
});

test("keyboard: options are reachable and usable without a mouse", async ({ page }) => {
  await open(page);
  const opt = card(page, "q-cta").getByRole("button", { name: /Describe a problem/ });
  await opt.focus();
  await page.keyboard.press("Enter");
  await expect(version(page)).toHaveAttribute("data-artifact-version", "2");
});

test("phone: the card is a bottom sheet and the prototype stays visible", async ({ page }) => {
  await open(page, { viewport: { width: 390, height: 844 } });
  const box = await card(page, "q-cta").boundingBox();
  expect(box, "card must render").not.toBeNull();
  expect(box.height).toBeLessThanOrEqual(844 / 2);
  expect(box.y + box.height).toBeGreaterThan(844 - 8);
  await expect(node(page, "hero-cta")).toBeInViewport();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

// Found by rendering Cursor's first pass (4121147) - all 11 tests above were green.
test("the highlight is visible, not just an attribute", async ({ page }) => {
  await open(page);
  const cta = node(page, "hero-cta");
  await expect(cta).toHaveAttribute("data-highlight", "true");
  const visible = await cta.evaluate((el) => {
    const s = getComputedStyle(el);
    return (s.outlineStyle !== "none" && parseFloat(s.outlineWidth) >= 2) ||
           (s.boxShadow && s.boxShadow !== "none");
  });
  expect(visible, "a highlight nobody can see is not a Point step").toBe(true);
});

test("progress is truthful: it clears when the change lands", async ({ page }) => {
  await open(page);
  await card(page, "q-cta").getByRole("button", { name: /Describe a problem/ }).click();
  await expect(version(page)).toHaveAttribute("data-artifact-version", "2");
  await expect(page.getByText("Updating the hero action")).toHaveCount(0);
});

test("confirm is a beat: the change is shown and named before the next question", async ({ page }) => {
  await open(page);
  await card(page, "q-cta").getByRole("button", { name: /Describe a problem/ }).click();
  const confirm = page.locator("[data-studio-confirm]");
  await expect(confirm).toBeVisible();
  await expect(confirm).toBeInViewport();
  await expect(node(page, "hero-cta")).toHaveAttribute("data-changed", "true");
  // The next question waits for the change to settle - never auto-advance on top of it.
  await expect(page.locator('[data-studio-batch="b-voice"]')).toHaveCount(0);
  await expect(page.locator('[data-studio-batch="b-voice"]')).toBeVisible({ timeout: 6000 });
});

test("reduced motion: highlights do not animate", async ({ browser }) => {
  const ctx = await browser.newContext({ reducedMotion: "reduce" });
  const page = await ctx.newPage();
  await open(page);
  const anim = await node(page, "hero-cta").evaluate((el) => {
    const s = getComputedStyle(el);
    return [s.animationName, s.transitionDuration].join("|");
  });
  expect(anim).toMatch(/^none\|0s/);
  await ctx.close();
});

// ---- Codex review of PR 139 (REQUEST_CHANGES at 2950d7d): hostile and
// out-of-order streams. Uses the fixture-mode hooks window.__studio.inject and
// window.__studio.sent (studio/contract/README.md, "How the page accepts events").
const ENV = (over) => Object.assign({ session_id: "fixture-1", generation: 1, task_id: "t-home",
  task_revision: 1, turn_id: "turn-x" }, over);
const inject = (page, ev) => page.evaluate((e) => window.__studio.inject(e), ev);
const snapshotRoot = (label) => ({ id: "screen-home", kind: "screen", label: "Homepage", children: [
  { id: "hero", kind: "section", label: "Hero", children: [
    { id: "hero-heading", kind: "heading", label }, { id: "hero-cta", kind: "button", label: "Get started" }] }] });

test("correcting a decision before submitting the form does not stall", async ({ page }) => {
  await open(page);
  await card(page, "q-cta").getByRole("button", { name: /Describe a problem/ }).click();
  await expect(page.locator('[data-studio-batch="b-voice"]')).toBeVisible({ timeout: 6000 });
  await card(page, "q-cta").getByRole("button", { name: "Change this decision" }).click();
  await card(page, "q-cta-2").getByRole("button", { name: /Book a consultation/ }).click();
  await expect(version(page)).toHaveAttribute("data-artifact-version", "3");
  await expect(node(page, "hero-cta")).toContainText("Book a consultation");
  const form = page.locator('[data-studio-batch="b-voice"]');
  await form.getByRole("radio", { name: /Salesforce admins/ }).check();
  await form.getByRole("radio", { name: /One line/ }).check();
  await form.getByRole("button", { name: "Submit decisions" }).click();
  await expect(version(page)).toHaveAttribute("data-artifact-version", "4");
  await expect(node(page, "hero-heading")).toContainText("Clear your Salesforce backlog");
  await expect(page.locator("body")).not.toContainText("must never render");
});

test("every command the page sends is allowed by the command schema", async ({ page }) => {
  await open(page);
  await card(page, "q-cta").getByRole("button", { name: /Describe a problem/ }).click();
  const form = page.locator('[data-studio-batch="b-voice"]');
  await form.getByRole("radio", { name: /Salesforce admins/ }).check();
  await form.getByRole("radio", { name: /One line/ }).check();
  await form.getByRole("button", { name: "Submit decisions" }).click();
  await expect(version(page)).toHaveAttribute("data-artifact-version", "3");
  const schema = JSON.parse(fs.readFileSync(path.join(REPO, "studio/contract/events.schema.json"), "utf8"));
  const cmd = schema.oneOf[1];
  const sent = await page.evaluate(() => window.__studio.sent);
  expect(sent.length).toBeGreaterThanOrEqual(2);
  for (const c of sent) {
    for (const k of cmd.required) expect(Object.keys(c), `missing ${k}`).toContain(k);
    for (const k of Object.keys(c)) expect(Object.keys(cmd.properties), `unlisted ${k}`).toContain(k);
    expect(c.session_id).toBe("fixture-1");
  }
});

test("a foreign session's event is refused and commands stay on this session", async ({ page }) => {
  await open(page);
  await inject(page, ENV({ session_id: "intruder", seq: 4, op_id: "x-1", type: "artifact.patch", artifact_version: 2,
    payload: { ops: [{ op: "set_label", node_id: "hero-cta", value: "FOREIGN" }] } }));
  await expect(page.locator("body")).not.toContainText("FOREIGN");
  await card(page, "q-cta").getByRole("button", { name: /Describe a problem/ }).click();
  await expect(version(page)).toHaveAttribute("data-artifact-version", "2");
  const sent = await page.evaluate(() => window.__studio.sent);
  expect(sent[sent.length - 1].session_id).toBe("fixture-1");
});

test("a malformed payload is refused without breaking the page", async ({ page }) => {
  await open(page);
  await inject(page, ENV({ seq: 4, op_id: "x-2", type: "question.asked", artifact_version: 1, payload: {} }));
  await card(page, "q-cta").getByRole("button", { name: /Describe a problem/ }).click();
  await expect(version(page)).toHaveAttribute("data-artifact-version", "2");
});

test("a new generation starts from its snapshot; the old generation is then refused", async ({ page }) => {
  await open(page);
  await inject(page, ENV({ generation: 2, seq: 1, op_id: "g2-1", type: "artifact.snapshot", artifact_version: 7,
    payload: { root: snapshotRoot("GEN TWO") } }));
  await expect(version(page)).toHaveAttribute("data-artifact-version", "7");
  await expect(node(page, "hero-heading")).toContainText("GEN TWO");
  await inject(page, ENV({ generation: 1, seq: 4, op_id: "g1-4", type: "artifact.patch", artifact_version: 8,
    payload: { ops: [{ op: "set_label", node_id: "hero-heading", value: "OLD GENERATION" }] } }));
  await expect(page.locator("body")).not.toContainText("OLD GENERATION");
  await inject(page, ENV({ generation: 2, seq: 2, op_id: "g2-2", type: "artifact.patch", artifact_version: 8,
    payload: { ops: [{ op: "set_label", node_id: "hero-heading", value: "GEN TWO, PATCHED" }] } }));
  await expect(node(page, "hero-heading")).toContainText("GEN TWO, PATCHED");
});

test("a patch that skips a version is held, and a newer snapshot repairs the gap", async ({ page }) => {
  await open(page);
  await inject(page, ENV({ seq: 5, op_id: "x-5", type: "artifact.patch", artifact_version: 3,
    payload: { ops: [{ op: "set_label", node_id: "hero-heading", value: "SKIPPED AHEAD" }] } }));
  await expect(version(page)).toHaveAttribute("data-artifact-version", "1");
  await expect(page.locator("body")).not.toContainText("SKIPPED AHEAD");
  await inject(page, ENV({ seq: 7, op_id: "x-7", type: "artifact.snapshot", artifact_version: 5,
    payload: { root: snapshotRoot("REPAIRED") } }));
  await expect(version(page)).toHaveAttribute("data-artifact-version", "5");
  await expect(node(page, "hero-heading")).toContainText("REPAIRED");
  await expect(page.locator("body")).not.toContainText("SKIPPED AHEAD");
});

test("a confirmation for an older version is fenced out", async ({ page }) => {
  await open(page);
  await inject(page, ENV({ seq: 4, op_id: "x-c", type: "confirm", artifact_version: 0,
    payload: { text: "OUT OF DATE CONFIRMATION", artifact_ids: ["hero-cta"] } }));
  await expect(page.locator("body")).not.toContainText("OUT OF DATE CONFIRMATION");
});

// Release 2 (2026-09-24): the bare URL - the one people will actually visit -
// showed an empty box. With no controller configured it plays the scripted
// walkthrough and says so; the test hooks stay behind ?script=fixture.
test("the bare /studio/ URL plays the labelled walkthrough, not an empty box", async ({ page }) => {
  await page.goto(srv.origin + "/studio/");
  await expect(version(page)).toHaveAttribute("data-artifact-version", "1");
  await expect(page.locator("[data-studio-demo]")).toBeVisible();
  await expect(page.locator("[data-studio-demo]")).toContainText("scripted walkthrough");
  await expect(card(page, "q-cta")).toHaveAttribute("data-active", "true");
  expect(await page.evaluate(() => typeof window.__studio)).toBe("undefined");
  await card(page, "q-cta").getByRole("button", { name: /Describe a problem/ }).click();
  await expect(version(page)).toHaveAttribute("data-artifact-version", "2");
  await page.getByRole("button", { name: "Start again" }).click();
  await expect(version(page)).toHaveAttribute("data-artifact-version", "1");
});

// Release 3 (2026-09-24): two dead ends on the live walkthrough - "Decide
// later" did nothing, and typing your own answer did nothing.
test("decide later defers the question and the walkthrough moves on", async ({ page }) => {
  await open(page);
  await card(page, "q-cta").getByRole("button", { name: "Decide later" }).click();
  await expect(card(page, "q-cta")).toHaveAttribute("data-status", "deferred");
  await expect(page.locator('[data-studio-batch="b-voice"]')).toBeVisible({ timeout: 6000 });
  await expect(version(page)).toHaveAttribute("data-artifact-version", "1");
});

test("your own words get an honest note, not silence", async ({ page }) => {
  await open(page);
  await card(page, "q-cta").getByRole("button", { name: "Say it your way" }).click();
  const box = page.locator("#studio-app input[type=text], #studio-app textarea").first();
  await box.fill("I want visitors to book a call");
  await box.press("Enter");
  await expect(page.locator("[data-studio-note]")).toBeVisible();
  await expect(page.locator("[data-studio-note]")).toContainText("scripted");
  await expect(version(page)).toHaveAttribute("data-artifact-version", "1");
  // and it clears once a scripted option is chosen
  await card(page, "q-cta").getByRole("button", { name: /Describe a problem/ }).click();
  await expect(page.locator("[data-studio-note]")).toBeHidden();
});
