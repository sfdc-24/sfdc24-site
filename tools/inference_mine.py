#!/usr/bin/env python3
"""Mine inference JSONL for the next prior. No cookies. Append-only.

Reads data/inference/catalog.json and each dataset JSONL. Emits summary
CI (via inference_ci) plus simple features: miss rate, conversion.
n ≥ 20 + CI before a call — summaries still print when n is small.

  python3 tools/inference_mine.py
  python3 tools/inference_mine.py --validate
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT / "tools") not in sys.path:
    sys.path.insert(0, str(ROOT / "tools"))

import inference_ci as ci  # noqa: E402

CATALOG = ROOT / "data" / "inference" / "catalog.json"
HITS = ("beat", "on_time", "win", "yes")
MISS = ("delayed", "failed", "lose", "no")


def load_catalog(path: Path | None = None) -> dict:
    src = path or CATALOG
    return json.loads(src.read_text(encoding="utf-8"))


def load_jsonl(path: Path) -> list[dict]:
    rows: list[dict] = []
    if not path.exists():
        return rows
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(obj, dict):
            rows.append(obj)
    return rows


def features(rows: list[dict]) -> dict:
    n = 0
    hits = 0
    misses = 0
    for row in rows:
        out = str(row.get("outcome") or "").replace("-", "_")
        if not out:
            continue
        n += 1
        if out in HITS:
            hits += 1
        elif out in MISS:
            misses += 1
    miss_rate = (misses / n) if n else None
    conversion = (hits / n) if n else None
    ready = ci.ready(n)
    lo = hi = None
    if n > 0:
        lo, hi = ci.wilson_ci(hits, n)
    return {
        "n": n,
        "hits": hits,
        "misses": misses,
        "miss_rate": miss_rate,
        "conversion": conversion,
        "ready": ready,
        "wilson": None if lo is None else {"lo": lo, "hi": hi},
    }


def mine(catalog_path: Path | None = None) -> dict:
    catalog = load_catalog(catalog_path)
    datasets = []
    for spec in catalog.get("datasets") or []:
        rel = spec.get("path") or ""
        path = ROOT / rel
        rows = load_jsonl(path)
        source = spec.get("source")
        if source and not rows:
            rows = load_jsonl(ROOT / source)
        item = {
            "id": spec.get("id"),
            "path": rel,
            "purpose": spec.get("purpose"),
            "owners": spec.get("owners") or [],
            **features(rows),
        }
        datasets.append(item)
    return {
        "cookies": catalog.get("cookies", False),
        "append_only": catalog.get("append_only", True),
        "min_n": catalog.get("min_n", ci.MIN_N),
        "authority": catalog.get("authority"),
        "public_site": catalog.get("public_site"),
        "datasets": datasets,
    }


def validate(catalog_path: Path | None = None) -> int:
    catalog = load_catalog(catalog_path)
    required = {"eta", "ab", "ask", "campaign", "challenge"}
    ids = {spec.get("id") for spec in catalog.get("datasets") or []}
    missing = sorted(required - ids)
    if missing:
        print("catalog missing datasets: " + ", ".join(missing), file=sys.stderr)
        return 1
    if catalog.get("cookies") is not False:
        print("catalog must set cookies=false", file=sys.stderr)
        return 1
    eta_path = ROOT / "data" / "inference" / "eta.jsonl"
    if not load_jsonl(eta_path):
        print("eta.jsonl is empty — seed from estimate-lessons.jsonl", file=sys.stderr)
        return 1
    summary = mine(catalog_path)
    eta = next(d for d in summary["datasets"] if d["id"] == "eta")
    if eta["n"] < 1:
        print("eta mine produced n=0", file=sys.stderr)
        return 1
    print(json.dumps({"ok": True, "eta_n": eta["n"], "eta_ready": eta["ready"]}, indent=2))
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Mine inference JSONL for next priors")
    ap.add_argument("--catalog", default=str(CATALOG))
    ap.add_argument("--validate", action="store_true")
    args = ap.parse_args(argv)
    path = Path(args.catalog)
    if args.validate:
        return validate(path)
    print(json.dumps(mine(path), indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
