#!/usr/bin/env python3
"""Append one estimate-lesson line. No model calls.

Standing rule (docs/lessons-log.md): after every ETA to Mr Salam, within 5 min
of deadline log outcome; if delayed/failed, next ETA must cite course_correct.

  python3 tools/log_eta_lesson.py --who grok-bot --promise "Ship rail" \\
      --eta-minutes 20 --actual-minutes 45 --outcome delayed \\
      --why "Stacked scope" --course-correct "Ship minimal PR in <10 min"

  python3 tools/log_eta_lesson.py --validate
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_PATH = ROOT / "data" / "estimate-lessons.jsonl"
TZ = ZoneInfo("America/Toronto")
OUTCOMES = ("beat", "on_time", "delayed", "failed")
REQUIRED = (
    "ts",
    "who",
    "promise",
    "eta_minutes",
    "actual_minutes",
    "outcome",
    "why",
    "course_correct",
)


def now_ts() -> str:
    return datetime.now(TZ).replace(microsecond=0).isoformat()


def parse_optional_number(raw: str | None) -> int | float | None:
    if raw is None or raw == "" or raw.lower() == "null":
        return None
    if "." in raw:
        return float(raw)
    return int(raw)


def validate_record(obj: Any, *, line_no: int | None = None) -> list[str]:
    where = f"line {line_no}" if line_no is not None else "record"
    errors: list[str] = []
    if not isinstance(obj, dict):
        return [f"{where}: not a JSON object"]
    for key in REQUIRED:
        if key not in obj:
            errors.append(f"{where}: missing {key}")
    if "outcome" in obj and obj["outcome"] not in OUTCOMES:
        errors.append(f"{where}: outcome must be one of {', '.join(OUTCOMES)}")
    for num_key in ("eta_minutes", "actual_minutes"):
        val = obj.get(num_key, None)
        if val is not None and not isinstance(val, (int, float)):
            errors.append(f"{where}: {num_key} must be a number or null")
    for text_key in ("who", "promise", "ts"):
        val = obj.get(text_key)
        if text_key in obj and (not isinstance(val, str) or not val.strip()):
            errors.append(f"{where}: {text_key} must be a non-empty string")
    outcome = obj.get("outcome")
    if outcome in ("delayed", "failed"):
        for key in ("why", "course_correct"):
            val = obj.get(key)
            if not isinstance(val, str) or not val.strip():
                errors.append(f"{where}: {key} required when outcome is {outcome}")
    return errors


def iter_jsonl(path: Path) -> tuple[list[dict], list[str]]:
    rows: list[dict] = []
    errors: list[str] = []
    if not path.is_file():
        return rows, [f"missing {path}"]
    text = path.read_text(encoding="utf-8")
    if text and not text.endswith("\n"):
        errors.append(f"{path}: JSONL must end with a newline")
    for i, line in enumerate(text.splitlines(), start=1):
        if not line.strip():
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError as exc:
            errors.append(f"line {i}: invalid JSON ({exc})")
            continue
        errors.extend(validate_record(obj, line_no=i))
        if isinstance(obj, dict):
            rows.append(obj)
    return rows, errors


def validate_file(path: Path) -> int:
    _rows, errors = iter_jsonl(path)
    if errors:
        for err in errors:
            print(err, file=sys.stderr)
        return 1
    print(f"OK {path} ({_rows and len(_rows) or 0} records)")
    return 0


def append_record(path: Path, record: dict, *, dry_run: bool) -> int:
    errors = validate_record(record)
    if errors:
        for err in errors:
            print(err, file=sys.stderr)
        return 2
    line = json.dumps(record, ensure_ascii=False, separators=(", ", ": "))
    if dry_run:
        print(line)
        return 0
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as fh:
        fh.write(line + "\n")
    rc = validate_file(path)
    if rc == 0:
        print(line)
    return rc


def build_record(args: argparse.Namespace) -> dict:
    record = {
        "ts": args.ts or now_ts(),
        "who": args.who,
        "promise": args.promise,
        "eta_minutes": parse_optional_number(args.eta_minutes),
        "actual_minutes": parse_optional_number(args.actual_minutes),
        "outcome": args.outcome,
        "why": args.why or "",
        "course_correct": args.course_correct or "",
    }
    if args.related:
        record["related"] = args.related
    return record


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Append or validate estimate-lessons JSONL")
    ap.add_argument("--file", default=str(DEFAULT_PATH), help="JSONL path")
    ap.add_argument("--validate", action="store_true", help="Validate file only")
    ap.add_argument("--dry-run", action="store_true", help="Print the line, do not write")
    ap.add_argument("--ts", help="ISO-8601 timestamp (default: now America/Toronto)")
    ap.add_argument("--who", help="Agent or human id")
    ap.add_argument("--promise", help="What was promised")
    ap.add_argument("--eta-minutes", dest="eta_minutes", help="Promised minutes, or null")
    ap.add_argument("--actual-minutes", dest="actual_minutes", help="Actual minutes, or null")
    ap.add_argument("--outcome", choices=OUTCOMES)
    ap.add_argument("--why", help="Root cause")
    ap.add_argument("--course-correct", dest="course_correct", help="Rule the next ETA must cite")
    ap.add_argument("--related", help="PR/issue/board id (optional)")
    args = ap.parse_args(argv)
    path = Path(args.file)
    if args.validate:
        return validate_file(path)
    missing = [flag for flag, val in (("--who", args.who), ("--promise", args.promise), ("--outcome", args.outcome)) if not val]
    if missing:
        ap.error("append requires " + ", ".join(missing) + " (or pass --validate)")
    return append_record(path, build_record(args), dry_run=args.dry_run)


if __name__ == "__main__":
    raise SystemExit(main())
