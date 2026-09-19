#!/usr/bin/env python3
"""Build a homepage-scoped site manifest for the tier-zero edit router.

Scope: index.html (+ assets/chrome.css/js inventory pointers). Other pages are
listed as paths only so the router can refuse off-scope writes without a
full-site crawl.
"""
from __future__ import annotations

import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HOME = ROOT / "index.html"
OUT = ROOT / "data" / "site-manifest.json"

KNOWN = [
    ("mic soft color", "color:var(--soft)", ".seekmic"),
    ("mic ink color", "color:var(--ink)", ".seekmic"),
    ("mic contrast dark", "background:#0A2744", ".seekmic"),
    ("mockup disclaimer", "Nothing on this page is a mockup. Press something and it runs.", "RULES"),
    ("caveat line", "Automation and AI enablement · research stage", "hero caveat"),
    ("caveat middot", "Automation and AI enablement &middot; research stage", "hero caveat html"),
    ("check note legacy", "checked — no claim about reading a live system", "checkReply"),
    ("check note human", "Looks clear — nothing here claims to have read a live customer system", "checkReply"),
    ("verified label", "verified", "scoreboard"),
]

CSS_VARS = [
    "--signal", "--ink", "--soft", "--body", "--paper", "--raised", "--rule",
]

ORG_NOUN = re.compile(
    r"\b(salesforce|org|tenant|instance|environment)\b", re.I
)
FIRST_PERSON = re.compile(r"\b(I|me|my|mine|myself)\b")


def extract_strings(html: str) -> list[dict]:
    """Homepage-first inventory: known anchors + capped literal sample."""
    items: list[dict] = []
    for name, needle, where in KNOWN:
        idx = html.find(needle)
        items.append({
            "id": name,
            "text": needle,
            "present": idx >= 0,
            "offset": idx if idx >= 0 else None,
            "where": where,
        })
    seen = set()
    for m in re.finditer(r'(["\'])([^"\']{16,120})\1', html):
        s = m.group(2)
        if s.startswith("http") or "function " in s or s in seen:
            continue
        if ORG_NOUN.search(s) or FIRST_PERSON.search(s):
            seen.add(s)
            items.append({
                "text": s,
                "offset": m.start(),
                "org_noun": bool(ORG_NOUN.search(s)),
                "first_person": bool(FIRST_PERSON.search(s)),
            })
        if len(seen) >= 40:
            break
    return items


def main() -> int:
    if not HOME.is_file():
        print(f"missing {HOME}", file=sys.stderr)
        return 1
    html = HOME.read_text(encoding="utf-8")
    manifest = {
        "built": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "scope": "homepage",
        "paths": {
            "home": "index.html",
            "chrome_css": "assets/chrome.css",
            "chrome_js": "assets/chrome.js",
            "triage_py": "assets/triage.py",
            "triage_js": "assets/triage.js",
            "agents": "agents/index.html",
        },
        "off_scope_examples": [
            "method/index.html", "panels/index.html", "privacy/index.html",
            "terms/index.html", "org/index.html",
        ],
        "css_variables": CSS_VARS,
        "templates": {
            "static_section": {
                "kind": "static_section",
                "wrap": "<section class=\"{cls}\" id=\"{id}\">\n{body}\n</section>\n",
            }
        },
        "inventory": extract_strings(html),
        "escalation_rules": [
            "triage_routing",
            "crew_dol_wiring",
            "new_org_noun_or_first_person_claim",
            "chrome_js_liveflow_wakefleet_estimator",
            "new_page_publisher_honesty_positioning",
            "ambiguous_no_manifest_target",
        ],
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"wrote {OUT} — {len(manifest['inventory'])} inventory rows")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
