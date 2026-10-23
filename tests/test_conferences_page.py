"""Public /conferences page: a short explanation, not an open room."""
from __future__ import annotations

import re
import unittest
from pathlib import Path

PAGE = Path(__file__).resolve().parents[1] / "conferences" / "index.html"
# Page weight on 2026-10-18, before motion gating:
#   baseline 178715. Ceiling is that baseline plus about 15% headroom.
# 178715 * 1.15 = 205522, rounded up to 206000 (~15.3%).
# The owner put that ceiling back and it stays. Measured weight only moves down.
BASELINE_WEIGHT = 178715
PAGE_BUDGET = 206000
# Prior measured pin, after the public menu label shortened the old page.
PRIOR_MEASURED = 154741
# This page no longer links the room assets. HTML is the whole measured weight.
MEASURED_WEIGHT = 4510
DISCLAIMER = (
    "sfdc24.com is an independent community resource for Salesforce customers, "
    "consultants and developers, run by Abdus Salam, a certified Salesforce "
    "Sales Cloud Consultant, with help from AI agents. It is not affiliated with, "
    "endorsed by, or sponsored by Salesforce, Inc., and does not represent or "
    "speak for Salesforce. Salesforce, Sales Cloud and related marks are "
    "trademarks of Salesforce, Inc."
)


def conferences_weight():
    """Bytes of /conferences/ HTML plus page-specific CSS, JS, and images."""
    html = PAGE.read_text(encoding="utf-8")
    root = PAGE.parents[1]
    parts = [("conferences/index.html", PAGE.stat().st_size)]
    seen = set()
    for match in re.finditer(r'(?:href|src|content)\s*=\s*"([^"]+)"', html):
        url = match.group(1)
        path = url
        if url.startswith("https://sfdc24.com/"):
            path = url[len("https://sfdc24.com"):]
        elif url.startswith(("http://", "https://", "//")):
            continue
        if not path.startswith("/conferences/"):
            continue
        rel = path.split("?", 1)[0].split("#", 1)[0]
        if rel.endswith("/") or rel in seen:
            continue
        seen.add(rel)
        file = root / rel.lstrip("/")
        if not file.is_file():
            raise AssertionError(f"missing local asset {rel}")
        if file.suffix.lower() not in {".css", ".js", ".png", ".svg", ".jpg", ".jpeg", ".webp", ".gif", ".ico"}:
            continue
        parts.append((rel.lstrip("/"), file.stat().st_size))
    parts.sort(key=lambda item: item[0])
    return sum(size for _name, size in parts), parts


class ConferencesPage(unittest.TestCase):
    def setUp(self):
        self.text = PAGE.read_text(encoding="utf-8")
        self.main = self.text.split("<main", 1)[1].split("</main>", 1)[0]

    def test_explains_the_session_and_says_the_room_is_not_open(self):
        self.assertIn("<h1>Conferences</h1>", self.text)
        self.assertIn("AI-assisted working session", self.main)
        self.assertIn("Abdus and his agent team, Claude, Cursor, Grok, Gemini, and Codex", self.main)
        self.assertIn("The live conference room is still being built and is not open yet.", self.main)
        self.assertIn('data-keep-names="1"', self.text)
        for step in (
            "Name the Salesforce work.",
            "Plan it with the agent team.",
            "Prototype the change on Salesforce.",
            "A person reviews it before anything ships.",
        ):
            self.assertIn(step, self.main)
        self.assertEqual(self.main.count("<li>"), 4)

    def test_one_contact_and_no_live_room_controls(self):
        self.assertEqual(self.main.count('href="mailto:abdus@sfdc24.com"'), 1)
        self.assertIn('id="conference-contact"', self.main)
        for banned in (
            'id="conference-start"',
            'id="conference-join"',
            'id="host-tease"',
            'id="conference-invite"',
            "https://sfdc24.com/conferences/room/",
            "getUserMedia",
            "Live conference room",
            ">Start</a>",
            ">Join</a>",
        ):
            self.assertNotIn(banned, self.text)
        self.assertIn('data-chrome-ask="off"', self.text)
        self.assertIn(DISCLAIMER, self.text)

    def test_footer_keeps_ops_and_conferences(self):
        footer = self.text.split("<footer", 1)[1].split("</footer>", 1)[0]
        self.assertIn('href="/ops/">Ops</a>', footer)
        self.assertIn('href="/conferences/">Conferences</a>', footer)
        self.assertNotIn('href="/conferences/"', self.main)

    def test_page_weight_stays_within_fifteen_percent(self):
        self.assertEqual(PAGE_BUDGET, 206000)
        self.assertEqual(BASELINE_WEIGHT, 178715)
        self.assertGreaterEqual(PAGE_BUDGET, int(BASELINE_WEIGHT * 1.15))
        self.assertLessEqual(PAGE_BUDGET, int(BASELINE_WEIGHT * 1.16))
        total, parts = conferences_weight()
        names = [name for name, _size in parts]
        self.assertEqual(names, ["conferences/index.html"])
        self.assertLess(total, PRIOR_MEASURED)
        self.assertEqual(total, MEASURED_WEIGHT)
        self.assertLessEqual(total, PAGE_BUDGET)

    def test_load_stays_under_the_measured_weight(self):
        total, _parts = conferences_weight()
        self.assertEqual(total, MEASURED_WEIGHT)
        self.assertLess(MEASURED_WEIGHT, PRIOR_MEASURED)
        self.assertLessEqual(total, PAGE_BUDGET)


if __name__ == "__main__":
    unittest.main()
