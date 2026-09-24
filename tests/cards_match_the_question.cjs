/* The cards the page opens on its own must match what was asked.
 *
 * Measured 2026-09-20 against the live site. A visitor typed
 *
 *   "Which is better for lead assignment, Apex trigger or Flow?"
 *
 * and the page opened a pipeline-desk demo card about accounts and
 * opportunities, printed an estimator card about picking one screen, and put
 * the one vote button on "Ship it now, or hold for one more review?" - a
 * question nobody had asked. Three separate features, one defect: a keyword
 * anywhere in the sentence was treated as a request.
 *
 * Nothing here throws in the browser, so nothing here is visible to any other
 * suite. Only a fixture comparing INTENT against OUTCOME can see it, which is
 * the same reason tests/estimator_shapes.cjs exists.
 *
 * It executes index.html's own estimate()/isMakeAsk()/isSizingAsk(),
 * local-first-boot.js's own wantsTheDesk(), and the page's own deriveBallot().
 * A test that retypes any of those passes while the page is broken.
 *
 * Run: node --test tests/cards_match_the_question.cjs
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
/* LF-normalised. These files are checked out with CRLF on Windows, and an
   anchor written with a bare newline then matches nothing - the suite would
   pass while testing an empty string. */
const CR = String.fromCharCode(13);
const read = (...p) =>
  fs.readFileSync(path.join(ROOT, ...p), "utf8").split(CR).join("");
const SRC = read("index.html");
const BOOT = read("assets", "local-first-boot.js");
const TRIAGE = read("assets", "triage.js");

/* ---- lift the page's own code, anchored so a move fails loudly ---------- */
function slice(src, startNeedle, endNeedle, from) {
  const a = src.indexOf(startNeedle, from || 0);
  assert.ok(a >= 0, `anchor moved: ${startNeedle}`);
  const b = src.indexOf(endNeedle, a);
  assert.ok(b >= 0, `end anchor moved: ${endNeedle} after ${startNeedle}`);
  return src.slice(a, b + endNeedle.length);
}

const sandbox = { window: {}, console, Intl, Date };
vm.createContext(sandbox);
vm.runInContext(TRIAGE, sandbox, { filename: "triage.js" });

/* index.html: the shape tables through estimate(), plus the two intent gates */
vm.runInContext(
  slice(SRC, "  var SHAPES = [", "    return null;\n  }") +
  "\n" + slice(SRC, "  function isSizingAsk(question){", "\n  }") +
  "\n" + slice(SRC, "  var MAKE_INTENT =", "\n  }") +
  "\nthis.estimate = estimate;" +
  "\nthis.isSizingAsk = isSizingAsk;" +
  "\nthis.isMakeAsk = isMakeAsk;",
  sandbox, { filename: "index.html#estimator" });

/* index.html: the ballot derivation */
vm.runInContext(
  slice(SRC, "    var BALLOT_SPLIT =", "    window.__deriveBallot = deriveBallot;"),
  sandbox, { filename: "index.html#ballot" });

/* local-first-boot.js: the desk gate */
vm.runInContext(
  slice(BOOT, "  var SF_DESK =", "return SF_DESK.test(q) || WHAT_WE_BUILT.test(q);")
    + "\n}\nthis.wantsTheDesk = wantsTheDesk;",
  sandbox, { filename: "boot#desk" });

const { estimate, isSizingAsk, isMakeAsk, wantsTheDesk } = sandbox;
const deriveBallot = sandbox.window.__deriveBallot;
const isDecision = sandbox.window.__TRIAGE.isDecision;

/* The page shows a card when maybeEstimate() would show one. Mirror only the
   GATE, never the table - the table is executed above. */
function estimateShown(q) {
  if (isDecision(q)) return null;
  const shape = estimate(q);
  if (shape) return shape.id;
  return isSizingAsk(q) ? "(soft)" : null;
}

