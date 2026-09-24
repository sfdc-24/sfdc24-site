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
import re
import subprocess
import sys
from datetime import date, datetime, time
from pathlib import Path
from zoneinfo import ZoneInfo

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

# A commit subject can cite a PR in the PRIVATE working repo, e.g.
# "(Blackboard #206, #210)". This page is public and a reader cannot open that
# number, so the citation is dropped and any bare "Blackboard #N" left over
# loses its number. PR numbers in this repo, "(#107)", are public and stay.
_PRIVATE_CITATION = re.compile(r"\s*\(Blackboard #\d+(?:\s*,\s*#\d+)*\)")
_PRIVATE_NUMBER = re.compile(r"\bBlackboard #\d+")
# UTF-8 bytes read as cp1252: what an em dash looks like when git output is
# decoded with the Windows default codec. Its presence means a bad regenerate.
_MOJIBAKE = "\u00e2\u20ac"
# The subject git writes by itself when a branch is brought up to date with
# main. It says nothing a visitor can use, and on a busy day it was six of the
# top ten rows. A PR landing ("Merge pull request #N ...") and a merge someone
# described in their own words stay.
_BRANCH_SYNC = re.compile(r"Merge (?:remote-tracking )?branch '[^']+'(?: of \S+)? into \S+")


def is_branch_sync(subject: str) -> bool:
    return _BRANCH_SYNC.fullmatch(subject) is not None


def utc_as_z(ts: str) -> str:
    """git's %aI spells a UTC author date "+00:00" in some versions and "Z" in
    others (Cursor on #184: git 2.43 on a UTC runner wrote +00:00 where the
    committed file, made on Windows, had Z for the same twenty commits). One
    spelling keeps a regenerate on any machine identical to the committed file."""
    return ts[:-6] + "Z" if ts.endswith("+00:00") else ts


def public_subject(subject: str) -> str:
    # One commit message was written with a byte order mark; it is invisible
    # in a terminal and a stray glyph in some renderers.
    subject = subject.replace("\ufeff", "")
    return _PRIVATE_NUMBER.sub("Blackboard", _PRIVATE_CITATION.sub("", subject))


def instant(ts: str) -> datetime:
    """The moment a timestamp names. Sorting the raw strings put a -04:00 row
    and a Z row in the wrong order whenever they fell within four hours of each
    other (Cursor on #175)."""
    return datetime.fromisoformat(ts.replace("Z", "+00:00"))


def git_since(since: str) -> str:
    """A bare date given to `git log --since` means that date at the CURRENT
    time of day, which silently dropped every Sep 4 commit made after the hour
    the script happened to run. A bare date is midnight in the page's zone."""
    try:
        day = date.fromisoformat(since)
    except ValueError:
        return since
    return datetime.combine(day, time(0), ZoneInfo(TZ_NAME)).isoformat()


def parse_log(raw: str) -> list[dict]:
    events: list[dict] = []
    for line in raw.splitlines():
        if not line.strip():
            continue
        parts = line.split("\x1f", 2)
        if len(parts) < 3:
            continue
        sha, ts, subject = parts
        if is_branch_sync(subject):
            continue
        events.append({"sha": sha, "ts": utc_as_z(ts), "subject": public_subject(subject)})
    return events


def load_milestones(path: Path | None = None) -> list[dict]:
    """Curated events that are not commits here. Absent file is not an error -
    a checkout without it still renders a true, smaller timeline.

    The default is read at CALL time, not bound at import. A default argument
    of `path: Path = MILESTONES` captures the module global when the function
    is defined, which makes the location untestable and unoverridable - and a
    knob that cannot be turned in a test is a knob nobody can prove works.
    """
    path = path or MILESTONES
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
    return sorted(commits + milestones, key=lambda e: instant(e["ts"]), reverse=True)


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
            f"--since={git_since(since)}",
            "--pretty=format:%h%x1f%aI%x1f%s",
            "--date=iso-strict",
        ],
        cwd=cwd,
        # git writes UTF-8; the platform default on Windows is cp1252, which
        # turned every em dash in a subject into mojibake on the public page.
        encoding="utf-8",
    )


def write_timeline(payload: dict, out: Path) -> None:
    out.parent.mkdir(parents=True, exist_ok=True)
    # CRLF on every platform. The committed file has always been CRLF because
    # it was regenerated on Windows, where text mode writes CRLF; the same call
    # on Linux writes LF and would rewrite every line (Cursor on #184).
    with out.open("w", encoding="utf-8", newline="\r\n") as fh:
        fh.write(json.dumps(payload, indent=2) + "\n")


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
    if isinstance(events, list):
        try:
            moments = [instant(e.get("ts", "")) for e in events]
        except ValueError as exc:
            errors.append(f"unparseable ts: {exc}")
        else:
            if moments != sorted(moments, reverse=True):
                errors.append("events are not newest first by instant")
        for e in events:
            subject = e.get("subject", "")
            if _MOJIBAKE in subject:
                errors.append(f"mojibake in {e.get('sha') or e.get('ts')}: {subject[:60]!r}")
            if public_subject(subject) != subject:
                errors.append(f"private repo citation in {e.get('sha') or e.get('ts')}")
            if is_branch_sync(subject):
                errors.append(f"branch-sync merge in {e.get('sha') or e.get('ts')}")
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
