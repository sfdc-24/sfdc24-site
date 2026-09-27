import importlib.util
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("collect", Path(__file__).parents[1] / "tools/ops_delivery_collect.py")
collect = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collect)


class CollectorTests(unittest.TestCase):
    def setUp(self):
        self.head = "a" * 40
        self.url = "https://github.com/sfdc-24/conference/pull/28"
        self.previous = {"schema_version": 1, "items": [{"id": "voice", "source": self.url}]}
        self.policy = {"sfdc-24/conference": ["chair / core"]}
        self.pull = {"head": {"sha": self.head}, "state": "closed", "merged_at": "2026-09-27T16:00:00Z",
                     "created_at": "2026-09-27T14:00:00Z", "updated_at": "2026-09-27T18:00:00Z",
                     "body": "PRIVATE CONTENT MUST NEVER EXPORT"}
        self.commit = {"sha": self.head, "commit": {"committer": {"date": "2026-09-27T15:00:00Z"}}}
        self.row = {"name": "chair / core", "head_sha": self.head, "status": "completed", "conclusion": "success",
                    "started_at": "2026-09-27T15:30:00Z", "completed_at": "2026-09-27T15:40:00Z"}

    def read(self, path):
        if "/pulls/" in path:
            return self.pull
        if "/check-runs?" in path:
            self.assertIn("filter=all&", path)
            return {"check_runs": [self.row], "total_count": 1}
        return self.commit

    def test_exports_exact_head_source_times_and_no_body(self):
        result = collect.collect(self.previous, self.policy, self.read)
        item = result["items"][0]
        self.assertEqual(item["state"], "merged")
        self.assertEqual(item["head_sha"], self.head)
        self.assertEqual(item["observed_at"], "2026-09-27T16:00:00Z")
        self.assertNotIn("PRIVATE", str(result))
        self.assertEqual(result, collect.collect(self.previous, self.policy, self.read))

    def test_requires_explicit_check_policy(self):
        with self.assertRaises(ValueError):
            collect.collect(self.previous, {}, self.read)

    def test_unstarted_checks_use_head_anchor_not_comment_or_poll(self):
        for state in ('queued', 'requested', 'waiting', 'pending'):
            with self.subTest(state=state):
                self.row.update(status=state, conclusion=None, started_at=None, completed_at=None)
                record = collect.collect(self.previous, self.policy, self.read)['items'][0]
                self.assertEqual(record['checks'][0]['observed_at'], '2026-09-27T15:00:00Z')
                self.assertNotEqual(record['checks'][0]['observed_at'], self.pull['updated_at'])

    def test_completed_check_without_event_time_fails_closed(self):
        self.row.update(started_at=None, completed_at=None)
        with self.assertRaises(ValueError):
            collect.collect(self.previous, self.policy, self.read)

    def test_head_mismatch_fails(self):
        self.row["head_sha"] = "b" * 40
        with self.assertRaises(ValueError):
            collect.collect(self.previous, self.policy, self.read)

    def test_missing_or_incomplete_checks_fail(self):
        for response in ({}, {"check_runs": [], "total_count": 1}):
            def read(path):
                if "/check-runs?" in path:
                    return response
                return self.read(path)
            with self.assertRaises(ValueError):
                collect.collect(self.previous, self.policy, read)

    def test_moving_head_during_collection_fails(self):
        calls = []
        def read(path):
            if "/pulls/" not in path:
                return self.read(path)
            calls.append(path)
            return self.pull if len(calls) == 1 else {**self.pull, "head": {"sha": "b" * 40}}
        with self.assertRaises(ValueError):
            collect.collect(self.previous, self.policy, read)

    def test_non_pr_sources_are_not_probed(self):
        previous = {"schema_version": 1, "items": [{"id": "private", "source": "https://other.example/private"}]}
        self.assertEqual(collect.collect(previous, {}, lambda _: self.fail("unexpected request"))["items"], [])

    def test_repo_scope_does_not_probe_private_other_repo(self):
        result = collect.collect(self.previous, {}, lambda _: self.fail("private repo accessed"),
                                 repositories={"sfdc-24/sfdc24-site"})
        self.assertEqual(result["items"], [])

    def test_comment_timestamp_cannot_freshen_prior_manual_hold(self):
        import sys
        sys.path.insert(0, str(Path(__file__).parents[1] / 'tools'))
        from ops_delivery import project
        self.pull.update(state='open', merged_at=None)
        prior = {"schema_version": 1, "observed_at": "2026-09-27T17:00:00Z", "items": [{
            "id": "voice", "project": "Conference", "title": "Voice", "owner": "Claude",
            "assignment": "Implementation", "stage": "test", "status": "blocked", "observed_at": "2026-09-27T17:00:00Z",
            "source": self.url, "evidence": "Independent review blocked", "next": "Repair finding", "periods": []}]}
        exported = collect.collect(prior, self.policy, self.read)
        self.assertEqual(project(prior, exported), prior)

    def test_all_filter_retains_duplicate_same_head_failed_check(self):
        failure = {**self.row, 'conclusion': 'failure', 'completed_at': '2026-09-27T15:35:00Z'}
        def read(path):
            if '/check-runs?' in path:
                self.assertIn('filter=all&', path)
                return {'check_runs': [failure, self.row], 'total_count': 2}
            return self.read(path)
        records = collect.collect(self.previous, self.policy, read)['items'][0]['checks']
        self.assertEqual(len(records), 2)
        self.assertIn('failure', [row['conclusion'] for row in records])


if __name__ == "__main__":
    unittest.main()
