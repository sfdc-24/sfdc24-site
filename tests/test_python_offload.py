"""Acceptance tests for the cheap Python offload scripts.

No live network. Local HTTP servers stand in for Pages. Git log is mocked.
"""
from __future__ import annotations

import hashlib
import importlib.util
import json
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock


def load(name: str):
    path = Path(__file__).resolve().parents[1] / "tools" / f"{name}.py"
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    return mod


log_eta = load("log_eta_lesson")
timeline = load("build_history_timeline")
smoke = load("site_smoke")
pages_wait = load("pages_wait")


class LogEtaLessonTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / "lessons.jsonl"

    def tearDown(self) -> None:
        self.temp.cleanup()

    def test_append_then_validate(self) -> None:
        rc = log_eta.main(
            [
                "--file",
                str(self.path),
                "--who",
                "test-bot",
                "--promise",
                "Ship offload scripts",
                "--eta-minutes",
                "15",
                "--actual-minutes",
                "12",
                "--outcome",
                "beat",
                "--why",
                "Thin PR",
                "--course-correct",
                "Keep scripts cheap",
                "--related",
                "PR#offload",
            ]
        )
        self.assertEqual(0, rc)
        self.assertEqual(0, log_eta.main(["--file", str(self.path), "--validate"]))
        rows, errors = log_eta.iter_jsonl(self.path)
        self.assertEqual([], errors)
        self.assertEqual(1, len(rows))
        self.assertEqual("beat", rows[0]["outcome"])
        self.assertEqual(15, rows[0]["eta_minutes"])
        self.assertEqual("PR#offload", rows[0]["related"])

    def test_delayed_requires_course_correct(self) -> None:
        rc = log_eta.main(
            [
                "--file",
                str(self.path),
                "--who",
                "test-bot",
                "--promise",
                "Ready to test",
                "--outcome",
                "failed",
            ]
        )
        self.assertEqual(2, rc)
        self.assertFalse(self.path.exists())

    def test_validate_rejects_bad_jsonl(self) -> None:
        self.path.write_text("{not json}\n", encoding="utf-8")
        self.assertEqual(1, log_eta.main(["--file", str(self.path), "--validate"]))

    def test_dry_run_does_not_write(self) -> None:
        rc = log_eta.main(
            [
                "--file",
                str(self.path),
                "--dry-run",
                "--who",
                "test-bot",
                "--promise",
                "noop",
                "--outcome",
                "on_time",
            ]
        )
        self.assertEqual(0, rc)
        self.assertFalse(self.path.exists())


