#!/usr/bin/env python3
"""Build data/history-timeline.json from git log (main).

Thin storybook feed: date, hash, subject, author — grouped by day.
Run from repo root:  python3 tools/build_history_timeline.py
CI can regenerate on merge later; committed JSON keeps Pages static.
"""
from __future__ import annotations

import json
import subprocess
import sys
from collections import OrderedDict
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "data" / "history-timeline.json"
TZ = ZoneInfo("America/Toronto")
STARTED_SINCE = "2026-09-04"  # narrative kickoff (storybook badge)
REF = "origin/main"


def git_log(ref: str) -> list[dict]:
    """Prefer origin/main; fall back to main / HEAD."""
    for candidate in (ref, "main", "HEAD"):
        try:
            raw = subprocess.check_output(
                [
                    "git",
                    "log",
                    candidate,
                    "--format=%H%x09%aI%x09%an%x09%s",
                    "--reverse",
                ],
                cwd=ROOT,
                text=True,
                stderr=subprocess.DEVNULL,
            )
            if raw.strip():
                return parse_log(raw)
        except (subprocess.CalledProcessError, FileNotFoundError):
            continue
    return []


def parse_log(raw: str) -> list[dict]:
    commits = []
    for line in raw.splitlines():
        if not line.strip():
            continue
        parts = line.split("\t", 3)
        if len(parts) < 4:
            continue
        full, iso, author, subject = parts
        try:
            dt = datetime.fromisoformat(iso)
        except ValueError:
            continue
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        local = dt.astimezone(TZ)
        commits.append(
            {
                "hash": full[:7],
                "full": full,
                "date": local.strftime("%Y-%m-%d"),
                "time": local.strftime("%H:%M"),
                "iso": local.isoformat(),
                "author": author.strip(),
                "subject": subject.strip(),
            }
        )
    return commits


def group_by_day(commits: list[dict]) -> list[dict]:
    days: "OrderedDict[str, list]" = OrderedDict()
    for c in commits:
        days.setdefault(c["date"], []).append(
            {
                "hash": c["hash"],
                "full": c["full"],
                "time": c["time"],
                "iso": c["iso"],
                "author": c["author"],
                "subject": c["subject"],
            }
        )
    out = []
    for date, beats in days.items():
        beats_sorted = sorted(beats, key=lambda b: b["iso"])
        out.append(
            {
                "date": date,
                "label": format_day_label(date),
                "count": len(beats_sorted),
                "commits": beats_sorted,
            }
        )
    return out


def format_day_label(date: str) -> str:
    try:
        d = datetime.strptime(date, "%Y-%m-%d").replace(tzinfo=TZ)
        return d.strftime("%a ") + str(d.day) + d.strftime(" %b %Y")
    except ValueError:
        return date


def main() -> int:
    commits = git_log(REF)
    if not commits:
        print("no commits found", file=sys.stderr)
        return 1
    commits = [c for c in commits if c["date"] >= STARTED_SINCE]
    if not commits:
        print(f"no commits on/after {STARTED_SINCE}", file=sys.stderr)
        return 1
    days = group_by_day(commits)
    payload = {
        "built": datetime.now(TZ).strftime("%Y-%m-%dT%H:%M:%S%z"),
        "timezone": "America/Toronto",
        "ref": REF,
        "started_since": STARTED_SINCE,
        "tone": "skateboarder / 24 hour clock — falls and fixes are part of the story",
        "first_date": commits[0]["date"],
        "last_date": commits[-1]["date"],
        "commit_count": len(commits),
        "day_count": len(days),
        "days": days,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(
        f"wrote {OUT.relative_to(ROOT)} — "
        f"{payload['commit_count']} commits, {payload['day_count']} days, "
        f"{payload['first_date']} → {payload['last_date']}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
