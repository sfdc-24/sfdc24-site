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
            timeline.write_timeline(timeline.build_payload(timeline.parse_log(self.SAMPLE)), out)
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
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "history-timeline.json"
            with mock.patch.object(timeline, "git_log", return_value=self.SAMPLE):
                rc = timeline.main(["--out", str(out)])
            self.assertEqual(0, rc)
            data = json.loads(out.read_text(encoding="utf-8"))
            self.assertEqual(2, data["count"])


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
