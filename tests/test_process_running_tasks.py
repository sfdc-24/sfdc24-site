"""Process page: running tasks are labeled, never a bare PR number."""
from __future__ import annotations

import re
import unittest
from pathlib import Path

PAGE = Path(__file__).resolve().parents[1] / "process" / "index.html"


class RunningTasks(unittest.TestCase):
    def test_running_tasks_name_title_milestone_and_status(self):
        page = PAGE.read_text(encoding="utf-8")
        self.assertLess(page.index('id="running-tasks"'), page.index('id="blocker-register"'))
        block = page.split('id="running-tasks"', 1)[1].split("</section>", 1)[0]
        self.assertIn("A number alone is not a label", block)
        heads = re.findall(r'<th scope="col">([^<]+)</th>', block)
        self.assertEqual(["PR", "Meaning", "Milestone", "Status"], heads)
        for text in (
            "#272 — Process page / blocker register",
            "https://github.com/sfdc-24/sfdc24-site/pull/272",
            "Fleet coordination page and the open blocker register.",
            ">Process<",
            "#273 — LiveKit milestones on Ops",
            "https://github.com/sfdc-24/sfdc24-site/pull/273",
            "LiveKit agent in-room and call-out gates on the Ops page.",
            "Ops · LiveKit agent in-room",
            "#133 — Architecture PDF AGREE gate",
            "Architecture PDF held until AGREE.",
            "Architecture · AGREE gate",
            "#137 — Chair quiet-hold",
            "NO-GO until the 2pm review.",
            "Chair · 2pm review",
            ">Draft<",
            ">AGREE gate<",
            ">NO-GO<",
        ):
            self.assertIn(text, block)
        self.assertLess(block.index("#272 —"), block.index("#273 —"))
        self.assertLess(block.index("#273 —"), block.index("#133 —"))
        self.assertLess(block.index("#133 —"), block.index("#137 —"))
        bare = re.findall(r"#\d+(?!\d)(?! —)", block)
        self.assertEqual([], bare)
        self.assertNotIn("sfdc24-site/pull/133", block)
        self.assertNotIn("sfdc24-site/pull/137", block)
        register = page.split('id="blocker-register"', 1)[1].split("</section>", 1)[0]
        self.assertIn("#133 — Architecture PDF AGREE gate", register)
        self.assertIn("#137 — Chair quiet-hold", register)
        self.assertEqual([], re.findall(r"#\d+(?!\d)(?! —)", register))


if __name__ == "__main__":
    unittest.main()
