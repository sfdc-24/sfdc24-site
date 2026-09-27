#!/usr/bin/env python3
"""Collect only public PR/check metadata for the Ops delivery projector.

No titles, bodies, comments, credentials, or polling timestamps are exported.
Run with authenticated gh or its normal public access. A missing page, ambiguous
head, or API failure fails the whole collection; callers keep their last good
snapshot. Required check names are explicit policy input, not inferred greens.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
from datetime import datetime
from pathlib import Path

PR = re.compile(r"https://github\.com/(sfdc-24/(?:conference|sfdc24-site|Blackboard))/pull/([1-9][0-9]*)\Z")
SHA = re.compile(r"[0-9a-f]{40}\Z")


def timestamp(value):
    if not isinstance(value, str) or not value.endswith("Z"):
        raise ValueError("invalid source timestamp")
    datetime.fromisoformat(value.replace("Z", "+00:00"))
    return value


def api(path):
    result = subprocess.run(["gh", "api", path], capture_output=True, text=True, encoding="utf-8",
                            timeout=40, check=False)
    if result.returncode:
        # Do not echo provider bodies or command stderr into public artifacts.
        raise ValueError("GitHub metadata read failed")
    return json.loads(result.stdout)


def collect(previous, required, read=api, repositories=None):
    if previous.get("schema_version") != 1 or not isinstance(previous.get("items"), list):
        raise ValueError("invalid previous snapshot")
    records = []
    for item in previous["items"]:
        match = PR.fullmatch(item.get("source", ""))
        if not match:
            continue
        repo, number = match.groups()
        if repositories is not None and repo not in repositories:
            continue
        names = required.get(repo)
        if not isinstance(names, list) or not names or any(not isinstance(n, str) or not n for n in names):
            raise ValueError("explicit required-check policy missing")
        pull = read(f"repos/{repo}/pulls/{number}")
        head = pull["head"]["sha"]
        if not SHA.fullmatch(head):
            raise ValueError("invalid PR head")
        checks = []
        page = 1
        while True:
            if page > 20:
                raise ValueError("check pagination exceeds bounded limit")
            response = read(f"repos/{repo}/commits/{head}/check-runs?per_page=100&page={page}")
            rows = response.get("check_runs")
            if not isinstance(rows, list):
                raise ValueError("missing check rows")
            for row in rows:
                if row.get("head_sha") != head:
                    raise ValueError("check head mismatch")
                event_time = row.get("completed_at") or row.get("started_at") or pull["updated_at"]
                checks.append({"name": row["name"], "head_sha": head,
                               "status": row["status"], "conclusion": row.get("conclusion"),
                               "observed_at": timestamp(event_time)})
            if len(rows) < 100:
                if len(checks) != response.get("total_count"):
                    raise ValueError("incomplete check pagination")
                break
            page += 1
        # A changed PR head while collecting invalidates this sample.
        again = read(f"repos/{repo}/pulls/{number}")
        if again["head"]["sha"] != head or again["updated_at"] != pull["updated_at"]:
            raise ValueError("PR moved during collection")
        state = "merged" if pull.get("merged_at") else pull["state"]
        times = [timestamp(pull["updated_at"])] + [c["observed_at"] for c in checks]
        records.append({"id": item["id"], "source": item["source"], "head_sha": head,
                        "state": state, "observed_at": max(times),
                        "required_checks": sorted(set(names)),
                        "checks": sorted(checks, key=lambda c: (c["name"], c["observed_at"]))})
    return {"schema_version": 1, "items": records}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--previous", type=Path, required=True)
    parser.add_argument("--policy", type=Path, required=True,
                        help="JSON object mapping repository to required check names")
    parser.add_argument("--out", type=Path, help="Atomic JSON export destination; default stdout")
    parser.add_argument("--repo", action="append", help="Restrict reads to these repositories; others retain prior evidence")
    args = parser.parse_args()
    try:
        value = collect(json.loads(args.previous.read_text(encoding="utf-8")),
                        json.loads(args.policy.read_text(encoding="utf-8")), repositories=set(args.repo) if args.repo else None)
        encoded = json.dumps(value, sort_keys=True, indent=2) + "\n"
        if args.out:
            args.out.parent.mkdir(parents=True, exist_ok=True)
            with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", newline="\n",
                                             dir=args.out.parent, delete=False) as handle:
                temporary = Path(handle.name)
                handle.write(encoded)
            try:
                os.replace(temporary, args.out)
            finally:
                temporary.unlink(missing_ok=True)
        else:
            print(encoded, end="")
        return 0
    except (ValueError, KeyError, TypeError, OSError, subprocess.TimeoutExpired):
        print("Ops GitHub collection failed; retain last good snapshot.", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
