#!/usr/bin/env python3
"""Bake the Ops functional-build storyboard. No live bus, no git-log dump.

The page at /ops/ reads data/ops-storyboard.json and draws illustration frames.
Entries are a date, a title, a short caption, and an optional illustration key.
`grain` is "week" now. The same entries group by month when grain is "month",
so a later bake can summarize without a page change.

  python3 tools/ops_storyboard.py --sample --out data/ops-storyboard.json
  python3 tools/ops_storyboard.py --check data/ops-storyboard.json
  python3 tools/ops_storyboard.py --bake --export frames.json --out /tmp/story.json

Weekly cadence starts in .github/workflows/ops-storyboard.yml. That job checks
the file. It does not push to main and it does not call a bus.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUT = ROOT / "data" / "ops-storyboard.json"

GRAINS = {"week", "month"}
SOURCES = {"sample", "bake"}
ILLUSTRATIONS = {"clock", "intake", "site", "voice", "honesty", "bus", "gate", "fleet"}
SNAP_KEYS = {"v", "grain", "baked_at", "source", "entries"}
ENTRY_REQUIRED = {"date", "title", "caption"}
ENTRY_KEYS = ENTRY_REQUIRED | {"illustration"}
CAP = 36
TITLE_LIMIT = 72
CAPTION_LIMIT = 180

DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
TS_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")
TEXT_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 .,'’+\-—]{0,179}$")
EMAIL_RE = re.compile(r"[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}", re.I)
RETIRED_RE = re.compile(r"foundry|azure", re.I)
BUS_RE = re.compile("|".join(("script" + ".google", "spread" + "sheets", "/" + "macros/", "alpha" + "-db")), re.I)
SECRET_VALUE_RE = re.compile(
    "|".join((
        "gh" + "p_",
        "github_" + "pat_",
        "gho" + "_",
        "glpat-",
        "xox[baprs]-",
        "sk-",
        "ya29.",
        "AKIA[0-9A-Z]{16}",
        "-----BEGIN ",
    )),
    re.I,
)
FORBIDDEN_KEYS = {
    "email", "e-mail", "mail", "token", "access_token", "refresh_token", "id_token",
    "secret", "password", "passwd", "credential", "credentials", "api_key", "apikey",
    "authorization", "auth", "transcript", "payload", "raw", "body", "cookie",
    "cookies", "session", "private_key", "bearer", "sha", "url",
}

MONTHS = (
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
)
MONTHS_SHORT = (
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
)


def _forbidden_key(key) -> bool:
    if not isinstance(key, str):
        return True
    norm = key.strip().lower().replace("-", "_")
    return norm in FORBIDDEN_KEYS or norm.endswith("_token") or norm.endswith("_secret")


def _secretish(value: str) -> bool:
    return bool(EMAIL_RE.search(value) or SECRET_VALUE_RE.search(value) or BUS_RE.search(value))


def _text(value, limit: int) -> str | None:
    if not isinstance(value, str):
        return None
    text = " ".join(value.split())
    if not text or len(text) > limit or not TEXT_RE.match(text):
        return None
    if _secretish(text) or RETIRED_RE.search(text):
        return None
    return text


def _date(value) -> date | None:
    if not isinstance(value, str) or not DATE_RE.match(value):
        return None
    try:
        return date.fromisoformat(value)
    except ValueError:
        return None


def _clean_entry(row) -> dict | None:
    if not isinstance(row, dict):
        return None
    if any(_forbidden_key(k) for k in row):
        row = {k: v for k, v in row.items() if not _forbidden_key(k)}
    day = _date(row.get("date"))
    title = _text(row.get("title"), TITLE_LIMIT)
    caption = _text(row.get("caption"), CAPTION_LIMIT)
    if day is None or not title or not caption:
        return None
    out = {"date": day.isoformat(), "title": title, "caption": caption}
    art = row.get("illustration")
    if isinstance(art, str) and art in ILLUSTRATIONS:
        out["illustration"] = art
    return out


def sanitize(raw, source: str | None = None) -> dict | None:
    """Return an allowlisted storyboard, or None when the envelope is unusable."""
    if not isinstance(raw, dict) or raw.get("v") != 1:
        return None
    if not isinstance(raw.get("baked_at"), str) or not TS_RE.match(raw["baked_at"]):
        return None
    grain = raw.get("grain") if raw.get("grain") in GRAINS else "week"
    src = source if source in SOURCES else raw.get("source")
    if src not in SOURCES:
        src = "bake"
    rows = raw.get("entries") if isinstance(raw.get("entries"), list) else []
    entries = []
    seen = set()
    for row in rows:
        if len(entries) >= CAP:
            break
        clean = _clean_entry(row)
        if not clean:
            continue
        key = (clean["date"], clean["title"])
        if key in seen:
            continue
        seen.add(key)
        entries.append(clean)
    entries.sort(key=lambda row: row["date"])
    return {
        "v": 1,
        "grain": grain,
        "baked_at": raw["baked_at"],
        "source": src,
        "entries": entries,
    }


def problems(snap) -> list[str]:
    if not isinstance(snap, dict):
        return ["storyboard must be an object"]
    if set(snap) != SNAP_KEYS:
        extra = sorted(set(snap) - SNAP_KEYS)
        missing = sorted(SNAP_KEYS - set(snap))
        out = []
        if extra:
            out.append("unknown keys: " + ", ".join(extra))
        if missing:
            out.append("missing keys: " + ", ".join(missing))
        return out
    out = []
    if snap["v"] != 1:
        out.append("v must be 1")
    if snap["grain"] not in GRAINS:
        out.append("grain must be week or month")
    if not isinstance(snap["baked_at"], str) or not TS_RE.match(snap["baked_at"]):
        out.append("baked_at must be UTC like 2026-09-26T06:30:00Z")
    if snap["source"] not in SOURCES:
        out.append("source must be sample or bake")
    entries = snap["entries"]
    if not isinstance(entries, list):
        out.append("entries must be a list")
    elif len(entries) > CAP:
        out.append("entries exceed the cap of %d" % CAP)
    else:
        for i, row in enumerate(entries):
            if not isinstance(row, dict):
                out.append("entries[%d] must be an object" % i)
                continue
            keys = set(row)
            if not ENTRY_REQUIRED <= keys or not keys <= ENTRY_KEYS:
                out.append("entries[%d] keys must stay inside the allowlist" % i)
        if sanitize(snap) != snap:
            out.append("storyboard is not stable under sanitize")
    return out


def monday_of(day: date) -> date:
    return day - timedelta(days=day.weekday())


def group_key(day: date, grain: str) -> str:
    """Stable bucket id. Week is an ISO year-week; month is YYYY-MM."""
    if grain == "month":
        return "%04d-%02d" % (day.year, day.month)
    iso = day.isocalendar()
    return "%04d-W%02d" % (iso.year, iso.week)


def group_label(day: date, grain: str) -> str:
    if grain == "month":
        return "%s %d" % (MONTHS[day.month - 1], day.year)
    start = monday_of(day)
    return "Week of %d %s" % (start.day, MONTHS_SHORT[start.month - 1])


def group_entries(entries, grain: str) -> list[dict]:
    """Oldest first. The page uses the same buckets, so a grain flip needs no rewrite."""
    groups = []
    index = {}
    for row in entries:
        day = date.fromisoformat(row["date"])
        key = group_key(day, grain)
        if key not in index:
            index[key] = {"key": key, "label": group_label(day, grain), "entries": []}
            groups.append(index[key])
        index[key]["entries"].append(row)
    return groups


def _frames() -> list[dict]:
    """Visitor-readable milestones. Not a log, not a commit list."""
    return [
        {
            "date": "2026-08-25",
            "title": "The clock starts",
            "caption": "A working place for the build, ten days before the public site.",
            "illustration": "clock",
        },
        {
            "date": "2026-09-01",
            "title": "A way in",
            "caption": "Messages can arrive and land as something a person can answer.",
            "illustration": "intake",
        },
        {
            "date": "2026-09-04",
            "title": "The site stands up",
            "caption": "The public pages begin. The website is the second half of the story.",
            "illustration": "site",
        },
        {
            "date": "2026-09-06",
            "title": "Someone can be reached",
            "caption": "When the work is blocked, a person can be asked, in one tap.",
            "illustration": "voice",
        },
        {
            "date": "2026-09-18",
            "title": "The page tells the truth",
            "caption": "Words that belonged only in tests come off the live site, and a check keeps them off.",
            "illustration": "honesty",
        },
        {
            "date": "2026-09-26",
            "title": "Ops, in the open",
            "caption": "Specialized agents on a Communication and Control BUS, with a gate between preview and production.",
            "illustration": "bus",
        },
    ]


def sample_story() -> dict:
    snap = sanitize({
        "v": 1,
        "grain": "week",
        "baked_at": "2026-09-26T06:30:00Z",
        "source": "sample",
        "entries": _frames(),
    })
    assert snap is not None
    return snap


def bake(baked_at: str, export, grain: str = "week") -> dict | None:
    raw = export if isinstance(export, dict) else {}
    body = {
        "v": 1,
        "grain": grain if grain in GRAINS else raw.get("grain"),
        "baked_at": baked_at,
        "source": "bake",
        "entries": raw.get("entries") if isinstance(raw.get("entries"), list) else [],
    }
    return sanitize(body, source="bake")


def dumps(snap: dict) -> str:
    return json.dumps(snap, indent=2, sort_keys=True) + "\n"


def validate(path: Path) -> list[str]:
    try:
        snap = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        return ["not JSON: %s" % exc]
    return problems(snap)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Bake or validate the Ops storyboard")
    ap.add_argument("--out", type=Path, help="Where to write the storyboard")
    ap.add_argument("--sample", action="store_true", help="Write the committed sample")
    ap.add_argument("--check", type=Path, nargs="?", const=DEFAULT_OUT, help="Validate a storyboard file")
    ap.add_argument("--bake", action="store_true", help="Sanitize an export into a storyboard")
    ap.add_argument("--export", type=Path, help="Curated frames JSON, not a log dump")
    ap.add_argument("--grain", choices=sorted(GRAINS), help="week now, month when summarizing")
    ap.add_argument("--baked-at", help="UTC timestamp for tests")
    args = ap.parse_args(argv)
    if args.check:
        bad = validate(args.check)
        for item in bad:
            print(item)
        print("ok" if not bad else "%d problem(s)" % len(bad))
        return 1 if bad else 0
    if not args.out:
        ap.error("--out is required unless --check")
    if args.sample:
        snap = sample_story()
    elif args.bake:
        export = {}
        if args.export:
            try:
                export = json.loads(args.export.read_text(encoding="utf-8"))
            except (OSError, ValueError) as exc:
                print("export unreadable: %s" % exc)
                return 1
            if not isinstance(export, dict):
                print("export must be an object")
                return 1
        stamp = args.baked_at or datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        grain = args.grain or (export.get("grain") if isinstance(export.get("grain"), str) else "week")
        snap = bake(stamp, export, grain)
        if snap is None:
            print("bake produced nothing renderable")
            return 1
    else:
        ap.error("one of --sample, --bake, or --check is required")
    bad = problems(snap)
    if bad:
        for item in bad:
            print(item)
        return 1
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(dumps(snap), encoding="utf-8")
    print("wrote %s (%d frames)" % (args.out, len(snap["entries"])))
    return 0


if __name__ == "__main__":
    sys.exit(main())
