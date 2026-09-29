"""Offline evidence projection and last-good publication; no API/SDK calls."""
import contextlib
import copy
import importlib.util
import io
import json
import subprocess
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('ops_delivery', ROOT / 'tools/ops_delivery.py')
delivery = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(delivery)
NOW = datetime(2025, 1, 2, tzinfo=timezone.utc)
HEAD = 'a' * 40
OLD_HEAD = 'b' * 40


def previous():
    return {'schema_version': 1, 'observed_at': '2025-01-01T10:00:00Z', 'items': [
        {'id': 'work', 'title': 'Repair voice', 'project': 'Conference', 'owner': 'Claude',
         'assignment': 'Implementation', 'stage': 'dev', 'status': 'pending',
         'next': 'Review the current head', 'evidence': 'Curated source observation.',
         'observed_at': '2025-01-01T10:00:00Z', 'source': 'https://github.com/sfdc-24/conference/pull/28',
         'periods': [{'stage': 'dev', 'kind': 'actual', 'start': '2025-01-01T09:00:00Z',
                      'end': '2025-01-01T10:00:00Z'}]},
        {'id': 'undated', 'title': 'Plan follow-up', 'project': 'Platform', 'owner': 'Codex',
         'assignment': 'Planning', 'stage': 'backlog', 'status': 'pending',
         'next': 'Agree a scope', 'evidence': 'No dated implementation evidence.',
         'observed_at': '2025-01-01T09:00:00Z', 'source': 'https://www.sfdc24.com/ops/', 'periods': []}]}


def check(name='test', head=HEAD, status='completed', conclusion='success', at='2025-01-01T11:00:00Z'):
    return {'name': name, 'head_sha': head, 'status': status, 'conclusion': conclusion, 'observed_at': at}


def github():
    return {'schema_version': 1, 'items': [{'id': 'work', 'source': previous()['items'][0]['source'],
            'head_sha': HEAD, 'state': 'open', 'observed_at': '2025-01-01T11:00:00Z',
            'required_checks': ['test'], 'checks': [check()]}]}


