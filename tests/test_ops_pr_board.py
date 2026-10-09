"""PR board collector and governed projection. No live GitHub or Redis calls."""
import base64
import importlib.util
import json
import re
import sys
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


if __name__ == "__main__":
    unittest.main()
