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
            "repo": "sfdc24-site", "conclusion": "failure", "name": "honesty-dom-test",
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
        self.assertEqual(482, snap["open_work"][0]["pr"])
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


class Bake(unittest.TestCase):
    def test_offline_bake_is_quiet_and_valid(self):
        snap = ops.bake("2026-09-26T06:30:00Z", ci=[], envs=[], export=None)
        self.assertEqual([], ops.problems(snap))
        self.assertEqual("bake", snap["source"])
        self.assertEqual(["claude-code-cli", "codex", "cursor", "grok"], sorted(a["id"] for a in snap["agents"]))
        self.assertTrue(all(a["status"] == "quiet" for a in snap["agents"]))
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
        self.assertEqual("hot", snap["agents"][0]["status"])
        self.assertEqual(1, snap["stats"]["dispatch_open"])
        self.assertEqual(1, snap["stats"]["result_1h"])
        self.assertEqual(1, snap["stats"]["nogo_1h"])
        self.assertEqual(6, snap["stats"]["median_ack_min"])
        self.assertEqual(80, snap["stats"]["rows_sampled"])

    def test_fetch_never_calls_a_bus_and_a_failed_repo_is_skipped(self):
        payload = {"workflow_runs": [{
            "name": "honesty-dom-test",
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

    def test_main_offline_writes_a_valid_file(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "data" / "board-ops-snap.json"
            code = ops.main(["--bake", "--offline", "--out", str(out)])
            self.assertEqual(0, code)
            self.assertEqual([], ops.validate(out))


class Page(unittest.TestCase):
    def test_route_is_unlisted_and_the_homepage_does_not_load_the_diagram(self):
        page = (REPO / "ops" / "index.html").read_text(encoding="utf-8")
        redirect = (REPO / "operating-model" / "index.html").read_text(encoding="utf-8")
        script = (REPO / "assets" / "board-ops.js").read_text(encoding="utf-8")
        home = (REPO / "index.html").read_text(encoding="utf-8")
        sitemap = (REPO / "sitemap.xml").read_text(encoding="utf-8")
        chrome = (REPO / "assets" / "chrome.js").read_text(encoding="utf-8")
        self.assertIn('content="noindex"', page)
        self.assertIn(">Ops<", page)
        self.assertIn("Communication &amp; Control BUS", page)
        self.assertIn("One ways-of-working", page)
        self.assertIn("Owner lanes", page)
        self.assertIn("exact head", page)
        self.assertIn("Mechanisms, not reminders", page)
        self.assertIn("ask-gate", page)
        self.assertNotIn("motherboard", page.lower())
        self.assertNotIn("BLACKBOARD", page)
        self.assertNotIn("honesty-dom", page)
        self.assertNotIn("/operating-model", sitemap)
        self.assertNotIn("/ops/", sitemap)
        self.assertIn('href="/ops/">Ops</a>', home)
        self.assertNotIn("board-ops.js", home)
        self.assertNotIn("board-ops.js", chrome)
        self.assertIn('"/ops/", "Ops"', chrome)
        self.assertIn('content="noindex"', redirect)
        self.assertIn("url=/ops/", redirect)
        self.assertIn('href="/ops/"', redirect)
        self.assertNotIn("board-ops.js", redirect)
        self.assertIn("/data/board-ops-snap.json", script)
        self.assertIn("board-ops-snap", script)
        for banned in ("script.google", "spreadsheets", "alpha-db", "/macros/"):
            self.assertNotIn(banned, script)
            self.assertNotIn(banned, page)
        self.assertIn("not a live bus", page)
        self.assertIn('rel="icon"', page)
        self.assertIn('class="chrome-foot"', page)
        workflow = (REPO / ".github" / "workflows" / "board-ops-snap.yml").read_text(encoding="utf-8")
        self.assertIn("board-ops-snap", workflow)
        self.assertNotIn("HEAD:main", workflow)
        self.assertNotIn("git push", workflow.split("board-ops-snap", 1)[0])

    def test_workflow_pushes_the_snap_branch_only(self):
        workflow = (REPO / ".github" / "workflows" / "board-ops-snap.yml").read_text(encoding="utf-8")
        self.assertIn("HEAD:board-ops-snap", workflow)
        self.assertNotIn("branches: [main]", workflow)


if __name__ == "__main__":
    unittest.main()
