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
  await expect(node(page, "hero-text")).toContainText("Help this week, not next quarter.");
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

// Release 4 moved this trap out of the public walkthrough (a visitor saw the
// raw markup in the Proof section) and into an injected patch.
test("typed data only: a label that looks like HTML is shown as text", async ({ page }) => {
  await open(page);
  await inject(page, ENV({ seq: 4, op_id: "xss-1", type: "artifact.patch", artifact_version: 2,
    payload: { ops: [{ op: "set_label", node_id: "proof-quote", value: '<img src=x onerror="window.__xss=1"> is how a client typed it' }] } }));
  await expect(version(page)).toHaveAttribute("data-artifact-version", "2");
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
// Release 6 ships the page WITH a live controller address. These two tests are
// about the page when no controller is configured, so they blank the address
// in the served HTML - locally and against www alike.
async function withoutController(page) {
  await page.route(/\/studio\/(\?.*)?$/, async (route) => {
    const res = await route.fetch();
    const html = (await res.text()).replace(/data-controller-url="[^"]*"/, 'data-controller-url=""');
    await route.fulfill({ response: res, body: html });
  });
}

test("the bare /studio/ URL plays the labelled walkthrough, not an empty box", async ({ page }) => {
  await withoutController(page);
  await page.goto(srv.origin + "/studio/");
  await expect(version(page)).toHaveAttribute("data-artifact-version", "1");
  await expect(page.locator("[data-studio-demo]")).toBeVisible();
  await expect(page.locator("[data-studio-demo]")).toContainText("scripted walkthrough");
  await expect(page.locator("[data-studio-talk]")).toBeHidden();
  await expect(card(page, "q-cta")).toHaveAttribute("data-active", "true");
  expect(await page.evaluate(() => typeof window.__studio)).toBe("undefined");
  await card(page, "q-cta").getByRole("button", { name: /Describe a problem/ }).click();
  await expect(version(page)).toHaveAttribute("data-artifact-version", "2");
  await page.getByRole("button", { name: "Start again" }).click();
  await expect(version(page)).toHaveAttribute("data-artifact-version", "1");
  await expect(page.locator("[data-studio-live]")).toBeHidden();
});

test("?live=1 without a controller still plays the walkthrough", async ({ page }) => {
  await withoutController(page);
  await page.goto(srv.origin + "/studio/?live=1");
  await expect(version(page)).toHaveAttribute("data-artifact-version", "1");
  await expect(page.locator("[data-studio-demo]")).toBeVisible();
  await expect(page.locator("[data-studio-live]")).toBeHidden();
  await expect(page.locator("[data-studio-email]")).toHaveCount(0);
  expect(await page.evaluate(() => typeof window.__studio)).toBe("undefined");
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

// Codex review of #144 (CODEX-PR144-REVIEW-20260924T0533Z, P2): an Enter that
// commits an input-method composition must not send half-typed words.
test("Enter while an input method is composing does not send; the next Enter sends once", async ({ page }) => {
  await open(page);
  await card(page, "q-cta").getByRole("button", { name: "Say it your way" }).click();
  const box = page.locator("#studio-app [data-freeform-input]").first();
  await box.fill("予約");
  await box.evaluate((el) => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true, cancelable: true }));
    const legacy = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    Object.defineProperty(legacy, "keyCode", { get: () => 229 });
    el.dispatchEvent(legacy);
  });
  const typed = () => page.evaluate(() => window.__studio.sent.filter((c) => c.freeform_answer).length);
  expect(await typed()).toBe(0);
  await expect(page.locator("[data-studio-note]")).toBeHidden();
  await box.press("Enter");
  await expect(page.locator("[data-studio-note]")).toBeVisible();
  expect(await typed()).toBe(1);
});

// Release 4 (2026-09-24): the walkthrough finishes somewhere. The form's words
// follow what was chosen, the form closes once answered, and a finish card
// offers the next step without taking away the chance to change a decision.
const finish = (page) => page.locator("[data-studio-finish]");

async function submitVoice(page, audience, length) {
  const form = page.locator('[data-studio-batch="b-voice"]');
  await form.getByRole("radio", { name: audience }).check();
  await form.getByRole("radio", { name: length }).check();
  await form.getByRole("button", { name: "Submit decisions" }).click();
}

