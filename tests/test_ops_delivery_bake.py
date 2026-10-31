import copy
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1] / 'tools'))
from ops_delivery_bake import bake, seed_overrides
from ops_delivery import InvalidEvidence


def fixture():
    return {'schema_version': 1, 'observed_at': '2026-09-27T12:00:00Z', 'items': [{
        'id': 'task', 'title': 'Test build', 'project': 'Conference', 'owner': 'Claude',
        'assignment': 'Implementation', 'stage': 'dev', 'status': 'pending',
        'observed_at': '2026-09-27T12:00:00Z', 'source': 'https://github.com/sfdc-24/conference/pull/28',
        'evidence': 'Source only', 'next': 'Finish tests', 'periods': []}]}


class BakeTests(unittest.TestCase):
    def test_old_seed_cannot_regress_newer_feed(self):
        old = fixture()
        latest = copy.deepcopy(old)
        latest['observed_at'] = latest['items'][0]['observed_at'] = '2026-09-27T13:00:00Z'
        latest['items'][0]['evidence'] = 'Newer independent evidence'
        result = bake(latest, old, {}, {'sfdc-24/sfdc24-site'}, lambda _: self.fail('outside scope'))
        self.assertEqual(result, latest)

    def test_new_curated_receipt_survives_scoped_poll(self):
        old = fixture()
        seed = copy.deepcopy(old)
        seed['observed_at'] = seed['items'][0]['observed_at'] = '2026-09-27T13:00:00Z'
        seed['items'][0].update(stage='production', status='verified', evidence='Explicit served identity and browser receipt',
                                periods=[{'stage': 'production', 'kind': 'actual', 'start': '2026-09-27T13:00:00Z', 'end': '2026-09-27T13:00:00Z'}])
        self.assertEqual(bake(old, seed, {}, {'sfdc-24/sfdc24-site'}), seed)

    def test_new_task_is_admitted_from_curated_seed(self):
        previous, seed = fixture(), fixture()
        added = copy.deepcopy(seed['items'][0]); added['id'] = 'second'
        seed['items'].append(added)
        self.assertEqual(len(bake(previous, seed, {}, set())['items']), 2)

    def test_invalid_seed_rejected_before_network(self):
        seed = fixture(); seed['items'][0]['source'] = 'javascript:alert(1)'
        with self.assertRaises(InvalidEvidence):
            bake(fixture(), seed, {}, None, lambda _: self.fail('network before validation'))

    def test_a_failed_bake_logs_its_cause_and_never_a_token(self):
        import contextlib
        import io
        from unittest import mock
        import ops_delivery_bake
        err = io.StringIO()
        boom = OSError('gh api failed with token=ghp_SECRETSECRET for Bearer abc.def\nsecond line')
        argv = ['bake', '--previous', 'p', '--seed', 's', '--policy', 'q', '--out', 'o']
        with mock.patch.object(ops_delivery_bake, 'load', side_effect=boom), mock.patch.object(sys, 'argv', argv), \
                contextlib.redirect_stderr(err):
            self.assertEqual(1, ops_delivery_bake.main())
        out = err.getvalue()
        self.assertIn('Delivery bake failed; retain last good snapshot.', out)
        self.assertIn('cause: OSError: gh api failed with', out)
        self.assertNotIn('ghp_SECRET', out)
        self.assertNotIn('abc.def', out)
        self.assertNotIn('second line', out)


if __name__ == '__main__':
    unittest.main()
