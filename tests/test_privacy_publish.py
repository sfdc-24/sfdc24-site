"""TASK ID: C69. Published data and the delivery page stay aggregate."""
from __future__ import annotations

import json
import unittest
from pathlib import Path

from tools.privacy_publish import problems, reduce_tracker, road_title, strip_published

ROOT = Path(__file__).resolve().parents[1]
PUBLISHED = [
    ROOT / "data" / "release-milestones.json",
    ROOT / "data" / "public-activity.json",
]


class Reducer(unittest.TestCase):
    def test_owner_rows_and_private_fields_do_not_survive(self):
        raw = {
            "tasks": [
                {"id": "T1", "title": "Test 2", "status": "planned", "owner": "Clay"},
                {"id": "T2", "title": "Retest call", "status": "active", "owner": "Owner"},
                {"id": "T3", "title": "Sign-off", "status": "done", "assignee": "You"},
            ],
            "source": "internal thread on the private board",
            "board_rows_by_phase": {"build": 4},
            "board_rows_by_agent": {"claude": 2},
        }
        reduced = reduce_tracker(raw)
        self.assertEqual(reduced["counts_by_status"]["planned"], 1)
        self.assertEqual(reduced["counts_by_status"]["active"], 0)
        self.assertEqual(reduced["counts_by_status"]["done"], 0)
        self.assertNotIn("source", reduced)
        stripped = strip_published(raw)
        self.assertNotIn("source", stripped)
        self.assertNotIn("board_rows_by_phase", stripped)
        self.assertNotIn("board_rows_by_agent", stripped)
        self.assertEqual(problems(json.dumps(reduced)), [])

    def test_road_titles_do_not_assign_owner_or_you(self):
        self.assertEqual(road_title("Owner retest", 1), "retest")
        self.assertEqual(road_title("You", 2), "Test 3")
        self.assertEqual(road_title("Test 2", 1), "Test 2")

    def test_banned_patterns_are_detected(self):
        self.assertIn("pull-request-number", problems("see /pull/428"))
        self.assertIn("branch-name", problems("branch cursor/c69"))
        self.assertIn("case", problems("Case 1001"))
        self.assertIn("email", problems("person@example.com"))
        self.assertEqual(problems("Test 2 planned 12 Nov"), [])


class PublishedFiles(unittest.TestCase):
    def test_refreshed_public_files_have_no_banned_items(self):
        page = (ROOT / "delivery" / "index.html").read_text(encoding="utf-8")
        self.assertIn("board_rows_by_phase", page)  # the page deletes the key; it must not render it
        self.assertIn("delete node.source", page)
        self.assertIn("Test ", page)
        for path in PUBLISHED:
            self.assertTrue(path.is_file(), path.name)
            text = path.read_text(encoding="utf-8")
            self.assertNotIn('"source"', text, path.name)
            self.assertNotIn("board_rows_by_phase", text, path.name)
            self.assertEqual(problems(text), [], path.name)

    def test_header_does_not_print_a_source_or_pull_request(self):
        clock = (ROOT / "assets" / "home-release-clock.js").read_text(encoding="utf-8")
        milestones = (ROOT / "data" / "release-milestones.json").read_text(encoding="utf-8")
        self.assertIn("release-milestones.json", clock)
        self.assertNotIn("/pull/", clock)
        self.assertNotIn('"source"', milestones)
        self.assertIn("V3 retest", milestones)


if __name__ == "__main__":
    unittest.main()