test("the prototype says what was chosen, not what was recommended", async ({ page }) => {
  await open(page);
  await card(page, "q-cta").getByRole("button", { name: /Describe a problem/ }).click();
  await submitVoice(page, /Executives/, /A short paragraph/);
  await expect(version(page)).toHaveAttribute("data-artifact-version", "3");
  await expect(node(page, "hero-heading")).toContainText("Get more from Salesforce");
  await expect(node(page, "hero-heading")).not.toContainText("backlog");
  await expect(page.locator("[data-studio-confirm]")).toContainText("executives");
  await expect(page.locator("[data-studio-confirm]")).toContainText("short paragraph");
});

test("the form closes once answered and the walkthrough says it is finished", async ({ page }) => {
  await open(page);
  await expect(finish(page)).toBeHidden();
  await card(page, "q-cta").getByRole("button", { name: /Describe a problem/ }).click();
  await expect(page.locator('[data-studio-batch="b-voice"]')).toBeVisible({ timeout: 6000 });
  await expect(finish(page)).toBeHidden();
  await submitVoice(page, /Salesforce admins/, /One line/);
  await expect(page.locator("[data-studio-batch]")).toHaveCount(0);
  await expect(card(page, "q-audience")).toHaveAttribute("data-status", "answered");
  await expect(card(page, "q-length")).toHaveAttribute("data-status", "answered");
  await expect(finish(page)).toBeVisible({ timeout: 6000 });
  await expect(finish(page)).toContainText("whole walkthrough");
  await expect(finish(page).getByRole("link", { name: "Tell us what you want built" })).toHaveAttribute("href", "/intake/");
});

test("a change after the finish reopens the question, then finishes again", async ({ page }) => {
  await open(page);
  await card(page, "q-cta").getByRole("button", { name: /Describe a problem/ }).click();
  await submitVoice(page, /Salesforce admins/, /One line/);
  await expect(finish(page)).toBeVisible({ timeout: 6000 });
  await card(page, "q-cta").getByRole("button", { name: "Change this decision" }).click();
  await expect(card(page, "q-cta-2")).toHaveAttribute("data-active", "true");
  await expect(finish(page)).toBeHidden();
  await card(page, "q-cta-2").getByRole("button", { name: /Book a consultation/ }).click();
  await expect(node(page, "hero-cta")).toContainText("Book a consultation");
  await expect(finish(page)).toBeVisible({ timeout: 6000 });
});

test("Start again on the finish card starts the walkthrough over", async ({ page }) => {
  await open(page);
  await card(page, "q-cta").getByRole("button", { name: /Describe a problem/ }).click();
  await submitVoice(page, /Salesforce admins/, /One line/);
  await expect(finish(page)).toBeVisible({ timeout: 6000 });
  await finish(page).getByRole("button", { name: "Start again" }).click();
  await expect(version(page)).toHaveAttribute("data-artifact-version", "1");
  await expect(finish(page)).toBeHidden();
});

test("a controller's session.ended is final: its reason shows and nothing is left to press", async ({ page }) => {
  await open(page);
  await inject(page, ENV({ seq: 4, op_id: "end-1", type: "session.ended", artifact_version: 1,
    payload: { reason: "This session reached its 10 minute limit." } }));
  await expect(finish(page)).toBeVisible({ timeout: 6000 });
  await expect(finish(page)).toContainText("10 minute limit");
  const before = await page.evaluate(() => window.__studio.sent.length);
  const buttons = card(page, "q-cta").getByRole("button");
  const count = await buttons.count();
  expect(count).toBeGreaterThan(0);
  for (let i = 0; i < count; i++) await expect(buttons.nth(i)).toBeDisabled();
  await card(page, "q-cta").getByRole("button", { name: /Describe a problem/ }).click({ force: true });
  expect(await page.evaluate(() => window.__studio.sent.length)).toBe(before);
});

