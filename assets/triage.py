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
# ---------------------------------------------------------------------------
# A DECISION-SHAPED QUESTION IS NEVER A KEYWORD.
#
# Measured 2026-09-20 against the live page and this file: of 30 realistic
# decision questions, 11 were intercepted by a canned answer or a game.
#
#   "Role-based sharing or territory management?"   -> the location blurb
#                                                      (matched "based")
#   "Is it worth the cost to migrate from HubSpot?" -> the pricing blurb
#   "Should we play it safe and stay on our CRM?"   -> a game menu, no answer
#   "automate our quote-to-cash"                    -> the pricing blurb
#   "our win rate is dropping"                      -> the pricing blurb
#
# It is a concierge who hears "rate" and hands you the room-rate card when you
# asked about the exchange rate. The rules are not wrong - "what does it cost"
# really should get the pricing answer - they are just too eager, because a
# single word anywhere in a sentence fires them.
#
# So the narrow rules carry not_on_decision, and a question that looks like a
# decision skips them and goes to an agent. Requiring FIVE words as well as a
# decision word keeps "hi or hey" and a bare "cost?" on the fast local path,
# which is the whole reason this file exists.
DECISION_RE = r"\b(should|shall|which|vs|versus|worth|better|either)\b|\s+or \w"
DECISION_MIN_WORDS = 5

