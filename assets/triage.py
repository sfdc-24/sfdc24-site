#!/usr/bin/env python3
from __future__ import annotations

import json
import re
import sys
from datetime import date, timezone, datetime
from pathlib import Path

OUT = Path(__file__).resolve().parent / "triage.js"

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
    {
        "id": "what-is-this",
        "patterns": [
            r"\bwhat (is|are) (this|sfdc24|the site|it)\b",
            r"\bwhat does (this|sfdc24|it) do\b",
            r"\bwhat'?s this\b",
        ],
        "answer": "SFDC24 is an interactive build portal. Local rules answer the simple questions right here with no model call, anything harder goes to a model, and whatever you type goes up on the board in your own hand.",
    },
    {
        "id": "contact",
        "patterns": [
            r"\b(contact|email|e-mail|reach|get in touch|speak to (a|someone) (human|person))\b",
            r"\bhow do (i|we|you) (contact|reach)\b",
        ],
        "answer": "abdus@sfdc24.com reaches a person, and a reply usually comes back the same day.",
    },
    {
        "id": "who-are-the-agents",
        "patterns": [
            r"\bwho (are|is) (the )?(you|agents?|they|the team|the fleet)\b",
            r"\bwhich (agents?|models?)\b",
            r"\bhow many agents\b",
        ],
        "answer": "Python is the gatekeeper on this page. Simple asks are answered here with no model call. Harder work hands off to Grok for product and orchestration, or Claude for Apex and Lightning implementation.",
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
        "answer": "Type a question. Python triages it here. Simple asks get a local answer with no model call. Harder asks hand off to Grok or Claude, and the live flow above lights the path as it happens.",
    },
    {
        "id": "are-you-a-bot",
        "patterns": [r"\bare you (a )?(bot|robot|human|real|ai)\b", r"\bis this (a )?(bot|real|ai)\b"],
        "answer": "AI agents, and the page says so rather than pretending. A human makes every decision that actually matters.",
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
    {
        "id": "clarify",
        "patterns": [
            r"^[\\w\'\\-]{1,12}$",
            r"^(this|that|it|stuff|thing|help|more|idk|hmm+|\\.\\.\\.|\\?+)$",
        ],
        "answer": "Could you say a bit more about what you are looking for?",
    },
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

CREW_DEFAULT = ["foundry", "claude", "codex", "gemini", "grok"]  # foundry = appointed default lead (ALL-HANDS-001); route() returns scored winner

ROUTING: dict[str, list[tuple[str, int]]] = {
    "claude": [
        (r"\b(apex|lwc|lightning|soql|validation rule|profile|permission set)\b", 3),
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
        (r"\b(search|research|compare|survey|architecture|architect|diagram|options)\b", 3),
    ],
    "grok": [
        (r"\b(product|roadmap|strategy|positioning|messaging|pricing|market)\b", 3),
        (r"\b(salesforce|sfdc|crm|help me with|can you help)\b", 2),
    ],
}

FIRST_PERSON = [
    re.compile(r"\bI\b"),
    re.compile(r"\bI'"),
    re.compile(r"\bmy\b", re.I),
    re.compile(r"\bmine\b", re.I),
    re.compile(r"\bme\b", re.I),
    re.compile(r"\bmyself\b", re.I),
]
ORG_NOUN = re.compile(r"\b(salesforce|orgs?|tenants?|instances?|environments?)\b", re.I)

REMOVED_CONTROLS = (
    "WhatsApp",
    "Talk instead",
    "Send button",
    "pipeline link",
    "joke button",
    "the chips",
)

RUNTIME_ANSWERERS = ("toronto_date", "toronto_time")

def check(rules: list[dict]) -> list[str]:
    """Return every copy problem. Empty list means the rules may ship."""
    problems: list[str] = []
    for rule in rules:
        text = rule.get("answer", "")

        if not text and not rule.get("hand_to") and not rule.get("runtime"):
            problems.append(
                f"{rule['id']}: matches but has no answer, no hand_to and no runtime"
            )
        if rule.get("runtime") and rule["runtime"] not in RUNTIME_ANSWERERS:
            problems.append(
                f"{rule['id']}: runtime {rule['runtime']!r} is not one of "
                f"{', '.join(RUNTIME_ANSWERERS)} - triage.js has no such answerer"
            )

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
            }
            for r in rules
        ],
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
      handTo: rule.handTo, runtime: rule.runtime
    });
  }

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

  function runtimeAnswer(kind) {
    var p = torontoParts();
    if (!p) return "";
    if (kind === "toronto_date") return "Today is " + p.weekday + ", " + p.date + " in Toronto.";
    if (kind === "toronto_time") return "It is " + p.time + " in Toronto, " + p.weekday + ".";
    return "";
  }

  function stamp(text) {
    var q = String(text == null ? "" : text);
    var p = torontoParts();
    if (!p) return q;
    return "Today is " + p.weekday + ", " + p.date + " in Toronto. " + q;
  }

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

  function ask(text) {
    var q = String(text == null ? "" : text);
    if (!q.trim()) return null;
    for (var i = 0; i < COMPILED.length; i++) {
      var rule = COMPILED[i];
      for (var j = 0; j < rule.res.length; j++) {
        if (rule.res[j].test(q)) {
          var answer = rule.answer;
          if (rule.runtime) {
            answer = runtimeAnswer(rule.runtime);
            
            if (!answer) return route(q);
          }
          return { id: rule.id, answer: answer, handTo: rule.handTo, by: "python" };
        }
      }
    }
    return route(q);
  }

  window.__TRIAGE = {
    built: DATA.built,
    count: COMPILED.length,
    crew: function () { return CREW.slice(); },
    setCrew: setCrew,
    ask: ask,
    route: route,
    stamp: stamp
  };
})();
"""
    )

def main() -> int:
    problems = check(RULES) + check_routing(ROUTING, CREW_DEFAULT)
    if problems:
        print("triage.py: the rules break the site's own copy constraints:", file=sys.stderr)
        for p in problems:
            print("  " + p, file=sys.stderr)
        return 1
    OUT.write_text(emit(RULES), encoding="utf-8", newline="\n")
    print(
        f"wrote {OUT} - {len(RULES)} rules, "
        f"{len(ROUTING)} routed agents, checked clean"
    )
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
