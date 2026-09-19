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
MILESTONES = ROOT / "data" / "history-milestones.json"
SINCE = "2026-09-04"

# WHAT THE GIT LOG CANNOT SEE, AND WHY THE PAGE WAS WRONG WITHOUT IT.
# This repository's first commit is 2026-09-04T00:36 - the static site. The
# board, its gateway, the WhatsApp intake, the backend deployments and the move
# off the old host all happened before that, in a private working repo and in
# third-party consoles. A timeline built from this log alone told a reader the
# work began when the website did, which is off by ten days and drops the whole
# foundation. data/history-milestones.json carries those events, each citing
# where it can be checked, and they are merged in by timestamp.
ORIGIN = "2026-08-25"
TITLE = "24 hour clock"
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


def load_milestones(path: Path = MILESTONES) -> list[dict]:
    """Curated events that are not commits here. Absent file is not an error -
    a checkout without it still renders a true, smaller timeline."""
    if not path.is_file():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        print(f"milestones file is invalid JSON, ignoring: {exc}", file=sys.stderr)
        return []
    out = []
    for ev in data.get("events", []):
        if not ev.get("ts") or not ev.get("subject"):
            continue
        # No sha: the renderer uses its absence to decide NOT to link. These
        # cite a private repo, and a link a reader cannot open is worse than a
        # citation they can take to the owner.
        out.append({"ts": ev["ts"], "subject": ev["subject"],
                    "source": ev.get("source", "")})
    return out


def merge(commits: list[dict], milestones: list[dict]) -> list[dict]:
    """Newest first, the order the page already renders in."""
    return sorted(commits + milestones, key=lambda e: e["ts"], reverse=True)


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
    # The committed file's `since` is the earliest event in it, which is not
    # the git window. Checking it against the git window is how the page ends
    # up claiming it starts on a day later than its own first row.
    if events := data.get("events"):
        earliest = min(e.get("ts", "")[:10] for e in events if e.get("ts"))
        if data.get("since") != earliest:
            errors.append(f"since {data.get('since')!r} != earliest event {earliest!r}")
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
    events = merge(parse_log(raw), load_milestones())
    # `since` now describes the whole timeline rather than the git window, or
    # the page prints a start date ten days after the first thing on it.
    earliest = min((e["ts"][:10] for e in events), default=args.since)
    payload = build_payload(events, earliest)
    write_timeline(payload, out)
    print(f"wrote {out} ({len(events)} events)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
