#!/usr/bin/env python3
"""Refresh a last-good feed from curated main receipts and scoped GitHub facts."""
import argparse
import subprocess
import sys

from ops_delivery import InvalidEvidence, atomic_write, instant, load, project, validate
from ops_delivery_collect import collect


def seed_overrides(previous, seed):
    previous, seed = validate(previous), validate(seed)
    old = {row['id']: row for row in previous['items']}
    # Curated main may add a task or newer destination receipt. Old seed rows
    # must not undo subsequent exact-head observations on the snapshot branch.
    rows = [row for row in seed['items'] if row['id'] not in old or
            instant(row['observed_at']) > instant(old[row['id']]['observed_at'])]
    return {'schema_version': 1, 'items': rows}


def with_milestones(previous, seed, result):
    """Curated seed milestones replace an older feed. A newer feed keeps its own."""
    source = None
    if isinstance(seed, dict) and seed.get('milestones') and instant(seed['observed_at']) >= instant(previous['observed_at']):
        source = seed['milestones']
    elif isinstance(previous, dict) and previous.get('milestones'):
        source = previous['milestones']
    if not source:
        return result
    merged = dict(result)
    merged['milestones'] = source
    return validate(merged)


def bake(previous, seed, policy, repositories=None, read=None):
    base = project(previous, okf_export=seed_overrides(previous, seed))
    kwargs = {'repositories': repositories}
    if read is not None:
        kwargs['read'] = read
    return with_milestones(previous, seed, project(base, github_export=collect(base, policy, **kwargs)))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('previous', 'seed', 'policy', 'out'):
        parser.add_argument('--' + name, required=True)
    parser.add_argument('--repo', action='append')
    args = parser.parse_args()
    try:
        result = bake(load(args.previous), load(args.seed), load(args.policy),
                      set(args.repo) if args.repo else None)
        changed = atomic_write(args.out, result, previous_path=args.previous)
        print('delivery evidence updated' if changed else 'delivery evidence unchanged')
        return 0
    except (ValueError, KeyError, TypeError, OSError, subprocess.TimeoutExpired):
        print('Delivery bake failed; retain last good snapshot.', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
