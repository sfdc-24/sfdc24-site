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
                     "updated_at": "2026-09-27T16:00:01Z", "body": "PRIVATE CONTENT MUST NEVER EXPORT"}
        self.row = {"name": "chair / core", "head_sha": self.head, "status": "completed", "conclusion": "success",
                    "started_at": "2026-09-27T15:30:00Z", "completed_at": "2026-09-27T15:40:00Z"}

    def read(self, path):
        return self.pull if "/pulls/" in path else {"check_runs": [self.row], "total_count": 1}

    def test_exports_exact_head_source_times_and_no_body(self):
        result = collect.collect(self.previous, self.policy, self.read)
        item = result["items"][0]
        self.assertEqual(item["state"], "merged")
        self.assertEqual(item["head_sha"], self.head)
        self.assertEqual(item["observed_at"], "2026-09-27T16:00:01Z")
        self.assertNotIn("PRIVATE", str(result))
        self.assertEqual(result, collect.collect(self.previous, self.policy, self.read))

    def test_requires_explicit_check_policy(self):
        with self.assertRaises(ValueError):
            collect.collect(self.previous, {}, self.read)

    def test_head_mismatch_fails(self):
        self.row["head_sha"] = "b" * 40
        with self.assertRaises(ValueError):
            collect.collect(self.previous, self.policy, self.read)

    def test_missing_or_incomplete_checks_fail(self):
        for response in ({}, {"check_runs": [], "total_count": 1}):
            def read(path):
                return self.pull if "/pulls/" in path else response
            with self.assertRaises(ValueError):
                collect.collect(self.previous, self.policy, read)

    def test_moving_head_during_collection_fails(self):
        calls = []
        def read(path):
            if "/pulls/" not in path:
                return {"check_runs": [self.row], "total_count": 1}
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


if __name__ == "__main__":
    unittest.main()