/* --------------------------------------------------------------- 6b ---- */
test("no estimate card for a question that asked for a call, not a range", async (t) => {
  const CASES = [
    ["Should we play it safe and stay on our current CRM?", "matched 'play' -> a plan for writing game rules"],
    ["Should we automate our quote-to-cash process or leave it manual?", "matched 'quote' -> the soft sizing pass"],
    ["Do we build this in Flow or buy an app from the AppExchange?", "matched 'app' -> a scope about picking one screen"],
    ["Which is better for lead assignment, Apex trigger or Flow?", "a decision, not a sizing ask"],
    ["Permission sets or profiles?", "a decision, not a sizing ask"],
    /* Not decision-shaped, so the decision gate does not cover it. Only the
       make gate stops this one, and without it the visitor is handed a plan
       for writing game rules. */
    ["We are inclined to play it safe with the CRM we already have", "matched 'play'"],
    ["The argument here is really about data quality", "matched 'argument'"],
  ];
  for (const [q, why] of CASES) {
    await t.test(q, () => {
      assert.strictEqual(estimateShown(q), null, `card shown (${why})`);
    });
  }
});

test("the estimator still sizes the problems it exists to size", async (t) => {
  const CASES = [
    ["How long would it take to automate our approvals?", "approvals"],
    ["We track the whole pipeline in Excel and it is falling apart", "spreadsheet"],
    ["Onboarding a new hire takes us two weeks of manual setup", "onboarding"],
    ["Our handover between sales and delivery keeps dropping things", "handover"],
    ["The numbers in our dashboard do not match the source system", "reports"],
    ["Build me an app that logs site visits", "app"],
  ];
  for (const [q, id] of CASES) {
    await t.test(`${q} -> ${id}`, () => {
      assert.strictEqual(estimateShown(q), id);
    });
  }
});

test("a make ask needs the verb, not the noun", async (t) => {
  await t.test("bare noun is not a make ask", () => {
    assert.strictEqual(isMakeAsk("should we play it safe"), false);
    assert.strictEqual(isMakeAsk("buy an app from the AppExchange"), false);
  });
  await t.test("the verb is", () => {
    assert.strictEqual(isMakeAsk("build me an app"), true);
    assert.strictEqual(isMakeAsk("can you design a logo for us"), true);
  });
});

test("'quote' alone is a Salesforce noun on this site, not a price ask", async (t) => {
  await t.test("quote-to-cash does not ask for a number", () => {
    assert.strictEqual(isSizingAsk("automate our quote-to-cash process"), false);
  });
  await t.test("a real price ask still does", () => {
    assert.strictEqual(isSizingAsk("can I get a quote"), true);
    assert.strictEqual(isSizingAsk("quote me for this"), true);
    assert.strictEqual(isSizingAsk("how much would this cost"), true);
  });
});

/* --------------------------------------------------------------- 6c ---- */
test("the pipeline desk opens when asked to be shown, not on a noun", async (t) => {
  const CLOSED = [
    "Which is better for lead assignment, Apex trigger or Flow?",
    "Should we hire a Salesforce admin or use a partner?",
    "Should we split the org or keep one org for both business units?",
    "Do we build this in Flow or buy an app from the AppExchange?",
  ];
  const OPEN = [
    "Can you show me something you have actually built?",
    "What does your pipeline desk look like?",
    "Do you have a demo of a Salesforce org?",
    "Show me an example of leads being worked",
  ];
  for (const q of CLOSED) {
    await t.test(`closed: ${q}`, () => assert.strictEqual(wantsTheDesk(q), false));
  }
  for (const q of OPEN) {
    await t.test(`open: ${q}`, () => assert.strictEqual(wantsTheDesk(q), true));
  }
});

/* ---------------------------------------------------------------- 5 ---- */
test("the vote runs on the visitor's own question when it names two options", async (t) => {
  const DERIVED = [
    ["Which is better for lead assignment, Apex trigger or Flow?", ["Apex trigger", "Flow"]],
    ["Permission sets or profiles?", ["Permission sets", "profiles"]],
    ["Should we expand into the US or stay in Canada?", null],
    ["Rebuild the integration or wrap what is there?", ["Rebuild the integration", "wrap what is there"]],
  ];
  for (const [q, want] of DERIVED) {
    await t.test(q, () => {
      const b = deriveBallot(q);
      if (want === null) {
        /* Long free clauses are not options. Falling back to the stock ballot
           is correct; inventing two is not. */
        assert.ok(!b || b.opts.every((o) => o.split(" ").length <= 4),
          `derived unusable options: ${b && b.opts.join(" / ")}`);
        return;
      }
      assert.ok(b, "no ballot derived");
      /* Array.from: the ballot is built inside the vm realm, so its array has
         that realm's prototype and deepStrictEqual rejects it as "same
         structure but not reference-equal". */
      assert.deepStrictEqual(Array.from(b.opts, (o) => o.toLowerCase()),
        want.map((o) => o.toLowerCase()));
    });
  }
});

