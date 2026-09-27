#!/usr/bin/env python3
"""Project sanitized evidence into the public Ops delivery snapshot, without network.

GitHub export: {schema_version: 1, items: [{id, source, head_sha, state,
observed_at, required_checks: [name], checks: [{name, head_sha, status,
conclusion, observed_at}]}]}. State is open, merged or closed. Check status is
queued, in_progress or completed. Timestamps name evidence events, not polls.

OKF export: {schema_version: 1, items: [{id, observed_at, source, evidence,
...explicit public item fields}]}. Existing items accept partial overrides;
new items need every public field. Production requires an explicit OKF
stage=production, status=verified and a recorded production period. GitHub
can never create production evidence. Historical verified receipts are
immune to GitHub updates. No input text is fetched or inferred by this tool.

python tools/ops_delivery.py --previous data/ops-delivery.json \
  --github-export github.json --okf-export okf.json --out candidate.json
python tools/ops_delivery.py --validate candidate.json
"""
from __future__ import annotations

import argparse
import copy
import json
import os
import re
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import unquote, urlsplit

STAGES = {'backlog', 'dev', 'staging', 'test', 'production'}
STATUSES = {'recorded', 'blocked', 'pending', 'verified'}
TEXT_LIMITS = {'id': 80, 'title': 180, 'project': 80, 'owner': 100,
               'assignment': 120, 'next': 400, 'evidence': 400}
ITEM_KEYS = set(TEXT_LIMITS) | {'stage', 'status', 'observed_at', 'source', 'periods'}
CHECK_CONCLUSIONS = {'success', 'failure', 'cancelled', 'timed_out', 'neutral',
                     'skipped', 'action_required', 'stale', 'startup_failure'}
