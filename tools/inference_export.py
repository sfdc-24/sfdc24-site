#!/usr/bin/env python3
"""Export inference JSONL toward the Blackboard Inference sheet.

Hybrid store (Mr Salam):
  1. Authoritative: Blackboard Alpha DB sheet titled Inference
     columns: ts, surface, agent, payload_json, outcome, learning
  2. Mine path: data/inference/*.jsonl + catalog.json
  3. Public site: aggregates only

This stub maps JSONL → sheet rows. It does not create the Sheet.
If Apps Script deploy is needed, hand sheet-create to Gemini/Claude.

  python3 tools/inference_export.py --schema
  python3 tools/inference_export.py --dry-run
  python3 tools/inference_export.py --seed-eta
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT / "tools") not in sys.path:
    sys.path.insert(0, str(ROOT / "tools"))

import inference_mine as mine  # noqa: E402

SHEET = "Inference"
COLUMNS = ("ts", "surface", "agent", "payload_json", "outcome", "learning")
ETA_SRC = ROOT / "data" / "estimate-lessons.jsonl"
ETA_DST = ROOT / "data" / "inference" / "eta.jsonl"


def to_sheet_row(surface: str, row: dict) -> dict:
    payload = {
        key: val
        for key, val in row.items()
        if key not in ("ts", "outcome", "who", "agent", "course_correct", "learning", "why")
    }
    if row.get("why") and "why" not in payload:
        payload["why"] = row.get("why")
    return {
        "ts": row.get("ts"),
        "surface": row.get("surface") or surface,
        "agent": row.get("agent") or row.get("who") or "",
        "payload_json": json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
        "outcome": row.get("outcome"),
        "learning": row.get("learning") or row.get("course_correct") or "",
    }


def dry_run() -> list[dict]:
    catalog = mine.load_catalog()
    out: list[dict] = []
    for spec in catalog.get("datasets") or []:
        surface = str(spec.get("id") or "")
        path = ROOT / (spec.get("path") or "")
        rows = mine.load_jsonl(path)
        if spec.get("source") and not rows:
            rows = mine.load_jsonl(ROOT / spec["source"])
        for row in rows:
            out.append(to_sheet_row(surface, row))
    return out


def seed_eta() -> int:
    if not ETA_SRC.exists():
        print("missing " + str(ETA_SRC), file=sys.stderr)
        return 1
    src = ETA_SRC.read_text(encoding="utf-8")
    ETA_DST.parent.mkdir(parents=True, exist_ok=True)
    ETA_DST.write_text(src if src.endswith("\n") else src + "\n", encoding="utf-8")
    print(f"seeded {ETA_DST} from {ETA_SRC}")
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Export inference JSONL toward the Inference sheet")
    ap.add_argument("--schema", action="store_true", help="Print sheet columns")
    ap.add_argument("--dry-run", action="store_true", help="Print mapped rows; do not write a sheet")
    ap.add_argument("--seed-eta", action="store_true", help="Copy estimate-lessons.jsonl → eta.jsonl")
    args = ap.parse_args(argv)
    if args.schema:
        print(json.dumps({"sheet": SHEET, "columns": list(COLUMNS), "create": "Gemini/Claude if Apps Script is blocked"}, indent=2))
        return 0
    if args.seed_eta:
        return seed_eta()
    if args.dry_run:
        print(json.dumps(dry_run(), indent=2))
        return 0
    ap.error("pass --schema, --dry-run, or --seed-eta")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
