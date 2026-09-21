/* A decision question must reach an agent, and a keyword must still answer.
 *
 * Measured 2026-09-20 against this file and the live page: of 30 realistic
 * decision questions, ELEVEN were intercepted by a canned answer or a game
 * menu. The rules were not wrong - "what does it cost" really should get the
 * pricing answer - they were too eager, because one word anywhere in a
 * sentence fired them.
 *
 *   "Role-based sharing or territory management?"   -> the location blurb
 *                                                      (matched "based")
 *   "Is it worth the cost to migrate from HubSpot?" -> the pricing blurb
 *   "Should we play it safe and stay on our CRM?"   -> a game menu, no answer
 *
 * Both halves are asserted here, and the second half is the one that makes
 * this test worth having: a fix that sends "hi" or "what does it cost" to a
 * model is worse than the bug, because the whole reason assets/triage.py
 * exists is that those must never cost a token.
 *
 * Run: node --test tests/decision_questions_reach_an_agent.cjs
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const TRIAGE = path.join(__dirname, "..", "assets", "triage.js");

function loadTriage() {
  const sandbox = { window: {}, console, Intl, Date };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(TRIAGE, "utf8"), sandbox, { filename: "triage.js" });
  const T = sandbox.window.__TRIAGE;
  assert.ok(T && typeof T.ask === "function", "triage.js must expose window.__TRIAGE.ask");
  return T;
}

/* Routed = no local answer and no handTo, so the page asks an agent. */
function isRouted(r) {
  return !!r && !r.answer && !r.handTo;
}

const INTERCEPTED = [
  ["Role-based sharing or territory management?", "matched 'based'"],
  ["Is it worth the cost to migrate from HubSpot?", "matched 'cost'"],
  ["Should we play it safe and stay on our current CRM?", "matched 'play'"],
  ["Should we automate our quote-to-cash process or leave it manual?", "matched 'quote'"],
  ["Our win rate is dropping - should we change the sales process or the CRM?", "matched 'rate'"],
  ["Which is better for lead assignment, Apex trigger or Flow?", "plain decision"],
  ["Should we expand into the US or stay in Canada?", "plain decision"],
];

const MUST_STILL_ANSWER_LOCALLY = [
  ["hi", "greeting", "a greeting must never cost a token"],
  ["what does it cost?", "price", "a real pricing ask still gets the pricing answer"],
  ["how much do you charge", "price", "same, phrased differently"],
  ["where are you based?", "location", "a real location ask still answers"],
  ["can we play a game?", "game", "a real game ask still offers the game"],
];

test("a decision question is never eaten by a keyword rule", async (t) => {
  const T = loadTriage();
  for (const [q, why] of INTERCEPTED) {
    await t.test(q, () => {
      const r = T.ask(q) || {};
      assert.ok(isRouted(r),
        `"${q}" was answered locally (${why}); id=${r.id} handTo=${r.handTo || "-"}`);
    });
  }
});

test("the local answers this file exists for still work", async (t) => {
  const T = loadTriage();
  for (const [q, id, why] of MUST_STILL_ANSWER_LOCALLY) {
    await t.test(`${q} -> ${id}`, () => {
      const r = T.ask(q) || {};
      assert.strictEqual(r.id, id, `${why} (got id=${r.id})`);
    });
  }
});

test("plurals route to the specialist, not the rotation", async (t) => {
  const T = loadTriage();
  /* "permission set" matched and "permission sets" did not, so
     "permission sets or profiles?" went to the rotation and on to the slow
     provider. The routed name is not asserted - only that a routing decision
     was reached with a named agent. */
  for (const q of ["Permission sets or profiles?",
                   "Should we use validation rules or Flow for this?"]) {
    await t.test(q, () => {
      const r = T.ask(q) || {};
      assert.ok(isRouted(r), `"${q}" was answered locally instead of routed`);
      assert.ok(r.routeTo, `"${q}" routed to nobody`);
    });
  }
});

test("the guard needs a decision word AND a real sentence", async (t) => {
  const T = loadTriage();
  /* Both halves matter. Without the word count, a bare "cost?" would stop
     getting the pricing answer; without the word, every long question would
     bypass the local rules. */
  await t.test("short keyword asks stay local", () => {
    assert.strictEqual((T.ask("cost?") || {}).id, "price");
  });
  await t.test("a long question with no decision word stays local", () => {
    const r = T.ask("please tell me roughly what the cost of this whole thing is") || {};
    assert.strictEqual(r.id, "price");
  });
});
