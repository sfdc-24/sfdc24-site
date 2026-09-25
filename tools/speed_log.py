#!/usr/bin/env python3
"""Post-deploy SPEED log for www.sfdc24.com and the studio controller. No model calls.

Cycle: Detect → Script → Validate N cycles → Measure → Retire model path
(docs/python-offload.md). Replaces the Foundry SPEED cron (board row
GROK-SPEED-POSTDEPLOY-GITLOG-20260925T1213Z): after each Pages deploy, time
the pages a visitor loads first and the controller's health, and append one
JSONL line per probe. The workflow (.github/workflows/speed-log.yml) commits
the file to the speed-log branch, never main, so logging never triggers a
Pages build.

One line per probe, schema v1 (Codex owns the schema and its acceptance):
  {"v": 1, "ts": "2026-09-25T12:23:40Z", "sha": "<deployed commit>", "run": "<workflow run id>",
   "target": "www" | "controller", "path": "/", "status": 200, "ms": 84.2, "ok": true}
A failed probe is still logged (ok false, status 0 on a network error); the
exit code is 1 when any probe failed, after the lines are written.

  python3 tools/speed_log.py --out speed/history.jsonl --sha "$GITHUB_SHA" --run "$GITHUB_RUN_ID"
  python3 tools/speed_log.py --validate speed/history.jsonl
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

WWW = "https://www.sfdc24.com"
CONTROLLER = "https://sfdc24-studio-controller-96522051727.us-central1.run.app"
# What a visitor's first seconds load, and the controller the homepage talks to.
PROBES = (
    ("www", WWW, "/"),
    ("www", WWW, "/assets/voice-conversation.js"),
    ("www", WWW, "/assets/prototype-canvas.js"),
    ("www", WWW, "/data/next-release.json"),
    ("controller", CONTROLLER, "/health?probe=1"),      # fleet probes say probe=1
)
UA = "sfdc24-speed-log/1.0 (+https://www.sfdc24.com)"
FIELDS = {"v", "ts", "sha", "run", "target", "path", "status", "ms", "ok"}
TARGETS = {"www", "controller"}
SHA_RE = re.compile(r"^[0-9a-f]{7,40}$|^$")
TS_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")


def now_utc() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def probe(url: str, timeout: float, opener=urllib.request.urlopen, clock=time.perf_counter) -> tuple[int, float]:
    """(status, ms to the first byte); status 0 on a network error."""
    request = urllib.request.Request(url, method="GET", headers={"User-Agent": UA, "Cache-Control": "no-cache"})
    t0 = clock()
    try:
        with opener(request, timeout=timeout) as response:
            ms = (clock() - t0) * 1000
            response.read(64)
            return int(response.status), round(ms, 1)
    except urllib.error.HTTPError as exc:
        return int(exc.code), round((clock() - t0) * 1000, 1)
    except Exception:  # noqa: BLE001 - a failed probe is a logged line, never a crash
        return 0, round((clock() - t0) * 1000, 1)


def measure(sha: str, run: str, timeout: float = 10.0, probes=PROBES, opener=urllib.request.urlopen,
            clock=time.perf_counter, stamp=now_utc) -> list[dict]:
    ts = stamp()
    lines = []
    for target, base, path in probes:
        status, ms = probe(base + path, timeout, opener, clock)
        lines.append({"v": 1, "ts": ts, "sha": sha, "run": run, "target": target, "path": path,
                      "status": status, "ms": ms, "ok": 200 <= status < 300})
    return lines


def problems(line) -> list[str]:
    """Why a line breaks schema v1; empty when it is clean."""
    if not isinstance(line, dict) or set(line) != FIELDS:
        return ["fields must be exactly " + ", ".join(sorted(FIELDS))]
    out = []
    if line["v"] != 1:
        out.append("v must be 1")
    if not isinstance(line["ts"], str) or not TS_RE.match(line["ts"]):
        out.append("ts must be UTC like 2026-09-25T12:23:40Z")
    if not isinstance(line["sha"], str) or not SHA_RE.match(line["sha"]):
        out.append("sha must be a hex commit id or empty")
    if not isinstance(line["run"], str):
        out.append("run must be a string")
    if line["target"] not in TARGETS:
        out.append("target must be www or controller")
    if not isinstance(line["path"], str) or not line["path"].startswith("/"):
        out.append("path must start with /")
    if type(line["status"]) is not int or not 0 <= line["status"] <= 599:
        out.append("status must be an int 0-599")
    if type(line["ms"]) not in (int, float) or line["ms"] < 0:
        out.append("ms must be a non-negative number")
    if type(line["ok"]) is not bool or (type(line["status"]) is int and line["ok"] != (200 <= line["status"] < 300)):
        out.append("ok must be true exactly when status is 2xx")
    return out


def append(path: Path, lines: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8", newline="\n") as fh:
        for line in lines:
            fh.write(json.dumps(line, sort_keys=True) + "\n")


def validate(path: Path) -> list[str]:
    bad = []
    if not path.exists():
        return bad
    for n, raw in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not raw.strip():
            continue
        try:
            line = json.loads(raw)
        except ValueError:
            bad.append("line %d: not JSON" % n)
            continue
        bad.extend("line %d: %s" % (n, p) for p in problems(line))
    return bad


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Post-deploy SPEED log (JSONL, one line per probe)")
    ap.add_argument("--out", type=Path, help="JSONL file to append to")
    ap.add_argument("--sha", default="", help="The deployed commit")
    ap.add_argument("--run", default="", help="The workflow run id")
    ap.add_argument("--timeout", type=float, default=10.0)
    ap.add_argument("--validate", type=Path, metavar="FILE", help="Check a history file against schema v1")
    args = ap.parse_args(argv)
    if args.validate:
        bad = validate(args.validate)
        for b in bad:
            print(b)
        print("ok" if not bad else "%d problem(s)" % len(bad))
        return 1 if bad else 0
    if not args.out:
        ap.error("--out is required unless --validate")
    if not SHA_RE.match(args.sha):
        ap.error("--sha must be a hex commit id")
    lines = measure(args.sha, args.run, args.timeout)
    append(args.out, lines)
    for line in lines:
        print("%s  %7.1fms  %3d  %s%s" % ("OK  " if line["ok"] else "FAIL", line["ms"], line["status"],
                                          line["target"], line["path"]))
    return 0 if all(line["ok"] for line in lines) else 1


if __name__ == "__main__":
    sys.exit(main())
