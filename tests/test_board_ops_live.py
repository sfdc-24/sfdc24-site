"""Living /ops board: open PRs bake into projects, agent tasks, productivity metrics."""
from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]


def load(name, folder="tools"):
    path = REPO / folder / f"{name}.py"
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    return mod


ops = load("board_ops_snap")


class LiveBoardTests(unittest.TestCase):
    def test_projects_from_pulls_become_cooking_work(self):
        baked = "2026-09-27T04:00:00Z"
        pulls = [
            {
                "number": 240,
                "state": "open",
                "draft": False,
                "title": "Ops polish living board and pushups idle",
                "updated_at": "2026-09-27T03:50:00Z",
                "user": {"login": "cursor-agent"},
                "assignees": [{"login": "grok-bot"}],
                "labels": [{"name": "cooking"}],
                "head": {"ref": "grok/ops-mascot-swap"},
            },
            {
                "number": 239,
                "state": "open",
                "draft": True,
                "title": "Later backlog item parked",
                "updated_at": "2026-09-20T03:50:00Z",
                "user": {"login": "codex"},
                "assignees": [],
                "labels": [{"name": "backlog"}],
                "head": {"ref": "chore/old-park"},
            },
        ]
        work, branches = ops.projects_from_pulls(pulls, baked)
        self.assertEqual(2, len(work))
        cook = next(r for r in work if r["pr"] == 240)
        park = next(r for r in work if r["pr"] == 239)
        self.assertEqual("cooking", cook["lane"])
        self.assertTrue(cook["next"])
        self.assertEqual("REVIEW", cook["phase"])
        self.assertEqual("backlog", park["lane"])
        self.assertEqual("DISPATCH", park["phase"])
        self.assertEqual({"grok/ops-mascot-swap", "chore/old-park"}, {b["name"] for b in branches})
        snap = ops.bake(baked, ci=[], envs=[], export={"open_work": work, "branches": branches, "ack_minutes": [5, 7, 9]})
        self.assertIsNone(ops.problems(snap) or None if not ops.problems(snap) else ops.problems(snap))
        self.assertEqual([], ops.problems(snap))
        self.assertGreaterEqual(len(snap["open_work"]), 2)
        self.assertIn("take_on_min", snap["stats"])
        self.assertIn("utilization_pct", snap["stats"])
        self.assertEqual(7, snap["stats"]["take_on_min"])

    def test_merge_export_keeps_export_and_appends_new_prs(self):
        baked = "2026-09-27T04:00:00Z"
        export = {
            "open_work": [
                {"id": "CONF-LINE", "from": "grok", "to": ["cursor"], "phase": "DISPATCH", "age_min": 3, "next": True, "lane": "cooking", "title": "Conference line"},
            ],
            "agents": [
                {"id": "grok", "last_seen": baked, "writes_1h": 2, "open_dispatch": 1, "status": "hot", "task": "PM living board", "phase": "DISPATCH"},
            ],
        }
        live, br = ops.projects_from_pulls([
            {"number": 241, "state": "open", "title": "New project from PR", "updated_at": baked,
             "user": {"login": "gemini"}, "assignees": [], "labels": ["priority"], "head": {"ref": "feature/new"}},
        ], baked)
        merged = ops.merge_export_with_live(export, live, br, baked)
        ids = {r["id"] for r in merged["open_work"]}
        self.assertIn("CONF-LINE", ids)
        self.assertIn("PR-241", ids)
        grok = next(a for a in merged["agents"] if a["id"] == "grok")
        self.assertEqual("PM living board", grok["task"])
        gemini = next(a for a in merged["agents"] if a["id"] == "gemini")
        self.assertIn("New project", gemini.get("task", ""))

    def test_productivity_metrics_on_sample(self):
        snap = ops.sample_snap()
        self.assertEqual([], ops.problems(snap))
        self.assertEqual(7, snap["stats"]["take_on_min"])
        self.assertEqual(14, snap["stats"]["finish_min"])
        self.assertEqual(8, snap["stats"]["wait_min"])
        self.assertAlmostEqual(83.3, snap["stats"]["utilization_pct"], places=1)

    def test_offline_bake_still_valid_with_empty_live(self):
        snap = ops.bake(ops.now_utc(), ci=[], envs=[], export=ops.merge_export_with_live(None, [], [], ops.now_utc()))
        self.assertEqual([], ops.problems(snap))
        self.assertIn("utilization_pct", snap["stats"])


if __name__ == "__main__":
    unittest.main()
