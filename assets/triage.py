#!/usr/bin/env python3
"""First-line triage for the sfdc24.com board, and the generator for triage.js.

WHY THIS IS PYTHON AND NOT JUST JAVASCRIPT
------------------------------------------
Asked for on 2026-09-18, verbatim:

    "get python in the page so its not dead and not constantly using tokens"
    "python should be first in line to ask simple questions process and
     handoff to others"

Both halves matter and they pull the same way. A page whose only answer path
is a model call is dead when the credential is dead, slow when the network is
slow, and costs a token every time somebody types "hi". Most of what a visitor
opens with is not a question that needs a model at all - it is a greeting, or
"what is this", or "how do you get in touch".

So Python answers those, instantly and for nothing, and hands everything else
to the agents. That is the "first in line ... and handoff" shape exactly.

WHY IT EMITS A FILE RATHER THAN SERVING REQUESTS
-------------------------------------------------
sfdc24.com is a static GitHub Pages site. There is no Python process to call.
Pretending otherwise would be the kind of thing this whole repository exists
to stop - so the rules live here, in Python, and `python assets/triage.py`
compiles them to assets/triage.js, which the page loads. The answers a visitor
reads were written and shaped by this file; nothing claims a live interpreter.

Re-run this after editing RULES, and commit both files together.

THE COPY RULES BELOW ARE NOT OPTIONAL
--------------------------------------
Every ANSWER here is rendered into the page, so it is subject to the same
constraints as any other copy, and two of them have drawn blood before:

  1. NO FIRST-PERSON SINGULAR. tests/site_positioning.cjs bans /\bI\b/,
     /\bI'/, /\bmy\b/i, /\bmine\b/i, /\bme\b/i and /\bmyself\b/i - including
     inside script string literals. Note `me` is case-insensitive and
     word-bounded: "tell me", "let me" and "for me" are all build failures.

  2. NO UNREGISTERED ORG NOUNS. tests/claim_surfaces.cjs puts any sentence
     containing salesforce / org / tenant / instance / environment into a risk
     class that must be listed verbatim in tests/capabilities.json first.

THESE ANSWERS ESCAPE BOTH GUARDS, AND THAT IS WHY THE RULES ARE RESTATED HERE.
site_positioning reads index.html's own bytes, so an external file is not in
its view; claim_surfaces reads the rendered DOM, and a triage answer only
renders after somebody types something, which the honesty spec never does. So
nothing would fail if this file broke either rule. It is held to them anyway,
because a guard I can walk around is not a reason to write worse copy - it is
the exact situation where writing worse copy goes unnoticed.
"""

from __future__ import annotations

import json
import re
import sys
from datetime import date, timezone, datetime
from pathlib import Path

OUT = Path(__file__).resolve().parent / "triage.js"