// Codex review of #146 at 053f270 (CODEX-PR146-REVIEW-PR205-CLOSURE-20260924T0605Z).
test("after session.ended nothing changes the prototype: not a later patch, not a queued one", async ({ page }) => {
  await open(page);
  // seq 5 waits for seq 4; seq 4 is the end. The queued patch must not land after it.
  await inject(page, ENV({ seq: 5, op_id: "late-q", type: "artifact.patch", artifact_version: 2,
    payload: { ops: [{ op: "set_label", node_id: "hero-heading", value: "AFTER THE END" }] } }));
  await inject(page, ENV({ seq: 4, op_id: "end-2", type: "session.ended", artifact_version: 1,
    payload: { reason: "This session reached its 10 minute limit." } }));
  await inject(page, ENV({ seq: 6, op_id: "late-n", type: "artifact.patch", artifact_version: 2,
    payload: { ops: [{ op: "set_label", node_id: "hero-heading", value: "AFTER THE END" }] } }));
  await expect(finish(page)).toBeVisible({ timeout: 6000 });
  await page.waitForTimeout(2600);
  await expect(version(page)).toHaveAttribute("data-artifact-version", "1");
  await expect(page.locator("body")).not.toContainText("AFTER THE END");
});

test("every option on the first card plays, not only the recommended one", async ({ page }) => {
  for (const [name, label] of [[/See the work/, "See the work"], [/Book a consultation/, "Book a consultation"]]) {
    await open(page);
    await card(page, "q-cta").getByRole("button", { name }).click();
    await expect(version(page)).toHaveAttribute("data-artifact-version", "2");
    await expect(node(page, "hero-cta")).toContainText(label);
    await expect(page.locator("[data-studio-note]")).toBeHidden();
    await expect(page.locator('[data-studio-batch="b-voice"]')).toBeVisible({ timeout: 6000 });
  }
});

test("a form decision can be changed after the finish, and the finish comes back", async ({ page }) => {
  await open(page);
  await card(page, "q-cta").getByRole("button", { name: /Describe a problem/ }).click();
  await submitVoice(page, /Salesforce admins/, /One line/);
  await expect(finish(page)).toBeVisible({ timeout: 6000 });
  await card(page, "q-audience").getByRole("button", { name: "Change this decision" }).click();
  await expect(card(page, "q-audience-2")).toHaveAttribute("data-active", "true");
  await expect(finish(page)).toBeHidden();
  await card(page, "q-audience-2").getByRole("button", { name: /Executives/ }).click();
  await expect(node(page, "hero-heading")).toContainText("Get more from Salesforce");
  await expect(page.locator("[data-studio-note]")).toBeHidden();
  await expect(finish(page)).toBeVisible({ timeout: 6000 });
  await card(page, "q-length").getByRole("button", { name: "Change this decision" }).click();
  await card(page, "q-length-2").getByRole("button", { name: /A short paragraph/ }).click();
  await expect(node(page, "hero-text")).toContainText("hand it back with notes");
  await expect(node(page, "hero-heading")).toContainText("Get more from Salesforce");
  await expect(finish(page)).toBeVisible({ timeout: 6000 });
});

test("no card offers a button the walkthrough cannot answer", async ({ page }) => {
  await open(page);
  await card(page, "q-cta").getByRole("button", { name: /Describe a problem/ }).click();
  await card(page, "q-cta").getByRole("button", { name: "Change this decision" }).click();
  const second = card(page, "q-cta-2");
  await expect(second).toHaveAttribute("data-active", "true");
  await expect(second.getByRole("button", { name: "Decide later" })).toHaveCount(0);
  await second.getByRole("button", { name: /See the work/ }).click();
  await expect(node(page, "hero-cta")).toContainText("See the work");
  await expect(card(page, "q-cta-2").getByRole("button", { name: "Change this decision" })).toHaveCount(0);
});

test("a decision left for later is acknowledged at the finish and can be made now", async ({ page }) => {
  await open(page);
  await card(page, "q-cta").getByRole("button", { name: "Decide later" }).click();
  await submitVoice(page, /Salesforce admins/, /One line/);
  await expect(finish(page)).toBeVisible({ timeout: 6000 });
  await expect(finish(page)).toContainText("every decision you made");
  await expect(finish(page)).toContainText("You left one for later.");
  await expect(finish(page)).not.toContainText("each decision changed");
  await card(page, "q-cta").getByRole("button", { name: "Decide now" }).click();
  await expect(card(page, "q-cta-2")).toHaveAttribute("data-active", "true");
  await card(page, "q-cta-2").getByRole("button", { name: /Book a consultation/ }).click();
  await expect(node(page, "hero-cta")).toContainText("Book a consultation");
  await expect(finish(page)).toBeVisible({ timeout: 6000 });
  await expect(finish(page)).not.toContainText("for later");
});

