// The honesty properties, asserted against a REAL RENDERED DOM.
//
// WHY THIS EXISTS, AND WHY THE REGEX VERSION COULD NOT
// ----------------------------------------------------
// tests/site_positioning.cjs tries to decide what a visitor can see by pattern
// matching HTML. It cannot. Two reviewers independently demonstrated that on
// 2026-09-09, between them defeating it with:
//
//     visibility:hidden          hidden="hidden" (valued attribute)
//     aria-hidden=true unquoted  inert
//     hidden until-found         display:none from a STYLESHEET, not inline
//     <template>                 <noscript> under scripting
//     data-id in place of id     a duplicate #honest-boundary elsewhere
//     the boundary moved to the footer, its section renamed
//
// I reproduced five of six myself before writing this. Every one of them makes
// the denial *present in the markup* and *invisible to a reader*, which is the
// distinction a regex has no way to draw. Each patch I added was another regex,
// and there is always another way to hide text: `stripUnrendered` was losing an
// arms race it could not win.
//
// Playwright was ALREADY a devDependency of this repository and `npm test`
// already ran it — I had been writing string matchers beside a browser. This
// asks the browser instead: `checkVisibility()` accounts for display,
// visibility, content-visibility and opacity together, which is the whole
// bypass class in one API.
//
// The regex file keeps its job as a fast pre-check with a stated ceiling. This
// is the one that decides.
const { test, expect } = require("@playwright/test");
const path = require("node:path");
const url = require("node:url");

const HOME = url.pathToFileURL(path.join(__dirname, "..", "index.html")).href;

// The sentences that make the surrounding claims honest.
const DENIALS = [
  "Nothing here has scored anyone's Salesforce instance.",
  "What does not exist yet is the part that reads a live org.",
  "The connector is designed and not built.",
];

test.beforeEach(async ({ page }) => {
  await page.goto(HOME);
});

test("exactly one honest-boundary exists in the DOM", async ({ page }) => {
  // Not "the first regex match". The DOM's own count, so a duplicate elsewhere
  // or a data-id decoy both fail rather than satisfy the check.
  const count = await page.locator("#honest-boundary").count();
  expect(count, "there must be exactly one #honest-boundary element").toBe(1);
});

test("the honest boundary is actually visible to a reader", async ({ page }) => {
  const el = page.locator("#honest-boundary");
  // checkVisibility covers display:none, visibility:hidden, content-visibility
  // and opacity:0 — from ANY source, inline or stylesheet — which is what the
  // string matcher could never see.
  const visible = await el.evaluate((node) =>
    node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }));
  expect(visible, "#honest-boundary is in the DOM but not rendered").toBe(true);

  // And nothing above it removes it from the accessibility tree.
  const ariaHidden = await el.evaluate((node) => !!node.closest("[aria-hidden='true'], [inert]"));
  expect(ariaHidden, "#honest-boundary sits inside an aria-hidden or inert subtree").toBe(false);
});

test("each denial is readable, exactly once, and inside the boundary", async ({ page }) => {
  const boundaryText = (await page.locator("#honest-boundary").innerText()).replace(/\s+/g, " ");
  const pageText = (await page.locator("body").innerText()).replace(/\s+/g, " ");

  for (const denial of DENIALS) {
    expect(boundaryText, `#honest-boundary no longer says "${denial}"`).toContain(denial);
    // innerText is what the browser renders, so a hidden duplicate does not count
    // here — and a visible duplicate is a second copy free to drift out of step.
    const occurrences = pageText.split(denial).length - 1;
    expect(occurrences, `"${denial}" appears ${occurrences} times in rendered text`).toBe(1);
  }
});

test("the boundary sits in the page's own content, not exiled to the footer", async ({ page }) => {
  const region = await page.locator("#honest-boundary").evaluate((node) => {
    const owner = node.closest("main, section, article, footer, header, nav");
    return owner ? owner.tagName.toLowerCase() : null;
  });
  expect(region, "#honest-boundary is not inside any semantic region").not.toBeNull();
  expect(
    ["footer", "nav", "header"].includes(region),
    `#honest-boundary was moved into <${region}>, where a reader is least likely to look`,
  ).toBe(false);
});

test("no rendered text claims a customer org is being read today", async ({ page }) => {
  const text = (await page.locator("body").innerText()).replace(/\s+/g, " ");

  const CLAIMS = [
    /scores? a live org/i,
    /assess(?:es)? your (?:production|live|real) [^.]{0,20}org/i,
    /scan(?:s|ning)? your (?:production|live|real) [^.]{0,20}org/i,
    /read(?:s|ing)? your (?:production|live|real) [^.]{0,20}org/i,
    /inspect(?:s|ing)? and grade[^.]{0,40}(?:salesforce|org|instance)/i,
    /connected to your (?:salesforce|org)/i,
  ];
  // Clause-scoped, not sentence-scoped. A reviewer showed that a future-tense
  // sentence followed by a present-tense claim passed a sentence-level check,
  // and that checking only the FIRST match let later claims through entirely.
  const FUTURE = /\b(will|would|once|when|after|plan to|intend to|is designed to|not yet|does not yet|cannot yet)\b/i;

  const offenders = [];
  for (const claim of CLAIMS) {
    for (const m of text.matchAll(new RegExp(claim.source, claim.flags + "g"))) {
      const from = Math.max(0, text.lastIndexOf(".", m.index) + 1);
      const semi = text.lastIndexOf(";", m.index);
      const comma = text.lastIndexOf(",", m.index);
      const clauseStart = Math.max(from, semi + 1, comma + 1);
      const stop = text.slice(m.index).search(/[.;,]/);
      const clause = text.slice(clauseStart, stop < 0 ? text.length : m.index + stop + 1).trim();
      if (!FUTURE.test(clause)) offenders.push(clause);
    }
  }
  expect(
    offenders,
    `rendered text claims a real customer org is read today:\n  ${offenders.join("\n  ")}`,
  ).toEqual([]);
});
