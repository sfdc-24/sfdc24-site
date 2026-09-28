"""Ops snap: schema, secret refusal, fail-silent bake, homepage script left alone."""
from __future__ import annotations

import importlib.util
import json
import sys
import unittest
import urllib.error
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
speed = load("speed_log")


class Response:
    def __init__(self, status, body=b"{}"):
        self.status = status
        self._body = body

    def read(self, n=-1):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class Opener:
    def __init__(self, routes=None, fail=None):
        self.routes = routes or {}
        self.fail = fail or {}
        self.urls = []

    def __call__(self, request, timeout=None):
        url = request.full_url
        self.urls.append(url)
        for needle, exc in self.fail.items():
            if needle in url:
                raise exc
        for needle, payload in self.routes.items():
            if needle in url:
                if isinstance(payload, int):
                    if payload >= 400:
                        raise urllib.error.HTTPError(url, payload, "err", {}, None)
                    return Response(payload, b"ok")
                return Response(200, json.dumps(payload).encode("utf-8"))
        return Response(200, b"{}")


POISON = {
    "v": 1,
    "baked_at": "2026-09-26T06:30:00Z",
    "refresh_sec": 120,
    "source": "sample",
    "email": "fleet-owner@example.com",
    "token": "fixture-token-value",
    "transcript": "private transcript text",
    "agents": [
        {
            "id": "claude-code-cli",
            "last_seen": "2026-09-26T06:20:00Z",
            "writes_1h": 2,
            "open_dispatch": 1,
            "status": "warm",
            "api_key": "fixture-api-key",
        },
        {"id": "foundry", "status": "hot", "writes_1h": 9, "open_dispatch": 3, "last_seen": "2026-09-26T06:20:00Z"},
    ],
    "open_work": [
        {
            "id": "THIS-ID-IS-WAY-TOO-LONG-TO-SHOW-IN-FULL-ABCDEF",
            "from": "grok",
            "to": ["claude-code-cli", "foundry"],
            "phase": "DISPATCH",
            "age_min": 12,
            "body": "secret payload text",
        }
    ],
    "edges": [
        {"from": "foundry", "to": "grok", "phase": "DISPATCH", "ts": "2026-09-26T06:29:00Z"},
        {
            "from": "grok", "to": "claude-code-cli", "phase": "DISPATCH",
            "ts": "2026-09-26T06:29:00Z", "password": "fixture-password",
        },
    ],
    "envs": [
        {"id": "www", "label": "sfdc24.com", "health": "ok", "note": "Pages from main"},
        {"id": "azure-vm", "label": "Azure VM", "health": "ok"},
        {"id": "pages", "label": "GitHub Pages", "health": "ok", "note": "ping fleet-owner@example.com now"},
    ],
    "ci": [
        {
            "repo": "sfdc24-site", "conclusion": "failure", "name": "homepage-browser-tests",
            "url": "https://github.com/sfdc-24/sfdc24-site/actions/runs/9",
            "ts": "2026-09-26T06:00:00Z", "cookie": "session-fixture",
        }
    ],
    "stats": {
        "rows_sampled": 4, "dispatch_open": 1, "result_1h": 0, "nogo_1h": 0,
        "median_ack_min": 7, "secret": "nope",
    },
}