// Release 5 (2026-09-24): voice can answer one question of a form. The
// controller then expects the form to be submitted with only the rest
// (Blackboard #206), and a re-render must not drop what was already ticked.
const formQ = (qid, node, a, b) => ({ question_id: qid, group: "Content", scope_path: "Homepage > Hero",
  reason: "It shapes the hero.", prompt: "Pick for " + qid + "?", status: "open", affected_artifact_ids: [node],
  options: [{ option_id: a, label: "Option " + a, consequence: "Uses " + a },
            { option_id: b, label: "Option " + b, consequence: "Uses " + b }] });

test("a form question answered by voice leaves the form; the rest submit alone and keep their ticks", async ({ page }) => {
  await open(page);
  await inject(page, ENV({ seq: 4, op_id: "fb-1", type: "decision.batch", artifact_version: 1,
    payload: { batch_id: "b-live", title: "Two decisions", questions: [
      formQ("q-a", "hero-heading", "a1", "a2"), formQ("q-b", "hero-text", "b1", "b2")] } }));
  const form = page.locator('[data-studio-batch="b-live"]');
  await expect(form).toBeVisible({ timeout: 6000 });
  await form.getByRole("radio", { name: /Option a2/ }).check();
  await inject(page, ENV({ seq: 5, op_id: "fb-2", type: "question.answered", artifact_version: 1,
    payload: { question: Object.assign(formQ("q-b", "hero-text", "b1", "b2"),
      { status: "answered", selected_option: "b1", answer_source: "voice" }) } }));
  await expect(form.getByRole("radio", { name: /Option b1/ })).toHaveCount(0);
  await expect(form.getByRole("radio", { name: /Option a2/ })).toBeChecked();
  await expect(form.getByRole("button", { name: "Submit decisions" })).toBeEnabled();
  await form.getByRole("button", { name: "Submit decisions" }).click();
  const sent = await page.evaluate(() => window.__studio.sent);
  const batch = sent.filter((c) => c.type === "answer_batch").pop();
  expect(batch.answers).toEqual([{ question_id: "q-a", option_id: "a2" }]);
});

test("an unrelated event does not clear choices already ticked in a form", async ({ page }) => {
  await open(page);
  await card(page, "q-cta").getByRole("button", { name: /Describe a problem/ }).click();
  const form = page.locator('[data-studio-batch="b-voice"]');
  await expect(form).toBeVisible({ timeout: 6000 });
  await form.getByRole("radio", { name: /Executives/ }).check();
  await inject(page, ENV({ seq: 20, op_id: "fb-3", type: "focus.set", artifact_version: 2,
    payload: { artifact_ids: ["hero-heading"] } }));
  await page.waitForTimeout(2500);
  await expect(form.getByRole("radio", { name: /Executives/ })).toBeChecked();
});

// Codex review of #149 at 7ec6380: a tick carries only into the same decision.
test("a replacement form that reuses ids starts unticked", async ({ page }) => {
  await open(page);
  await inject(page, ENV({ seq: 4, op_id: "rb-1", type: "decision.batch", artifact_version: 1,
    payload: { batch_id: "b-one", title: "First", questions: [formQ("q-a", "hero-heading", "a1", "a2"), formQ("q-b", "hero-text", "b1", "b2")] } }));
  const first = page.locator('[data-studio-batch="b-one"]');
  await expect(first).toBeVisible({ timeout: 6000 });
  await first.getByRole("radio", { name: /Option a2/ }).check();
  const changed = formQ("q-a", "hero-heading", "a1", "a2");
  changed.prompt = "A different decision?";
  await inject(page, ENV({ seq: 5, op_id: "rb-2", type: "decision.batch", artifact_version: 1,
    payload: { batch_id: "b-one", title: "Replaced", questions: [changed, formQ("q-b", "hero-text", "b1", "b2")] } }));
  const second = page.locator('[data-studio-batch="b-one"]');
  await expect(second).toContainText("A different decision?");
  await expect(second.locator('fieldset').first().locator("input[type=radio]:checked")).toHaveCount(0);
  await expect(second.getByRole("button", { name: "Submit decisions" })).toBeDisabled();
});

