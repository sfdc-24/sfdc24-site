"""Process is a findable delivery board. Sheet counts are real. Redis is not live."""
from __future__ import annotations

import json
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
PAGE = REPO / "process" / "index.html"
CHROME = REPO / "assets" / "chrome.js"
SNAP = REPO / "data" / "ops-delivery.json"


def _counts():
    data = json.loads(SNAP.read_text(encoding="utf-8"))
    landed = in_progress = blocked = 0
    by_project = {}
    for item in data["items"]:
        is_landed = item["stage"] == "production" and item["status"] == "verified"
        project = by_project.setdefault(item["project"], {"in": 0, "landed": 0})
        if is_landed:
            landed += 1
            project["landed"] += 1
        else:
            in_progress += 1
            project["in"] += 1
        if item["status"] == "blocked":
            blocked += 1
    return data["observed_at"], len(data["items"]), landed, in_progress, blocked, by_project


class ProcessRoute(unittest.TestCase):
    def test_shared_nav_links_the_page_and_the_page_does_not_call_itself_a_draft(self):
        page = PAGE.read_text(encoding="utf-8")
        chrome = CHROME.read_text(encoding="utf-8")
        self.assertIn('["/process/", "Process"', chrome)
        self.assertIn('href="/process/">Process</a>', page)
        self.assertIn('id="project-delivery"', page)
        self.assertIn('id="path-comparison"', page)
        self.assertIn('id="wait-charts"', page)
        self.assertIn('id="agent-scorecard"', (REPO / "ops" / "index.html").read_text(encoding="utf-8"))
        self.assertNotIn("unmerged", page.lower())
        self.assertNotIn("redis://", page.lower())
        self.assertNotIn("memorystore", page.lower())
        self.assertNotIn("Redis is the system of record", page)
        self.assertIn("system of record", page.lower())
        self.assertIn("not a trusted live read", page)
        self.assertIn("The comparison gate is not green", page)
        self.assertIn("No Redis count is published", page)
        self.assertIn("Spend is a first-class design constraint, with quality and fit.", page)
        self.assertIn("Codex owns that discipline.", page)
        self.assertIn("Task-level routing stays parked", page)
        self.assertNotIn('id="model-routing"', page)
        self.assertNotIn("classifier", page.lower())
        self.assertNotIn("fast/balanced/powerful", page.lower())

    def test_delivery_counts_match_the_published_snapshot(self):
        page = PAGE.read_text(encoding="utf-8")
        observed, total, landed, in_progress, blocked, by_project = _counts()
        self.assertIn(observed, page)
        self.assertIn(f"{total} rows", page)
        self.assertIn(f"{landed} landed", page)
        self.assertIn(f"{in_progress} not landed", page)
        self.assertIn(f"{blocked} blocked", page)
        for project, counts in by_project.items():
            self.assertIn(
                f"{project} {counts['in']} in progress and {counts['landed']} landed",
                page,
            )
            self.assertIn(f"{counts['in']} in progress · {counts['landed']} landed", page)


if __name__ == "__main__":
    unittest.main()
