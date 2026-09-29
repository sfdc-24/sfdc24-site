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

    def test_newer_seed_milestones_publish_on_the_feed(self):
        previous = fixture()
        seed = copy.deepcopy(previous)
        seed['observed_at'] = seed['items'][0]['observed_at'] = '2026-09-27T13:00:00Z'
        seed['milestones'] = [milestone()]
        result = bake(previous, seed, {}, {'sfdc-24/sfdc24-site'}, lambda _: self.fail('outside scope'))
        self.assertEqual(result['milestones'], [milestone()])

    def test_older_seed_cannot_replace_newer_feed_milestones(self):
        previous = fixture()
        previous['observed_at'] = previous['items'][0]['observed_at'] = '2026-09-27T13:00:00Z'
        previous['milestones'] = [milestone('kept', 'Gateway deploy')]
        seed = fixture()
        seed['milestones'] = [milestone('stale', 'Stale gate')]
        result = bake(previous, seed, {}, {'sfdc-24/sfdc24-site'}, lambda _: self.fail('outside scope'))
        self.assertEqual([mark['id'] for mark in result['milestones']], ['kept'])

    def test_recorded_milestone_after_the_snapshot_is_rejected(self):
        seed = fixture()
        seed['milestones'] = [milestone('late', 'EOC close', status='recorded', at='2026-09-27T13:00:00Z')]
        with self.assertRaises(InvalidEvidence):
            bake(fixture(), seed, {}, set(), lambda _: self.fail('network before validation'))


def milestone(ident='eoc-close', label='EOC close', status='planned', at='2026-09-28T18:30:00Z'):
    return {'id': ident, 'label': label, 'project': 'Conference', 'at': at, 'status': status,
            'evidence': 'Named by the rehearsal dispatch.',
            'source': 'https://github.com/sfdc-24/conference/pull/50'}


if __name__ == '__main__':
    unittest.main()