test("no ballot is invented from a question with no choice in it", async (t) => {
  for (const q of ["", "hi", "What does this cost?",
                   "We track the whole pipeline in Excel and it is falling apart"]) {
    await t.test(JSON.stringify(q), () => {
      assert.strictEqual(deriveBallot(q), null);
    });
  }
});

/* ---------------------------------------------------------------- 4 ---- */
/* The refusal. assets/overnight-polish-boot.js installs engageLiveReply onto
   window, so it can be run for real rather than inspected. */
function liveReply() {
  const POLISH = read("assets", "overnight-polish-boot.js");
  const doc = {
    readyState: "complete",
    addEventListener() {},
    getElementById: () => null,
    querySelector: () => null,
  };
  const box = {
    window: { __TRIAGE: sandbox.window.__TRIAGE },
    document: doc,
    setTimeout: (fn) => { try { fn(); } catch (e) {} },
    MutationObserver: function () { this.observe = () => {}; },
    console,
  };
  vm.createContext(box);
  vm.runInContext(POLISH, box, { filename: "overnight-polish-boot.js" });
  assert.strictEqual(typeof box.window.engageLiveReply, "function",
    "engageLiveReply was not installed");
  return box.window.engageLiveReply;
}

test("a refusal is in the visitor's words, and keeps the model's own line", async (t) => {
  const engage = liveReply();
  const asked = "Should we expand into the US or stay in Canada?";
  const modelSaid = "That is a business strategy question, not Salesforce work. "
    + "Thank you for visiting our page.";
  const shown = engage(asked, modelSaid, "claude");

  await t.test("no private vocabulary", () => {
    assert.ok(!/time.?lagged/i.test(shown),
      `"time-lagged" is our phrase, not the visitor's: ${shown}`);
  });
  await t.test("the model's own sentence survives", () => {
    assert.ok(shown.indexOf("That is a business strategy question, not Salesforce work.") >= 0,
      `the model's refusal was thrown away: ${shown}`);
  });
  await t.test("it says what IS in scope", () => {
    assert.match(shown, /fixed-scope diagnostic/);
  });
  await t.test("it gives one next step", () => {
    assert.match(shown, /request form at www\.sfdc24\.com\/intake\//);
    assert.doesNotMatch(shown, /abdus|salam/i, 'a reply must not name him (his words, 2026-09-24)');
  });
  await t.test("the goodbye is dropped before the offer", () => {
    /* The prompt closes with "Thank you for visiting our page." Leaving it in
       front of an offer says goodbye and then pitches. The first version of
       the strip matched "Thanks for visiting" and missed this entirely. */
    assert.ok(!/for visiting/i.test(shown),
      `the closer survived in front of the offer: ${shown}`);
  });
  await t.test("the rejected phrase does not ship, even in a comment", () => {
    const polish = read("assets", "overnight-polish-boot.js");
    assert.ok(!/time.?lagged/i.test(polish),
      "this file is served to the browser; rejected copy should not travel "
      + "with its own replacement");
  });
});

/* -------------------------------------------- wiring, not behaviour ---- */
/* deriveBallot and __recredit can each be perfect and never called. These
   assert the call site, because a dead helper is how this page has shipped a
   fix that did nothing before. */
test("the fixes are actually wired into the page", async (t) => {
  await t.test("the vote reads the visitor's question", () => {
    const fn = slice(SRC, "    function putToVote(){", "voteAt += 1;");
    assert.match(fn, /deriveBallot\(window\.__lastQuestion\)/,
      "putToVote no longer derives a ballot from what was asked");
    assert.match(SRC, /window\.__lastQuestion\s*=\s*text/,
      "submit() no longer publishes the question the vote reads");
  });
  await t.test("the board is recredited from who actually answered", () => {
    assert.match(SRC, /window\.__recredit\(res\.by\)/,
      "nothing reconciles the routed guess on the board with the real author");
  });
  await t.test("the boot script gates the desk on wantsTheDesk", () => {
    assert.match(BOOT, /q\.trim\(\) && wantsTheDesk\(q\)/,
      "the desk is being staged off SF_DESK again, so a noun reopens it");
  });
  await t.test("the estimator asks triage what a decision is", () => {
    assert.match(SRC, /__TRIAGE\.isDecision\(question\)/,
      "maybeEstimate no longer defers to triage's decision test");
  });
});
