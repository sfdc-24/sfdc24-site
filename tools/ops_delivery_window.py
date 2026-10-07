#!/usr/bin/env python3
"""Weekday Eastern hours for the Ops refresh job.

GitHub Actions cron is UTC and cannot name America/New_York. The workflow
schedules both Eastern Daylight (UTC-4) and Eastern Standard (UTC-5) hours,
then asks this check before doing any work. A scheduled run proceeds only at
9:00, 12:00, 15:00, or 18:00 local time, Monday through Friday. The other
offset's hours exit without writing. Manual runs are not decided here.
"""
from __future__ import annotations

import argparse
import sys
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

EASTERN = ZoneInfo("America/New_York")
HOURS = frozenset({9, 12, 15, 18})


def in_window(moment):
    """True when moment is 9, 12, 15, or 18 in America/New_York on a weekday."""
    if moment.tzinfo is None:
        raise ValueError("moment must be timezone-aware")
    local = moment.astimezone(EASTERN)
    return local.weekday() < 5 and local.hour in HOURS


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Exit 0 inside the window, 1 outside")
    parser.parse_args(argv)
    if in_window(datetime.now(timezone.utc)):
        print("inside Eastern refresh window")
        return 0
    print("outside Eastern refresh window", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