# ---------------------------------------------------------------------------
# The rules. Order matters: the first match wins, so put the specific before
# the general. `patterns` are matched case-insensitively against the whole
# question; they are deliberately narrow, because a wrong instant answer is far
# worse than a handoff that costs a token.
# ---------------------------------------------------------------------------
RULES: list[dict] = [
    {
        "id": "greeting",
        "patterns": [r"^\s*(hi|hey|hello|yo|howdy|good (morning|afternoon|evening))\b[\s!.?]*$"],
        "answer": "Hello. Ask anything here, or press one of the buttons to watch the agents do something.",
    },
    {
        "id": "thanks",
        "patterns": [r"^\s*(thanks|thank you|ta|cheers|much appreciated)\b[\s!.?]*$"],
        "answer": "Any time. Anything else worth a look?",
    },
    {
        "id": "what-is-this",
        "patterns": [
            r"\bwhat (is|are) (this|sfdc24|the site|it)\b",
            r"\bwhat does (this|sfdc24|it) do\b",
            r"\bwhat'?s this\b",
        ],
        # No org nouns: this sentence would otherwise need registering.
        #
        # REWRITTEN 2026-09-18. It used to end "a visitor can put real work in
        # front of them and watch it happen". Reading wakeBoard() settles what
        # actually happens: the typed question IS pushed onto the board in the
        # visitor's own chalk, and then the WORK fixture plays out beside it.
        # The agents do not act on the question. "Real work in front of them"
        # was therefore a capability claim, and a false one.
        # THE COUNT IS GONE FROM THIS SENTENCE, ON PURPOSE.
        #
        # It read "Twelve local rules" while eleven were defined, here and in
        # the generated file. The joke rule was deleted, taking twelve to
        # eleven, and this one sentence did not follow. A visitor saw it on
        # 2026-09-18 next to the page's own console line, which says
        # "11 rules, first in line" - twelve and eleven in a single frame.
        #
        # The console number is DERIVED (window.__TRIAGE.count). This one was
        # ASSERTED in prose. That is the whole reason they drifted, and it is
        # why the number is now simply not stated: a hardcoded count in copy is
        # a fact with no mechanism keeping it true, and the next rule added or
        # removed would break it again in exactly the same way.
        "answer": "SFDC24 is an interactive build portal. Local rules answer the simple questions right here with no model call, anything harder goes to a model, and whatever you type goes up on the board in your own hand.",
    },
    {
        "id": "contact",
        "patterns": [
            r"\b(contact|email|e-mail|reach|get in touch|speak to (a|someone) (human|person))\b",
            r"\bhow do (i|we|you) (contact|reach)\b",
        ],
        # STALE ANSWER FIXED 2026-09-18. This used to end "...and the WhatsApp
        # button at the foot of the page opens a consultation thread." That
        # button was removed on instruction earlier the same day, so Python was
        # confidently telling visitors about a control that is not on the page.
        #
        # Worth recording because of HOW it was found: not by a guard. Every
        # suite stayed green, because no test asserts that an answer describes
        # the page it is served from. It surfaced only when the rules were
        # dumped verbatim to brief another model. A rules table is copy, and
        # copy goes stale the moment the thing it describes moves.
        "answer": "abdus@sfdc24.com reaches a person, and a reply usually comes back the same day.",
    },
    {
        "id": "who-are-the-agents",
        "patterns": [
            r"\bwho (are|is) (the )?(you|agents?|they|the team|the fleet)\b",
            r"\bwhich (agents?|models?)\b",
            r"\bhow many agents\b",
        ],
        # SPLIT LIVE FROM FIXTURE, 2026-09-18. This used to say each of the five
        # "writes on the board in its own hand, and a second agent checks the
        # work" with no indication of which part a visitor is actually looking
        # at. Both halves are true of different things, and running them
        # together implied the five take the question you typed. They do not.
        #
        # The five on the board are a labelled illustration. The check that runs
        # on YOUR question is real and happens on this page. Naming which is
        # which is the whole difference between a demonstration and a claim.
        "answer": "Five: claude, codex, foundry, gemini and grok. Meet the agents shows them working a shared board, which is a labelled illustration. A question typed here is answered live and then checked in front of you.",
    },
    {
        "id": "price",
        "patterns": [
            r"\b(price|pricing|cost|how much|rate|quote|fees?|budget)\b",
        ],
        "answer": "The first piece of work is a fixed-scope diagnostic that ends in a written recommendation, and it commits you to nothing. Email for the current figure.",
    },
    {
        "id": "location",
        "patterns": [r"\bwhere (are|is) (you|this|sfdc24)\b", r"\b(location|based|located)\b"],
        "answer": "The Toronto area, working with clients wherever they are.",
    },
    {
        "id": "how-does-this-work",
        "patterns": [
            r"\bhow does (this|it|the board|sfdc24) work\b",
            r"\bhow do you work\b",
        ],
        # REWRITTEN 2026-09-18, and this one was defended before it was fixed.
        # "it goes to the agents" reads as the agents working ON the question.
        # They do not: wakeBoard() posts the visitor line, then walks the WORK
        # fixture, which is unrelated to whatever was asked. The write-then-check
        # sequence on screen is real and is worth describing; attributing it to
        # the visitor's question is not.
        "answer": "Type a question. A local rule answers it right here when one fits, with no model call. Anything else goes to a model. Your line goes up on the board, and the lines beside it are a labelled illustration of how the work is checked.",
    },
    {
        "id": "are-you-a-bot",
        "patterns": [r"\bare you (a )?(bot|robot|human|real|ai)\b", r"\bis this (a )?(bot|real|ai)\b"],
        "answer": "AI agents, and the page says so rather than pretending. A human makes every decision that actually matters.",
    },
    # THE JOKE RULE IS GONE, 2026-09-18, as Grok's item 3 - with one deviation
    # reported back rather than taken silently. Grok wanted a joke request
    # routed to the GAME chooser, on the reasoning that the joke button was
    # killed and dead routes rot. Asking for a joke and being handed a chess
    # board is a non-sequitur, so instead the rule is removed entirely and a
    # joke falls through to a model like any other miss. That answers the
    # person, which the chooser would not have.
    #
    # Removing the rule rather than repointing it also keeps this table honest:
    # every remaining entry either answers or opens something that matches what
    # was asked for.
    {
        "id": "game",
        "patterns": [r"\b(play|game|checkers|chess|bored)\b"],
        "hand_to": "game",
        "answer": "",
    },
    {
        "id": "music",
        "patterns": [r"\b(music|piano|mozart|something relaxing|play something)\b"],
        "hand_to": "piano",
        "answer": "",
    },
]

# Answers are checked against the same copy rules the site enforces, here,
# at build time - so a bad line fails the generator instead of shipping.
FIRST_PERSON = [
    re.compile(r"\bI\b"),
    re.compile(r"\bI'"),
    re.compile(r"\bmy\b", re.I),
    re.compile(r"\bmine\b", re.I),
    re.compile(r"\bme\b", re.I),
    re.compile(r"\bmyself\b", re.I),
]
ORG_NOUN = re.compile(r"\b(salesforce|orgs?|tenants?|instances?|environments?)\b", re.I)