class Projection(unittest.TestCase):
    def test_unchanged_snapshot_has_no_time_or_date_invention(self):
        raw = previous()
        self.assertEqual(raw, delivery.project(raw, now=NOW))
        self.assertEqual(raw, delivery.project(raw, {'schema_version': 1, 'items': []}, now=NOW))

    def test_only_current_head_green_checks_record_testing(self):
        raw = previous()
        output = delivery.project(raw, github(), now=NOW)
        self.assertEqual(('test', 'recorded'), (output['items'][0]['stage'], output['items'][0]['status']))
        self.assertIn('exact-head independent review', output['items'][0]['next'])
        self.assertIn(HEAD, output['items'][0]['evidence'])
        self.assertEqual(raw['items'][0]['periods'], output['items'][0]['periods'])
        self.assertEqual(raw['items'][1], output['items'][1])
        self.assertEqual('2025-01-01T11:00:00Z', output['observed_at'])
        self.assertEqual(raw, previous(), 'Input fixture was not mutated')

    def test_replayed_or_comment_bumped_export_does_not_refresh_evidence(self):
        first = delivery.project(previous(), github(), now=NOW)
        later = github()
        later['items'][0]['observed_at'] = '2025-01-01T18:00:00Z'
        self.assertEqual(first, delivery.project(first, later, now=NOW))
        self.assertEqual(delivery.dumps(first), delivery.dumps(delivery.project(first, github(), now=NOW)))

    def test_moved_head_cannot_inherit_old_greens(self):
        first = delivery.project(previous(), github(), now=NOW)
        moved = github()
        moved['items'][0].update(head_sha=OLD_HEAD, observed_at='2025-01-01T12:00:00Z')
        result = delivery.project(first, moved, now=NOW)['items'][0]
        self.assertEqual(('dev', 'pending'), (result['stage'], result['status']))
        self.assertIn(OLD_HEAD, result['evidence'])
        self.assertNotIn('passed', result['evidence'])
        self.assertTrue(result['next'].startswith('Finish the exact-head checks'))

    def test_duplicate_check_names_cannot_mask_failure_or_pending(self):
        for extra in [check(conclusion='failure', at='2025-01-01T10:30:00Z'),
                      check(status='in_progress', conclusion=None)]:
            source = github()
            source['items'][0]['checks'].append(extra)
            result = delivery.project(previous(), source, now=NOW)['items'][0]
            self.assertEqual('blocked' if extra['conclusion'] == 'failure' else 'pending', result['status'])
            self.assertTrue(result['next'].startswith('Repair the exact-head CI finding' if extra['conclusion'] == 'failure'
                                                     else 'Finish the exact-head checks'))
            source['items'][0]['checks'].reverse()
            self.assertEqual(result, delivery.project(previous(), source, now=NOW)['items'][0])

    def test_reset_to_older_head_invalidates_automatic_green_without_freshening(self):
        first = delivery.project(previous(), github(), now=NOW)
        moved = github()
        moved['items'][0].update(head_sha=OLD_HEAD, observed_at='2025-01-01T09:30:00Z',
                                checks=[check(head=OLD_HEAD, status='queued', conclusion=None,
                                              at='2025-01-01T09:30:00Z')])
        result = delivery.project(first, moved, now=NOW)
        self.assertEqual('pending', result['items'][0]['status'])
        self.assertIn(OLD_HEAD, result['items'][0]['evidence'])
        self.assertNotIn('passed', result['items'][0]['evidence'])
        self.assertEqual(first['observed_at'], result['observed_at'])
        self.assertEqual(first['items'][0]['observed_at'], result['items'][0]['observed_at'])
        self.assertEqual(first['items'][0]['periods'], result['items'][0]['periods'])

    def test_missing_required_check_and_empty_policy_cannot_claim_green(self):
        for names in [['test', 'ownership'], []]:
            source = github()
            source['items'][0]['required_checks'] = names
            self.assertEqual('pending', delivery.project(previous(), source, now=NOW)['items'][0]['status'])

    def test_noncompleted_github_states_are_pending_only_with_null_conclusions(self):
        for status in ['waiting', 'requested', 'pending', 'queued', 'in_progress']:
            with self.subTest(status=status):
                source = github()
                source['items'][0]['checks'] = [check(status=status, conclusion=None)]
                row = delivery.project(previous(), source, now=NOW)['items'][0]
                self.assertEqual(('test', 'pending'), (row['stage'], row['status']))
                self.assertNotIn('passed', row['evidence'])
                source['items'][0]['checks'][0]['conclusion'] = 'success'
                with self.assertRaises(delivery.InvalidEvidence):
                    delivery.project(previous(), source, now=NOW)

    def test_any_current_head_failed_check_still_blocks_including_optional_checks(self):
        source = github()
        source['items'][0]['checks'].append(check(name='optional-preview', conclusion='failure'))
        self.assertEqual('blocked', delivery.project(previous(), source, now=NOW)['items'][0]['status'])

    def test_percent_encoded_credential_prefixes_are_refused_without_exposing_them(self):
        for suffix in ['?token=%67%68%70%5fsynthetic', '#%73%6b%2dsynthetic',
                       '?token=%2567%2568%2570%255fsynthetic', '?auth=%42earer%20synthetic',
                       '?auth=Bearer+synthetic', '?token=%ff']:
            with self.subTest(suffix=suffix):
                raw = previous()
                raw['items'][0]['source'] += suffix
                with self.assertRaises(delivery.InvalidEvidence) as caught:
                    delivery.project(raw, now=NOW)
                self.assertNotIn('synthetic', str(caught.exception))
        safe = 'https://github.com/sfdc-24/conference/tree/main/docs/Design%20notes.md'
        self.assertEqual(safe, delivery.public_source(safe), 'Safe encoding retains its original URL spelling')

    def test_merge_is_staging_pending_and_never_creates_production_interval(self):
        source = github()
        source['items'][0]['state'] = 'merged'
        result = delivery.project(previous(), source, now=NOW)['items'][0]
        self.assertEqual(('staging', 'pending'), (result['stage'], result['status']))
        self.assertEqual('Provide deployed identity, then receiver-side verification and human acceptance.', result['next'])
        self.assertNotIn('production', [period['stage'] for period in result['periods']])
        self.assertEqual(previous()['items'][0]['periods'], result['periods'])

    def test_closed_pr_requires_owner_replanning_without_deployment_claim(self):
        source = github()
        source['items'][0]['state'] = 'closed'
        result = delivery.project(previous(), source, now=NOW)['items'][0]
        self.assertEqual(('dev', 'blocked'), (result['stage'], result['status']))
        self.assertEqual('The owner must replan this work or explicitly close the lane.', result['next'])

    def test_verified_historical_receipt_is_not_rewritten_by_github(self):
        raw = previous()
        receipt = raw['items'][0]
        receipt.update(stage='production', status='verified', evidence='Served identity verified.')
        receipt['periods'] = [{'stage': 'production', 'kind': 'actual',
                               'start': '2025-01-01T10:00:00Z', 'end': '2025-01-01T10:00:00Z'}]
        self.assertEqual(raw, delivery.project(raw, github(), now=NOW))
        override = {'id': 'work', 'observed_at': '2025-01-01T12:00:00Z', 'source': receipt['source'],
                    'evidence': 'Source-only new change.', 'stage': 'dev', 'status': 'pending', 'periods': []}
        with self.assertRaises(delivery.InvalidEvidence):
            delivery.project(raw, okf_export={'schema_version': 1, 'items': [override]}, now=NOW)

    def test_older_github_facts_preserve_newer_manual_evidence(self):
        source = github()
        source['items'][0]['observed_at'] = '2025-01-01T09:00:00Z'
        source['items'][0]['checks'][0]['observed_at'] = '2025-01-01T09:00:00Z'
        self.assertEqual(previous(), delivery.project(previous(), source, now=NOW))

    def test_explicit_okf_override_and_new_row_keep_unknown_dates(self):
        new = copy.deepcopy(previous()['items'][1])
        new.update(id='added', observed_at='2025-01-01T12:00:00Z')
        override = {'id': 'work', 'observed_at': '2025-01-01T12:00:00Z', 'owner': 'Codex',
                    'source': previous()['items'][0]['source'], 'evidence': 'Independent test assignment.',
                    'assignment': 'Independent acceptance', 'periods': []}
        result = delivery.project(previous(), github(), {'schema_version': 1, 'items': [new, override]}, NOW)
        self.assertEqual(['work', 'undated', 'added'], [row['id'] for row in result['items']])
        self.assertEqual('Codex', result['items'][0]['owner'])
        self.assertEqual([], result['items'][0]['periods'])
        self.assertEqual([], result['items'][2]['periods'])
        with self.assertRaises(delivery.InvalidEvidence):
            delivery.project(result, okf_export={'schema_version': 1, 'items': [dict(override, observed_at='2025-01-01T11:00:00Z')]}, now=NOW)

    def test_unproven_okf_production_and_bad_source_binding_are_rejected(self):
        override = {'id': 'work', 'observed_at': '2025-01-01T12:00:00Z', 'source': previous()['items'][0]['source'],
                    'evidence': 'Merged.', 'stage': 'production', 'status': 'verified'}
        with self.assertRaises(delivery.InvalidEvidence):
            delivery.project(previous(), okf_export={'schema_version': 1, 'items': [override]}, now=NOW)
        source = github()
        source['items'][0]['source'] = 'https://github.com/sfdc-24/conference/pull/29'
        with self.assertRaises(delivery.InvalidEvidence):
            delivery.project(previous(), source, now=NOW)

    def test_unknown_fields_and_raw_private_content_do_not_survive(self):
        raw, source = previous(), github()
        raw['token'] = 'secret-one'
        raw['items'][0]['private_body'] = 'secret-two'
        raw['items'][0]['periods'][0]['raw'] = 'secret-three'
        source['items'][0]['body'] = 'secret-four'
        source['items'][0]['checks'][0]['output'] = 'secret-five'
        output = delivery.project(raw, source, now=NOW)
        self.assertNotIn('secret-', delivery.dumps(output))
        override = {'id': 'work', 'observed_at': '2025-01-01T12:00:00Z',
                    'source': previous()['items'][0]['source'], 'evidence': 'Public evidence.', 'transcript': 'secret-six'}
        self.assertNotIn('secret-six', delivery.dumps(delivery.project(output, okf_export={'schema_version': 1, 'items': [override]}, now=NOW)))

    def test_invalid_schema_dates_links_and_shapes_fail_closed(self):
        for change in [lambda x: x.update(schema_version=True),
                       lambda x: x.update(observed_at='2025-02-30T00:00:00Z'),
                       lambda x: x.update(observed_at='2030-01-01T00:00:00Z'),
                       lambda x: x['items'][0].update(stage=[]),
                       lambda x: x['items'][0].update(source='javascript:alert(1)'),
                       lambda x: x['items'][0].update(source='https://github.com:444/sfdc-24/x'),
                       lambda x: x['items'][0].update(source='https://github.com/sfdc-24/%2e%2e/other'),
                       lambda x: x['items'][0]['periods'][0].update(end='2025-01-01T12:00:00Z'),
                       lambda x: x['items'].append(copy.deepcopy(x['items'][0]))]:
            raw = previous()
            change(raw)
            with self.assertRaises(delivery.InvalidEvidence):
                delivery.project(raw, now=NOW)

    def test_generated_snapshot_matches_the_browser_contract(self):
        result = delivery.project(previous(), github(), now=NOW)
        # Existing renderer validator is the independent schema consumer.
        script = "const g=require('./assets/ops-gantt.js');let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>g.validate(JSON.parse(s),Date.parse('2025-01-02T00:00:00Z')));"
        checked = subprocess.run(['node', '-e', script], cwd=ROOT, input=delivery.dumps(result), text=True,
                                 capture_output=True, timeout=10)
        self.assertEqual(0, checked.returncode, checked.stderr)


