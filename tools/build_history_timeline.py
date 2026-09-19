#!/usr/bin/env python3
"""Build data/history-timeline.json from git log since 2026-09-04.

Cycle: Detect → Script → Validate N cycles → Measure → Retire model path
(docs/python-offload.md). Models still choose what to narrate.

Schema is consumed by assets/history-timeline.js on /history/:
  {since, timezone, title, started, count, events: [{sha, ts, subject}]}

  python3 tools/build_history_timeline.py
  python3 tools/build_history_timeline.py --since 2026-09-04 --check
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "data" / "history-timeline.json"
SINCE = "2026-09-04"
TITLE = "AI Fitness — 24"
TZ_NAME = "America/Toronto"


def parse_log(raw: str) -> list[dict]:
    events: list[dict] = []
    for line in raw.splitlines():
        if not line.strip():
            continue
        parts = line.split("\x1f", 2)
        if len(parts) < 3:
            continue
        sha, ts, subject = parts
        events.append({"sha": sha, "ts": ts, "subject": subject})
    return events


def build_payload(events: list[dict], since: str = SINCE) -> dict:
    return {
        "since": since,
        "timezone": TZ_NAME,
        "title": TITLE,
        "started": since,
        "count": len(events),
        "events": events,
    }


def git_log(since: str, cwd: Path) -> str:
    return subprocess.check_output(
        [
            "git",
            "log",
            f"--since={since}",
            "--pretty=format:%h%x1f%aI%x1f%s",
            "--date=iso-strict",
        ],
        cwd=cwd,
        text=True,
    )


def write_timeline(payload: dict, out: Path) -> None:
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def check_file(path: Path, since: str = SINCE) -> int:
    if not path.is_file():
        print(f"missing {path}", file=sys.stderr)
        return 1
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        print(f"invalid JSON: {exc}", file=sys.stderr)
        return 1
    errors = []
    if data.get("since") != since:
        errors.append(f"since {data.get('since')!r} != {since!r}")
    events = data.get("events")
    if not isinstance(events, list):
        errors.append("events must be a list")
    elif data.get("count") != len(events):
        errors.append(f"count {data.get('count')} != len(events) {len(events)}")
    if errors:
        for err in errors:
            print(err, file=sys.stderr)
        return 1
    print(f"OK {path} ({data.get('count', 0)} events since {since})")
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Regenerate History timeline JSON from git")
    ap.add_argument("--since", default=SINCE, help="git log --since (default 2026-09-04)")
    ap.add_argument("--out", default=str(OUT), help="Output JSON path")
    ap.add_argument("--check", action="store_true", help="Validate committed JSON only")
    args = ap.parse_args(argv)
    out = Path(args.out)
    if args.check:
        return check_file(out, args.since)
    try:
        raw = git_log(args.since, ROOT)
    except subprocess.CalledProcessError as exc:
        print(f"git log failed: {exc}", file=sys.stderr)
        return 1
    events = parse_log(raw)
    payload = build_payload(events, args.since)
    write_timeline(payload, out)
    print(f"wrote {out} ({len(events)} events)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