# CONTROLS THAT HAVE BEEN ON THIS PAGE AND ARE NOT ANY MORE.
#
# An answer naming one of these tells a visitor to press something that is not
# there. That shipped: the contact rule pointed at a WhatsApp button for hours
# after it was removed, and every suite stayed green, because nothing in this
# repository asserts that copy describes the page it is served from.
#
# A general "copy matches the DOM" oracle is not buildable. A FINITE list of
# controls known to have been removed is, and it catches exactly the failure
# that happened. Add to it whenever a control comes off the page - that is now
# part of removing one.
REMOVED_CONTROLS = (
    "WhatsApp",
    "Talk instead",
    "Send button",
    "pipeline link",
    "joke button",
    "the chips",
)


def check(rules: list[dict]) -> list[str]:
    """Return every copy problem. Empty list means the rules may ship."""
    problems: list[str] = []
    for rule in rules:
        text = rule.get("answer", "")
        if not text:
            continue
        for pattern in FIRST_PERSON:
            if pattern.search(text):
                problems.append(
                    f"{rule['id']}: first-person singular ({pattern.pattern}) in: {text}"
                )
        if ORG_NOUN.search(text):
            problems.append(
                f"{rule['id']}: mentions an org noun, so it must be registered "
                f"verbatim in tests/capabilities.json first: {text}"
            )
        for gone in REMOVED_CONTROLS:
            if gone.lower() in text.lower():
                problems.append(
                    f"{rule['id']}: names \"{gone}\", which is no longer on the "
                    f"page. Refusing to generate copy that sends a visitor to a "
                    f"control that does not exist: {text}"
                )
        for pattern in rule["patterns"]:
            try:
                re.compile(pattern)
            except re.error as exc:
                problems.append(f"{rule['id']}: bad pattern {pattern!r}: {exc}")
    return problems


BANNER = """\
/* GENERATED BY assets/triage.py - DO NOT EDIT THIS FILE BY HAND.
 *
 * Python is first in line on this page. It answers the questions that do not
 * need a model - a greeting, "what is this", how to get in touch - instantly,
 * offline, and for no tokens at all, then hands everything else to the agents.
 *
 * "get python in the page so its not dead and not constantly using tokens"
 * "python should be first in line to ask simple questions process and handoff
 *  to others"                                        - 2026-09-18
 *
 * Built %(built)s from %(count)d rules. Edit assets/triage.py and re-run it.
 */
"""


def emit(rules: list[dict]) -> str:
    payload = {
        "built": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%SZ"),
        "rules": [
            {
                "id": r["id"],
                "patterns": r["patterns"],
                "answer": r.get("answer", ""),
                "handTo": r.get("hand_to", ""),
            }
            for r in rules
        ],
    }
    banner = BANNER % {"built": payload["built"], "count": len(rules)}
    return (
        banner
        + "(function(){\n"
        + '  "use strict";\n'
        + "  var DATA = " + json.dumps(payload, indent=2, ensure_ascii=False) + ";\n"
        + """
  /* Compiled once, not per keystroke. */
  var COMPILED = [];
  for (var i = 0; i < DATA.rules.length; i++) {
    var rule = DATA.rules[i];
    var res = [];
    for (var j = 0; j < rule.patterns.length; j++) {
      try { res.push(new RegExp(rule.patterns[j], "i")); } catch (e) {}
    }
    COMPILED.push({ id: rule.id, res: res, answer: rule.answer, handTo: rule.handTo });
  }

  /* Returns an answer, a handoff, or null. NULL IS THE IMPORTANT ONE: it means
     Python has no confident answer and the question belongs to the agents.
     Guessing here would be worse than costing a token. */
  function ask(text) {
    var q = String(text == null ? "" : text);
    if (!q.trim()) return null;
    for (var i = 0; i < COMPILED.length; i++) {
      var rule = COMPILED[i];
      for (var j = 0; j < rule.res.length; j++) {
        if (rule.res[j].test(q)) {
          return { id: rule.id, answer: rule.answer, handTo: rule.handTo, by: "python" };
        }
      }
    }
    return null;
  }

  window.__TRIAGE = { built: DATA.built, count: COMPILED.length, ask: ask };
})();
"""
    )


def main() -> int:
    problems = check(RULES)
    if problems:
        print("triage.py: the rules break the site's own copy constraints:", file=sys.stderr)
        for p in problems:
            print("  " + p, file=sys.stderr)
        return 1
    OUT.write_text(emit(RULES), encoding="utf-8", newline="\n")
    print(f"wrote {OUT} - {len(RULES)} rules, checked clean")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
