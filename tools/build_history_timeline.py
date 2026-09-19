#!/usr/bin/env python3
"""Build data/history-timeline.json from git log since 2026-09-04."""
from __future__ import annotations

import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "data" / "history-timeline.json"
SINCE = "2026-09-04"


def main() -> int:
    raw = subprocess.check_output(
        [
            "git", "log",
            f"--since={SINCE}",
            "--pretty=format:%h%x1f%aI%x1f%s",
            "--date=iso-strict",
        ],
        cwd=ROOT,
        text=True,
    )
    events = []
    for line in raw.splitlines():
        if not line.strip():
            continue
        parts = line.split("\x1f", 2)
        if len(parts) < 3:
            continue
        sha, ts, subject = parts
        events.append({"sha": sha, "ts": ts, "subject": subject})
    payload = {
        "since": SINCE,
        "timezone": "America/Toronto",
        "title": "24 hour clock",
        "started": "2026-09-04",
        "count": len(events),
        "events": events,
    }
    OUT.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {OUT} ({len(events)} events)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
