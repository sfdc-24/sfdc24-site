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
            "#272 — Process page / blocker register",
            "https://github.com/sfdc-24/sfdc24-site/pull/272",
            ">Process<",
            "Worked before</dt><dd>Grok</dd>",
            "45-minute peer-wait SLA",
            "static seed, not a live board",
            "#273 — LiveKit milestones on Ops",
            "https://github.com/sfdc-24/sfdc24-site/pull/273",
            "Ops · LiveKit agent in-room",
            "Worked before</dt><dd>Cursor</dd>",
            "not in the room",
            "VERIFY in a live room has not happened",
            "#133 — Architecture PDF AGREE gate",
            "Architecture · AGREE gate",
            "Working now</dt><dd>Gemini, held for AGREE.</dd>",
            "Worked before</dt><dd>Claude</dd>",
            "private diff is not attached",
            "AGREE is not recorded",
            "#137 — Chair quiet-hold",
            "Chair · 2pm review",
            "Working now</dt><dd>None. Quiet-hold.</dd>",
            "NO-GO until the 2pm review",
        ):
            self.assertIn(text, block)
        self.assertLess(block.index("#272 —"), block.index("#273 —"))
        self.assertLess(block.index("#273 —"), block.index("#133 —"))
        self.assertLess(block.index("#133 —"), block.index("#137 —"))
        self.assertEqual([], re.findall(r"#\d+(?!\d)(?! —)", block))
        self.assertNotIn("sfdc24-site/pull/133", block)
        self.assertNotIn("sfdc24-site/pull/137", block)
        register = page.split('id="blocker-register"', 1)[1].split("</section>", 1)[0]
        self.assertIn("#133 — Architecture PDF AGREE gate", register)
        self.assertIn("#137 — Chair quiet-hold", register)
        self.assertEqual([], re.findall(r"#\d+(?!\d)(?! —)", register))


if __name__ == "__main__":
    unittest.main()
