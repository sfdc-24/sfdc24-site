"""tools/speed_log.py: the post-deploy SPEED log. No live network; a fake
opener stands in for www and the controller."""
from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import unittest
import urllib.error
from pathlib import Path


def load(name: str):
    path = Path(__file__).resolve().parents[1] / "tools" / f"{name}.py"
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    return mod


speed = load("speed_log")


class Response:
    def __init__(self, status):
        self.status = status

    def read(self, n=-1):
        return b"x"

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class Opener:
    def __init__(self, statuses=None, fail=None):
        self.statuses = statuses or {}
        self.fail = fail or {}
        self.urls = []

    def __call__(self, request, timeout=None):
        url = request.full_url
        self.urls.append((url, timeout, request.get_header("User-agent")))
        for needle, exc in self.fail.items():
            if needle in url:
                raise exc
        for needle, status in self.statuses.items():
            if needle in url:
                if status >= 400:
                    raise urllib.error.HTTPError(url, status, "err", {}, None)
                return Response(status)
        return Response(200)


def ticking():
    t = [0.0]

    def clock():
        t[0] += 0.05
        return t[0]
    return clock


SHA = "c1f9363" + "0" * 33


class Measure(unittest.TestCase):
    def test_one_clean_line_per_probe_with_the_deployed_commit(self):
        opener = Opener()
        lines = speed.measure(SHA, "123", opener=opener, clock=ticking(), stamp=lambda: "2026-09-25T12:23:40Z")
        self.assertEqual(len(speed.PROBES), len(lines))
        for line in lines:
            self.assertEqual([], speed.problems(line), line)
            self.assertEqual((SHA, "123", 1, True), (line["sha"], line["run"], line["v"], line["ok"]))
            self.assertEqual(50.0, line["ms"])
        self.assertEqual({"www", "controller"}, {line["target"] for line in lines})

    def test_the_controller_probe_says_probe_1(self):
        opener = Opener()
        speed.measure(SHA, "1", opener=opener, clock=ticking())
        health = [u for u, _, _ in opener.urls if "/health" in u]
        self.assertEqual([speed.CONTROLLER + "/health?probe=1"], health)
        self.assertTrue(all(ua.startswith("sfdc24-speed-log/") for _, _, ua in opener.urls))

    def test_failures_are_logged_not_raised(self):
        opener = Opener(statuses={"prototype-canvas": 404}, fail={"/health": TimeoutError("slow")})
        lines = speed.measure(SHA, "1", opener=opener, clock=ticking())
        by_path = {line["path"]: line for line in lines}
        self.assertEqual((404, False), (by_path["/assets/prototype-canvas.js"]["status"],
                                        by_path["/assets/prototype-canvas.js"]["ok"]))
        self.assertEqual((0, False), (by_path["/health?probe=1"]["status"], by_path["/health?probe=1"]["ok"]))
        for line in lines:
            self.assertEqual([], speed.problems(line), line)


class History(unittest.TestCase):
    def test_append_never_overwrites_and_the_file_validates(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "speed" / "history.jsonl"
            for run in ("1", "2"):
                speed.append(out, speed.measure(SHA, run, opener=Opener(), clock=ticking()))
            raw = out.read_bytes()
            self.assertNotIn(b"\r\n", raw)
            rows = [json.loads(x) for x in raw.decode("utf-8").splitlines()]
            self.assertEqual(2 * len(speed.PROBES), len(rows))
            self.assertEqual(["1", "2"], sorted({r["run"] for r in rows}))
            self.assertEqual([], speed.validate(out))

    def test_the_validator_names_each_broken_rule(self):
        good = speed.measure(SHA, "1", opener=Opener(), clock=ticking())[0]
        cases = {
            "an extra field": dict(good, note="x"),
            "a missing field": {k: v for k, v in good.items() if k != "ms"},
            "a local time": dict(good, ts="2026-09-25 08:23"),
            "a branch name for sha": dict(good, sha="main"),
            "an unknown target": dict(good, target="foundry"),
            "a relative path": dict(good, path="health"),
            "ok on a 500": dict(good, status=500, ok=True),
            "a string status": dict(good, status="200"),
            "a negative time": dict(good, ms=-1),
            "a bool status": dict(good, status=True),
        }
        for name, line in cases.items():
            self.assertTrue(speed.problems(line), name)
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "h.jsonl"
            out.write_text(json.dumps(good) + "\nnot json\n" + json.dumps(cases["ok on a 500"]) + "\n", encoding="utf-8")
            bad = speed.validate(out)
            self.assertEqual(["line 2", "line 3"], [b.split(":")[0] for b in bad])

    def test_main_writes_then_exits_1_on_a_failed_probe(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "h.jsonl"
            real = speed.measure
            speed.measure = lambda sha, run, timeout: [dict(real(sha, run, opener=Opener(statuses={"/": 503}),
                                                                 clock=ticking())[0])]
            try:
                code = speed.main(["--out", str(out), "--sha", SHA, "--run", "9"])
            finally:
                speed.measure = real
            self.assertEqual(1, code)
            self.assertEqual(1, len(out.read_text(encoding="utf-8").splitlines()))
            self.assertEqual(0, speed.main(["--validate", str(out)]))


if __name__ == "__main__":
    unittest.main()