class HistoryTimelineTests(unittest.TestCase):
    SAMPLE = (
        "abc1234\x1f2026-09-04T12:00:00-04:00\x1fFirst commit\n"
        "def5678\x1f2026-09-19T01:00:00-04:00\x1fLater commit\n"
    )

    def test_parse_and_payload(self) -> None:
        events = timeline.parse_log(self.SAMPLE)
        self.assertEqual(2, len(events))
        self.assertEqual("abc1234", events[0]["sha"])
        payload = timeline.build_payload(events)
        self.assertEqual(2, payload["count"])
        self.assertEqual("2026-09-04", payload["since"])
        self.assertEqual("24 hour clock", payload["title"])
        self.assertEqual("America/Toronto", payload["timezone"])

    def test_write_and_check(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "history-timeline.json"
            # Through merge(), as main() does: assets/history-timeline.js draws
            # rows in file order, so --check now rejects a file that is not
            # newest first, and SAMPLE is oldest first.
            events = timeline.merge(timeline.parse_log(self.SAMPLE), [])
            timeline.write_timeline(timeline.build_payload(events), out)
            self.assertEqual(0, timeline.main(["--check", "--out", str(out)]))

    def test_check_fails_on_count_drift(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "history-timeline.json"
            out.write_text(
                json.dumps({"since": "2026-09-04", "count": 99, "events": []}) + "\n",
                encoding="utf-8",
            )
            self.assertEqual(1, timeline.main(["--check", "--out", str(out)]))

    def test_main_uses_git_log(self) -> None:
        # THE CONTRACT CHANGED ON 2026-09-19 AND THIS TEST CAUGHT IT, which is
        # the test doing its job rather than being in the way. The payload used
        # to be exactly the git log. It is now the git log MERGED with curated
        # events that are not commits in this repository - the board gateway,
        # the message intake, the backend deployments, all of which predate the
        # first commit here by ten days. Asserting a bare 2 would now assert
        # that the merge does not happen.
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "history-timeline.json"
            with mock.patch.object(timeline, "git_log", return_value=self.SAMPLE):
                rc = timeline.main(["--out", str(out)])
            self.assertEqual(0, rc)
            data = json.loads(out.read_text(encoding="utf-8"))
            shas = [e.get("sha") for e in data["events"]]
            self.assertIn("abc1234", shas)
            self.assertIn("def5678", shas)
            self.assertEqual(
                len(timeline.parse_log(self.SAMPLE)) + len(timeline.load_milestones()),
                data["count"],
                "payload must be exactly the git log plus the curated milestones",
            )
            self.assertEqual(data["count"], len(data["events"]))

    def test_milestones_are_optional_and_additive(self) -> None:
        # A checkout without the milestones file must still produce a true,
        # smaller timeline rather than failing - and the merge must add nothing
        # of its own when there is nothing to add.
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "history-timeline.json"
            missing = Path(tmp) / "no-such-milestones.json"
            with mock.patch.object(timeline, "MILESTONES", missing):
                with mock.patch.object(timeline, "git_log", return_value=self.SAMPLE):
                    rc = timeline.main(["--out", str(out)])
            self.assertEqual(0, rc)
            data = json.loads(out.read_text(encoding="utf-8"))
            self.assertEqual(2, data["count"])

    def test_merge_orders_by_instant_not_by_string(self) -> None:
        # 01:30Z is 21:30 the evening before in Toronto, so it is OLDER than
        # 22:00-04:00. As strings "2026-09-20T01:30Z" sorts after
        # "2026-09-19T22:00-04:00" and landed first (Cursor on #175).
        commits = timeline.parse_log(
            "aaa1111\x1f2026-09-19T22:00:00-04:00\x1fLater in Toronto\n"
        )
        milestones = [{"ts": "2026-09-20T01:30:00Z", "subject": "Earlier", "source": "s"}]
        merged = timeline.merge(commits, milestones)
        self.assertEqual(["Later in Toronto", "Earlier"], [e["subject"] for e in merged])

    def test_git_output_is_decoded_as_utf8(self) -> None:
        seen = {}

        def fake(args, **kwargs):
            seen.update(kwargs)
            return ""
        with mock.patch.object(timeline.subprocess, "check_output", fake):
            timeline.git_log("2026-09-04", Path("."))
        self.assertEqual("utf-8", seen.get("encoding"))

    def test_a_bare_date_is_midnight_in_toronto(self) -> None:
        # git reads a bare date as that date at the current time of day, which
        # dropped the Sep 4 commits made after the hour the script ran.
        self.assertEqual("2026-09-04T00:00:00-04:00", timeline.git_since("2026-09-04"))
        self.assertEqual("2026-09-04 12:00", timeline.git_since("2026-09-04 12:00"))

    def test_private_repo_citations_are_dropped(self) -> None:
        raw = (
            "66f1e06\x1f2026-09-23T10:00:00-04:00\x1f"
            "Studio contract: /health, voice refusals (Blackboard #206, #210)\n"
            "1111111\x1f2026-09-23T09:00:00-04:00\x1fPort from Blackboard #99 to the site\n"
            "2222222\x1f2026-09-23T08:00:00-04:00\x1fstyle(chrome): quiet borders (#107)\n"
            "3333333\x1f2026-09-23T07:00:00-04:00\x1f\ufeffPublish the prototype (#27)\n"
        )
        subjects = [e["subject"] for e in timeline.parse_log(raw)]
        self.assertEqual(
            [
                "Studio contract: /health, voice refusals",
                "Port from Blackboard to the site",
                "style(chrome): quiet borders (#107)",
                "Publish the prototype (#27)",
            ],
            subjects,
        )

    def test_check_rejects_the_three_defects(self) -> None:
        good = {"sha": "a", "ts": "2026-09-20T10:00:00-04:00", "subject": "ok"}
        cases = {
            # what the string sort produced: the older Z row first
            "order": [
                {"sha": "c", "ts": "2026-09-20T01:30:00Z", "subject": "y"},
                {"sha": "b", "ts": "2026-09-19T22:00:00-04:00", "subject": "x"},
            ],
            "mojibake": [good, {"sha": "d", "ts": "2026-09-19T10:00:00-04:00",
                                "subject": "a \u00e2\u20ac\u201d b"}],
            "private": [good, {"sha": "e", "ts": "2026-09-19T10:00:00-04:00",
                               "subject": "x (Blackboard #206)"}],
        }
        for name, events in cases.items():
            with self.subTest(name), tempfile.TemporaryDirectory() as tmp:
                out = Path(tmp) / "history-timeline.json"
                payload = timeline.build_payload(events, min(e["ts"][:10] for e in events))
                out.write_text(json.dumps(payload) + "\n", encoding="utf-8")
                self.assertEqual(1, timeline.main(["--check", "--out", str(out)]))

    def test_milestone_rows_carry_a_source_and_no_sha(self) -> None:
        # A row with no sha is what tells the renderer NOT to link it. Every
        # curated row must therefore carry a source instead, or the page shows
        # a citation-less claim the reader cannot check.
        for ev in timeline.load_milestones():
            self.assertNotIn("sha", ev, "a curated row must never look like a commit here")
            self.assertTrue(ev.get("source"), "every curated row cites where it can be checked")
            self.assertTrue(ev.get("ts") and ev.get("subject"))


class _Handler(BaseHTTPRequestHandler):
    payload = b"ok"
    status = 200
    hits = 0
    fail_first = 0

    def log_message(self, fmt: str, *args) -> None:  # noqa: A003
        return

    def do_GET(self) -> None:  # noqa: N802
        type(self).hits += 1
        if type(self).hits <= type(self).fail_first:
            self.send_response(404)
            self.end_headers()
            return
        self.send_response(type(self).status)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(type(self).payload)))
        self.end_headers()
        self.wfile.write(type(self).payload)


