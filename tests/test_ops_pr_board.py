"""PR board collector and governed projection. No live GitHub or Redis calls."""
import base64
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
spec = importlib.util.spec_from_file_location("ops_pr_board", ROOT / "tools/ops_pr_board.py")
board = importlib.util.module_from_spec(spec)
spec.loader.exec_module(board)
import ops_delivery  # noqa: E402

HEAD = "a" * 40
OLD = "b" * 40
BASE = "c" * 40
AS_OF = "2026-10-09T17:00:00Z"
CREATED = "2026-10-07T16:00:00Z"
REOPENED = "2026-10-09T12:00:00Z"
TITLE = "Launch plan PRIVATE TITLE"
LABEL = "secret project name"
TOKEN = "gh" + "p_abcdefghijklmnopqrstuvwxyz0123456789"
REPOS = ("sfdc-24/conference", "sfdc-24/Blackboard", "sfdc-24/sfdc24-site")


def raw(number, head=HEAD):
    return {
        "number": number, "state": "open", "draft": False, "created_at": CREATED,
        "updated_at": "2026-10-09T16:59:00Z", "title": TITLE,
        "body": "PRIVATE CONTENT MUST NEVER EXPORT " + TOKEN,
        "head": {"sha": head, "ref": "cursor/pr-board"}, "base": {"sha": BASE},
        "user": {"login": "sfdc-24"}, "assignees": [{"login": "cursor"}],
        "requested_reviewers": [{"login": "grok"}],
        "labels": [{"name": "security"}, {"name": LABEL}],
    }


def record(repo="sfdc-24/conference", number=7, **extra):
    base = {
        "repo": repo, "number": number, "state": "open", "created_at": CREATED,
        "proposed_head": HEAD, "author": "sfdc-24", "assignees": ["cursor"],
        "review_requests": ["grok"], "head_ref": "cursor/pr-board", "draft": False,
        "reviews": [], "events": [], "checks": None, "required_checks": [],
    }
    base.update(extra)
    return base


def catalog():
    rows = {
        "sfdc-24/conference": [raw(number) for number in range(1, 121)],
        "sfdc-24/Blackboard": [raw(number) for number in range(1, 102)],
        "sfdc-24/sfdc24-site": [raw(5)],
    }
    calls = []

    def read(path):
        calls.append(path)
        if "/reviews?" in path or "/events?" in path:
            return []
        for repo, items in rows.items():
            if path.startswith("repos/%s/pulls?" % repo):
                page = int(re.search(r"[?&]page=(\d+)", path).group(1))
                start = (page - 1) * 100
                return items[start:start + 100]
        raise AssertionError(path)

    return read, calls


class Store:
    def __init__(self):
        self.data = {}
        self.audit = []
        self.writes = 0
        self.fail_at = None
        self.timeout_at = None
        self.partial_at = None
        self.preview = False

    def read_full(self, key):
        got = self.data.get(key)
        if got is None:
            return None
        if not self.preview:
            return dict(got)
        return {name: value if len(value) <= 200 else value[:200] + "..." for name, value in got.items()}

    def put(self, key, mapping):
        self.writes += 1
        if self.timeout_at == self.writes:
            raise TimeoutError()
        encoded = json.dumps(mapping, sort_keys=True, separators=(",", ":"))
        self.audit.append(encoded[:200])
        if not str(key).startswith("proj:pr-board:"):
            return {"ok": False, "refused": "namespace"}
        if len(encoded.encode()) > 2048 or len(mapping) > 50:
            return {"ok": False, "refused": "cap"}
        if self.partial_at == self.writes:
            self.data[key] = dict(mapping)
            return {"ok": False, "partial": True, "error": "AUDIT FAILED - the write may have landed unaudited"}
        if self.fail_at == self.writes:
            return {"ok": False, "error": "failed"}
        self.data[key] = dict(mapping)
        return {"ok": True, "op": "hput", "key": key}