test("a new generation does not inherit a tick from the one before", async ({ page }) => {
  await open(page);
  await inject(page, ENV({ seq: 4, op_id: "rg-1", type: "decision.batch", artifact_version: 1,
    payload: { batch_id: "b-gen", title: "Gen one", questions: [formQ("q-a", "hero-heading", "a1", "a2"), formQ("q-b", "hero-text", "b1", "b2")] } }));
  const form = page.locator('[data-studio-batch="b-gen"]');
  await expect(form).toBeVisible({ timeout: 6000 });
  await form.getByRole("radio", { name: /Option a1/ }).check();
  await inject(page, ENV({ generation: 2, seq: 1, op_id: "rg-2", type: "artifact.snapshot", artifact_version: 1,
    payload: { root: snapshotRoot("After repair") } }));
  await inject(page, ENV({ generation: 2, seq: 2, op_id: "rg-3", type: "decision.batch", artifact_version: 1,
    payload: { batch_id: "b-gen", title: "Gen one", questions: [formQ("q-a", "hero-heading", "a1", "a2"), formQ("q-b", "hero-text", "b1", "b2")] } }));
  await expect(page.locator('[data-studio-batch="b-gen"] input[type=radio]:checked')).toHaveCount(0, { timeout: 6000 });
});

// Codex re-review of #149 at 18f2d1c: the meaning of a decision includes
// where it applies, what it changes, and what each option does.
for (const [what, change] of [
  ["its scope", (q) => { q.scope_path = "Homepage > Footer"; }],
  ["the node it changes", (q) => { q.affected_artifact_ids = ["hero-text"]; }],
  ["an option's consequence", (q) => { q.options[1].consequence = "Does something else entirely"; }],
]) {
  test(`a tick does not survive a change to ${what}`, async ({ page }) => {
    await open(page);
    await inject(page, ENV({ seq: 4, op_id: "rs-1", type: "decision.batch", artifact_version: 1,
      payload: { batch_id: "b-sem", title: "Same title", questions: [formQ("q-a", "hero-heading", "a1", "a2"), formQ("q-b", "hero-text", "b1", "b2")] } }));
    const form = page.locator('[data-studio-batch="b-sem"]');
    await expect(form).toBeVisible({ timeout: 6000 });
    await form.getByRole("radio", { name: /Option a2/ }).check();
    const changed = formQ("q-a", "hero-heading", "a1", "a2");
    change(changed);
    await inject(page, ENV({ seq: 5, op_id: "rs-2", type: "decision.batch", artifact_version: 1, task_revision: 2,
      payload: { batch_id: "b-sem", title: "Same title", questions: [changed, formQ("q-b", "hero-text", "b1", "b2")] } }));
    await expect(form.locator("fieldset").first().locator("input[type=radio]:checked")).toHaveCount(0, { timeout: 6000 });
  });
}

test("an unchanged form question keeps its tick through an unrelated revision", async ({ page }) => {
  await open(page);
  const qs = () => [formQ("q-a", "hero-heading", "a1", "a2"), formQ("q-b", "hero-text", "b1", "b2")];
  await inject(page, ENV({ seq: 4, op_id: "ru-1", type: "decision.batch", artifact_version: 1,
    payload: { batch_id: "b-keep", title: "Keep", questions: qs() } }));
  const form = page.locator('[data-studio-batch="b-keep"]');
  await expect(form).toBeVisible({ timeout: 6000 });
  await form.getByRole("radio", { name: /Option a2/ }).check();
  await inject(page, ENV({ seq: 5, op_id: "ru-2", type: "decision.batch", artifact_version: 1, task_revision: 2,
    payload: { batch_id: "b-keep", title: "Keep", questions: qs() } }));
  await page.waitForTimeout(500);
  await expect(form.getByRole("radio", { name: /Option a2/ })).toBeChecked();
});