SHA = re.compile(r'^[0-9a-f]{40}$')
STAMP = re.compile(r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$')
SECRET = re.compile(r'(?:gh[pousr]_|github_pat_|sk-[A-Za-z0-9]|xox[baprs]-|-----BEGIN |Bearer\s+)', re.I)
MAX_INPUT_BYTES = 1_000_000
MAX_OUTPUT_BYTES = 200_000


class InvalidEvidence(ValueError):
    """A fixed diagnostic: never echo untrusted source content into logs."""


def require(condition, message):
    if not condition:
        raise InvalidEvidence(message)


def instant(value):
    require(isinstance(value, str) and bool(STAMP.fullmatch(value)), 'invalid UTC timestamp')
    try:
        return datetime.strptime(value, '%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=timezone.utc)
    except ValueError:
        raise InvalidEvidence('invalid calendar timestamp') from None


def public_text(value, limit):
    require(isinstance(value, str) and bool(value.strip()) and len(value) <= limit,
            'invalid public text field')
    require(not SECRET.search(value) and not any(ord(c) < 32 for c in value),
            'unsafe public text field')
    return value


def public_source(value):
    require(isinstance(value, str), 'invalid public source')
    try:
        url = urlsplit(value)
        allowed = (url.scheme == 'https' and url.port in (None, 443)
                   and not url.username and not url.password
                   and not any(c.isspace() or ord(c) < 32 for c in value) and '\\' not in value
                   and not any(unquote(segment) in {'.', '..'} for segment in url.path.split('/'))
                   and ((url.hostname == 'github.com' and url.path.startswith('/sfdc-24/'))
                        or (url.hostname == 'www.sfdc24.com' and url.path.startswith('/'))))
    except ValueError:
        allowed = False
    require(allowed and not SECRET.search(value), 'unapproved public source')
    return value


def clean_item(raw, ceiling):
    require(isinstance(raw, dict), 'invalid delivery item')
    item = {key: public_text(raw.get(key), limit) for key, limit in TEXT_LIMITS.items()}
    require(isinstance(raw.get('stage'), str) and isinstance(raw.get('status'), str)
            and raw['stage'] in STAGES and raw['status'] in STATUSES,
            'invalid delivery stage or status')
    stamp = instant(raw.get('observed_at'))
    require(stamp <= ceiling, 'item observed after snapshot')
    item.update(stage=raw['stage'], status=raw['status'], observed_at=raw['observed_at'],
                source=public_source(raw.get('source')))
    periods = raw.get('periods')
    require(isinstance(periods, list) and len(periods) <= 20, 'invalid delivery periods')
    item['periods'] = []
    for period in periods:
        require(isinstance(period, dict) and isinstance(period.get('stage'), str)
                and period['stage'] in STAGES and isinstance(period.get('kind'), str)
                and period['kind'] in {'actual', 'planned'}, 'invalid period kind or stage')
        start, end = instant(period.get('start')), instant(period.get('end'))
        require(start <= end and (period['kind'] != 'actual' or end <= stamp),
                'invalid period chronology')
        item['periods'].append({key: period[key] for key in ('stage', 'kind', 'start', 'end')})
    return item


def validate(raw, now=None):
    now = now or datetime.now(timezone.utc)
    require(isinstance(raw, dict) and type(raw.get('schema_version')) is int
            and raw['schema_version'] == 1, 'invalid snapshot schema')
    stamp = instant(raw.get('observed_at'))
    require(stamp <= now + timedelta(seconds=60), 'future snapshot')
    rows = raw.get('items')
    require(isinstance(rows, list) and len(rows) <= 100, 'invalid snapshot items')
    items = [clean_item(row, stamp) for row in rows]
    require(len({row['id'] for row in items}) == len(items), 'duplicate item ID')
    return {'schema_version': 1, 'observed_at': raw['observed_at'], 'items': items}


def export_rows(raw):
    if raw is None:
        return []
    require(isinstance(raw, dict) and type(raw.get('schema_version')) is int
            and raw['schema_version'] == 1, 'invalid evidence export schema')
    rows = raw.get('items')
    require(isinstance(rows, list) and len(rows) <= 100, 'invalid evidence export items')
    ids = []
    for row in rows:
        require(isinstance(row, dict), 'invalid evidence export row')
        ids.append(public_text(row.get('id'), 80))
    require(len(set(ids)) == len(ids), 'duplicate evidence item ID')
    return rows


def github_item(previous, raw, ceiling):
    require(raw['id'] == previous['id'], 'GitHub item identity mismatch')
    source = public_source(raw.get('source'))
    require(bool(re.fullmatch(r'https://github\.com/sfdc-24/[A-Za-z0-9_.-]+/pull/[1-9][0-9]*', source)),
            'GitHub source must name a public pull request')
    # Bind an existing PR row to its PR; curated branch links may become PR links.
    if re.search(r'/pull/[0-9]+$', previous['source']):
        require(source == previous['source'], 'GitHub pull request binding changed')
    head = raw.get('head_sha')
    require(isinstance(head, str) and bool(SHA.fullmatch(head)), 'invalid GitHub head SHA')
    require(isinstance(raw.get('state'), str) and raw['state'] in {'open', 'merged', 'closed'}, 'invalid GitHub PR state')
    stamp = instant(raw.get('observed_at'))
    require(stamp <= ceiling, 'future GitHub evidence')
    required = raw.get('required_checks')
    require(isinstance(required, list) and len(required) <= 100, 'invalid required checks')
    for name in required:
        public_text(name, 160)
    require(len(set(required)) == len(required), 'duplicate required check')
    checks = raw.get('checks')
    require(isinstance(checks, list) and len(checks) <= 300, 'invalid GitHub checks')
    current = {}
    for check in checks:
        require(isinstance(check, dict), 'invalid GitHub check')
        name = public_text(check.get('name'), 160)
        sha = check.get('head_sha')
        require(isinstance(sha, str) and bool(SHA.fullmatch(sha)), 'invalid check head SHA')
        status, conclusion = check.get('status'), check.get('conclusion')
        require(isinstance(status, str) and status in {'queued', 'in_progress', 'completed'}, 'invalid check status')
        require((status == 'completed' and isinstance(conclusion, str) and conclusion in CHECK_CONCLUSIONS)
                or (status != 'completed' and conclusion is None), 'invalid check conclusion')
        checked = instant(check.get('observed_at'))
        require(checked <= ceiling, 'future check evidence')
        if sha == head:
            current.setdefault(name, []).append({key: check[key] for key in
                                                 ('name', 'head_sha', 'status', 'conclusion', 'observed_at')})
            stamp = max(stamp, checked)
    # Validate source records even for historical rows, but never overwrite a receipt.
    if previous['stage'] == 'production' and previous['status'] == 'verified':
        return copy.deepcopy(previous)
    # A manual/runtime observation may legitimately be newer than PR metadata.
    # Old GitHub evidence cannot supersede it, but need not block other items.
    if stamp < instant(previous['observed_at']):
        return copy.deepcopy(previous)
    if raw['state'] == 'merged':
        stage, status, detail = 'staging', 'pending', 'Source merged; staging and production unverified.'
        next_action = 'Provide deployed identity, then receiver-side verification and human acceptance.'
    elif raw['state'] == 'closed':
        stage, status, detail = previous['stage'], 'blocked', 'PR closed without merge; delivery not established.'
        next_action = 'The owner must replan this work or explicitly close the lane.'
    elif current:
        stage = 'test'
        relevant = [check for name in required for check in current.get(name, [])]
        failed = any(check['status'] == 'completed' and check['conclusion'] in
                     {'failure', 'cancelled', 'timed_out', 'action_required', 'stale', 'startup_failure'}
                     for group in current.values() for check in group)
        green = bool(required) and all(name in current for name in required) and all(
            check['status'] == 'completed' and check['conclusion'] == 'success' for check in relevant)
        status = 'blocked' if failed else 'recorded' if green else 'pending'
        detail = ('Exact-head checks failed; delivery unverified.' if failed else
                  'Required exact-head checks passed; deployment unverified.' if green else
                  'Exact-head checks incomplete; deployment unverified.')
        next_action = ('Repair the exact-head CI finding, then obtain independent review.' if failed else
                       'Obtain exact-head independent review, then read back the deployed identity.' if green else
                       'Finish the exact-head checks before independent review and deployment.')
    else:
        stage, status, detail = 'dev', 'pending', 'No checks for this head; deployment unverified.'
        next_action = 'Finish the exact-head checks before independent review and deployment.'
    item = copy.deepcopy(previous)
    item.update(source=source, stage=stage, status=status, next=next_action,
                evidence='PR at ' + head + '. ' + detail,
                observed_at=stamp.strftime('%Y-%m-%dT%H:%M:%SZ'))
    # Repeated fetches of the same effective evidence cannot freshen a row.
    comparable = lambda row: {key: value for key, value in row.items() if key != 'observed_at'}
    if comparable(item) == comparable(previous):
        item['observed_at'] = previous['observed_at']
    return item


def project(previous, github_export=None, okf_export=None, now=None):
    now = now or datetime.now(timezone.utc)
    baseline = validate(previous, now)
    rows = {item['id']: copy.deepcopy(item) for item in baseline['items']}
    ceiling = now + timedelta(seconds=60)
    for raw in export_rows(github_export):
        require(raw['id'] in rows, 'GitHub item absent from curated roster')
        rows[raw['id']] = github_item(rows[raw['id']], raw, ceiling)
    for raw in export_rows(okf_export):
        previous_row = rows.get(raw['id'])
        stamp = instant(raw.get('observed_at'))
        require(stamp <= ceiling, 'future OKF evidence')
        public_source(raw.get('source'))
        public_text(raw.get('evidence'), 400)
        if previous_row:
            require(stamp >= instant(previous_row['observed_at']), 'backdated OKF evidence')
        combined = dict(previous_row or {})
        combined.update({key: value for key, value in raw.items() if key in ITEM_KEYS})
        clean = clean_item(combined, ceiling)
        if previous_row and previous_row['stage'] == 'production' and previous_row['status'] == 'verified':
            require(all(clean[key] == previous_row[key] for key in ITEM_KEYS - {'observed_at'}),
                    'historical receipt is immutable; use a new work item')
        if clean['stage'] == 'production' and not (previous_row and previous_row['stage'] == 'production'
                                                  and previous_row['status'] == 'verified'):
            require(raw.get('stage') == 'production' and raw.get('status') == 'verified'
                    and 'periods' in raw and any(p['stage'] == 'production' and p['kind'] == 'actual'
                                                for p in clean['periods']), 'production requires explicit OKF receipt')
        if previous_row and all(clean[key] == previous_row[key] for key in ITEM_KEYS - {'observed_at'}):
            clean['observed_at'] = previous_row['observed_at']
        rows[raw['id']] = clean
    # Existing order is curated. Newly introduced OKF rows have a stable ID order.
    ids = [item['id'] for item in baseline['items']]
    ids.extend(sorted(set(rows) - set(ids)))
    items = [rows[key] for key in ids]
    stamp = max([instant(baseline['observed_at'])] + [instant(item['observed_at']) for item in items])
    result = validate({'schema_version': 1, 'observed_at': stamp.strftime('%Y-%m-%dT%H:%M:%SZ'), 'items': items}, now)
    require(len(dumps(result).encode('utf-8')) <= MAX_OUTPUT_BYTES, 'public snapshot too large')
    return result


def dumps(value):
    return json.dumps(value, ensure_ascii=False, indent=2) + '\n'


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, 'duplicate JSON key')
        result[key] = value
    return result


def load(path):
    raw = Path(path).read_bytes()
    require(len(raw) <= MAX_INPUT_BYTES, 'input too large')
    try:
        return json.loads(raw.decode('utf-8'), object_pairs_hook=unique_object,
                          parse_constant=lambda _: (_ for _ in ()).throw(InvalidEvidence('nonfinite JSON value')))
    except (UnicodeError, json.JSONDecodeError):
        raise InvalidEvidence('invalid JSON input') from None


def atomic_write(path, snapshot, now=None, previous_path=None):
    path = Path(path)
    if path.exists():
        existing_raw = load(path)
        existing = validate(existing_raw, now)
        require(instant(snapshot['observed_at']) >= instant(existing['observed_at']), 'output would regress')
        old_rows = {row['id']: row for row in existing['items']}
        for row in snapshot['items']:
            require(row['id'] not in old_rows or instant(row['observed_at']) >= instant(old_rows[row['id']]['observed_at']),
                    'output item would regress')
        if snapshot == existing_raw:
            return False
    content = dumps(snapshot).encode('utf-8')
    if previous_path is not None and load(previous_path) == snapshot:
        content = Path(previous_path).read_bytes()  # preserve a clean unchanged snapshot byte for byte
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(prefix='.' + path.name + '.', suffix='.tmp', dir=path.parent, delete=False) as output:
            temporary = output.name
            output.write(content)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
        temporary = None
    finally:
        if temporary is not None:
            os.unlink(temporary)
    return True


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--previous', type=Path)
    parser.add_argument('--github-export', type=Path)
    parser.add_argument('--okf-export', type=Path)
    parser.add_argument('--out', type=Path)
    parser.add_argument('--validate', type=Path)
    args = parser.parse_args(argv)
    if not args.validate and (not args.previous or not args.out):
        parser.error('--previous and --out are required')
    try:
        if args.validate:
            validate(load(args.validate))
            print('valid delivery snapshot')
            return 0
        now = datetime.now(timezone.utc)
        result = project(load(args.previous), load(args.github_export) if args.github_export else None,
                         load(args.okf_export) if args.okf_export else None, now)
        changed = atomic_write(args.out, result, now, args.previous)
        print('delivery snapshot written' if changed else 'delivery snapshot unchanged')
        return 0
    except (InvalidEvidence, OSError) as error:
        print(str(error) if isinstance(error, InvalidEvidence) else 'delivery file operation failed', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