class AtomicCLI(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.previous = self.root / 'previous.json'
        self.output = self.root / 'output.json'
        self.source = self.root / 'github.json'
        self.previous.write_text(json.dumps(previous(), indent=4) + '\n', encoding='utf-8')
        self.output.write_bytes(self.previous.read_bytes())
        self.source.write_text(json.dumps(github()), encoding='utf-8')

    def run_cli(self, *extra):
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            return delivery.main(['--previous', str(self.previous), '--out', str(self.output), *extra])

    def test_noop_preserves_bytes_and_destination_mtime(self):
        before, stamp = self.output.read_bytes(), self.output.stat().st_mtime_ns
        self.assertEqual(0, self.run_cli())
        self.assertEqual(before, self.output.read_bytes())
        self.assertEqual(stamp, self.output.stat().st_mtime_ns)
        self.output.unlink()
        self.assertEqual(0, self.run_cli())
        self.assertEqual(before, self.output.read_bytes())

    def test_valid_update_is_atomic_and_replay_is_noop(self):
        self.assertEqual(0, self.run_cli('--github-export', str(self.source)))
        first, stamp = self.output.read_bytes(), self.output.stat().st_mtime_ns
        self.assertEqual('test', json.loads(first)['items'][0]['stage'])
        self.assertEqual(0, self.run_cli('--github-export', str(self.source)))
        self.assertEqual(first, self.output.read_bytes())
        self.assertEqual(stamp, self.output.stat().st_mtime_ns)
        self.assertFalse(list(self.root.glob('*.tmp')))

    def test_malformed_inputs_never_replace_last_good(self):
        before = self.output.read_bytes()
        for value in ['{broken', '{"schema_version":1,"schema_version":1,"items":[]}',
                      '{"schema_version":1,"items":null}', '{"schema_version":1,"items":[],"raw":NaN}']:
            self.source.write_text(value, encoding='utf-8')
            self.assertEqual(1, self.run_cli('--github-export', str(self.source)))
            self.assertEqual(before, self.output.read_bytes())

    def test_backdated_override_and_atomic_replace_failure_keep_last_good(self):
        before = self.output.read_bytes()
        override = {'schema_version': 1, 'items': [{'id': 'work', 'observed_at': '2025-01-01T09:00:00Z',
                    'source': previous()['items'][0]['source'], 'evidence': 'Old override.'}]}
        self.source.write_text(json.dumps(override), encoding='utf-8')
        self.assertEqual(1, self.run_cli('--okf-export', str(self.source)))
        self.assertEqual(before, self.output.read_bytes())
        self.source.write_text(json.dumps(github()), encoding='utf-8')
        with patch.object(delivery.os, 'replace', side_effect=OSError('synthetic failure')):
            self.assertEqual(1, self.run_cli('--github-export', str(self.source)))
        self.assertEqual(before, self.output.read_bytes())
        self.assertFalse(list(self.root.glob('*.tmp')))

    def test_existing_newer_destination_cannot_regress(self):
        newer = previous()
        newer['observed_at'] = newer['items'][0]['observed_at'] = '2025-01-01T15:00:00Z'
        self.output.write_text(json.dumps(newer), encoding='utf-8')
        before = self.output.read_bytes()
        self.assertEqual(1, self.run_cli('--github-export', str(self.source)))
        self.assertEqual(before, self.output.read_bytes())


class ShippedReceiptTest(unittest.TestCase):
    """A verified production receipt in the shipped feed stays verified (Codex NO-GO on #255: a refresh
    moved PR245's receipted production release back to 'staging, pending, production unverified')."""

    def test_pr245_keeps_its_verified_production_receipt(self):
        feed = json.loads((Path(__file__).resolve().parents[1] / "data" / "ops-delivery.json").read_text(encoding="utf-8"))
        [row] = [r for r in feed["items"] if r["source"].endswith("/pull/245")]
        self.assertEqual(("production", "verified"), (row["stage"], row["status"]))
        self.assertIn({"stage": "production", "kind": "actual", "start": "2026-09-27T19:16:12Z",
                       "end": "2026-09-27T19:16:12Z"}, row["periods"])
        self.assertIn("5859009029", row["evidence"])
        self.assertIn("schedule reliability", row["next"])           # still unknown, and said so


if __name__ == '__main__':
    unittest.main()
