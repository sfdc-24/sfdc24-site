"""Ops, Process, and Method share one dark Redis coordination read."""
from __future__ import annotations

import json
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]


class CoordFlag(unittest.TestCase):
    def test_the_shipped_flag_is_off_and_has_no_secret(self):
        raw = (REPO / "data" / "coord-redis.json").read_text(encoding="utf-8")
        data = json.loads(raw)
        self.assertEqual("sfdc24.coord.flag.v1", data["schema"])
        self.assertEqual("off", data["dual_run"])
        self.assertFalse(data["redis_answers"])
        self.assertTrue(data["site_authoritative"])
        self.assertEqual("", data["api"])
        self.assertEqual("/api/coord", data["future_api"])
        self.assertEqual("blackboard:", data["key_prefix"])
        self.assertEqual("/data/ops-delivery.json", data["site_snapshot"])
        rollup = data["keys"]["rollup"]
        self.assertEqual("blackboard:coord:v1:rollup", rollup["redis"])
        self.assertEqual("coord:v1:rollup", rollup["dual_run_key"])
        self.assertNotIn("REDIS_AUTH", raw)
        self.assertNotIn("password", raw.lower())
        self.assertNotIn("10.", raw)
        script = (REPO / "assets" / "coord-report.js").read_text(encoding="utf-8")
        css = (REPO / "assets" / "coord-report.css").read_text(encoding="utf-8")
        self.assertNotIn("REDIS_AUTH", script)
        self.assertNotIn("Authorization", script)
        self.assertNotIn("redis://", script)
        self.assertNotRegex(script, r"password\s*[:=]")
        self.assertIn("redis_answers: false", script)
        self.assertIn("production", script)
        self.assertIn("verified", script)
        self.assertIn("min-height:44px", css)
        self.assertIn("min-width:0", css)
        self.assertNotIn("min-width:52rem", css)


class CoordPages(unittest.TestCase):
    def test_three_pages_mount_the_same_read(self):
        ops = (REPO / "ops" / "index.html").read_text(encoding="utf-8")
        process = (REPO / "process" / "index.html").read_text(encoding="utf-8")
        method = (REPO / "method" / "index.html").read_text(encoding="utf-8")
        for page, mode in ((ops, "ops"), (process, "process"), (method, "method")):
            self.assertIn('href="/assets/coord-report.css"', page)
            self.assertIn('src="/assets/coord-report.js"', page)
            self.assertIn(f'data-coord-report="{mode}"', page)
            self.assertIn('data-coord-flag="/data/coord-redis.json"', page)
        main = ops.split("<main", 1)[1]
        self.assertLess(main.index('id="action-items"'), main.index('id="coord-report"'))
        self.assertLess(main.index('id="coord-report"'), main.index('id="strategic-alignment"'))
        self.assertLess(process.index('id="project-delivery"'), process.index('id="running-tasks"'))
        self.assertLess(process.index('id="running-tasks"'), process.index('id="blocker-register"'))
        self.assertIn('id="coordination"', method)
        self.assertIn("published delivery snapshot is authoritative", method)
        self.assertIn("What is in progress", process)
        doc = (REPO / "docs" / "COORD-REDIS.md").read_text(encoding="utf-8")
        self.assertIn("blackboard:coord:v1:rollup", doc)
        self.assertIn("coord:v1:rollup", doc)
        self.assertIn("GET /api/coord", doc)


if __name__ == "__main__":
    unittest.main()
