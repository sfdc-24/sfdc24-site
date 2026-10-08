"""Process queue: title, milestone, agents, changes, and quality. No bare PR number."""
from __future__ import annotations

import re
import unittest
from pathlib import Path

PAGE = Path(__file__).resolve().parents[1] / "process" / "index.html"


class RunningTasks(unittest.TestCase):
    def test_queue_shows_title_milestone_agents_changes_and_quality(self):
        page = PAGE.read_text(encoding="utf-8")
        self.assertLess(page.index('id="running-tasks"'), page.index('id="blocker-register"'))
        block = page.split('id="running-tasks"', 1)[1].split("</section>", 1)[0]
        self.assertIn("A number alone is not a label", block)
        self.assertIn("Not a live roster", block)
        for label in ("Milestone", "Working now", "Worked before", "Changes", "Quality"):
            self.assertEqual(block.count(f"<dt>{label}</dt>"), 4)
        for text in (
            "Hear all conference contributors",
            "Conference · staging",
            "Working now</dt><dd>Claude</dd>",
            "Worked before</dt><dd>Aya and Cody, on review</dd>",
            "A merge is not production verified.",
            "Ops refresh, roles and mobile repair",
            "SFDC24 · test",
            "Working now</dt><dd>Greg. The row is blocked.</dd>",
            "Worked before</dt><dd>Claude, on release</dd>",
            "Blocked on the published snapshot. Not landed.",
            "Independent native-duplex acceptance",
            "Conference · test",
            "Working now</dt><dd>Aya</dd>",
            "not a guest invitation",
            "M8 release gate (planned)",
            "SFDC24 · production, still pending",
            "Working now</dt><dd>Greg</dd>",
            "External invites stay closed until the owner records GO.",
            "this row is not landed",
        ):
            self.assertIn(text, block)
        self.assertLess(block.index("Hear all conference contributors"), block.index("Ops refresh, roles and mobile repair"))
        self.assertLess(block.index("Ops refresh, roles and mobile repair"), block.index("Independent native-duplex acceptance"))
        self.assertLess(block.index("Independent native-duplex acceptance"), block.index("M8 release gate (planned)"))
        self.assertEqual([], re.findall(r"#\d+(?!\d)(?! —)", block))
        self.assertNotIn("unmerged", block.lower())
        self.assertNotIn("sfdc24-site/pull/133", block)
        self.assertNotIn("sfdc24-site/pull/137", block)
        register = page.split('id="blocker-register"', 1)[1].split("</section>", 1)[0]
        self.assertIn("#133 — Architecture PDF AGREE gate", register)
        self.assertIn("#137 — Chair quiet-hold", register)
        self.assertEqual([], re.findall(r"#\d+(?!\d)(?! —)", register))


if __name__ == "__main__":
    unittest.main()