// Release 6: the page as shipped carries the live controller address. The
// public default is still the walkthrough, it never calls the controller, and
// the owner's way in is the "Sign in for a live session" link.
test("as shipped, bare /studio/ is the walkthrough, calls no controller, and offers owner sign-in", async ({ page }) => {
  const calls = [];
  page.on("request", (r) => { if (/run\.app/.test(r.url())) calls.push(r.url()); });
  await page.goto(srv.origin + "/studio/");
  await expect(version(page)).toHaveAttribute("data-artifact-version", "1");
  await expect(page.locator("[data-studio-demo]")).toBeVisible();
  const link = page.getByRole("link", { name: "Sign in for a live session" });
  await expect(link).toBeVisible();
  expect(await link.getAttribute("href")).toMatch(/\/studio\/\?live=1$/);
  await page.waitForTimeout(1500);
  expect(calls, "the public walkthrough must not call the controller").toEqual([]);
});

// Release 7 (2026-09-24): accessibility pass on the walkthrough.
test("screen readers get a page heading, section headings and a main landmark", async ({ page }) => {
  await open(page);
  await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("SFDC24 Studio");
  await expect(page.getByRole("heading", { level: 2, name: "Prototype" })).toHaveCount(1);
  await expect(page.getByRole("heading", { level: 2, name: "Decisions" })).toHaveCount(1);
  await expect(page.getByRole("main")).toHaveCount(1);
  // present for assistive technology, not drawn on screen
  const box = await page.getByRole("heading", { level: 1 }).boundingBox();
  expect(box.width * box.height).toBeLessThanOrEqual(1);
});

test("every visible control has an accessible name, and the notice is drawn at full contrast", async ({ page }) => {
  await page.goto(srv.origin + "/studio/");
  await expect(version(page)).toHaveAttribute("data-artifact-version", "1");
  const unnamed = await page.evaluate(() => [...document.querySelectorAll("button, a[href], input")]
    .filter((el) => el.offsetParent !== null)
    .filter((el) => !((el.getAttribute("aria-label") || el.textContent || "").trim() ||
      (el.closest("label") && el.closest("label").textContent.trim())))
    .map((el) => el.outerHTML.slice(0, 80)));
  expect(unnamed).toEqual([]);
  expect(await page.locator("[data-studio-demo]").evaluate((el) => getComputedStyle(el).opacity)).toBe("1");
});

test("the recommended choice can be reached and applied with the keyboard alone", async ({ page }) => {
  await open(page);
  let reached = false;
  for (let i = 0; i < 40 && !reached; i += 1) {
    await page.keyboard.press("Tab");
    reached = await page.evaluate(() => /Describe a problem/.test((document.activeElement || {}).textContent || ""));
  }
  expect(reached, "Tab reaches the recommended option").toBe(true);
  const outline = await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle);
  expect(outline).not.toBe("none");
  await page.keyboard.press("Enter");
  await expect(version(page)).toHaveAttribute("data-artifact-version", "2");
});

// Release 9 (2026-09-24): on a phone the question card is a bottom sheet, so a
// change can land behind it. The page brings the changed node into the top
// half - scrolling only, never moving focus.
test("on a phone the changed node is brought into the visible top half", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await open(page, { viewport: { width: 390, height: 844 } });
  const before = await node(page, "hero-cta").boundingBox();
  expect(before.y + before.height, "the hero action starts below the top half").toBeGreaterThan(844 / 2);
  await card(page, "q-cta").getByRole("button", { name: /Describe a problem/ }).click();
  await expect(version(page)).toHaveAttribute("data-artifact-version", "2");
  await expect.poll(async () => {
    const box = await node(page, "hero-cta").boundingBox();
    return box.y >= 0 && box.y + box.height <= 844 / 2;
  }).toBe(true);
  const focused = await page.evaluate(() => (document.activeElement || {}).getAttribute
    ? document.activeElement.getAttribute("data-node-id") : null);
  expect(focused, "focus never moves to the prototype").toBeNull();
});

test("on a wide screen a change does not scroll the page", async ({ page }) => {
  await open(page, { viewport: { width: 1280, height: 800 } });
  await card(page, "q-cta").getByRole("button", { name: /Describe a problem/ }).click();
  await expect(version(page)).toHaveAttribute("data-artifact-version", "2");
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
});

