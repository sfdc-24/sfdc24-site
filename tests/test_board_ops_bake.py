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


class Bake(unittest.TestCase):
    def test_offline_bake_is_quiet_and_valid(self):
        snap = ops.bake("2026-09-26T06:30:00Z", ci=[], envs=[], export=None)
        self.assertEqual([], ops.problems(snap))
        self.assertEqual("bake", snap["source"])
        self.assertEqual(["claude-code-cli", "codex", "copilot", "cursor", "gemini", "grok"], sorted(a["id"] for a in snap["agents"]))
        self.assertTrue(all(a["status"] == "idle" for a in snap["agents"]))
        self.assertIsNone(snap["stats"]["median_ack_min"])

    def test_export_drives_status_and_median(self):
        snap = ops.bake("2026-09-26T06:30:00Z", export={
            "ack_minutes": [2, 10],
            "rows_sampled": 80,
            "agents": [
                {"id": "grok", "writes_1h": 5, "open_dispatch": 2, "last_seen": "2026-09-26T06:28:00Z"},
            ],
            "open_work": [
                {"id": "GROK-OPS-1", "from": "grok", "to": ["codex"], "phase": "DISPATCH", "age_min": 3},
            ],
            "edges": [
                {"from": "grok", "to": "codex", "phase": "RESULT", "ts": "2026-09-26T06:20:00Z"},
                {"from": "codex", "to": "grok", "phase": "NOGO", "ts": "2026-09-26T06:10:00Z"},
            ],
        })
        self.assertEqual("active", snap["agents"][0]["status"])
        self.assertEqual(1, snap["stats"]["dispatch_open"])
        self.assertEqual(1, snap["stats"]["result_1h"])
        self.assertEqual(1, snap["stats"]["nogo_1h"])
        self.assertEqual(6, snap["stats"]["median_ack_min"])
        self.assertEqual(80, snap["stats"]["rows_sampled"])

    def test_fetch_never_calls_a_bus_and_a_failed_repo_is_skipped(self):
        payload = {"workflow_runs": [{
            "name": "homepage-browser-tests",
            "conclusion": "success",
            "html_url": "https://github.com/sfdc-24/sfdc24-site/actions/runs/4",
            "updated_at": "2026-09-26T06:00:00Z",
        }]}
        opener = Opener(
            routes={"sfdc24-site": payload},
            fail={"Blackboard": urllib.error.URLError("nope")},
        )
        rows = ops.fetch_ci("fixture", opener=opener)
        self.assertEqual(1, len(rows))
        self.assertEqual("success", rows[0]["conclusion"])
        self.assertTrue(all("script.google" not in url and "spreadsheet" not in url for url in opener.urls))
        self.assertIsNone(ops._get_json("https://script.google.com/macros/s/x/exec", "t", opener, 1))

    def test_a_token_that_cannot_see_the_other_repo_falls_back_to_public(self):
        class Limited:
            def __init__(self):
                self.calls = []

            def __call__(self, request, timeout=None):
                authed = bool(request.get_header("Authorization"))
                self.calls.append((request.full_url, authed))
                if authed:
                    raise urllib.error.HTTPError(request.full_url, 403, "no", {}, None)
                if "Blackboard" in request.full_url:
                    body = {"workflow_runs": [{
                        "name": "example-check", "conclusion": "failure",
                        "html_url": "https://github.com/sfdc-24/Blackboard/actions/runs/8",
                        "updated_at": "2026-09-26T05:00:00Z",
                    }]}
                    return Response(200, json.dumps(body).encode("utf-8"))
                return Response(200, b'{"workflow_runs":[]}')

        opener = Limited()
        rows = ops.fetch_ci("fixture", opener=opener)
        self.assertEqual([("Blackboard", "failure")], [(r["repo"], r["conclusion"]) for r in rows])
        self.assertTrue(any(not authed and "Blackboard" in url for url, authed in opener.calls))

    def test_probes_map_status_and_match_the_speed_log_hosts(self):
        self.assertEqual(speed.WWW, ops.WWW)
        self.assertEqual(speed.CONTROLLER, ops.CONTROLLER)
        opener = Opener(routes={"/health": 503}, fail={ops.WWW: TimeoutError("slow")})
        envs = {row["id"]: row for row in ops.probe_envs(opener)}
        self.assertEqual("unknown", envs["www"]["health"])
        self.assertEqual("degraded", envs["studio-r6"]["health"])
        self.assertNotIn("traffic_pct", envs["studio-r6"])
        self.assertEqual(envs["www"]["health"], envs["pages"]["health"])

    def test_actions_timestamp_with_offset_becomes_z(self):
        rows = ops.ci_from_payload("Blackboard", {"workflow_runs": [{
            "name": "example-check",
            "conclusion": None,
            "html_url": "https://evil.example/not-github",
            "updated_at": "2026-09-26T06:00:00.123456Z",
        }]})
        self.assertEqual("unknown", rows[0]["conclusion"])
        self.assertEqual("2026-09-26T06:00:00Z", rows[0]["ts"])
        clean = ops._clean_ci(rows[0])
        self.assertNotIn("url", clean)

    def test_roster_uses_real_timestamps_and_does_not_invent_writes(self):
        baked = "2026-09-28T21:55:00Z"
        pulls = [
            {
                "number": 249,
                "title": "Ops: live States strip, productivity, and activity log",
                "updated_at": "2026-09-28T21:51:08Z",
                "head": {"ref": "cursor/ops-productivity-live-9a53"},
            },
            {
                "number": 66,
                "title": "The bus-client suite runs on Linux, and the leak detector fails open there",
                "updated_at": "2026-09-11T02:57:41Z",
                "head": {"ref": "vm-claude-code-cli/read-resilience-on-linux"},
            },
            {
                "number": 280,
                "title": "Gate heavy local agent work behind host headroom",
                "updated_at": "2026-09-27T01:06:00Z",
                "head": {"ref": "codex/host-resource-governor"},
            },
        ]
        delivery = [
            {
                "id": "ops-repair",
                "title": "Ops refresh, roles and mobile repair",
                "owner": "Grok",
                "status": "blocked",
                "observed_at": "2026-09-28T19:15:08Z",
            },
            {
                "id": "ops-gantt",
                "title": "Delivery Gantt at the top of Ops",
                "owner": "Codex",
                "status": "verified",
                "observed_at": "2026-09-27T17:18:16Z",
            },
        ]
        roster = ops.roster_export(pulls, delivery, baked)
        by = {row["id"]: row for row in roster["agents"]}
        self.assertTrue(all(row["writes_1h"] == 0 for row in roster["agents"]))
        self.assertEqual("active", by["cursor"]["status"])
        self.assertEqual("2026-09-28T21:51:08Z", by["cursor"]["last_seen"])
        self.assertIn("productivity", by["cursor"]["task"])
        self.assertEqual("assigned", by["grok"]["status"])
        self.assertEqual("2026-09-28T19:15:08Z", by["grok"]["last_seen"])
        self.assertEqual("Ops refresh, roles and mobile repair", by["grok"]["task"])
        self.assertEqual("assigned", by["claude-code-cli"]["status"])
        self.assertEqual("2026-09-11T02:57:41Z", by["claude-code-cli"]["last_seen"])
        self.assertIn("leak detector", by["claude-code-cli"]["task"])
        self.assertEqual("assigned", by["codex"]["status"])
        self.assertNotIn("Gantt", by["codex"]["task"])
        self.assertEqual("idle", by["gemini"]["status"])
        self.assertNotIn("task", by["gemini"])
        snap = ops.bake(baked, export=roster)
        self.assertEqual([], ops.problems(snap))
        cursor = next(row for row in snap["agents"] if row["id"] == "cursor")
        self.assertEqual(0, cursor["writes_1h"])
        self.assertEqual("active", cursor["status"])

    def test_quiet_bake_keeps_previous_activity(self):
        previous = ops.bake("2026-09-28T19:00:00Z", export={
            "agents": [{
                "id": "cursor",
                "writes_1h": 0,
                "open_dispatch": 1,
                "last_seen": "2026-09-28T18:50:00Z",
                "status": "hot",
                "task": "Ops live States strip, productivity, and activity log",
                "phase": "COMMIT",
            }],
        })
        fresh = ops.bake("2026-09-28T21:55:00Z", ci=[], envs=[], export=None)
        self.assertTrue(all(row["status"] == "idle" for row in fresh["agents"]))
        kept = ops.retain_activity(previous, fresh)
        cursor = next(row for row in kept["agents"] if row["id"] == "cursor")
        self.assertEqual("active", cursor["status"])
        self.assertEqual(0, cursor["writes_1h"])
        self.assertIn("productivity", cursor["task"])
        self.assertEqual("2026-09-28T21:55:00Z", kept["baked_at"])
        self.assertEqual("bake", kept["source"])

    def test_pull_fetch_stays_on_github_and_refuses_a_bus(self):
        opener = Opener(routes={"pulls?": [{"number": 1, "title": "x", "updated_at": "2026-09-28T21:00:00Z", "head": {"ref": "cursor/x"}}]})
        rows = ops.fetch_pulls(None, opener=opener)
        self.assertEqual(2, len(rows))
        self.assertTrue(all("script.google" not in url and "spreadsheet" not in url for url in opener.urls))
        self.assertTrue(all("/pulls?" in url for url in opener.urls))
        self.assertIsNone(ops._get_json("https://script.google.com/macros/s/x/exec", None, opener, 1))

    def test_main_offline_writes_a_valid_file(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "data" / "board-ops-snap.json"
            code = ops.main(["--bake", "--offline", "--out", str(out)])
            self.assertEqual(0, code)
            self.assertEqual([], ops.validate(out))


if __name__ == "__main__":
    unittest.main()
