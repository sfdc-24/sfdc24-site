"""Merged-pull-request discovery for the Ops delivery feed. No network."""
import copy
import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1] / "tools"))
from ops_delivery_bake import bake, refresh
from ops_delivery_discover import discover, plain_title

NOW = datetime(2026, 10, 7, 17, 0, tzinfo=timezone.utc)
HEAD = "ab" * 20


def previous():
    return {"schema_version": 1, "observed_at": "2026-09-30T10:40:26Z", "items": [{
        "id": "kept", "title": "Hear the room", "project": "Conference", "owner": "Claude",
        "assignment": "Implementation", "stage": "staging", "status": "pending",
        "observed_at": "2026-09-30T10:40:26Z",
        "source": "https://github.com/sfdc-24/conference/pull/28",
        "evidence": "Already listed", "next": "Keep this row", "periods": []}]}


def pull(number, title, merged, created="2026-10-06T14:00:00Z", ref="cursor/plain-words", body="DO NOT PUBLISH"):
    return {"number": number, "title": title, "merged_at": merged, "created_at": created,
            "state": "closed", "closed_at": merged, "head": {"ref": ref, "sha": HEAD}, "body": body}


class DiscoverTests(unittest.TestCase):
    def test_plain_titles_keep_sentences_and_drop_numbers_names_and_secrets(self):
        self.assertEqual("Explain the release clock in plain words",
                         plain_title("  Explain   the release clock in plain words "))
        for title in ("#400", "400", "redis queue depth 42", "A note for salam",
                      "Rotate the api key", "client portal", "", "   ", 12):
            self.assertIsNone(plain_title(title), title)

    def test_new_merged_pull_requests_are_added_by_title_and_known_ones_are_not_repeated(self):
        seen = []

        def read(path):
            seen.append(path)
            if path.startswith("search/issues"):
                self.assertIn("Blackboard", path)
                self.assertNotIn("conference", path)
                return {"items": [
                    {"number": 300, "title": "Already listed elsewhere"},
                    {"number": 310, "title": "Show the board lane in plain words"},
                    {"number": 311, "title": "#311"},
                    {"number": 312, "title": "redis hit rate"},
                ]}
            if path.endswith("/pulls/310"):
                return pull(310, "Show the board lane in plain words", "2026-10-06T15:00:00Z")
            if path.endswith("/pulls/311"):
                return pull(311, "#311", "2026-10-06T16:00:00Z")
            if path.endswith("/pulls/312"):
                return pull(312, "redis hit rate", "2026-10-06T16:30:00Z")
            self.fail(path)

        base = previous()
        base["items"].append(dict(base["items"][0], id="board-300",
                                   source="https://github.com/sfdc-24/Blackboard/pull/300"))
        found = discover(base, read, NOW, ["sfdc-24/Blackboard"])
        self.assertEqual(["merged-blackboard-310"], [row["id"] for row in found["items"]])
        row = found["items"][0]
        self.assertEqual("Show the board lane in plain words", row["title"])
        self.assertEqual("Cursor", row["owner"])
        self.assertEqual("Blackboard", row["project"])
        self.assertEqual("staging", row["stage"])
        self.assertEqual("pending", row["status"])
        self.assertEqual("https://github.com/sfdc-24/Blackboard/pull/310", row["source"])
        self.assertNotIn("DO NOT PUBLISH", str(found))
        self.assertNotIn("redis", str(found).lower())
        self.assertTrue(any(path.startswith("search/issues") for path in seen))

    def test_older_discovered_rows_make_room_for_a_newer_merge(self):
        from ops_delivery_discover import prune_discovered

        def row(number, when, protected=False):
            item = {"id": "kept" if protected else "merged-sfdc24-site-%s" % number,
                    "observed_at": when, "stage": "staging", "status": "pending"}
            return item
        previous_rows = {
            "schema_version": 1,
            "items": [row(1, "2026-10-01T00:00:00Z", protected=True),
                      row(10, "2026-10-02T00:00:00Z"),
                      row(11, "2026-10-03T00:00:00Z")]}
        incoming = [row(12, "2026-10-06T00:00:00Z")]
        pruned, new_rows = prune_discovered(previous_rows, incoming, keep=2, limit=4)
        self.assertEqual(["kept", "merged-sfdc24-site-11"], [item["id"] for item in pruned["items"]])
        self.assertEqual(["merged-sfdc24-site-12"], [item["id"] for item in new_rows])

    def test_the_newest_rows_fill_the_remaining_room(self):
        def read(path):
            if path.startswith("search/issues"):
                return {"items": [{"number": 1}, {"number": 2}, {"number": 3}]}
            number = int(path.rsplit("/", 1)[-1])
            hour = 10 + number
            return pull(number, "Merged change %s" % number, "2026-10-06T%02d:00:00Z" % hour,
                        ref="codex/change-%s" % number)
        found = discover(previous(), read, NOW, ["sfdc-24/sfdc24-site"], limit=2)
        self.assertEqual(["merged-sfdc24-site-3", "merged-sfdc24-site-2"],
                         [row["id"] for row in found["items"]])
        self.assertTrue(all(row["owner"] == "Codex" for row in found["items"]))

    def test_a_private_repository_is_not_a_discovery_source(self):
        with self.assertRaises(ValueError):
            discover(previous(), lambda path: self.fail(path), NOW, ["sfdc-24/conference"])

    def test_a_broken_search_fails_closed(self):
        with self.assertRaises(ValueError):
            discover(previous(), lambda path: {"message": "no"}, NOW, ["sfdc-24/sfdc24-site"])

    def test_bake_keeps_curated_rows_and_records_the_refresh(self):
        def read(path):
            self.assertNotIn("conference", path)
            if path.startswith("search/issues"):
                return {"items": [{"number": 310}]}
            if path.endswith("/pulls/310"):
                return pull(310, "Show the board lane in plain words", "2026-10-06T15:00:00Z")
            self.fail(path)

        result = refresh(previous(), previous(), {}, repositories={"sfdc-24/sfdc24-site"},
                         read=read, discover_repos=["sfdc-24/Blackboard"], now=NOW)
        self.assertEqual("2026-10-07T17:00:00Z", result["refreshed_at"])
        self.assertEqual(["kept", "merged-blackboard-310"], [row["id"] for row in result["items"]])
        added = result["items"][1]
        self.assertEqual("Show the board lane in plain words", added["title"])
        self.assertEqual("pending", added["status"])
        self.assertEqual("staging", added["stage"])
        self.assertNotIn("DO NOT PUBLISH", str(result))

    def test_a_site_merge_is_checked_and_keeps_its_plain_title(self):
        policy = {"sfdc-24/sfdc24-site": ["site-positioning-test / test"]}

        def read(path):
            if path.startswith("search/issues"):
                return {"items": [{"number": 400}]}
            if "/pulls/400" in path:
                return pull(400, "Explain the release clock in plain words", "2026-10-06T15:00:00Z",
                            ref="cursor/clock-words")
            if path.endswith("/commits/" + HEAD):
                return {"sha": HEAD, "commit": {"committer": {"date": "2026-10-06T14:30:00Z"}}}
            if "/check-runs?" in path:
                self.assertIn("filter=all", path)
                return {"total_count": 1, "check_runs": [{
                    "name": "site-positioning-test / test", "head_sha": HEAD, "status": "completed",
                    "conclusion": "success", "started_at": "2026-10-06T14:40:00Z",
                    "completed_at": "2026-10-06T14:50:00Z"}]}
            self.fail(path)

        result = bake(previous(), previous(), policy, repositories={"sfdc-24/sfdc24-site"},
                      read=read, discover_repos=["sfdc-24/sfdc24-site"], now=NOW)
        added = next(row for row in result["items"] if row["id"] == "merged-sfdc24-site-400")
        self.assertEqual("Explain the release clock in plain words", added["title"])
        self.assertEqual("staging", added["stage"])
        self.assertEqual("pending", added["status"])
        self.assertIn(HEAD, added["evidence"])
        self.assertNotIn("DO NOT PUBLISH", str(result))
        self.assertNotIn("body", added)

    def test_refresh_does_not_move_evidence_time_when_nothing_new_arrived(self):
        before = previous()
        result = refresh(before, copy.deepcopy(before), {}, repositories=set(), read=lambda path: self.fail(path),
                         now=NOW)
        self.assertEqual(before["items"], result["items"])
        self.assertEqual(before["observed_at"], result["observed_at"])
        self.assertEqual("2026-10-07T17:00:00Z", result["refreshed_at"])


if __name__ == "__main__":
    unittest.main()
