"""Ops storyboard: week grain now, month later, secrets dropped, page stays quiet."""
from __future__ import annotations

import importlib.util
import json
import sys
import unittest
from datetime import date
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]


def load():
    path = REPO / "tools" / "ops_storyboard.py"
    spec = importlib.util.spec_from_file_location("ops_storyboard", path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    return mod


story = load()


class Schema(unittest.TestCase):
    def test_committed_sample_is_weekly_and_clean(self):
        path = REPO / "data" / "ops-storyboard.json"
        snap = json.loads(path.read_text(encoding="utf-8"))
        self.assertEqual([], story.problems(snap))
        self.assertEqual(story.sample_story(), snap)
        self.assertEqual("sample", snap["source"])
        self.assertEqual("week", snap["grain"])
        blob = json.dumps(snap).lower()
        self.assertNotIn("foundry", blob)
        self.assertNotIn("azure", blob)
        self.assertNotIn("script.google", blob)

    def test_week_groups_and_month_groups_share_the_same_entries(self):
        snap = story.sample_story()
        weeks = story.group_entries(snap["entries"], "week")
        months = story.group_entries(snap["entries"], "month")
        self.assertEqual(
            ["Week of 24 Aug", "Week of 31 Aug", "Week of 14 Sep", "Week of 21 Sep"],
            [row["label"] for row in weeks],
        )
        self.assertEqual(3, len(weeks[1]["entries"]))
        self.assertEqual(["August 2026", "September 2026"], [row["label"] for row in months])
        self.assertEqual(5, len(months[1]["entries"]))
        self.assertEqual(
            [row["title"] for row in snap["entries"]],
            [item["title"] for group in months for item in group["entries"]],
        )

    def test_iso_week_of_the_first_frame(self):
        self.assertEqual("2026-W35", story.group_key(date(2026, 8, 25), "week"))
        self.assertEqual("2026-08", story.group_key(date(2026, 8, 25), "month"))

    def test_poison_does_not_survive(self):
        raw = story.sample_story()
        raw["entries"].append({
            "date": "2026-09-20",
            "title": "Leaked",
            "caption": "Write fleet-owner@example.com into the frame",
            "token": "fixture-token-value",
            "sha": "abc123",
        })
        raw["entries"].append({
            "date": "2026-09-21",
            "title": "Bus",
            "caption": "Call script.google.com/macros now",
        })
        snap = story.sanitize(raw)
        blob = json.dumps(snap)
        self.assertNotIn("fleet-owner@example.com", blob)
        self.assertNotIn("fixture-token-value", blob)
        self.assertNotIn("script.google", blob)
        self.assertNotIn("abc123", blob)
        self.assertEqual(len(story.sample_story()["entries"]), len(snap["entries"]))
        self.assertEqual([], story.problems(snap))

    def test_bad_illustration_is_omitted_and_the_frame_stays(self):
        raw = story.sample_story()
        raw["entries"][0]["illustration"] = "foundry-bay"
        snap = story.sanitize(raw)
        self.assertNotIn("illustration", snap["entries"][0])
        self.assertEqual("The clock starts", snap["entries"][0]["title"])

    def test_bake_can_switch_grain_without_new_fields(self):
        export = {"entries": story.sample_story()["entries"], "grain": "week"}
        snap = story.bake("2026-09-26T12:00:00Z", export, grain="month")
        self.assertEqual("month", snap["grain"])
        self.assertEqual("bake", snap["source"])
        self.assertEqual([], story.problems(snap))
        self.assertEqual("September 2026", story.group_entries(snap["entries"], snap["grain"])[1]["label"])


class Page(unittest.TestCase):
    def test_storyboard_sits_with_the_panels_and_fails_quiet(self):
        page = (REPO / "ops" / "index.html").read_text(encoding="utf-8")
        script = (REPO / "assets" / "ops-storyboard.js").read_text(encoding="utf-8")
        home = (REPO / "index.html").read_text(encoding="utf-8")
        workflow = (REPO / ".github" / "workflows" / "ops-storyboard.yml").read_text(encoding="utf-8")
        self.assertIn('id="engine"', page)
        self.assertIn('id="engine-lists"', page)
        self.assertIn('id="ops-story"', page)
        self.assertIn("Functional build", page)
        self.assertIn('content="noindex"', page)
        self.assertIn("/assets/ops-storyboard.js", page)
        self.assertNotIn("ops-storyboard.js", home)
        self.assertIn("/data/ops-storyboard.json", script)
        for banned in ("script.google", "spreadsheets", "alpha-db", "/macros/", "git log", "gitlog"):
            self.assertNotIn(banned, script)
            self.assertNotIn(banned, page)
        self.assertIn("cron:", workflow)
        self.assertIn("* * 1", workflow)
        self.assertNotIn("HEAD:main", workflow)
        self.assertNotIn("git push", workflow)


if __name__ == "__main__":
    unittest.main()