def start_server(handler_cls) -> tuple[ThreadingHTTPServer, str]:
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler_cls)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    host, port = server.server_address[:2]
    return server, f"http://{host}:{port}"


class SiteSmokeTests(unittest.TestCase):
    def test_ok_prints_ttfb(self) -> None:
        class H(_Handler):
            payload = b"homepage"
            hits = 0
            fail_first = 0
            status = 200

        server, base = start_server(H)
        try:
            rc = smoke.main(["--base", base, "--timeout", "2"])
            self.assertEqual(0, rc)
        finally:
            server.shutdown()

    def test_nonzero_on_404(self) -> None:
        class H(_Handler):
            payload = b"nope"
            hits = 0
            fail_first = 0
            status = 404

        server, base = start_server(H)
        try:
            rc = smoke.main(["--base", base, "--timeout", "2"])
            self.assertEqual(1, rc)
        finally:
            server.shutdown()

    def test_require_markers_fails_without_boundary(self) -> None:
        class H(_Handler):
            payload = b"<html><body>nope</body></html>"
            hits = 0
            fail_first = 0
            status = 200

        server, base = start_server(H)
        try:
            rc = smoke.main(["--base", base, "--timeout", "2", "--require-markers"])
            self.assertEqual(1, rc)
        finally:
            server.shutdown()

    def test_require_markers_needs_static_skate_on_method(self) -> None:
        class H(_Handler):
            payload = b'<p id="honest-boundary">x</p>'
            hits = 0
            fail_first = 0
            status = 200

        server, base = start_server(H)
        try:
            rc = smoke.main(["--base", base, "--timeout", "2", "--require-markers"])
            self.assertEqual(1, rc)
        finally:
            server.shutdown()

    def test_require_markers_ok(self) -> None:
        class H(_Handler):
            payload = b'<p id="honest-boundary">x</p><div id="skateboarder"></div>'
            hits = 0
            fail_first = 0
            status = 200

        server, base = start_server(H)
        try:
            rc = smoke.main(["--base", base, "--timeout", "2", "--require-markers"])
            self.assertEqual(0, rc)
        finally:
            server.shutdown()


class PagesWaitTests(unittest.TestCase):
    def test_waits_until_200(self) -> None:
        class H(_Handler):
            payload = b"cabinet"
            hits = 0
            fail_first = 2
            status = 200

        server, base = start_server(H)
        try:
            rc = pages_wait.main(
                [
                    "--base",
                    base,
                    "--path",
                    "/assets/cabinet.js",
                    "--timeout",
                    "4",
                    "--interval",
                    "0.05",
                    "--request-timeout",
                    "1",
                ]
            )
            self.assertEqual(0, rc)
            self.assertGreaterEqual(H.hits, 3)
        finally:
            server.shutdown()

    def test_hash_mismatch_times_out(self) -> None:
        class H(_Handler):
            payload = b"wrong-body"
            hits = 0
            fail_first = 0
            status = 200

        server, base = start_server(H)
        try:
            rc = pages_wait.main(
                [
                    "--base",
                    base,
                    "--path",
                    "/",
                    "--sha256",
                    "0" * 64,
                    "--timeout",
                    "0.3",
                    "--interval",
                    "0.05",
                    "--request-timeout",
                    "1",
                ]
            )
            self.assertEqual(1, rc)
        finally:
            server.shutdown()

    def test_hash_match(self) -> None:
        body = b"next-deploy"
        digest = hashlib.sha256(body).hexdigest()

        class H(_Handler):
            payload = body
            hits = 0
            fail_first = 0
            status = 200

        server, base = start_server(H)
        try:
            rc = pages_wait.main(
                [
                    "--base",
                    base,
                    "--path",
                    "/assets/next-deploy.js",
                    "--sha256",
                    digest,
                    "--timeout",
                    "2",
                    "--interval",
                    "0.05",
                ]
            )
            self.assertEqual(0, rc)
        finally:
            server.shutdown()


class CommittedArtifactsTests(unittest.TestCase):
    ROOT = Path(__file__).resolve().parents[1]

    def test_estimate_lessons_valid(self) -> None:
        self.assertEqual(
            0,
            log_eta.main(["--file", str(self.ROOT / "data" / "estimate-lessons.jsonl"), "--validate"]),
        )

    def test_history_timeline_valid(self) -> None:
        self.assertEqual(
            0,
            timeline.main(["--check", "--out", str(self.ROOT / "data" / "history-timeline.json")]),
        )


if __name__ == "__main__":
    unittest.main()
