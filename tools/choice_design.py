#!/usr/bin/env python3
"""Generate and validate a deterministic, non-deploying choice-design pilot."""
from __future__ import annotations

import argparse
import itertools
import json
import random
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CATALOG = ROOT / "data" / "choice-design-pilot.json"


def load_catalog(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def validate_catalog(data: dict) -> list[str]:
    errors: list[str] = []
    if data.get("status") != "pilot-not-deployed":
        errors.append("status must remain pilot-not-deployed")
    attrs = data.get("attributes")
    if not isinstance(attrs, list) or len(attrs) < 2:
        errors.append("attributes must contain at least two entries")
        return errors
    names: set[str] = set()
    for attr in attrs:
        name, levels = attr.get("name"), attr.get("levels")
        if not isinstance(name, str) or not name:
            errors.append("each attribute needs a name")
        elif name in names:
            errors.append(f"duplicate attribute: {name}")
        else:
            names.add(name)
        if not isinstance(levels, list) or len(levels) < 2 or len(set(levels)) != len(levels):
            errors.append(f"{name or 'attribute'} needs at least two unique levels")
    if data.get("profiles_per_choice_set") != 2:
        errors.append("pilot supports exactly two profiles per choice set")
    privacy = data.get("privacy", {})
    if privacy.get("cookies") is not False or privacy.get("persistent_cross_session_id") is not False:
        errors.append("pilot must remain cookie-free and session-ephemeral")
    return errors


def profiles(data: dict) -> list[dict]:
    attrs = data["attributes"]
    return [dict(zip((a["name"] for a in attrs), values))
            for values in itertools.product(*(a["levels"] for a in attrs))]


def generate(data: dict, seed: int, sets: int | None = None) -> list[dict]:
    errors = validate_catalog(data)
    if errors:
        raise ValueError("; ".join(errors))
    count = sets or int(data["choice_sets_per_survey"])
    all_profiles = profiles(data)
    pairs = [(a, b) for i, a in enumerate(all_profiles) for b in all_profiles[i + 1:]
             if sum(a[k] != b[k] for k in a) >= 2]
    rng = random.Random(seed)
    rng.shuffle(pairs)
    if count > len(pairs):
        raise ValueError(f"requested {count} sets but only {len(pairs)} eligible pairs")
    rows: list[dict] = []
    for set_no, pair in enumerate(pairs[:count], 1):
        for profile_no, attrs in enumerate(pair, 1):
            rows.append({
                "design_id": data["design_id"], "survey_id": f"seed-{seed}",
                "choice_set_id": set_no, "profile_id": profile_no,
                "attributes": attrs, "selected": None,
            })
    return rows


def validate_responses(rows: list[dict]) -> list[str]:
    errors: list[str] = []
    grouped: dict[tuple, list] = {}
    for row in rows:
        key = (row.get("survey_id"), row.get("choice_set_id"))
        grouped.setdefault(key, []).append(row.get("selected"))
    for key, selected in grouped.items():
        if len(selected) != 2:
            errors.append(f"{key}: expected two profiles")
        if any(v not in (0, 1) for v in selected):
            errors.append(f"{key}: selected must be numeric 0 or 1")
        elif sum(selected) != 1:
            errors.append(f"{key}: exactly one profile must be selected")
    return errors


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--catalog", type=Path, default=DEFAULT_CATALOG)
    ap.add_argument("--seed", type=int, default=24)
    ap.add_argument("--sets", type=int)
    ap.add_argument("--out", type=Path)
    ap.add_argument("--validate", action="store_true")
    ap.add_argument("--validate-responses", type=Path)
    args = ap.parse_args(argv)
    data = load_catalog(args.catalog)
    errors = validate_catalog(data)
    if args.validate:
        if errors:
            print("\n".join(errors), file=sys.stderr)
            return 1
        print(f"valid: {data['design_id']} ({len(profiles(data))} profiles)")
        return 0
    if args.validate_responses:
        rows = [json.loads(line) for line in args.validate_responses.read_text(encoding="utf-8").splitlines() if line]
        errors = validate_responses(rows)
        if errors:
            print("\n".join(errors), file=sys.stderr)
            return 1
        print(f"valid responses: {len(rows)} profile rows")
        return 0
    rows = generate(data, args.seed, args.sets)
    text = "".join(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n" for row in rows)
    if args.out:
        args.out.write_text(text, encoding="utf-8")
    else:
        print(text, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