RULES: list[dict] = [
    {
        "id": "greeting",
        "patterns": [r"^\s*(hi|hey|hello|yo|howdy|good (morning|afternoon|evening))\b[\s!.?]*$"],
        "answer": "Hi. What can we help you with?",
    },
    {
        "id": "thanks",
        "patterns": [r"^\s*(thanks|thank you|ta|cheers|much appreciated)\b[\s!.?]*$"],
        "answer": "Any time. Anything else worth a look?",
    },
    # Product comments about the site itself — not a Salesforce problem,
    # and not a sizing ask. Must sit before `clarify`, because a lone
    # "roadmap" is short enough to look like a one-word shrug.
    {
        "id": "whats-next",
        "patterns": [
            r"\bwhat'?s next\b",
            r"\bwhats next\b",
            r"\bwhat is next\b",
            r"\b(much|looks|way) better\b",
            r"\b(next up|up next)\b",
            r"\b(roadmap|what'?s coming|what is coming)\b",
            r"\bchallenge prep\b",
        ],
        "answer": "This release describes shipped work, not a countdown to the next deployment. History is the release log. Method explains the approach and includes a session-only preference exercise.",
    },
    {
        "id": "public-builds",
        # Only the generic public-site question. Client-specific and compound
        # questions must continue to the existing routing path.
        "patterns": [r"^\s*what (?:have you (?:actually )?built|did you (?:actually )?build)[?.!\s]*$"],
        "answer": "The public site includes a working question-and-answer page, a preference exercise on Method, and a release timeline on History. The preference exercise gives a session-only tally, not a fitted model or a recommendation. These are working site features, not proof of a completed client deployment.",
    },
    {
        "id": "what-is-this",
        "patterns": [
            r"^\s*what does this site do[?.!\s]*$",
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
        "answer": "Python is the gatekeeper on this page. Simple asks are answered here with no model call. Harder work hands off to Grok for product and orchestration, or Claude for Apex and Lightning implementation.",
    },
    # FACTS — cheap Python courtesy. One short line. No invite. No fleet.
    # Decision-engine still owns time-lagged work; these never escalate.
    # Sit before `price` so "5 miles in km" is not read as a quote ask.
    {
        "id": "fact-moon",
        "patterns": [
            r"\bhow far (is|away is) (the )?moon\b",
            r"\b(distance|how far) (to|from) (the )?moon\b",
            r"\bmoon('?s)? (distance|how far)\b",
            r"\bearth[-–— ]moon (distance|how far)\b",
        ],
        "answer": "About 384,400 km (mean Earth–Moon).",
    },
    {
        "id": "fact-light",
        "patterns": [
            r"\bspeed of light\b",
            r"\bhow fast (does|is) light\b",
        ],
        "answer": "299,792 km/s in vacuum.",
    },
    {
        "id": "fact-sound",
        "patterns": [
            r"\bspeed of sound\b",
            r"\bhow fast (does|is) sound\b",
        ],
        "answer": "About 343 m/s in dry air at 20°C.",
    },
    {
        "id": "fact-water-boil",
        "patterns": [r"\bboiling point of water\b"],
        "answer": "100°C (212°F) at 1 atm.",
    },
    {
        "id": "fact-water-freeze",
        "patterns": [r"\bfreezing point of water\b"],
        "answer": "0°C (32°F) at 1 atm.",
    },
    {
        "id": "fact-pi",
        "patterns": [
            r"\bwhat('?s| is) (the )?(value of )?pi\b",
            r"\bvalue of pi\b",
        ],
        "answer": "3.14159 (π, to five decimals).",
    },
    {
        "id": "fact-gravity",
        "patterns": [
            r"\bstandard gravity\b",
            r"\bacceleration (due to )?gravity\b",
            r"\bwhat is (standard )?g\b",
        ],
        "answer": "9.81 m/s² (standard g).",
    },
    {
        "id": "fact-light-year",
        "patterns": [r"\b(how (long|far) is )?(a )?light[ -]?year\b"],
        "answer": "About 9.46 trillion km.",
    },
    {
        "id": "fact-earth-circ",
        "patterns": [r"\b(earth|earth'?s) (circumference|equator)\b"],
        "answer": "About 40,075 km (equator).",
    },
    {
        "id": "convert",
        "patterns": [
            r"\b\d+(?:\.\d+)?\s*(km|kilometers?|miles?|mi|kg|pounds?|lbs?|celsius|fahrenheit|[cCfF]|meters?|metres?|m|feet|ft|inches|in|cm)\s+(in|to|into|as)\s+",
            r"\bhow many\s+(km|kilometers?|miles?|mi|meters?|metres?|feet|ft|inches|in|kg|pounds?|lbs?|cm)\s+in\b",
            r"\bconvert\s+\d+",
        ],
        "runtime": "unit_convert",
        "answer": "",
    },
    {
        "id": "price",
        "not_on_decision": True,
        "patterns": [
            r"\b(price|pricing|cost|how much|rate|quote|fees?|budget)\b",
        ],
        "answer": "The first piece of work is a fixed-scope diagnostic that ends in a written recommendation, and it commits you to nothing. Email for the current figure.",
    },
    {
        "id": "location",
        "not_on_decision": True,
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
        "answer": "Type a question. Python triages it here. Simple asks get a local answer with no model call. Harder asks hand off to Grok or Claude, and the live flow above lights the path as it happens.",
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
        "not_on_decision": True,
        "patterns": [r"\b(play|game|checkers|chess|bored)\b"],
        "hand_to": "game",
        "answer": "",
    },
    {
        "id": "music",
        "not_on_decision": True,
        "patterns": [r"\b(music|piano|mozart|something relaxing|play something)\b"],
        "hand_to": "piano",
        "answer": "",
    },
    {
        "id": "clarify",
        "patterns": [
            r"^[\\w\'\\-]{1,12}$",
            r"^(this|that|it|stuff|thing|help|more|idk|hmm+|\\.\\.\\.|\\?+)$",
        ],
        "answer": "Could you say a bit more about what you are looking for?",
    },
    # THE CLOCK RULES ANSWER AT RUNTIME, AND THAT IS THE WHOLE POINT.
    #
    # Asked for 2026-09-18 by the product lead: a date rule whose answer is
    # "baked RUNTIME JS in emit() using the visitor clock America/Toronto, not
    # a build-time string".
    #
    # A date written into `answer` here would be the date this file was last
    # run. The page is static and cached by GitHub Pages, so that string can be
    # days stale while looking exactly as confident as a correct one - the same
    # failure shape as the hardcoded rule count that drifted from eleven to
    # twelve, and as a triage answer naming a button that had been removed. A
    # fact with no mechanism keeping it true does not stay true.
    #
    # So these rules carry NO answer text at all. `runtime` names one of a
    # closed set of answerers compiled into triage.js, which reads the clock in
    # the visitor's own browser and formats it for America/Toronto - the zone
    # the location rule above already commits this site to.
    {
        "id": "today",
        "patterns": [
            r"\bwhat('?s| is)?\s+(the\s+)?(today'?s\s+)?date\b",
            r"\bwhat day is it\b",
            r"\bwhat'?s today\b",
            r"\btoday'?s date\b",
            r"\bwhat is today\b",
        ],
        "runtime": "toronto_date",
        "answer": "",
    },
    {
        "id": "time",
        "patterns": [
            r"\bwhat time is it\b",
            r"\bwhat'?s the time\b",
            r"\b(current|local) time\b",
        ],
        "runtime": "toronto_time",
        "answer": "",
    },
    # Orientation, and deliberately the only new copy rule in this change.
    # "Add other trivial self-answers where sensible" was asked for too, and the
    # tempting ones - are you hiring, how long does it take, do you work with X
    # - are all claims about a person or a commitment nobody has made. Those are
    # not trivia, and answering them from a table would only make a guess arrive
    # faster. This one describes the page it is served from and nothing else.
    {
        "id": "help",
        "patterns": [
            r"^\s*(help|options?)\b[\s!.?]*$",
            r"\bwhat can (you|this) do\b",
            r"\bwhat do you do here\b",
        ],
        "answer": "Type a question. Python answers the simple ones here. Harder asks hand off to Grok or Claude. abdus@sfdc24.com reaches a person.",
    },
]

# ---------------------------------------------------------------------------
# THE GATEKEEPER: WHO GETS A QUESTION PYTHON CANNOT ANSWER.
#
# Asked for 2026-09-18: "on a miss return routeTo ONE reachable CREW member
# (round-robin/keyword) - no fan-out to all five."
#
# Before this, a miss returned null and the page woke the whole board: the
# visitor's line plus eight fixture tasks played out across every hand, which
# reads as five agents working on what was just typed. They are not. One agent
# taking one line is both the smaller animation and the true one.
#
# TWO RULES ABOUT THIS TABLE.
#
#   1. These are CREW names, not model names. Which model actually answers is
#      the backend's decision, and this page does not claim to know it.
#   2. The crew list is NOT baked in. The page owns who is reachable - an agent
#      without a credential is drawn "no key" and must never be handed work -
#      so it calls setCrew() with the live roster, and routing is resolved
#      against that. Baking five names here is how a question gets routed to an
#      agent that went offline nine days ago.
# ---------------------------------------------------------------------------
CREW_DEFAULT = ["claude", "codex", "foundry", "gemini", "grok"]  # keywords; miss uses route() winner, not a hard-coded grok

# Keyword -> weight, per agent. Zero everywhere means no signal, and no signal
# means round-robin rather than a favourite: a constant bias would park every
# unmatched question on one agent and still call itself routing.
ROUTING: dict[str, list[tuple[str, int]]] = {
    "claude": [
        (r"\b(apex|lwc|lightning|soql|validation rules?|profiles?|permission sets?)\b", 3),
        (r"\b(migration|integration|enterprise|rollout)\b", 1),
    ],
    "codex": [
        (r"\b(code|coding|bug|patch|refactor|typescript|javascript|python|html|css|repo|github|pull request|commit|test suite|playwright)\b", 3),
        (r"\b(sprint|backlog|ticket|acceptance criteria)\b", 2),
    ],
    "foundry": [
        (r"\b(azure|foundry|deployment|scoring|score|grade|grading|benchmark)\b", 3),
    ],
    "gemini": [
        (r"\b(search|research|compare|survey|architecture|architect|diagram|options?)\b", 3),
    ],
    "grok": [
        (r"\b(product|roadmap|strategy|positioning|messaging|pricing|market)\b", 3),
        (r"\b(salesforce|sfdc|crm|help me with|can you help)\b", 2),
    ],
}

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


# The closed set of runtime answerers compiled into triage.js. A rule naming
# anything else would generate a call to a function that does not exist, and
# the visitor would see a rule match with an empty answer - which the page
# would then treat as a handoff to nobody.
RUNTIME_ANSWERERS = ("toronto_date", "toronto_time", "unit_convert")


def check(rules: list[dict]) -> list[str]:
    """Return every copy problem. Empty list means the rules may ship."""
    problems: list[str] = []
    for rule in rules:
        text = rule.get("answer", "")

        # EVERY RULE HAS TO DO SOMETHING. A rule with no answer, no handoff and
        # no runtime answerer matches the question, returns an empty string, and
        # the page falls through to neither an answer nor the agents - the
        # visitor gets silence from a rule that fired.
        if not text and not rule.get("hand_to") and not rule.get("runtime"):
            problems.append(
                f"{rule['id']}: matches but has no answer, no hand_to and no runtime"
            )
        if rule.get("runtime") and rule["runtime"] not in RUNTIME_ANSWERERS:
            problems.append(
                f"{rule['id']}: runtime {rule['runtime']!r} is not one of "
                f"{', '.join(RUNTIME_ANSWERERS)} - triage.js has no such answerer"
            )

        # PATTERNS ARE CHECKED FOR EVERY RULE, answer or not. This loop used to
        # sit under `if not text: continue`, so the two handoff rules - game and
        # music, the ones with no copy - had their regexes compiled by nothing
        # until a visitor typed. A bad pattern there is caught at build time
        # now, which is the entire reason this file has a check step.
        for pattern in rule["patterns"]:
            try:
                re.compile(pattern)
            except re.error as exc:
                problems.append(f"{rule['id']}: bad pattern {pattern!r}: {exc}")

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
    return problems


def check_routing(routing: dict, crew: list[str]) -> list[str]:
    """The gatekeeper's own build-time check. A route to a name the page does
    not have is a question handed to nobody, and it would fail silently."""
    problems: list[str] = []
    for who, entries in routing.items():
        if who not in crew:
            problems.append(f"routing: {who!r} is not in CREW_DEFAULT {crew}")
        for pattern, weight in entries:
            try:
                re.compile(pattern)
            except re.error as exc:
                problems.append(f"routing {who}: bad pattern {pattern!r}: {exc}")
            if not isinstance(weight, int) or weight <= 0:
                problems.append(f"routing {who}: weight {weight!r} must be a positive int")
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
                "runtime": r.get("runtime", ""),
                "notOnDecision": bool(r.get("not_on_decision")),
            }
            for r in rules
        ],
        "decision": {"re": DECISION_RE, "minWords": DECISION_MIN_WORDS},
        "crew": list(CREW_DEFAULT),
        "routing": {
            who: [[pattern, weight] for pattern, weight in entries]
            for who, entries in ROUTING.items()
        },
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
    COMPILED.push({
      id: rule.id, res: res, answer: rule.answer,
      handTo: rule.handTo, runtime: rule.runtime,
      notOnDecision: rule.notOnDecision
    });
  }

  /* ── THE CLOCK ────────────────────────────────────────────────────────────
     Read from the VISITOR'S browser, formatted for America/Toronto. Nothing
     about the date is compiled into this file: a static page served from a CDN
     can be days older than the reader, and a stale date is indistinguishable
     from a correct one until somebody checks.

     Returns null rather than a guess when the environment has no Intl with
     timezone support. A wrong date stated confidently is worse than a question
     handed to an agent. */
  function torontoParts() {
    try {
      var now = new Date();
      var opts = { timeZone: "America/Toronto" };
      var fmt = function (extra) {
        var o = { timeZone: opts.timeZone };
        for (var k in extra) { if (Object.prototype.hasOwnProperty.call(extra, k)) o[k] = extra[k]; }
        return new Intl.DateTimeFormat("en-CA", o).format(now);
      };
      return {
        weekday: fmt({ weekday: "long" }),
        date: fmt({ year: "numeric", month: "long", day: "numeric" }),
        time: fmt({ hour: "numeric", minute: "2-digit" })
      };
    } catch (e) { return null; }
  }

  var UNIT_ALIASES = {
    km: "km", kilometer: "km", kilometers: "km",
    mi: "mi", mile: "mi", miles: "mi",
    m: "m", meter: "m", meters: "m", metre: "m", metres: "m",
    ft: "ft", foot: "ft", feet: "ft",
    "in": "in", inch: "in", inches: "in",
    cm: "cm", centimeter: "cm", centimeters: "cm",
    kg: "kg", kilogram: "kg", kilograms: "kg",
    lb: "lb", lbs: "lb", pound: "lb", pounds: "lb",
    c: "c", celsius: "c",
    f: "f", fahrenheit: "f"
  };
  var LEN_M = { km: 1000, mi: 1609.344, m: 1, ft: 0.3048, "in": 0.0254, cm: 0.01 };
  var MASS_KG = { kg: 1, lb: 0.45359237 };

  function canonUnit(s) {
    return UNIT_ALIASES[String(s || "").toLowerCase().replace(/°/g, "")] || "";
  }
  function fmtQty(n) {
    if (!isFinite(n)) return "";
    var a = Math.abs(n);
    if (a >= 100) return String(Math.round(n));
    if (a >= 10) return String(Math.round(n * 10) / 10);
    return String(Math.round(n * 1000) / 1000);
  }
  function convertPair(n, fromU, toU) {
    if (!fromU || !toU) return "";
    if (fromU === "c" && toU === "f") return fmtQty(n * 9 / 5 + 32) + "°F.";
    if (fromU === "f" && toU === "c") return fmtQty((n - 32) * 5 / 9) + "°C.";
    if (LEN_M[fromU] && LEN_M[toU]) return fmtQty(n * LEN_M[fromU] / LEN_M[toU]) + " " + toU + ".";
    if (MASS_KG[fromU] && MASS_KG[toU]) return fmtQty(n * MASS_KG[fromU] / MASS_KG[toU]) + " " + toU + ".";
    return "";
  }
  function convertUnits(q) {
    var text = String(q || "").toLowerCase().replace(/°/g, " ");
    var howManyN = text.match(/how many\s+([a-z]+)\s+in\s+(\d+(?:\.\d+)?)\s*([a-z]+)/);
    if (howManyN) {
      var a = convertPair(parseFloat(howManyN[2]), canonUnit(howManyN[3]), canonUnit(howManyN[1]));
      if (a) return a;
    }
    var howMany = text.match(/how many\s+([a-z]+)\s+in\s+(?:a|one|1)?\s*([a-z]+)/);
    if (howMany) {
      var b = convertPair(1, canonUnit(howMany[2]), canonUnit(howMany[1]));
      if (b) return b;
    }
    var pair = text.match(/(\d+(?:\.\d+)?)\s*([a-z]+)\s+(?:in|to|into|as)\s+([a-z]+)/);
    if (pair) {
      var c = convertPair(parseFloat(pair[1]), canonUnit(pair[2]), canonUnit(pair[3]));
      if (c) return c;
    }
    return "No local figure for that.";
  }

  /* Narrow: celestial distance, constants, unit convert. Not "how far along". */
  var FACT_SHAPE = /how far (?:is|away is|to)\\b.{0,48}\\b(moon|sun|mars|earth|pluto|venus|jupiter|saturn|neptune|uranus|mercury|iss)|distance (?:to|from) (?:the )?(moon|sun|mars|earth|pluto)|speed of (?:light|sound)|(?:boiling|freezing) point of water|what(?:'s| is) (?:the )?(?:value of )?pi\\b|how many\\s+(?:km|kilometers?|miles?|mi|meters?|metres?|feet|ft|inches|kg|pounds?|lbs?|cm)\\b|\\bconvert\\s+\\d|\\d+(?:\\.\\d+)?\\s*(?:km|kilometers?|miles?|mi|kg|lbs?|pounds?|celsius|fahrenheit|[cf]|meters?|feet|ft|inches|cm)\\s+(?:in|to|into)\\b/i;

  function isFactualAsk(q) {
    return FACT_SHAPE.test(String(q || ""));
  }
  function isFactId(id) {
    id = String(id || "");
    return id === "convert" || id === "fact-miss" || id.indexOf("fact-") === 0;
  }

  function runtimeAnswer(kind, q) {
    if (kind === "unit_convert") return convertUnits(q);
    var p = torontoParts();
    if (!p) return "";
    if (kind === "toronto_date") return "Today is " + p.weekday + ", " + p.date + " in Toronto.";
    if (kind === "toronto_time") return "It is " + p.time + " in Toronto, " + p.weekday + ".";
    return "";
  }

  /* Put the day in front of the question before it reaches a model. A model has
     no clock, so "by Friday" or "next week" is otherwise read against whenever
     its weights were frozen. Returns the question UNSTAMPED when the clock is
     unavailable, for the same reason the date rule declines to answer. */
  function stamp(text) {
    var q = String(text == null ? "" : text);
    var p = torontoParts();
    if (!p) return q;
    return "Today is " + p.weekday + ", " + p.date + " in Toronto. " + q;
  }

  /* ── WHO IS REACHABLE IS THE PAGE'S FACT, NOT THIS FILE'S ─────────────────
     DATA.crew is a default for a page that never tells us. index.html calls
     setCrew() with the roster minus anyone drawn "no key", because an agent
     without a credential must never be handed work - that exact bug has shipped
     here twice, once as a hardcoded sweeper index and once as a fixture task
     assigned to an offline agent. */
  var CREW = (DATA.crew || []).slice();
  var rr = 0;

  function setCrew(list) {
    var out = [], seen = {}, i = 0;
    for (i = 0; i < (list || []).length; i++) {
      var name = String(list[i] || "").trim();
      if (!name || seen[name]) continue;
      seen[name] = true; out.push(name);
    }
    if (!out.length) return CREW.slice();
    CREW = out;
    rr = 0;
    return CREW.slice();
  }

  var ROUTES = {};
  (function () {
    var table = DATA.routing || {};
    for (var who in table) {
      if (!Object.prototype.hasOwnProperty.call(table, who)) continue;
      var pairs = table[who] || [], built = [], i = 0;
      for (i = 0; i < pairs.length; i++) {
        try { built.push({ re: new RegExp(pairs[i][0], "i"), w: pairs[i][1] }); } catch (e) {}
      }
      ROUTES[who] = built;
    }
  })();

  /* ONE agent, chosen by keyword, and by round-robin when the question gives no
     signal at all. Never a list: a question handed to five agents is a question
     nobody owns, and on the board it draws five hands working on something only
     one of them will answer. */
  function route(q) {
    if (!CREW.length) return null;
    var text = String(q == null ? "" : q);
    var best = "", bestScore = 0, i = 0, j = 0;
    for (i = 0; i < CREW.length; i++) {
      var who = CREW[i], entries = ROUTES[who] || [], score = 0;
      for (j = 0; j < entries.length; j++) {
        if (entries[j].re.test(text)) score += entries[j].w;
      }
      if (score > bestScore) { bestScore = score; best = who; }
    }
    var why = "keyword";
    if (!bestScore) {
      best = CREW[rr % CREW.length];
      rr = (rr + 1) % CREW.length;
      why = "round-robin";
    }
    return { id: "route", answer: "", handTo: "", routeTo: best, why: why, by: "python" };
  }

  /* Returns an answer, a handoff, or a route. The old NULL-on-miss is gone:
     a miss now names ONE agent instead of leaving the page to wake all of them.
     Null survives for empty input, and for the case where there is no reachable
     agent to name - the page must be able to tell those apart from an answer. */
  /* Decision-shaped: a decision word AND enough words to be a real question.
     Both halves matter - "cost?" is a pricing ask, "is it worth the cost to
     migrate from HubSpot?" is not. */
  var DECISION_RE = new RegExp(DATA.decision.re, "i");
  function isDecision(q) {
    var words = String(q).trim().split(/\s+/).length;
    return words >= DATA.decision.minWords && DECISION_RE.test(q);
  }

  function ask(text) {
    var q = String(text == null ? "" : text);
    if (!q.trim()) return null;
    var decision = isDecision(q);
    for (var i = 0; i < COMPILED.length; i++) {
      var rule = COMPILED[i];
      /* A keyword rule does not get to answer a decision. */
      if (decision && rule.notOnDecision) continue;
      for (var j = 0; j < rule.res.length; j++) {
        if (rule.res[j].test(q)) {
          var answer = rule.answer;
          if (rule.runtime) {
            answer = runtimeAnswer(rule.runtime, q);
            /* The clock failed. Rather than answer a date question with an empty
               line, fall through to an agent like any other question. */
            if (!answer) return route(q);
          }
          return { id: rule.id, answer: answer, handTo: rule.handTo, by: "python" };
        }
      }
    }
    if (isFactualAsk(q)) {
      return { id: "fact-miss", answer: "No local figure for that.", handTo: "", by: "python" };
    }
    return route(q);
  }

  window.__TRIAGE = {
    /* ONE definition of decision-shaped on this page. index.html's
       estimator reuses it; a second copy would drift inside a month. */
    isDecision: isDecision,
    built: DATA.built,
    count: COMPILED.length,
    crew: function () { return CREW.slice(); },
    setCrew: setCrew,
    ask: ask,
    route: route,
    stamp: stamp,
    isFactualAsk: isFactualAsk,
    isFactId: isFactId
  };
})();
"""
    )


def check_route_return(js: str) -> list[str]:
    """CODEX-REVIEW-001 B1: route() must return the scored winner, not grok."""
    problems: list[str] = []
    if 'routeTo: "grok", why: "escalate-to-grok"' in js:
        problems.append(
            "route() still hard-codes routeTo grok (CODEX-REVIEW-001 B1); "
            "return routeTo: best, why: why"
        )
    if "routeTo: best" not in js:
        problems.append("route() must return routeTo: best from the scored CREW winner")
    return problems


def main() -> int:
    problems = check(RULES) + check_routing(ROUTING, CREW_DEFAULT)
    js = emit(RULES)
    problems += check_route_return(js)
    if problems:
        print("triage.py: the rules break the site's own copy constraints:", file=sys.stderr)
        for p in problems:
            print("  " + p, file=sys.stderr)
        return 1
    OUT.write_text(js, encoding="utf-8", newline="\n")
    print(
        f"wrote {OUT} - {len(RULES)} rules, "
        f"{len(ROUTING)} routed agents, checked clean"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
