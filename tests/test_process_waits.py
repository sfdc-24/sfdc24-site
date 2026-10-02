"""Process page: overnight wait map and control-chart seed."""
from __future__ import annotations

import unittest
from pathlib import Path

PAGE = Path(__file__).resolve().parents[1] / "process" / "index.html"


class ProcessWaits(unittest.TestCase):
    def test_who_waits_on_whom_with_seed_minutes(self):
        page = PAGE.read_text(encoding="utf-8")
        self.assertIn('id="wait-charts"', page)
        self.assertIn("Who waits → on whom", page)
        self.assertIn("45-minute peer-wait SLA", page)
        block = page.split('id="wait-charts"', 1)[1].split("</section>", 1)[0]
        for text in (
            "Gemini → Claude",
            "#133 — Architecture PDF AGREE gate",
            "BLK-133-DIFF",
            'data-minutes="20,50,110,180"',
            "180 min",
            "Chair → Claude",
            "#137 — Chair quiet-hold",
            "BLK-137-CHAIR",
            "silence",
            'data-minutes="45,120,210,300"',
            "300 min",
            "Codex → Gemini",
            "AGREE",
            "BLK-GEM-AGREE",
            'data-minutes="12,25,40"',
            "40 min",
            "Overnight seed",
            "Not a live clock",
        ):
            self.assertIn(text, block)
        self.assertLess(block.index("Gemini → Claude"), block.index("Chair → Claude"))
        self.assertLess(block.index("Chair → Claude"), block.index("Codex → Gemini"))
        register = page.split('id="blocker-register"', 1)[1].split('id="wait-charts"', 1)[0]
        self.assertIn("180 min seed", register)
        self.assertIn("300 min (~5h)", register)
        self.assertIn("40 min seed", register)
        script = page.split("<script>", 1)[1]
        self.assertIn("var SLA = 45", script)
        self.assertIn("stroke-dasharray", script)
        self.assertIn('class="ctl"', script)
        self.assertNotIn("mailto:", block.lower())


if __name__ == "__main__":
    unittest.main()
