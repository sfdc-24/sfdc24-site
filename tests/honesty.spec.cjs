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

// NAMED FOR WHAT IT IS. The previous name was "no page claims a live org is
// being scored", which promises a semantic property; the implementation is a
// list of verbs. chatgpt-codex-desktop-01a08613 walked straight past it with
//
//     "SFDC24 evaluates live customer Salesforce environments today
//      and returns a grade."
//
// — no `score`, `assess`, `scan`, `read` or `inspect and grade` in it, so every
// pattern returned false. A blocklist that is named like a property invites
// exactly that: it looks discharged when it is only unmatched.
//
// The list is still worth having, and it is not the control. The control is
// the landmark tests above, which are structural and cannot be paraphrased
// around. This one catches what it has been taught to catch, and its name now
// says so.
test("no rendered text uses a KNOWN present-tense claim phrasing", async ({ page }) => {
  const text = (await page.locator("body").innerText()).replace(/\s+/g, " ");

  const CLAIMS = [
    // Added after it defeated the list. Each entry here is a phrasing that got
    // through once; none is hypothetical.
    /evaluat(?:es|ing) live [^.]{0,30}(?:salesforce|org|environment)/i,
    /returns? a grade/i,
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

// ── Round two: two false greens, two different holes ────────────────────────
//
// chatgpt-codex-desktop-01a0839e got both of these past the suite above at
// 21033f2, and I reproduced both before writing a line of this:
//
//   1. "SFDC24 imports metadata from live customer Salesforce tenants today and
//      publishes diagnostic scores." — VISIBLE, and the CLAIMS blocklist had
//      simply never been taught those verbs.
//   2. "SFDC24 scores a live org today and returns a grade." — in the
//      <meta name="description">, where NOTHING looked. body.innerText excludes
//      metadata, so every check passed while the page's search result and link
//      preview said the thing the page itself denies.
//
// The second is a SURFACE hole and closes structurally: enumerate every place
// prose reaches a customer and scan all of them, with unknown <meta> names
// treated as prose so omission fails closed.
//
// The first does NOT close by adding two more verbs. I said exactly that last
// round and then shipped a longer list anyway. So phrasing is INVERTED here:
// every sentence mentioning an org is a candidate claim and must appear in the
// reviewed allowlist in tests/capabilities.json. Deny by default — the same
// rule I argued for in G3 of the plan document, applied to my own copy.
const fsx = require('node:fs');
const CAPS = JSON.parse(
  fsx.readFileSync(path.join(__dirname, 'capabilities.json'), 'utf8'));
const { COLLECT_SURFACES, NON_PROSE_ATTRS, candidateClaims } =
  require('./claim_surfaces.cjs');

function sitePages() {
  const root = path.join(__dirname, '..');
  const found = [];
  for (const entry of fsx.readdirSync(root, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.html')) found.push(entry.name);
    else if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
      if (fsx.existsSync(path.join(root, entry.name, 'index.html'))) {
        found.push(`${entry.name}/index.html`);
      }
    }
  }
  return found.sort();
}

test('every capability claim, on every surface of every page, has been reviewed', async ({ page }) => {
  const approved = new Map(CAPS.approved_claims.map((c) => [c.text, c]));
  const disputed = new Set((CAPS.disputed_claims || []).map((c) => c.text));
  const unreviewed = [];

  for (const rel of sitePages()) {
    await page.goto(url.pathToFileURL(path.join(__dirname, '..', rel)).href);
    const { surfaces } = await page.evaluate(COLLECT_SURFACES, [...NON_PROSE_ATTRS]);
    for (const s of surfaces) {
      for (const claim of candidateClaims(s.text)) {
        // A disputed claim HAS been reviewed - it is recorded, with a reason,
        // and `no live claim is disputed` fails on it separately. Counting it
        // here as well would report one finding twice and blur which is which.
        if (approved.has(claim) || disputed.has(claim)) continue;
        unreviewed.push(`${rel} [${s.surface}] ${claim}`);
      }
    }
  }

  expect(
    unreviewed,
    'these sentences mention an org and are not in tests/capabilities.json.\n'
    + 'Nothing is wrong with them yet — they have simply not been read against the\n'
    + 'declared capability state. Read each one, then add it with the capability it\n'
    + "asserts (or `none`). Do not add a sentence you would not defend:\n  "
    + unreviewed.join('\n  '),
  ).toEqual([]);
});

test('no reviewed claim asserts a capability we do not have', async () => {
  // This is what stops capabilities.json being decoration. Adding a sentence to
  // the allowlist is not enough: if it asserts a capability declared false, it
  // fails here. Someone can still mark a claim `none` dishonestly — but that is
  // a person writing a false statement into a reviewed file under their own
  // name in git blame, which is a different thing from a test being fooled.
  const bad = [];
  for (const c of CAPS.approved_claims) {
    if (c.asserts === 'none') continue;
    if (!(c.asserts in CAPS.capability)) {
      bad.push(`"${c.text}" asserts ${c.asserts}, which is not a declared capability`);
    } else if (CAPS.capability[c.asserts] !== true) {
      bad.push(`"${c.text}" asserts ${c.asserts}, which is declared FALSE`);
    }
  }
  expect(bad, `the site claims capabilities it does not have:\n  ${bad.join('\n  ')}`)
    .toEqual([]);
});

test('the metadata surfaces are actually being collected', async ({ page }) => {
  // A positive control for the collector itself. If COLLECT_SURFACES silently
  // returned only the body — a selector typo, a renamed attribute — every check
  // above would pass on a page whose <meta> said anything at all. That is
  // precisely the shape of the bug being fixed, so it gets its own assertion
  // rather than being assumed.
  await page.goto(HOME);
  const { surfaces } = await page.evaluate(COLLECT_SURFACES, [...NON_PROSE_ATTRS]);
  const kinds = new Set(surfaces.map((s) => s.surface));
  for (const required of ['title', 'body', 'meta[description]', 'meta[og:description]']) {
    expect(
      kinds.has(required),
      `the surface collector returned nothing for ${required}. Every claim test `
      + 'above would pass regardless of what that surface says.',
    ).toBe(true);
  }
});

test('the surface collection covers every visible text node', async ({ page }) => {
  // ROUND THREE. The collector claimed completeness and hand-selected
  // containers: `p,li,h1..h6,td,...`. A standalone <div> was invisible to it,
  // and a <meta> carrying only `itemprop` was too, because the key was read
  // from `name` or `property` and nothing else. I had written "unknown meta
  // names are treated as prose, so omission fails closed" in that same file,
  // three lines above a hand-written list of tags. Both bypasses reproduced.
  //
  // Nothing is selected by tag name now — text is collected by COMPUTED
  // DISPLAY, and this test is the proof rather than the claim: a TreeWalker
  // visits every visible text node and reports any the collection missed. An
  // empty list here is what makes "complete" a measurement.
  for (const rel of sitePages()) {
    await page.goto(url.pathToFileURL(path.join(__dirname, '..', rel)).href);
    const { uncovered } = await page.evaluate(COLLECT_SURFACES, [...NON_PROSE_ATTRS]);
    expect(
      uncovered,
      `${rel}: these visible text nodes were not covered by any collected `
      + 'surface, so nothing would have read them:\n  '
      + uncovered.join('\n  '),
    ).toEqual([]);
  }
});

test('no live claim is disputed and still unresolved', async () => {
  // The gate's first encounter with contested copy, and it is not a mechanism
  // failure — it is the mechanism working. Four sentences on /xray/ are present
  // tense and addressed to the reader ("your org", "free first scan") while
  // describing capabilities capabilities.json records as absent.
  //
  // I will not approve them: that is the quiet blessing this file exists to
  // stop. I will not delete them: it is Mr. Salam's copy on a live page. So
  // they are recorded, this fails while they stand, and the decision sits with
  // the person whose decision it is. A red suite for a true reason is worth
  // more than a green one bought by looking away.
  const open = CAPS.disputed_claims || [];
  expect(
    open.map((c) => `${c.text}  [${c.seen_on.join(', ')}] — ${c.why_disputed}`),
    'live copy claims capabilities we do not have. This is a decision for Mr. '
    + 'Salam, not a test to be relaxed:\n  ',
  ).toEqual([]);
});