class BoardTests(unittest.TestCase):
    def generation(self, records, **kwargs):
        return board.build_generation(records, AS_OF, **kwargs)

    def test_all_repositories_paginate_past_100(self):
        read, calls = catalog()
        receipt = board.run(AS_OF, read, enabled_flag=True)
        self.assertEqual(receipt["status"], "projected_not_written")
        generation = receipt["generation"]
        self.assertEqual(generation["counts"], {
            "sfdc-24/conference": 120, "sfdc-24/Blackboard": 101, "sfdc-24/sfdc24-site": 1})
        self.assertGreater(generation["counts"]["sfdc-24/conference"], 100)
        self.assertTrue(any("sfdc-24/conference/pulls?" in path and "page=2" in path for path in calls))
        self.assertTrue(any("sfdc-24/Blackboard/pulls?" in path and "page=2" in path for path in calls))
        self.assertTrue(any(path.startswith("repos/sfdc-24/sfdc24-site/pulls?") for path in calls))
        self.assertEqual(len(generation["items"]), 222)
        conference = next(item for item in generation["items"] if item["repo"] == "sfdc-24/conference")
        blackboard = next(item for item in generation["items"] if item["repo"] == "sfdc-24/Blackboard")
        self.assertEqual(conference["queue_owners"], ["cursor", "grok"])
        self.assertEqual(blackboard["queue_owners"], ["claude"])
        self.assertEqual(conference["project"], "Conference")
        self.assertEqual(blackboard["project"], "Blackboard")
        self.assertEqual(generation["by_project"]["SFDC24.com"]["count"], 1)
        self.assertEqual(conference["creation_age"]["hours"], 49)
        self.assertEqual(conference["creation_age"]["days"], 2)
        self.assertEqual(conference["creation_age"]["basis"], "since_creation")
        self.assertEqual(conference["as_of"], AS_OF)
        self.assertEqual(generation["inventory_delta"]["sfdc-24/conference"], 120 - 69)
        self.assertNotEqual(generation["counts"]["sfdc-24/sfdc24-site"], 34)
        for mapping in dict(board.redis_documents(generation)).values():
            encoded = json.dumps(mapping, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
            self.assertLessEqual(len(encoded.encode()), 2048)
            self.assertLessEqual(len(mapping), 50)

    def test_duplicate_and_reordered_events_keep_one_generation(self):
        events = [
            {"id": 2, "event": "reopened", "created_at": REOPENED},
            {"id": 1, "event": "closed", "created_at": "2026-10-08T17:00:00Z"},
            {"id": 2, "event": "reopened", "created_at": REOPENED},
        ]
        first = self.generation([record(events=events)])
        second = self.generation([record(events=list(reversed(events)))])
        self.assertEqual(first["id"], second["id"])
        current = first["items"][0]["current_open"]
        self.assertEqual(current["basis"], "since_reopen")
        self.assertTrue(current["measured"])
        self.assertEqual(current["hours"], 5)
        self.assertEqual(current["days"], 0)
        self.assertEqual(first["items"][0]["creation_age"]["hours"], 49)

    def test_access_loss_keeps_last_good_without_empty_items(self):
        def read(path):
            if path.startswith("repos/sfdc-24/conference/pulls?"):
                if "page=1" in path:
                    return [raw(1)]
                return []
            raise ValueError("GitHub metadata read failed")

        receipt = board.run(AS_OF, read, enabled_flag=True)
        self.assertEqual(receipt["status"], "stale")
        self.assertEqual(receipt["reason"], "source_failure")
        self.assertIsNone(receipt["items"])
        self.assertNotIn("counts", receipt)
        self.assertFalse(receipt["wrote"])

    def test_private_data_does_not_leak_into_projection_or_audit(self):
        def read(path):
            if path.startswith("repos/sfdc-24/conference/pulls?") and "page=1" in path:
                return [raw(7)]
            if path.startswith("repos/sfdc-24/conference/pulls?"):
                return []
            if path.startswith("repos/sfdc-24/Blackboard/pulls?") or path.startswith("repos/sfdc-24/sfdc24-site/pulls?"):
                return [] if "page=1" in path else []
            if "/reviews?" in path:
                return [{"state": "APPROVED", "commit_id": HEAD, "submitted_at": CREATED,
                         "body": "do not export this review " + TOKEN, "user": {"login": "aya"}}]
            if "/events?" in path:
                return [{"id": 1, "event": "commented", "created_at": CREATED, "body": TITLE}]
            return []

        receipt = board.run(AS_OF, read, enabled_flag=True)
        generation = receipt["generation"]
        encoded = json.dumps(generation)
        for secret in (TITLE, LABEL, TOKEN, "PRIVATE CONTENT", BASE):
            self.assertNotIn(secret, encoded)
        self.assertNotIn("title", encoded)
        self.assertNotIn("body", encoded)
        store = Store()
        written = board.write_generation(generation, store.put, store.read_full)
        self.assertEqual(written["status"], "complete")
        leaked = json.dumps(store.data) + json.dumps(store.audit)
        for secret in (TITLE, LABEL, TOKEN, "PRIVATE CONTENT", BASE):
            self.assertNotIn(secret, leaked)
        with self.assertRaises(board.InvalidEvidence):
            board.build_generation([record()], AS_OF, acknowledgments=[{
                "repo": "sfdc-24/conference", "number": 7, "role": "closure_driver",
                "actor": "grok", "acknowledged": True, "source": "okf:has space"}])

    def test_shared_author_and_assignee_are_not_owners(self):
        generation = self.generation([
            record("sfdc-24/conference", 7),
            record("sfdc-24/Blackboard", 3, author="sfdc-24", assignees=["cursor"], head_ref="cursor/pr-board"),
            record("sfdc-24/sfdc24-site", 5, author="cursor", assignees=["sfdc-24"]),
        ])
        by_id = {item["id"]: item for item in generation["items"]}
        conference, blackboard, site = by_id["sfdc-24/conference#7"], by_id["sfdc-24/Blackboard#3"], by_id["sfdc-24/sfdc24-site#5"]
        self.assertEqual(conference["queue_owners"], ["cursor", "grok"])
        self.assertEqual(blackboard["queue_owners"], ["claude"])
        self.assertEqual(site["queue_owners"], ["cursor", "grok"])
        for item in (conference, blackboard, site):
            self.assertIsNone(item["closure_driver"])
            self.assertEqual(item["closure_driver_state"], "unacknowledged")
            self.assertIsNone(item["implementation_owner"])
        self.assertNotIn("sfdc-24", conference["queue_owners"])
        self.assertNotIn("cursor", blackboard["queue_owners"])
        self.assertEqual(conference["author"], "sfdc-24")
        self.assertEqual(conference["assignees"], ["cursor"])
        self.assertEqual(conference["head_ref"], "cursor/pr-board")
        self.assertEqual(site["author"], "cursor")

    def test_handoff_requires_acknowledgment(self):
        requested = self.generation([record()])["items"][0]
        self.assertEqual(requested["reviewer_state"], "requested")
        self.assertIsNone(requested["reviewer"])
        self.assertIn("grok", requested["review_requests"])
        accepted = self.generation([record()], acknowledgments=[{
            "repo": "sfdc-24/conference", "number": 7, "role": "reviewer",
            "actor": "aya", "acknowledged": True, "source": "okf:WRK-1"}])["items"][0]
        self.assertEqual(accepted["reviewer"], "aya")
        self.assertEqual(accepted["reviewer_state"], "acknowledged")
        self.assertEqual(accepted["reviewer_source"], "okf:WRK-1")
        unverified = self.generation([record()], acknowledgments=[{
            "repo": "sfdc-24/conference", "number": 7, "role": "closure_driver",
            "actor": "grok", "acknowledged": True}])["items"][0]
        self.assertIsNone(unverified["closure_driver"])
        self.assertEqual(unverified["closure_driver_state"], "unverified")
        shared = self.generation([record()], acknowledgments=[{
            "repo": "sfdc-24/conference", "number": 7, "role": "closure_driver",
            "actor": "sfdc-24", "acknowledged": True, "source": "okf:WRK-1"}])["items"][0]
        self.assertEqual(shared["closure_driver_state"], "unknown")
        self.assertIsNone(shared["closure_driver"])
        ambiguous = self.generation([record()], acknowledgments=[
            {"repo": "sfdc-24/conference", "number": 7, "role": "closure_driver",
             "actor": "grok", "acknowledged": True, "source": "okf:WRK-1"},
            {"repo": "sfdc-24/conference", "number": 7, "role": "closure_driver",
             "actor": "cursor", "acknowledged": True, "source": "okf:WRK-2"}])["items"][0]
        self.assertEqual(ambiguous["closure_driver_state"], "ambiguous")
        self.assertIsNone(ambiguous["closure_driver"])

    def test_reopen_and_missing_history(self):
        events = [
            {"id": 1, "event": "closed", "created_at": "2026-10-08T17:00:00Z"},
            {"id": 2, "event": "reopened", "created_at": REOPENED},
        ]
        opened = self.generation([record(events=events)])["items"][0]
        self.assertTrue(opened["creation_age"]["measured"])
        self.assertEqual(opened["creation_age"]["basis"], "since_creation")
        self.assertEqual(opened["current_open"]["basis"], "since_reopen")
        self.assertEqual(opened["current_open"]["hours"], 5)
        missing = self.generation([record(events=None)])["items"][0]
        self.assertTrue(missing["creation_age"]["measured"])
        self.assertFalse(missing["current_open"]["measured"])
        self.assertIsNone(missing["current_open"]["hours"])
        self.assertIsNone(missing["current_open"]["days"])
        self.assertEqual(missing["current_open"]["reason"], "missing_history")
        self.assertNotEqual(missing["current_open"]["hours"], missing["creation_age"]["hours"])
        compact = board._compact(missing)
        self.assertEqual(compact["c_measured"], "1")
        self.assertEqual(compact["c_hours"], "49")
        self.assertEqual(compact["o_measured"], "0")
        self.assertEqual(compact["o_hours"], "")
        conflict = self.generation([record(events=[{"id": 1, "event": "closed", "created_at": "2026-10-08T17:00:00Z"}])])["items"][0]
        self.assertFalse(conflict["current_open"]["measured"])
        self.assertEqual(conflict["current_open"]["reason"], "history_conflict")
        nameless = self.generation([record(events=[{"event": "reopened", "created_at": REOPENED}])])["items"][0]
        self.assertFalse(nameless["current_open"]["measured"])

    def test_stale_head_invalidates_review_and_checks(self):
        stale = record(
            reviews=[{"state": "APPROVED", "commit_id": OLD, "submitted_at": CREATED, "login": "aya"}],
            checks=[{"name": "test", "head_sha": OLD, "status": "completed", "conclusion": "success",
                     "observed_at": CREATED}],
            required_checks=["test"])
        item = self.generation([stale])["items"][0]
        self.assertEqual(item["stage"], "review_stale")
        self.assertNotEqual(item["stage"], "checks_recorded")
        self.assertFalse(item["runtime_accepted"])
        blocked = record(checks=[{"name": "test", "head_sha": HEAD, "status": "completed",
                                  "conclusion": "failure", "observed_at": CREATED}],
                         reviews=[{"state": "APPROVED", "commit_id": HEAD, "submitted_at": CREATED, "login": "aya"}])
        self.assertEqual(self.generation([blocked])["items"][0]["stage"], "checks_blocked")

        def read(path):
            if path.startswith("repos/sfdc-24/conference/pulls?") and "page=1" in path:
                return [raw(7)]
            if "/pulls?" in path or "/reviews?" in path or "/events?" in path:
                return []
            if "/check-runs?" in path:
                return {"check_runs": [{"name": "test", "head_sha": OLD, "status": "completed",
                                        "conclusion": "success", "started_at": CREATED, "completed_at": CREATED}],
                        "total_count": 1}
            if "/commits/" in path:
                return {"sha": HEAD, "commit": {"committer": {"date": CREATED}}}
            if "/pulls/7" in path:
                return {"head": {"sha": HEAD}, "state": "open", "created_at": CREATED,
                        "merged_at": None, "closed_at": None, "updated_at": AS_OF, "title": TITLE, "body": TOKEN}
            raise AssertionError(path)

        receipt = board.run(AS_OF, read, policy={"sfdc-24/conference": ["test"]}, enabled_flag=True)
        self.assertEqual(receipt["status"], "stale")
        self.assertIsNone(receipt["items"])

    def test_priority_is_independent_of_type(self):
        security = self.generation([record()], assessments=[{
            "id": "sfdc-24/conference#7", "types": ["security"], "type_state": "assessed",
            "evidence": "okf:T-1"}])["items"][0]
        self.assertEqual(security["types"], ["security"])
        self.assertIsNone(security["priority"])
        self.assertEqual(security["priority_state"], "unassessed")
        self.assertNotEqual(security["priority"], "HIGH")
        deferred = self.generation([record()], assessments=[{
            "id": "sfdc-24/conference#7", "types": ["security", "ux:loading"], "type_state": "assessed",
            "priority": "LOW", "priority_state": "assessed", "evidence": "okf:T-2"}])["items"][0]
        self.assertEqual(deferred["priority"], "LOW")
        self.assertEqual(deferred["types"], ["security", "ux:loading"])
        unevidenced = self.generation([record()], assessments=[{
            "id": "sfdc-24/conference#7", "priority": "HIGH", "priority_state": "assessed",
            "types": ["security"]}])["items"][0]
        self.assertIsNone(unevidenced["priority"])
        self.assertNotEqual(unevidenced["priority_state"], "assessed")

    def test_dependency_and_closure_are_not_inferred(self):
        item = {row["id"]: row for row in self.generation([record(), record("sfdc-24/Blackboard", 3)], dependencies=[
            {"from_id": "sfdc-24/conference#7", "to_id": "sfdc-24/Blackboard#3",
             "direction": "blocks", "state": "suspected", "evidence": "okf:D-1"},
            {"from_id": "sfdc-24/conference#7", "to_id": "sfdc-24/Blackboard#9",
             "direction": "blocks", "state": "assessed"},
        ])["items"]}
        conference = item["sfdc-24/conference#7"]
        self.assertEqual(conference["blocks"], [{
            "id": "sfdc-24/Blackboard#3", "state": "suspected", "evidence": "okf:D-1"}])
        self.assertEqual(item["sfdc-24/Blackboard#3"]["blocked_by"], [{
            "id": "sfdc-24/conference#7", "state": "suspected", "evidence": "okf:D-1"}])
        self.assertEqual(conference["disposition"], "unassessed")
        self.assertEqual(conference["state"], "open")
        self.assertNotIn("closed", conference["stage"])
        self.assertIsNone(conference["closure_driver"])

    def test_proposed_head_is_not_deployed_identity(self):
        differs = self.generation([record(state="merged")], deployed=[{
            "id": "sfdc-24/conference#7", "sha": OLD, "evidence": "okf:RUN-1"}])["items"][0]
        self.assertEqual(differs["proposed_head"], HEAD)
        self.assertEqual(differs["deployed_head"], OLD)
        self.assertEqual(differs["deployed_state"], "differs")
        self.assertEqual(differs["stage"], "merged_undelivered")
        self.assertFalse(differs["runtime_accepted"])
        matched = self.generation([record(state="merged")], deployed=[{
            "id": "sfdc-24/conference#7", "sha": HEAD, "evidence": "okf:RUN-2"}])["items"][0]
        self.assertEqual(matched["deployed_state"], "matches_proposed")
        self.assertFalse(matched["runtime_accepted"])
        self.assertNotEqual(matched["stage"], "production")
        unknown = self.generation([record()])["items"][0]
        self.assertIsNone(unknown["deployed_head"])
        self.assertEqual(unknown["deployed_state"], "unknown")
        self.assertNotEqual(unknown["deployed_head"], BASE)

    def test_partial_audit_and_timeout_do_not_advance_head(self):
        generation = self.generation([record()])
        previous = {"advisory": "1", "complete": "1", "generation": "d" * 64}
        for label, kwargs, reason in (
                ("partial", {"fail_at": 2}, "partial_write"),
                ("audit", {"partial_at": 1}, "audit_failed"),
                ("timeout", {"timeout_at": 1}, "timeout")):
            store = Store()
            store.data[board.HEAD_KEY] = dict(previous)
            store.fail_at = kwargs.get("fail_at")
            store.partial_at = kwargs.get("partial_at")
            store.timeout_at = kwargs.get("timeout_at")
            receipt = board.write_generation(generation, store.put, store.read_full)
            self.assertEqual(receipt["status"], "stale", label)
            self.assertEqual(receipt["reason"], reason, label)
            self.assertIsNone(receipt["items"], label)
            self.assertFalse(receipt["wrote_head"], label)
            self.assertEqual(store.data[board.HEAD_KEY], previous, label)
            self.assertEqual(receipt["previous_head"], "d" * 64, label)

    def test_replay_keeps_the_generation_id(self):
        generation = self.generation([record()])
        store = Store()
        first = board.write_generation(generation, store.put, store.read_full)
        writes = store.writes
        second = board.write_generation(generation, store.put, store.read_full)
        self.assertEqual(first["generation_id"], second["generation_id"])
        self.assertEqual(second["status"], "replay")
        self.assertEqual(store.writes, writes)
        self.assertEqual(len(generation["id"]), 64)

    def test_ttl_loss_rebuilds_the_same_generation(self):
        generation = self.generation([record(events=None)])
        store = Store()
        first = board.write_generation(generation, store.put, store.read_full)
        self.assertEqual(first["status"], "complete")
        self.assertTrue(first["advisory_head"])
        store.data.clear()
        second = board.write_generation(generation, store.put, store.read_full)
        self.assertEqual(second["status"], "complete")
        self.assertEqual(second["generation_id"], first["generation_id"])
        self.assertEqual(store.data[board.HEAD_KEY]["generation"], generation["id"])
        self.assertEqual(store.data[board.HEAD_KEY]["advisory"], "1")
        meta = next(value for key, value in store.data.items() if key.endswith(":meta"))
        self.assertEqual(meta["generation"], generation["id"])
        shard = next(value for key, value in store.data.items() if ":i:" in key)
        rows = json.loads(shard["rows"])
        self.assertEqual(rows[0]["o_measured"], "0")
        self.assertEqual(rows[0]["qo"], "cursor,grok")
        self.assertEqual(rows[0]["stage"], "open")
        self.assertEqual(rows[0]["c_hours"], "49")
        self.assertEqual(rows[0]["c_days"], "2")

    def test_preview_readback_is_not_acceptance(self):
        generation = self.generation([record()])
        store = Store()
        store.preview = True
        receipt = board.write_generation(generation, store.put, store.read_full)
        self.assertEqual(receipt["status"], "stale")
        self.assertEqual(receipt["reason"], "preview_readback")
        self.assertIsNone(receipt["items"])
        self.assertNotIn(board.HEAD_KEY, store.data)

    def test_immutable_conflict_does_not_overwrite(self):
        generation = self.generation([record()])
        documents = board.redis_documents(generation)
        key, _mapping = documents[-1]
        store = Store()
        store.data[key] = {"generation": "e" * 64, "complete": "0"}
        receipt = board.write_generation(generation, store.put, store.read_full)
        self.assertEqual(receipt["status"], "stale")
        self.assertEqual(receipt["reason"], "immutable_conflict")
        self.assertEqual(store.data[key]["generation"], "e" * 64)
        self.assertNotIn(board.HEAD_KEY, store.data)

    def test_flag_defaults_off(self):
        calls = []
        self.assertEqual(board.main([], read=lambda path: calls.append(path) or [], env={}), 0)
        self.assertEqual(calls, [])
        self.assertEqual(board.main(["--enable"], read=lambda path: calls.append(path), env={}), 2)
        self.assertEqual(calls, [])
        receipt = board.run(AS_OF, lambda path: calls.append(path), enabled_flag=False, env={})
        self.assertEqual(receipt["status"], "disabled")
        self.assertIsNone(receipt["items"])
        self.assertEqual(calls, [])
        self.assertFalse(board.enabled(False, {}))
        self.assertTrue(board.enabled(False, {"OPS_PR_BOARD": "1"}))

    def test_milestones_principal_and_public_feed_stay_put(self):
        with self.assertRaises(board.InvalidEvidence):
            board.governed_put(lambda *args, **kwargs: None, None, {}, principal="milestones-sync")
        seen = {}

        def execute(conn, acl, raw_tag, via, op, key, field="", raw_value="", enc="", count=10, now=None):
            seen.update(op=op, enc=enc, key=key, principal=raw_tag, field=field)
            self.assertEqual(json.loads(base64.b64decode(raw_value)), {"advisory": "1", "complete": "1", "generation": "ab" * 32})
            return {"ok": True}

        put = board.governed_put(execute, object(), {}, principal="cursor")
        self.assertEqual(put(board.HEAD_KEY, {"advisory": "1", "complete": "1", "generation": "ab" * 32})["ok"], True)
        self.assertEqual(seen["op"], "hput")
        self.assertEqual(seen["enc"], "b64")
        self.assertEqual(seen["principal"], "cursor")
        with self.assertRaises(board.InvalidEvidence):
            put("proj:milestones:v1:meta", {"advisory": "1"})
        with self.assertRaises(ops_delivery.InvalidEvidence):
            ops_delivery.validate({"schema_version": 1, "observed_at": "2025-01-01T00:00:00Z", "items": [{}] * 101})
        workflow = (ROOT / ".github/workflows/ops-delivery-snap.yml").read_text(encoding="utf-8")
        self.assertIn("--repo sfdc-24/sfdc24-site", workflow)
        self.assertNotIn("ops_pr_board", workflow)
        self.assertNotIn("proj:pr-board", workflow)

    def test_incomplete_page_is_not_a_hundred_item_board(self):
        def read(path):
            if "page=1" in path and "sfdc-24/conference/pulls?" in path:
                return [raw(number) for number in range(1, 101)]
            if "page=2" in path and "sfdc-24/conference/pulls?" in path:
                return [raw(100), raw(101)]
            return [raw(1)]

        self.assertIsNone(board.run(AS_OF, read, enabled_flag=True, max_pages=1)["items"])
        self.assertEqual(board.run(AS_OF, read, enabled_flag=True)["status"], "stale")

    def test_salesforce_topic_overrides_only_when_assessed(self):
        assessed = self.generation([record("sfdc-24/sfdc24-site", 5)], assessments=[{
            "id": "sfdc-24/sfdc24-site#5", "topic": "salesforce", "topic_state": "assessed",
            "evidence": "okf:SF-1"}])["items"][0]
        self.assertEqual(assessed["queue_owners"], ["claude"])
        self.assertEqual(assessed["queue_basis"], "salesforce_topic")
        suspected = self.generation([record("sfdc-24/sfdc24-site", 5)], assessments=[{
            "id": "sfdc-24/sfdc24-site#5", "topic": "salesforce", "topic_state": "suspected",
            "evidence": "okf:SF-2"}])["items"][0]
        self.assertEqual(suspected["queue_owners"], ["cursor", "grok"])
        self.assertEqual(suspected["topic_state"], "suspected")


GLANCE_FIELDS = ("priority", "blocks", "blocked_by", "owner", "closure_driver", "status", "days_open")


def glance_body(*lines, heading="At a glance"):
    return "\n".join([heading, *lines]) + "\n"


class GlanceTests(unittest.TestCase):
    def generation(self, records, **kwargs):
        return board.build_generation(records, AS_OF, **kwargs)

    def assert_filled(self, glance):
        for field in GLANCE_FIELDS:
            self.assertIn(field, glance)
            self.assertIsInstance(glance[field], str)
            self.assertTrue(glance[field].strip())
            self.assertEqual(glance[field], glance[field].strip())

    def test_priority_comes_from_the_glance_block_then_labels(self):
        stated = board.parse_at_a_glance(glance_body("Priority: p0", "Priority: P2"), TITLE)
        self.assertEqual(stated["priority"], "P0")
        bullet = board.parse_at_a_glance(glance_body("- Priority: P1", heading="## At a glance:"), "")
        self.assertEqual(bullet["priority"], "P1")
        invalid = board.parse_at_a_glance(glance_body("Priority: HIGH"), "")
        self.assertNotIn("priority", invalid)

        from_glance = self.generation([record(glance={"priority": "P2"}, labels=["p0"])])["items"][0]
        self.assertEqual(from_glance["glance"]["priority"], "P2")
        self.assertIsNone(from_glance["priority"])
        self.assertEqual(from_glance["priority_state"], "unassessed")
        self.assertNotEqual(from_glance["priority"], "P2")

        from_label = self.generation([record(labels=["p2", "p0", "security"])])["items"][0]
        self.assertEqual(from_label["glance"]["priority"], "P0")
        self.assertIsNone(from_label["priority"])
        fallback = self.generation([record(labels=["P1"])])["items"][0]
        self.assertEqual(fallback["glance"]["priority"], "P1")
        allow = board.allowlisted_labels([{"name": "P1"}, {"name": LABEL}, "blocked", "security"])
        self.assertEqual(allow, ["p1", "blocked"])
        labeled = self.generation([record(labels=allow)])["items"][0]
        self.assertEqual(labeled["glance"]["priority"], "P1")
        assessed = self.generation([record(glance={"priority": "P0"})], assessments=[{
            "id": "sfdc-24/conference#7", "priority": "LOW", "priority_state": "assessed",
            "types": ["security"], "type_state": "assessed", "evidence": "okf:T-9"}])["items"][0]
        self.assertEqual(assessed["priority"], "LOW")
        self.assertEqual(assessed["glance"]["priority"], "P0")
        self.assert_filled(assessed["glance"])

    def test_blocks_line_is_plain_english_or_unassessed(self):
        safe = "The public homepage cannot open until this review is accepted"
        parsed = board.parse_at_a_glance(glance_body("Blocks: " + safe), TITLE)
        self.assertEqual(parsed["blocks"], safe)
        self.assertEqual(board.public_phrase("x" * 160), "x" * 160)
        self.assertEqual(board.public_phrase("x" * 161), "unassessed")
        for unsafe in (
                TITLE,
                "Ship " + TITLE + " this week",
                "Waiting on " + TOKEN,
                "Ask owner@example.com",
                "the private launch",
                "a confidential note",
                "keep the secret",
                "use <b>bold</b>",
        ):
            self.assertEqual(board.public_phrase(unsafe, TITLE), "unassessed", unsafe)
        short = "Fix voice"
        self.assertEqual(board.public_phrase(short, short), "unassessed")
        self.assertEqual(board.public_phrase("Fix voice on the homepage", short), "Fix voice on the homepage")
        item = self.generation([record(glance={"blocks": safe})])["items"][0]
        self.assertEqual(item["glance"]["blocks"], safe)
        self.assertEqual(board._compact(item)["g_blocks"], safe)
        self.assertNotIn(TITLE, json.dumps(item))
        copied = self.generation([record(glance={})])["items"][0]
        self.assertEqual(copied["glance"]["blocks"], "unassessed")
        self.assert_filled(item["glance"])

    def test_blocked_by_is_a_plain_line_and_a_label_does_not_invent_one(self):
        parsed = board.parse_at_a_glance(glance_body(
            "Blocked by: sfdc-24/conference#12, site#22, Blackboard#3"), "")
        self.assertEqual(parsed["blocked_by"], "conference#12, sfdc24-site#22, Blackboard#3")
        prose = board.parse_at_a_glance(glance_body("Blocked by: The design review on Thursday"), TITLE)
        self.assertEqual(prose["blocked_by"], "The design review on Thursday")
        hidden = board.parse_at_a_glance(glance_body("Blocked by: conference#12, the private board"), TITLE)
        self.assertNotIn("blocked_by", hidden)
        labeled = self.generation([record(labels=["blocked"])])["items"][0]
        self.assertEqual(labeled["glance"]["blocked_by"], "unassessed")
        self.assertEqual(labeled["glance"]["status"], "Blocked")
        self.assertNotIn("blocked", labeled["glance"]["blocked_by"])
        linked = self.generation([
            record(),
            record("sfdc-24/Blackboard", 3),
        ], dependencies=[{
            "from_id": "sfdc-24/conference#7", "to_id": "sfdc-24/Blackboard#3",
            "direction": "blocks", "state": "suspected", "evidence": "okf:D-1",
        }])
        conference = {row["id"]: row for row in linked["items"]}["sfdc-24/conference#7"]
        self.assertEqual(conference["blocks"][0]["id"], "sfdc-24/Blackboard#3")
        self.assertEqual(conference["glance"]["blocks"], "unassessed")
        self.assertEqual(conference["glance"]["blocked_by"], "unassessed")
        row = {entry["pr"]: entry for entry in board.display_rows(linked)}["conference#7"]
        self.assertEqual(row["blocked_by"], "unassessed")
        self.assertEqual(row["blocks"], "unassessed")
        self.assertNotIn("Blackboard#3", row.values())
        self.assert_filled(conference["glance"])

    def test_owner_comes_from_the_glance_block_not_the_author(self):
        names = {
            "grok": "Greg", "Greg": "Greg", "cursor": "Cody", "claude": "Claude",
            "aya": "Aya", "gemini": "Jenny", "owner": "Owner",
        }
        for raw_name, shown in names.items():
            parsed = board.parse_at_a_glance(glance_body("Owner: " + raw_name), "")
            self.assertEqual(parsed["owner"], shown, raw_name)
        self.assertNotIn("owner", board.parse_at_a_glance(glance_body("Owner: sfdc-24"), ""))
        self.assertNotIn("owner", board.parse_at_a_glance(glance_body("Owner: " + TITLE), TITLE))
        shared = self.generation([record(author="sfdc-24", assignees=["cursor"], review_requests=["grok"])])["items"][0]
        self.assertEqual(shared["author"], "sfdc-24")
        self.assertEqual(shared["glance"]["owner"], "unassessed")
        self.assertEqual(shared["queue_owners"], ["cursor", "grok"])
        self.assertNotEqual(shared["glance"]["owner"], "Cody")
        named = self.generation([record(glance={"owner": "Claude"}, author="sfdc-24")])["items"][0]
        self.assertEqual(named["glance"]["owner"], "Claude")
        self.assertEqual(named["author"], "sfdc-24")
        self.assertIsNone(named["closure_driver"])
        self.assert_filled(named["glance"])

    def test_closure_driver_is_the_acknowledged_person_or_unassessed(self):
        def driven(acknowledgments):
            return self.generation([record()], acknowledgments=acknowledgments)["items"][0]

        accepted = driven([{
            "repo": "sfdc-24/conference", "number": 7, "role": "closure_driver",
            "actor": "aya", "acknowledged": True, "source": "okf:WRK-9"}])
        self.assertEqual(accepted["closure_driver"], "aya")
        self.assertEqual(accepted["glance"]["closure_driver"], "Aya")
        greg = driven([{
            "repo": "sfdc-24/conference", "number": 7, "role": "closure_driver",
            "actor": "grok", "acknowledged": True, "source": "okf:WRK-8"}])
        self.assertEqual(greg["glance"]["closure_driver"], "Greg")
        for acknowledgments in (
                None,
                [{"repo": "sfdc-24/conference", "number": 7, "role": "closure_driver",
                  "actor": "cursor", "acknowledged": True}],
                [{"repo": "sfdc-24/conference", "number": 7, "role": "closure_driver",
                  "actor": "sfdc-24", "acknowledged": True, "source": "okf:WRK-1"}],
                [{"repo": "sfdc-24/conference", "number": 7, "role": "closure_driver",
                  "actor": "grok", "acknowledged": True, "source": "okf:WRK-1"},
                 {"repo": "sfdc-24/conference", "number": 7, "role": "closure_driver",
                  "actor": "cursor", "acknowledged": True, "source": "okf:WRK-2"}],
        ):
            item = driven(acknowledgments)
            self.assertEqual(item["glance"]["closure_driver"], "unassessed")
            self.assertIsNone(item["closure_driver"])
        requested = self.generation([record()])["items"][0]
        self.assertEqual(requested["reviewer_state"], "requested")
        self.assertEqual(requested["glance"]["closure_driver"], "unassessed")
        self.assertEqual(board._compact(accepted)["g_cd"], "Aya")
        self.assert_filled(accepted["glance"])

    def test_status_is_a_plain_sentence(self):
        expected = {
            "open": "Open",
            "review": "In review",
            "review_stale": "Review is out of date",
            "checks_blocked": "Checks failed",
            "checks_pending": "Checks still running",
            "checks_recorded": "Checks passed, not live yet",
            "merged_undelivered": "Merged, not live yet",
            "closed_unmerged": "Closed without merge",
        }
        samples = {
            "open": record(),
            "review": record(reviews=[{"state": "APPROVED", "commit_id": HEAD, "submitted_at": CREATED, "login": "aya"}]),
            "review_stale": record(reviews=[{"state": "APPROVED", "commit_id": OLD, "submitted_at": CREATED, "login": "aya"}]),
            "checks_blocked": record(checks=[{"name": "test", "head_sha": HEAD, "status": "completed",
                                              "conclusion": "failure", "observed_at": CREATED}]),
            "checks_pending": record(checks=[{"name": "test", "head_sha": HEAD, "status": "in_progress",
                                              "conclusion": None, "observed_at": CREATED}]),
            "checks_recorded": record(required_checks=["test"], checks=[{
                "name": "test", "head_sha": HEAD, "status": "completed", "conclusion": "success",
                "observed_at": CREATED}]),
            "merged_undelivered": record(state="merged"),
            "closed_unmerged": record(state="closed"),
        }
        for stage, sample in samples.items():
            item = self.generation([sample])["items"][0]
            self.assertEqual(item["stage"], stage)
            self.assertEqual(item["glance"]["status"], expected[stage])
            self.assert_filled(item["glance"])
        blocked_open = self.generation([record(labels=["blocked"])])["items"][0]
        self.assertEqual(blocked_open["glance"]["status"], "Blocked")
        blocked_review = self.generation([record(
            labels=["blocked"],
            reviews=[{"state": "APPROVED", "commit_id": HEAD, "submitted_at": CREATED, "login": "aya"}])])["items"][0]
        self.assertEqual(blocked_review["stage"], "review")
        self.assertEqual(blocked_review["glance"]["status"], "Blocked")
        failed = self.generation([record(
            labels=["blocked"],
            checks=[{"name": "test", "head_sha": HEAD, "status": "completed",
                     "conclusion": "failure", "observed_at": CREATED}])])["items"][0]
        self.assertEqual(failed["glance"]["status"], "Checks failed")
        body = glance_body("Priority: P0", "Status: Ready", "Blocks: The homepage can open")
        parsed = board.parse_at_a_glance(body, "")
        self.assertEqual(parsed["priority"], "P0")
        self.assertEqual(parsed["blocks"], "The homepage can open")
        self.assertNotIn("status", parsed)
        scrubbed = board.scrub_pull("sfdc-24/conference", dict(raw(7), body=body, title=TITLE))
        self.assertNotIn("body", scrubbed)
        self.assertNotIn("title", scrubbed)
        self.assertEqual(scrubbed["glance"]["status"] if "status" in scrubbed["glance"] else None, None)
        self.assertEqual(scrubbed["glance"]["priority"], "P0")

    def test_days_open_uses_the_measured_interval_only(self):
        measured = self.generation([record(events=[])])["items"][0]
        self.assertEqual(measured["creation_age"]["days"], 2)
        self.assertEqual(measured["current_open"]["days"], 2)
        self.assertEqual(measured["glance"]["days_open"], "2")
        missing = self.generation([record(events=None)])["items"][0]
        self.assertEqual(missing["creation_age"]["days"], 2)
        self.assertFalse(missing["current_open"]["measured"])
        self.assertEqual(missing["glance"]["days_open"], "unassessed")
        self.assertNotEqual(missing["glance"]["days_open"], "2")
        reopened = self.generation([record(events=[
            {"id": 1, "event": "closed", "created_at": "2026-10-08T17:00:00Z"},
            {"id": 2, "event": "reopened", "created_at": REOPENED},
        ])])["items"][0]
        self.assertEqual(reopened["current_open"]["hours"], 5)
        self.assertEqual(reopened["glance"]["days_open"], "0")
        conflict = self.generation([record(events=[
            {"id": 1, "event": "closed", "created_at": "2026-10-08T17:00:00Z"}])])["items"][0]
        self.assertEqual(conflict["glance"]["days_open"], "unassessed")
        self.assertEqual(board._compact(missing)["g_days"], "unassessed")
        self.assertEqual(board._compact(measured)["g_days"], "2")
        self.assert_filled(missing["glance"])

    def test_rows_sort_p0_first_then_days_open(self):
        records = [
            record(number=1, created_at="2026-10-08T17:00:00Z", glance={"priority": "P0"}, events=[]),
            record(number=2, created_at="2026-09-30T17:00:00Z", glance={"priority": "P0"}, events=[]),
            record("sfdc-24/Blackboard", 4, created_at="2026-08-30T17:00:00Z", labels=["p1"], events=[]),
            record("sfdc-24/sfdc24-site", 8, glance={"priority": "P2"}, events=None),
            record(number=3, created_at="2026-10-06T17:00:00Z", events=[]),
        ]
        generation = self.generation(records)
        rows = board.display_rows(generation)
        self.assertEqual([row["pr"] for row in rows], [
            "conference#2", "conference#1", "Blackboard#4", "sfdc24-site#8", "conference#3"])
        self.assertEqual([row["priority"] for row in rows], ["P0", "P0", "P1", "P2", "unassessed"])
        self.assertEqual([row["days_open"] for row in rows], ["9", "1", "40", "unassessed", "3"])
        for row in rows:
            self.assert_filled(row)
        self.assertLess(
            [row["priority"] for row in rows].index("P0"),
            [row["priority"] for row in rows].index("P1"))
        snapshot = board.public_snapshot(generation, enabled=True)
        self.assertEqual(snapshot["rows"], rows)
        self.assertEqual(snapshot["as_of"], AS_OF)
        off = board.public_snapshot(generation, enabled=False)
        self.assertFalse(off["enabled"])
        self.assertEqual(off["rows"], [])
        self.assertEqual(off["as_of"], "")

    def test_unassessed_fields_are_never_blank(self):
        bare = self.generation([record(events=None, author="", assignees=[], review_requests=[])])["items"][0]
        self.assert_filled(bare["glance"])
        for field in ("priority", "blocks", "blocked_by", "owner", "closure_driver", "days_open"):
            self.assertEqual(bare["glance"][field], "unassessed")
        self.assertEqual(bare["glance"]["status"], "Open")
        compact = board._compact(bare)
        for key in ("g_priority", "g_blocks", "g_blocked", "g_owner", "g_cd", "g_status", "g_days"):
            self.assertEqual(compact[key], bare["glance"][{
                "g_priority": "priority", "g_blocks": "blocks", "g_blocked": "blocked_by",
                "g_owner": "owner", "g_cd": "closure_driver", "g_status": "status", "g_days": "days_open",
            }[key]])
            self.assertNotEqual(compact[key], "")
        self.assertLessEqual(len(compact) + 1, board.MAX_PUT_FIELDS)
        row = board.display_rows(self.generation([record(events=None)]))[0]
        self.assert_filled(row)
        self.assertNotIn("", row.values())

    def test_blockquote_glance_block_at_the_top(self):
        safe = "The Ops page can show priority and what is waiting"
        body = "\n".join([
            "<!-- at-a-glance:start -->",
            "> **At a glance** (as of Oct 9, 2026, 3:10 PM ET)",
            "> **Priority:** P0 - Blocks: " + safe,
            "> **Blocked by:** conference#12",
            "> **Owner:** queue Grok (acknowledged) · closure driver Cody (proposed)",
            "<!-- at-a-glance:end -->",
            "",
            "The rest of the description stays in GitHub.",
        ])
        parsed = board.parse_at_a_glance(body, TITLE)
        self.assertEqual(parsed["priority"], "P0")
        self.assertEqual(parsed["blocks"], safe)
        self.assertEqual(parsed["blocked_by"], "conference#12")
        self.assertEqual(parsed["owner"], "Greg")
        self.assertNotIn("closure_driver", parsed)
        hidden = body.replace("conference#12", "the private repo and a review pass")
        self.assertNotIn("blocked_by", board.parse_at_a_glance(hidden, TITLE))
        self.assertNotIn("owner", board.parse_at_a_glance(
            body.replace("queue Grok (acknowledged)", "Grok and Cody"), TITLE))
        late = "Notes first.\n" + body
        self.assertEqual(board.parse_at_a_glance(late, TITLE), {})
        item = self.generation([record(glance=parsed)])["items"][0]
        self.assertEqual(item["glance"]["owner"], "Greg")
        self.assertEqual(item["glance"]["closure_driver"], "unassessed")
        self.assertNotIn("Cody", item["glance"]["closure_driver"])
        self.assertNotIn(TITLE, json.dumps(item))
        self.assert_filled(item["glance"])

    def test_glance_block_must_be_at_the_top(self):
        late = "Notes first.\n\nAt a glance\nPriority: P0\nBlocks: The homepage can open\n"
        self.assertEqual(board.parse_at_a_glance(late, TITLE), {})
        prose = glance_body("Priority: P0", "Then we wait.", "Blocks: This should be ignored")
        self.assertEqual(board.parse_at_a_glance(prose, "")["priority"], "P0")
        self.assertNotIn("blocks", board.parse_at_a_glance(prose, ""))
        kept = glance_body(
            "Priority: P1",
            "Status: Ready",
            "Closure driver: Aya",
            "Blocks: The homepage can open",
            "Blocked by: conference#12",
            "Owner: grok",
        )
        parsed = board.parse_at_a_glance(kept, TITLE)
        self.assertEqual(parsed["priority"], "P1")
        self.assertEqual(parsed["blocks"], "The homepage can open")
        self.assertEqual(parsed["blocked_by"], "conference#12")
        self.assertEqual(parsed["owner"], "Greg")
        row = dict(raw(11), body=late, title=TITLE, labels=[{"name": "P0"}, {"name": LABEL}])
        scrubbed = board.scrub_pull("sfdc-24/sfdc24-site", row)
        self.assertEqual(scrubbed["glance"], {})
        self.assertEqual(scrubbed["labels"], ["p0"])
        self.assertNotIn(TITLE, json.dumps(scrubbed))
        self.assertNotIn(LABEL, json.dumps(scrubbed))
        self.assertNotIn(TOKEN, json.dumps(scrubbed))
        item = self.generation([dict(scrubbed, reviews=[], events=[], checks=None, required_checks=[])])["items"][0]
        self.assertEqual(item["glance"]["priority"], "P0")
        self.assertEqual(item["glance"]["blocks"], "unassessed")
        self.assertNotIn(TITLE, json.dumps(item))

    def test_private_title_and_sensitive_lines_stay_off_the_public_table(self):
        safe = "The public homepage cannot open until this review is accepted"
        body = glance_body("Priority: P0", "Blocks: " + TITLE, "Blocked by: " + TOKEN, "Owner: grok")
        secret_row = dict(raw(7), body=body, title=TITLE, labels=[{"name": LABEL}, {"name": "P1"}])
        scrubbed = board.scrub_pull("sfdc-24/conference", secret_row)
        self.assertEqual(scrubbed["glance"]["priority"], "P0")
        self.assertNotIn("blocks", scrubbed["glance"])
        self.assertNotIn("blocked_by", scrubbed["glance"])
        self.assertEqual(scrubbed["owner"] if "owner" in scrubbed else None, None)
        self.assertEqual(scrubbed["glance"]["owner"], "Greg")
        self.assertEqual(scrubbed["labels"], ["p1"])
        secret_item = self.generation([dict(
            scrubbed, reviews=[], events=[], checks=None, required_checks=[])])["items"][0]
        self.assertEqual(secret_item["glance"]["priority"], "P0")
        self.assertEqual(secret_item["glance"]["blocks"], "unassessed")
        self.assertEqual(secret_item["glance"]["blocked_by"], "unassessed")
        self.assertEqual(secret_item["glance"]["owner"], "Greg")
        for secret in (TITLE, LABEL, TOKEN, "PRIVATE CONTENT"):
            self.assertNotIn(secret, json.dumps(secret_item))
        generation = self.generation([record(glance={"priority": "P0", "owner": "Greg", "blocks": safe})])
        self.assertIn(safe, json.dumps(generation))
        for secret in (TITLE, LABEL, TOKEN, "PRIVATE CONTENT"):
            self.assertNotIn(secret, json.dumps(generation))
            self.assertNotIn(secret, json.dumps(board.display_rows(generation)))
            self.assertNotIn(secret, json.dumps(board.public_snapshot(generation, enabled=True)))
        store = Store()
        written = board.write_generation(generation, store.put, store.read_full)
        self.assertEqual(written["status"], "complete")
        leaked = json.dumps(store.data)
        self.assertIn(safe, leaked)
        for secret in (TITLE, LABEL, TOKEN, "PRIVATE CONTENT"):
            self.assertNotIn(secret, leaked)
        documents = board.redis_documents(generation)
        self.assertTrue(documents)
        self.assertIn(safe, json.dumps(documents))
        page = (ROOT / "ops" / "index.html").read_text(encoding="utf-8")
        script = (ROOT / "assets" / "ops-pr-board.js").read_text(encoding="utf-8")
        published = (ROOT / "data" / "pr-board-public.json").read_text(encoding="utf-8")
        for surface in (page, script, published):
            for secret in (TITLE, LABEL, TOKEN, "PRIVATE CONTENT"):
                self.assertNotIn(secret, surface)

    def test_page_stays_behind_the_off_flag(self):
        page = (ROOT / "ops" / "index.html").read_text(encoding="utf-8")
        section = page.split('id="pr-board"', 1)[1].split("</section>", 1)[0]
        self.assertIn("The pull-request board is off. Priority and blockers are not loaded.", section)
        self.assertIn('id="pr-board-table" hidden', section)
        heads = re.findall(r'<th scope="col">([^<]+)</th>', section)
        self.assertEqual(heads, [
            "Pull request", "Priority", "What this blocks", "Blocked by",
            "Owner", "Closure driver", "Status", "Days open"])
        main = page.split("<main", 1)[1]
        self.assertLess(main.index('id="action-items"'), main.index('id="pr-board"'))
        self.assertIn('<script src="/assets/ops-pr-board.js" defer></script>', page)
        script = (ROOT / "assets" / "ops-pr-board.js").read_text(encoding="utf-8")
        self.assertIn("var PR_BOARD_ENABLED = false;", script)
        self.assertIn("td.textContent", script)
        self.assertNotIn("innerHTML", script)
        self.assertLess(script.index("if (!PR_BOARD_ENABLED || !page) return;"), script.index("new XMLHttpRequest"))
        published = json.loads((ROOT / "data" / "pr-board-public.json").read_text(encoding="utf-8"))
        self.assertIs(published["enabled"], False)
        self.assertEqual(published["rows"], [])
        self.assertEqual(published["as_of"], "")
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "board.json")
            code = board.main(["--public-out", path, "--out", path + ".full"], read=lambda _path: (_ for _ in ()).throw(
                AssertionError("flag off must not read GitHub")), env={})
            self.assertEqual(code, 0)
            self.assertFalse(os.path.exists(path))
            self.assertFalse(os.path.exists(path + ".full"))
        node = shutil.which("node")
        self.assertIsNotNone(node)
        probe = r"""
const assert = require("assert");
const api = require(process.env.BOARD);
assert.strictEqual(api.PR_BOARD_ENABLED, false);
assert.deepStrictEqual(api.COLUMNS, ["pr","priority","blocks","blocked_by","owner","closure_driver","status","days_open"]);
const filled = api.displayRows([{pr:"conference#1", priority:"", blocks:null, status:" Open "}]);
assert.strictEqual(filled[0].priority, "unassessed");
assert.strictEqual(filled[0].blocks, "unassessed");
assert.strictEqual(filled[0].blocked_by, "unassessed");
assert.strictEqual(filled[0].owner, "unassessed");
assert.strictEqual(filled[0].closure_driver, "unassessed");
assert.strictEqual(filled[0].status, "Open");
assert.strictEqual(filled[0].days_open, "unassessed");
assert.strictEqual(filled[0].pr, "conference#1");
function make(id) {
  return {id: id, hidden: false, textContent: "stale", className: "", children: [], appendChild(child) { this.children.push(child); }};
}
const nodes = {"pr-board-note": make("note"), "pr-board-table": make("table"), "pr-board-rows": make("rows")};
const document = {getElementById(id) { return nodes[id] || null; }, createElement() { return make(""); }};
api.fill(document, {enabled: true, as_of: "2026-10-09T17:00:00Z", rows: [{pr:"conference#1", priority:"P0", blocks:"The homepage can open"}]});
assert.strictEqual(nodes["pr-board-table"].hidden, true);
assert.strictEqual(nodes["pr-board-rows"].children.length, 0);
assert.strictEqual(nodes["pr-board-note"].textContent, "The pull-request board is off. Priority and blockers are not loaded.");
assert.ok(!JSON.stringify(nodes).includes("The homepage can open"));
"""
        completed = subprocess.run(
            [node, "-e", probe],
            check=False,
            capture_output=True,
            text=True,
            env=dict(os.environ, BOARD=str(ROOT / "assets" / "ops-pr-board.js")),
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)


if __name__ == "__main__":
    unittest.main()