class Schema(unittest.TestCase):
    def test_committed_sample_is_clean_and_labelled_sample(self):
        path = REPO / "data" / "board-ops-snap.json"
        snap = json.loads(path.read_text(encoding="utf-8"))
        self.assertEqual([], ops.problems(snap))
        self.assertEqual(ops.sample_snap(), snap)
        self.assertEqual("sample", snap["source"])
        self.assertNotIn("foundry", json.dumps(snap).lower())
        self.assertNotIn("azure", json.dumps(snap).lower())
        self.assertLessEqual(ops.compact_len(snap), ops.MAX_BYTES)

    def test_sample_stats_match_the_visible_slice(self):
        snap = ops.sample_snap()
        self.assertEqual(1, snap["stats"]["dispatch_open"])
        self.assertEqual(1, sum(1 for row in snap["open_work"] if row["phase"] == "DISPATCH"))
        self.assertEqual(7, snap["stats"]["median_ack_min"])
        self.assertEqual(14, snap["stats"]["deploy_lead_min"])
        self.assertEqual(96, snap["stats"]["success_7d_pct"])
        self.assertEqual(1.8, snap["stats"]["error_rate_pct"])
        self.assertEqual(40, snap["stats"]["rows_sampled"])
        self.assertEqual(120, snap["refresh_sec"])
        self.assertEqual(
            "Living OKF hub on Ops for packs, how we work, and release links.",
            snap["open_work"][0]["title"],
        )
        self.assertTrue(snap["open_work"][0]["next"])
        self.assertEqual("cooking", snap["open_work"][0]["lane"])
        voice = next(row for row in snap["open_work"] if row["id"].startswith("GROK-OPS"))
        self.assertEqual("backlog", voice["lane"])
        self.assertNotIn("next", voice)
        self.assertEqual(224, voice["pr"])
        self.assertEqual(
            "SA Wed Applicant Portal build for the Wednesday demo.",
            snap["open_work"][1]["title"],
        )
        self.assertTrue(snap["open_work"][1]["next"])
        self.assertEqual("cooking", snap["open_work"][1]["lane"])
        parked = next(row for row in snap["open_work"] if row["id"] == "CONF-LINE-FUNNEL")
        self.assertEqual("backlog", parked["lane"])
        self.assertNotIn("next", parked)
        self.assertEqual(
            ["feature/ops-polish", "fix/staging-gate", "chore/snap-bake"],
            [row["name"] for row in snap["branches"]],
        )

    def test_median_odd_even_and_empty(self):
        self.assertIsNone(ops.median([]))
        self.assertEqual(7, ops.median([4, 7, 12]))
        self.assertEqual(8, ops.median([4, 12]))
        self.assertEqual(4, ops.median([4, "nope", -1, True]))

    def test_poison_keys_and_retired_nodes_do_not_survive(self):
        snap = ops.sanitize(POISON)
        self.assertIsNotNone(snap)
        self.assertEqual([], ops.problems(snap))
        blob = json.dumps(snap)
        for leaked in (
            "fleet-owner@example.com", "fixture-token-value", "private transcript",
            "fixture-api-key", "fixture-password", "secret payload", "session-fixture",
            "foundry", "azure",
        ):
            self.assertNotIn(leaked, blob, leaked)
        self.assertEqual(["claude-code-cli"], [a["id"] for a in snap["agents"]])
        self.assertEqual("THIS-ID-IS-WAY-T", snap["open_work"][0]["id"])
        self.assertEqual(["claude-code-cli"], snap["open_work"][0]["to"])
        self.assertEqual({"pages", "www"}, {e["id"] for e in snap["envs"]})
        pages = next(row for row in snap["envs"] if row["id"] == "pages")
        self.assertNotIn("note", pages)
        self.assertNotIn("secret", snap["stats"])

    def test_presentation_titles_are_optional_and_jargon_is_dropped(self):
        raw = ops.sample_snap()
        raw["open_work"][0]["title"] = "Blackboard motherboard"
        raw["open_work"][1]["title"] = "sk-" + "live title"
        long_row = dict(raw["open_work"][0])
        long_row["id"] = "CURSOR-OK-0001"
        long_row["title"] = "A" * 161
        raw["open_work"].append(long_row)
        snap = ops.sanitize(raw)
        self.assertNotIn("title", snap["open_work"][0])
        self.assertNotIn("title", snap["open_work"][1])
        self.assertNotIn("title", snap["open_work"][-1])
        self.assertEqual([], ops.problems(snap))
        self.assertNotIn("blackboard", json.dumps(snap["open_work"]).lower())
        self.assertNotIn("motherboard", json.dumps(snap["open_work"]).lower())

    def test_token_shaped_note_is_dropped(self):
        shaped = "gh" + "p_" + ("a" * 8)
        raw = ops.sample_snap()
        raw["envs"][0]["note"] = shaped
        snap = ops.sanitize(raw)
        self.assertNotIn("note", snap["envs"][0])
        self.assertNotIn(shaped, json.dumps(snap))

    def test_unknown_phase_and_bad_clock_drop_the_row(self):
        raw = ops.sample_snap()
        raw["edges"].append({"from": "grok", "to": "codex", "phase": "CHAT", "ts": "yesterday"})
        snap = ops.sanitize(raw)
        self.assertEqual(len(ops.sample_snap()["edges"]), len(snap["edges"]))

    def test_byte_budget_trims_the_tail(self):
        raw = ops.sample_snap()
        raw["edges"] = [
            {"from": "grok", "to": "codex", "phase": "RESULT", "ts": "2026-09-26T06:05:00Z"}
            for _ in range(400)
        ]
        snap = ops.sanitize(raw)
        self.assertLessEqual(ops.compact_len(snap), ops.MAX_BYTES)
        self.assertGreater(len(raw["edges"]), len(snap["edges"]))


if __name__ == "__main__":
    unittest.main()
