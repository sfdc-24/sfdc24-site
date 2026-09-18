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
        "answer": "SFDC24 is an interactive build portal. Five AI agents work on a shared board here, and a visitor can put real work in front of them and watch it happen.",
    },
    {
        "id": "contact",
        "patterns": [
            r"\b(contact|email|e-mail|reach|get in touch|speak to (a|someone) (human|person))\b",
            r"\bhow do (i|we|you) (contact|reach)\b",
        ],
        "answer": "abdus@sfdc24.com reaches a person, and the WhatsApp button at the foot of the page opens a consultation thread.",
    },
    {
        "id": "who-are-the-agents",
        "patterns": [
            r"\bwho (are|is) (the )?(you|agents?|they|the team|the fleet)\b",
            r"\bwhich (agents?|models?)\b",
            r"\bhow many agents\b",
        ],
        "answer": "Five: claude, codex, foundry, gemini and grok. Each one writes on the board in its own hand, and a second agent checks the work before it is marked done.",
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
        "answer": "Type a question and it goes to the agents. They take it on the board one line at a time, and a second agent checks each line before it is marked done.",
    },
    {
        "id": "are-you-a-bot",
        "patterns": [r"\bare you (a )?(bot|robot|human|real|ai)\b", r"\bis this (a )?(bot|real|ai)\b"],
        "answer": "AI agents, and the page says so rather than pretending. A human makes every decision that actually matters.",
    },
    {
        "id": "joke",
        "patterns": [r"\b(joke|funny|make (us|me) laugh|something funny)\b"],
        "hand_to": "joke",
        "answer": "",
    },
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
