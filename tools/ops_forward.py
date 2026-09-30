"""Ops data only moves forward: a change may add to the delivery snapshot or bring it up to date,
never take it back in time.

    python tools/ops_forward.py --base <main's data/ops-delivery.json> --head data/ops-delivery.json

The owner, 2026-09-30: "the ops page keeps going back in time ... fix if it's broken instead of pushing
it back to older versions; this creates a lot of rework". On 2026-09-30 #260 carried an older copy of
data/ops-delivery.json and dropped two production receipts (conference-telemetry-log and
waker-standby-wording) that main already had. This check fails such a change, before it merges:

- every item on the base is still on the head (an item is updated, never dropped);
- the snapshot's observed_at is not earlier than the base's;
- no item's observed_at is earlier than the same item's on the base;
- an item that was production on the base is still production on the head.

A deliberate removal is a decision, not a side effect: it is made in its own change that says so,
by editing this rule, never by landing an older file.
"""
from __future__ import annotations

import argparse
import json
import sys


def backwards(base: dict, head: dict) -> list:
    """What `head` loses from `base`: an empty list when it only moves forward."""
    found = []
    if str(head.get("observed_at") or "") < str(base.get("observed_at") or ""):
        found.append("the snapshot's observed_at went back from %s to %s" % (base.get("observed_at"), head.get("observed_at")))
    now = {item.get("id"): item for item in head.get("items") or []}
    for item in base.get("items") or []:
        key = item.get("id")
        later = now.get(key)
        if later is None:
            found.append("item %s was dropped" % key)
            continue
        if str(later.get("observed_at") or "") < str(item.get("observed_at") or ""):
            found.append("item %s went back from %s to %s" % (key, item.get("observed_at"), later.get("observed_at")))
        if item.get("stage") == "production" and later.get("stage") != "production":
            found.append("item %s left production (now %s)" % (key, later.get("stage")))
    return found


def main(argv) -> int:
    args = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    args.add_argument("--base", required=True)
    args.add_argument("--head", required=True)
    opts = args.parse_args(argv[1:])
    with open(opts.base, encoding="utf-8") as f:
        base = json.load(f)
    with open(opts.head, encoding="utf-8") as f:
        head = json.load(f)
    found = backwards(base, head)
    for line in found:
        print("BACKWARDS: " + line)
    if not found:
        print("forward only: %d items on the base, %d on the head" % (len(base.get("items") or []),
                                                                     len(head.get("items") or [])))
    return 1 if found else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
