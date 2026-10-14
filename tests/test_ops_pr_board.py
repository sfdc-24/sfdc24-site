"""PR board collector and governed projection. No live GitHub or Redis calls."""
import base64
import contextlib
import hashlib
import importlib.util
import inspect
import io
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
        if "state=closed" in path or "/reviews?" in path or "/events?" in path:
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


def _gov_acl():
    return {
        "readable": True,
        "principals": {"cursor": {"read": ["proj:"], "write": ["proj:"]}},
        "aliases": {},
        "ttl_seconds": {},
        "max_value_bytes": 2048,
        "digest": "",
    }


class _FlagOffConn:
    """xadd only. A document read means the flag-off refusal looked at Redis."""

    def __init__(self, boom=False):
        self.boom = boom
        self.reads = 0

    def xadd(self, stream, fields, maxlen=None, approximate=None):
        if self.boom:
            raise OSError("audit down")
        return "1-1"

    def pipeline(self, transaction=True):
        self.reads += 1
        raise AssertionError("flag-off haudit read")

    def type(self, key):
        self.reads += 1
        raise AssertionError("flag-off haudit read")


class GovRedis:
    """Immediate hash reads before MULTI, queued TYPE after it, and a working xadd."""

    def __init__(self, data):
        self.data = {key: dict(value) for key, value in data.items()}
        self.audits = []
        self.reads = 0

    def type(self, key):
        self.reads += 1
        return "hash" if key in self.data else "none"

    def hget(self, key, field):
        self.reads += 1
        return (self.data.get(key) or {}).get(field)

    def hlen(self, key):
        self.reads += 1
        return len(self.data.get(key) or {})

    def hkeys(self, key):
        self.reads += 1
        return list((self.data.get(key) or {}).keys())

    def hstrlen(self, key, field):
        self.reads += 1
        value = (self.data.get(key) or {}).get(field, "")
        if isinstance(value, bytes):
            return len(value)
        return len(str(value).encode("utf-8"))

    def hgetall(self, key):
        self.reads += 1
        return dict(self.data.get(key) or {})

    def xadd(self, stream, fields, maxlen=None, approximate=None):
        self.audits.append(stream)
        return "1-1"

    def pipeline(self, transaction=True):
        return _GovPipe(self)


class _GovPipe:
    def __init__(self, conn):
        self.conn = conn
        self.queued = False
        self.ops = []

    def watch(self, *keys):
        return True

    def reset(self):
        self.queued = False
        self.ops = []

    def multi(self):
        self.queued = True

    def _call(self, name, args):
        if self.queued:
            self.ops.append((name, args))
            return self
        return getattr(self.conn, name)(*args)

    def type(self, key):
        return self._call("type", (key,))

    def hget(self, key, field):
        return self._call("hget", (key, field))

    def hlen(self, key):
        return self._call("hlen", (key,))

    def hkeys(self, key):
        return self._call("hkeys", (key,))

    def hstrlen(self, key, field):
        return self._call("hstrlen", (key, field))

    def hgetall(self, key):
        return self._call("hgetall", (key,))

    def execute(self, raise_on_error=False):
        results = [getattr(self.conn, name)(*args) for name, args in self.ops]
        self.queued = False
        self.ops = []
        return results


def conference_read(count):
    rows = [raw(number) for number in range(1, count + 1)]

    def read(path):
        if "state=closed" in path or "/reviews?" in path or "/events?" in path:
            return []
        if path.startswith("repos/sfdc-24/conference/pulls?"):
            page = int(re.search(r"[?&]page=(\d+)", path).group(1))
            start = (page - 1) * 100
            return rows[start:start + 100]
        if "page=1" in path:
            return []
        return []

    return read


def haudit_receipt(generation, local):
    """A complete backend haudit receipt for this generation's local digests."""
    listed = local["listed"]
    root = local["root_digest"]
    entries = board._listed_entries(board.redis_documents(generation))
    report_length = len(board.report_body(board._specs(entries)))
    return {
        "ok": True,
        "page_ok": True,
        "op": "haudit",
        "generation": generation["id"],
        "correlation": "c" * 16,
        "partial": False,
        "moved": False,
        "timeout": False,
        "head_generation": generation["id"],
        "head_manifest_root": root,
        "coverage": {
            "expected": listed,
            "seen": listed,
            "missing": 0,
            "extra": 0,
            "changed": 0,
            "matched": listed,
            "covered": True,
        },
        "audit": "ok",
        "digest": local["report_digest"],
        "length": report_length,
        "listed": listed,
        "pages": local["page_count"],
        "manifest_digest": local["manifest_digest"],
        "manifest_root": root,
        "page_count": local["page_count"],
    }


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
            if "state=closed" in path:
                return []
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
        self.assertEqual(snapshot["rows"], [row for row in rows if row["pr"].startswith("sfdc24-site#")])
        self.assertNotIn("conference#", json.dumps(snapshot["rows"]))
        self.assertNotIn("Blackboard#", json.dumps(snapshot["rows"]))
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
        self.assertLess(page.index('id="agent-scorecard"'), page.index('id="pr-turnaround"'))
        turnaround = page.split('id="pr-turnaround"', 1)[1].split("</section>", 1)[0]
        self.assertIn("Turnaround is off. Review and close times are not loaded.", turnaround)
        self.assertIn('id="pr-turnaround-table" hidden', turnaround)
        self.assertIn("7-day trend", turnaround)
        self.assertIn("First review", turnaround)
        self.assertIn("Review to close", turnaround)
        self.assertIn("Open to close", turnaround)
        self.assertIn('id="pr-board-table" hidden', section)
        heads = re.findall(r'<th scope="col">([^<]+)</th>', section)
        self.assertEqual(heads, [
            "Pull request", "Priority", "What this blocks", "Blocked by",
            "Owner", "Closure driver", "Status", "Days open",
            "Milestone", "Project", "GO on this head"])
        main = page.split("<main", 1)[1]
        self.assertNotIn('id="action-items"', main)
        self.assertLess(main.index('id="pr-board"'), main.index('id="spend"'))
        self.assertIn('<script src="/assets/ops-pr-board.js" defer></script>', page)
        script = (ROOT / "assets" / "ops-pr-board.js").read_text(encoding="utf-8")
        self.assertIn("var PR_BOARD_ENABLED = false;", script)
        self.assertIn("cell.textContent", script)
        self.assertNotIn("innerHTML", script)
        self.assertLess(script.index("if (!PR_BOARD_ENABLED || !page) return;"), script.index("new XMLHttpRequest"))
        published = json.loads((ROOT / "data" / "pr-board-public.json").read_text(encoding="utf-8"))
        self.assertIs(published["enabled"], False)
        self.assertEqual(published["rows"], [])
        self.assertEqual(published["as_of"], "")
        self.assertEqual(published["turnaround"], {"days": [], "metrics": {}, "rows": []})
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
assert.strictEqual(api.PUBLIC_PRIVATE_AGGREGATES, false);
assert.deepStrictEqual(api.COLUMNS, ["pr","priority","blocks","blocked_by","owner","closure_driver","status","days_open","milestone","project","go_on_head"]);
const filled = api.displayRows([{pr:"conference#1", priority:"", blocks:null, status:" Open "}]);
assert.strictEqual(filled[0].priority, "unassessed");
assert.strictEqual(filled[0].blocks, "unassessed");
assert.strictEqual(filled[0].blocked_by, "unassessed");
assert.strictEqual(filled[0].owner, "unassessed");
assert.strictEqual(filled[0].closure_driver, "unassessed");
assert.strictEqual(filled[0].status, "Open");
assert.strictEqual(filled[0].days_open, "unassessed");
assert.strictEqual(filled[0].milestone, "unassessed");
assert.strictEqual(filled[0].project, "unassessed");
assert.strictEqual(filled[0].go_on_head, "unassessed");
assert.strictEqual(filled[0].pr, "conference#1");
const hidden = api.publishRows([{pr:"conference#1", priority:"P0", blocks:"Synthetic acquisition schedule", blocked_by:"Synthetic client decision", owner:"Greg", closure_driver:"Cody", milestone:"Synthetic expansion milestone", status:"Open", days_open:"1", project:"Conference", go_on_head:"No"}]);
assert.strictEqual(hidden.length, 0);
assert.ok(!JSON.stringify(hidden).includes("conference#"));
assert.ok(!JSON.stringify(hidden).includes("Synthetic acquisition schedule"));
const shownSite = api.publishRows([{pr:"sfdc24-site#3", priority:"P0", blocks:"Synthetic acquisition schedule", milestone:"Synthetic expansion milestone"}]);
assert.strictEqual(shownSite[0].blocks, "Synthetic acquisition schedule");
assert.strictEqual(shownSite[0].milestone, "Synthetic expansion milestone");
const hiddenTurn = api.publishTurnaroundRows([{pr:"conference#1", first_review:"2 h", review_to_close:"9 h", open_to_close:"11 h"}]);
assert.strictEqual(hiddenTurn.length, 0);
const shownTurn = api.publishTurnaroundRows([{pr:"sfdc24-site#3", first_review:"2 h"}]);
assert.strictEqual(shownTurn[0].pr, "sfdc24-site#3");
assert.strictEqual(shownTurn[0].first_review, "2 h");
assert.strictEqual(api.turnaroundRows([{pr:"conference#1", first_review:"", review_to_close:null}])[0].first_review, "unknown");
assert.strictEqual(api.turnaroundRows([{pr:"conference#1", first_review:"2 h"}])[0].review_to_close, "unknown");
assert.strictEqual(api.turnaroundRows([{pr:"conference#1", first_review:"2 h"}])[0].open_to_close, "unknown");
function make(id) {
  return {id: id, hidden: false, textContent: "stale", className: "", children: [], appendChild(child) { this.children.push(child); }};
}
const nodes = {
  "pr-board-note": make("note"), "pr-board-table": make("table"), "pr-board-rows": make("rows"),
  "pr-turnaround-note": make("turn-note"), "pr-turnaround-table": make("turn-table"),
  "pr-turnaround-rows": make("turn-rows"), "pr-turnaround-trend-note": make("trend-note"),
  "pr-turnaround-trends": make("trends")
};
const document = {getElementById(id) { return nodes[id] || null; }, createElement() { return make(""); }};
api.fill(document, {enabled: true, as_of: "2026-10-09T17:00:00Z",
  rows: [{pr:"conference#1", priority:"P0", blocks:"The homepage can open"}],
  turnaround: {rows: [{pr:"conference#1", first_review:"2 h"}], days: ["2026-10-09"], metrics: {}}});
assert.strictEqual(nodes["pr-board-table"].hidden, true);
assert.strictEqual(nodes["pr-board-rows"].children.length, 0);
assert.strictEqual(nodes["pr-board-note"].textContent, "The pull-request board is off. Priority and blockers are not loaded.");
assert.strictEqual(nodes["pr-turnaround-table"].hidden, true);
assert.strictEqual(nodes["pr-turnaround-rows"].children.length, 0);
assert.strictEqual(nodes["pr-turnaround-trends"].children.length, 0);
assert.strictEqual(nodes["pr-turnaround-note"].textContent, "Turnaround is off. Review and close times are not loaded.");
assert.ok(!JSON.stringify(nodes).includes("The homepage can open"));
assert.ok(!JSON.stringify(nodes).includes("2 h"));
"""
        completed = subprocess.run(
            [node, "-e", probe],
            check=False,
            capture_output=True,
            text=True,
            env=dict(os.environ, BOARD=str(ROOT / "assets" / "ops-pr-board.js")),
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)


class TurnaroundTests(unittest.TestCase):
    def generation(self, records, closed=None):
        return board.build_generation(records, AS_OF, closed_records=closed)

    def test_time_to_first_review(self):
        item = self.generation([record(
            author="cursor", events=[],
            reviews=[{"state": "APPROVED", "commit_id": HEAD, "submitted_at": "2026-10-07T18:00:00Z", "login": "aya"}],
        )])["items"][0]
        turn = item["turnaround"]
        self.assertEqual(turn["first_review"], "2 h")
        self.assertEqual(turn["reviewer_name"], "Aya")
        self.assertEqual(turn["author_name"], "Cody")
        self.assertEqual(turn["review_to_close"], "unknown")
        self.assertEqual(turn["open_to_close"], "unknown")
        self.assertEqual(item["glance"]["status"], "In review")
        self.assertNotEqual(item["glance"]["days_open"], "unknown")

    def test_review_to_close(self):
        item = self.generation([record(
            state="closed", author="claude",
            events=[{"id": 1, "event": "closed", "created_at": "2026-10-07T21:00:00Z"}],
            reviews=[{"state": "COMMENTED", "commit_id": HEAD, "submitted_at": "2026-10-07T18:00:00Z", "login": "cursor"}],
        )])["items"][0]
        turn = item["turnaround"]
        self.assertEqual(turn["first_review"], "2 h")
        self.assertEqual(turn["review_to_close"], "3 h")
        self.assertEqual(turn["open_to_close"], "5 h")
        self.assertEqual(turn["reviewer_name"], "Cody")
        self.assertEqual(turn["author_name"], "Claude")
        self.assertTrue(all(turn[field].strip() for field in ("first_review", "review_to_close", "open_to_close")))

    def test_reopen_sums_open_time_and_starts_the_review_clock_again(self):
        item = self.generation([record(
            state="closed", author="grok", created_at="2026-10-01T17:00:00Z",
            events=[
                {"id": 1, "event": "closed", "created_at": "2026-10-02T17:00:00Z"},
                {"id": 2, "event": "reopened", "created_at": "2026-10-04T17:00:00Z"},
                {"id": 3, "event": "closed", "created_at": "2026-10-04T21:00:00Z"},
            ],
            reviews=[
                {"state": "APPROVED", "commit_id": HEAD, "submitted_at": "2026-10-01T19:00:00Z", "login": "aya"},
                {"state": "CHANGES_REQUESTED", "commit_id": HEAD, "submitted_at": "2026-10-04T19:00:00Z", "login": "claude"},
            ],
        )])["items"][0]
        turn = item["turnaround"]
        self.assertEqual(turn["first_review"], "2 h")
        self.assertEqual(turn["review_to_close"], "2 h")
        self.assertEqual(turn["open_to_close"], "28 h")
        self.assertNotEqual(turn["open_to_close"], "76 h")
        self.assertEqual(turn["reviewer_name"], "Claude")
        self.assertEqual(turn["author_name"], "Greg")

    def test_missing_history_is_unknown(self):
        item = self.generation([record(
            events=None, updated_at="2026-10-09T16:00:00Z",
            reviews=[{"state": "APPROVED", "commit_id": HEAD, "submitted_at": "2026-10-07T18:00:00Z", "login": "aya"}],
        )])["items"][0]
        for field in ("first_review", "review_to_close", "open_to_close"):
            self.assertEqual(item["turnaround"][field], "unknown")
            self.assertTrue(item["turnaround"][field].strip())
        self.assertIsNone(item["turnaround"]["first_review_hours"])
        self.assertNotIn("2026-10-09T16:00:00Z", json.dumps(item["turnaround"]))
        self.assertEqual(item["glance"]["priority"], "unassessed")

    def test_updated_at_does_not_set_a_duration(self):
        turn = board.turnaround_of(record(events=[], reviews=[], updated_at="2026-10-09T16:59:00Z"), AS_OF)
        self.assertEqual(turn["first_review"], "unknown")
        self.assertEqual(turn["review_to_close"], "unknown")
        self.assertEqual(turn["open_to_close"], "unknown")

    def test_pending_review_is_not_a_first_review_and_zero_hours_is_measured(self):
        pending = self.generation([record(events=[], reviews=[
            {"state": "PENDING", "commit_id": HEAD, "submitted_at": "2026-10-07T17:00:00Z", "login": "aya"},
            {"state": "APPROVED", "commit_id": HEAD, "submitted_at": "", "login": "claude"},
        ])])["items"][0]
        self.assertEqual(pending["turnaround"]["first_review"], "unknown")
        measured = self.generation([record(events=[], reviews=[{
            "state": "COMMENTED", "commit_id": HEAD, "submitted_at": CREATED, "login": "aya",
        }])])["items"][0]
        self.assertEqual(measured["turnaround"]["first_review"], "0 h")
        self.assertNotEqual(measured["turnaround"]["first_review"], "unknown")

    def test_daily_median_per_repo_and_per_agent(self):
        first = record(number=1, author="cursor", events=[], reviews=[{
            "state": "APPROVED", "commit_id": HEAD, "submitted_at": "2026-10-07T18:00:00Z", "login": "aya"}])
        second = record(number=2, author="cursor", events=[], reviews=[{
            "state": "APPROVED", "commit_id": HEAD, "submitted_at": "2026-10-07T22:00:00Z", "login": "aya"}])
        closed = record(
            "sfdc-24/Blackboard", 9, state="closed", author="claude",
            events=[{"id": 1, "event": "closed", "created_at": "2026-10-08T16:00:00Z"}],
            reviews=[{"state": "APPROVED", "commit_id": HEAD, "submitted_at": "2026-10-08T14:00:00Z", "login": "grok"}],
        )
        generation = self.generation([first, second], closed=[closed])
        trend = generation["turnaround_trend"]
        self.assertEqual(trend["days"], [
            "2026-10-03", "2026-10-04", "2026-10-05", "2026-10-06",
            "2026-10-07", "2026-10-08", "2026-10-09"])
        firsts = trend["metrics"]["first_review"]
        self.assertEqual(firsts["repos"]["conference"][4], "4 h")
        self.assertEqual(firsts["author"]["Cody"][4], "4 h")
        self.assertEqual(firsts["reviewer"]["Aya"][4], "4 h")
        self.assertEqual(firsts["repos"]["Blackboard"][5], "22 h")
        self.assertEqual(firsts["author"]["Claude"][5], "22 h")
        self.assertEqual(firsts["reviewer"]["Greg"][5], "22 h")
        self.assertEqual(trend["metrics"]["open_to_close"]["repos"]["Blackboard"][5], "24 h")
        self.assertEqual(trend["metrics"]["review_to_close"]["repos"]["Blackboard"][5], "2 h")
        self.assertEqual(trend["metrics"]["open_to_close"]["repos"]["conference"][4], "unknown")
        self.assertEqual(board._median_label([2, 3]), "2.5 h")
        self.assertEqual(board._median_label([]), "unknown")
        self.assertNotIn("sfdc-24/Blackboard#9", [item["id"] for item in generation["items"]])
        self.assertEqual(generation["counts"]["sfdc-24/Blackboard"], 0)
        self.assertEqual(generation["closed_turnaround"][0]["open_to_close"], "24 h")
        self.assertNotIn(TITLE, json.dumps(generation["closed_turnaround"]))
        shared = self.generation([record(author="sfdc-24", events=[], reviews=[{
            "state": "APPROVED", "commit_id": HEAD, "submitted_at": "2026-10-07T18:00:00Z", "login": "sfdc-24"}])])
        shared_turn = shared["items"][0]["turnaround"]
        self.assertEqual(shared_turn["first_review"], "2 h")
        self.assertEqual(shared_turn["author_name"], "")
        self.assertEqual(shared_turn["reviewer_name"], "")
        self.assertEqual(shared["turnaround_trend"]["metrics"]["first_review"]["repos"]["conference"][4], "2 h")
        self.assertEqual(shared["turnaround_trend"]["metrics"]["first_review"]["author"]["Cody"][4], "unknown")
        for name in board.AGENT_ORDER:
            for role in ("author", "reviewer"):
                series = shared["turnaround_trend"]["metrics"]["first_review"][role][name]
                self.assertEqual(len(series), 7)
                self.assertTrue(all(value.strip() for value in series))

    def test_a_close_without_events_and_a_dismissed_review(self):
        conflict = self.generation([record(
            state="open",
            events=[{"id": 1, "event": "closed", "created_at": "2026-10-08T17:00:00Z"}],
            reviews=[{"state": "APPROVED", "commit_id": HEAD, "submitted_at": "2026-10-07T18:00:00Z", "login": "aya"}],
        )])["items"][0]
        self.assertEqual(conflict["turnaround"]["first_review"], "unknown")
        self.assertEqual(conflict["turnaround"]["open_to_close"], "unknown")
        closed_without_events = self.generation([record(state="merged", events=[])])["items"][0]
        self.assertEqual(closed_without_events["turnaround"]["open_to_close"], "unknown")
        dismissed = self.generation([record(events=[], reviews=[{
            "state": "DISMISSED", "commit_id": HEAD, "submitted_at": "2026-10-07T19:00:00Z", "login": "gemini",
        }])])["items"][0]
        self.assertEqual(dismissed["turnaround"]["first_review"], "3 h")
        self.assertEqual(dismissed["turnaround"]["reviewer_name"], "Jenny")

    def test_public_turnaround_keeps_titles_off_the_page_feed(self):
        generation = self.generation([record(
            glance={"priority": "P0", "blocks": "The public homepage cannot open until this review is accepted"},
            events=[], author="cursor",
            reviews=[{"state": "APPROVED", "commit_id": HEAD, "submitted_at": "2026-10-07T18:00:00Z", "login": "aya"}],
        )])
        public = board.public_snapshot(generation, enabled=True)
        self.assertEqual(public["rows"], [])
        self.assertEqual(public["turnaround"]["rows"], [])
        self.assertNotIn("conference#7", json.dumps(public))
        self.assertEqual(generation["items"][0]["turnaround"]["first_review"], "2 h")
        self.assertNotIn("conference", public["turnaround"]["metrics"]["first_review"]["repos"])
        self.assertNotIn("Blackboard", public["turnaround"]["metrics"]["first_review"]["repos"])
        self.assertEqual(generation["turnaround_trend"]["metrics"]["first_review"]["repos"]["conference"][4], "2 h")
        self.assertEqual(public["turnaround"]["days"][4], "2026-10-07")
        for secret in (TITLE, LABEL, TOKEN, "PRIVATE CONTENT"):
            self.assertNotIn(secret, json.dumps(public))
        off = board.public_snapshot(generation, enabled=False)
        self.assertEqual(off["turnaround"], {"days": [], "metrics": {}, "rows": []})
        self.assertEqual(off["rows"], [])
        documents = board.redis_documents(generation)
        trend_docs = [item for item in documents if ":turn:" in item[0]]
        self.assertEqual([item[0].rsplit(":", 1)[1] for item in trend_docs], list(board.TURN_METRICS))
        blob = json.dumps([item[1] for item in documents])
        self.assertIn("2 h", blob)
        for secret in (TITLE, LABEL, TOKEN):
            self.assertNotIn(secret, blob)
        compact = board._compact(generation["items"][0])
        self.assertEqual(compact["t_first"], "2 h")
        self.assertEqual(compact["t_review"], "unknown")
        self.assertEqual(compact["t_open"], "unknown")
        self.assertLessEqual(len(compact) + 1, board.MAX_PUT_FIELDS)

    def test_closed_walk_uses_the_close_time(self):
        recent = dict(raw(4), state="closed", closed_at="2026-10-08T12:00:00Z", updated_at="2026-10-01T00:00:00Z")
        old = dict(raw(5), state="closed", closed_at="2026-09-01T12:00:00Z", updated_at=AS_OF)

        def read(path):
            if "state=closed" not in path:
                raise AssertionError(path)
            if "sfdc-24/conference" in path and "page=1" in path:
                return [recent, old]
            return []

        found = board.list_closed(read, AS_OF)
        self.assertEqual([item["number"] for item in found], [4])
        self.assertNotIn(TITLE, json.dumps(found))
        self.assertNotIn("updated_at", json.dumps(found))


class ReviewFixTests(unittest.TestCase):
    def generation(self, records, **kwargs):
        return board.build_generation(records, AS_OF, **kwargs)

    def test_page_two_head_change_rejects_the_generation(self):
        seen = {"page2": 0}

        def read(path):
            if "state=closed" in path or "/reviews?" in path or "/events?" in path:
                return []
            match = re.search(r"[?&]page=(\d+)", path)
            page = int(match.group(1)) if match else 0
            if "sfdc-24/conference/pulls?" in path and page == 1:
                return [raw(number) for number in range(1, 101)]
            if "sfdc-24/conference/pulls?" in path and page == 2:
                seen["page2"] += 1
                return [raw(101, head=HEAD if seen["page2"] == 1 else OLD)]
            if page == 1:
                return []
            return []

        receipt = board.run(AS_OF, read, enabled_flag=True)
        self.assertGreaterEqual(seen["page2"], 2)
        self.assertEqual(receipt["status"], "stale")
        self.assertIsNone(receipt["items"])

    def test_closed_walk_sorts_by_update_and_stops_past_the_window(self):
        pages = []

        def read(path):
            pages.append(path)
            self.assertIn("sort=updated", path)
            self.assertIn("direction=desc", path)
            page = int(re.search(r"[?&]page=(\d+)", path).group(1))
            if page > 1:
                raise AssertionError(path)
            if "sfdc-24/conference" in path and page == 1:
                return [dict(raw(9), state="closed", closed_at="2026-09-01T00:00:00Z",
                             updated_at="2026-09-01T00:00:00Z")]
            return []

        original = board.PER_PAGE
        board.PER_PAGE = 1
        try:
            found = board.list_closed(read, AS_OF, repos=("sfdc-24/conference",))
        finally:
            board.PER_PAGE = original
        self.assertEqual(found, [])
        self.assertTrue(any("page=1" in path for path in pages))

    def test_latest_observation_does_not_depend_on_row_order(self):
        identifier = "sfdc-24/conference#7"
        older = {"id": identifier, "sha": OLD, "evidence": "okf:RUN-1", "observed_at": "2026-10-08T12:00:00Z"}
        newer = {"id": identifier, "sha": HEAD, "evidence": "okf:RUN-2", "observed_at": "2026-10-09T12:00:00Z"}
        forward = self.generation([record(state="merged")], deployed=[older, newer])["items"][0]
        backward = self.generation([record(state="merged")], deployed=[newer, older])["items"][0]
        self.assertEqual(forward["deployed_head"], HEAD)
        self.assertEqual(forward["deployed_state"], "matches_proposed")
        self.assertEqual(backward["deployed_head"], HEAD)
        self.assertEqual(backward["deployed_state"], "matches_proposed")
        tied = self.generation([record(state="merged")], deployed=[
            dict(older, observed_at="2026-10-09T12:00:00Z"),
            newer,
        ])["items"][0]
        self.assertEqual(tied["deployed_state"], "unknown")
        self.assertIsNone(tied["deployed_head"])

    def test_unaudited_shard_is_written_again_before_the_head_moves(self):
        generation = self.generation([record()])
        store = Store()
        previous = {"advisory": "1", "complete": "1", "generation": "d" * 64}
        store.data[board.HEAD_KEY] = dict(previous)
        store.partial_at = 1
        first = board.write_generation(generation, store.put, store.read_full)
        self.assertEqual(first["reason"], "audit_failed")
        self.assertEqual(store.data[board.HEAD_KEY], previous)
        self.assertTrue(first["head_retained"])
        store.partial_at = None
        writes = store.writes
        second = board.write_generation(generation, store.put, store.read_full)
        self.assertEqual(second["status"], "complete")
        self.assertGreater(store.writes, writes)
        self.assertEqual(store.data[board.HEAD_KEY]["generation"], generation["id"])

    def test_partial_head_write_does_not_claim_the_old_head_was_kept(self):
        generation = self.generation([record()])
        store = Store()
        previous = {"advisory": "1", "complete": "1", "generation": "d" * 64}
        store.data[board.HEAD_KEY] = dict(previous)
        real = store.put

        def put(key, mapping):
            if key == board.HEAD_KEY:
                store.partial_at = store.writes + 1
            return real(key, mapping)

        receipt = board.write_generation(generation, put, store.read_full)
        self.assertEqual(receipt["reason"], "head_audit_uncertain")
        self.assertTrue(receipt["wrote_head"])
        self.assertFalse(receipt["head_retained"])
        self.assertEqual(store.data[board.HEAD_KEY]["generation"], generation["id"])

        store = Store()
        store.data[board.HEAD_KEY] = dict(previous)
        real = store.put

        def fail_head(key, mapping):
            if key == board.HEAD_KEY:
                store.fail_at = store.writes + 1
            return real(key, mapping)

        kept = board.write_generation(generation, fail_head, store.read_full)
        self.assertEqual(kept["reason"], "head_unmoved")
        self.assertTrue(kept["head_retained"])
        self.assertFalse(kept["wrote_head"])
        self.assertEqual(store.data[board.HEAD_KEY], previous)

    def test_keys_stay_in_the_governed_prefix(self):
        generation = self.generation([record()])
        keys = [key for key, _mapping in board.redis_documents(generation)]
        self.assertTrue(keys)
        for key in keys:
            self.assertTrue(key.startswith("proj:pr-board:v1:"))
            self.assertFalse(key.startswith("pr:"))
            self.assertNotIn("/", key)
            self.assertNotIn("+", key)
            self.assertTrue(board.KEY_GRAMMAR.fullmatch(key))
        self.assertTrue(any(key.endswith(":repo:sfdc-24:conference") for key in keys))
        meta = next(mapping for key, mapping in board.redis_documents(generation) if key.endswith(":meta"))
        self.assertEqual(meta["advisory"], "0")
        self.assertNotIn("advisory_head", meta)
        self.assertEqual(board.SWEEP_CADENCE_HOURS, 4)

    def test_dashboard_fields_are_one_owner_milestone_and_go_flag(self):
        plain = self.generation([record()])["items"][0]
        self.assertEqual(plain["owner"], "unassessed")
        self.assertEqual(plain["queue_owners"], ["cursor", "grok"])
        self.assertNotEqual(plain["owner"], "cursor,grok")
        self.assertEqual(plain["milestone"], "unassessed")
        self.assertEqual(plain["project"], "Conference")
        self.assertEqual(plain["go_on_exact_head"], "no")
        approved = self.generation([record(reviews=[{
            "state": "APPROVED", "commit_id": HEAD, "submitted_at": CREATED, "login": "aya"}])])["items"][0]
        self.assertEqual(approved["go_on_exact_head"], "yes")
        stale = self.generation([record(reviews=[{
            "state": "APPROVED", "commit_id": OLD, "submitted_at": CREATED, "login": "aya"}])])["items"][0]
        self.assertEqual(stale["go_on_exact_head"], "no")
        missing = self.generation([record(reviews=None)])["items"][0]
        self.assertEqual(missing["go_on_exact_head"], "unassessed")
        named = self.generation([record(glance={"owner": "Cody", "priority": "P1"})])["items"][0]
        self.assertEqual(named["owner"], "Cody")
        row = board.display_rows(self.generation([record(
            milestone="GATE-2",
            glance={"owner": "Cody"},
            reviews=[{"state": "APPROVED", "commit_id": HEAD, "submitted_at": CREATED, "login": "aya"}],
        )]))[0]
        self.assertEqual(row["owner"], "Cody")
        self.assertEqual(row["milestone"], "GATE-2")
        self.assertEqual(row["project"], "Conference")
        self.assertEqual(row["go_on_head"], "Yes")
        self.assertEqual(row["blocked_by"], "unassessed")
        private = board.scrub_pull("sfdc-24/conference", dict(
            raw(7), milestone={"title": "Launch plan PRIVATE TITLE"}))
        self.assertEqual(private["milestone"], "")
        safe = board.scrub_pull("sfdc-24/conference", dict(raw(7), milestone={"title": "GATE-2"}))
        self.assertEqual(safe["milestone"], "GATE-2")


PROBE_AS_OF = "2026-10-11T15:00:00Z"
NEUTRAL_BLOCKS = "Synthetic acquisition schedule"
NEUTRAL_BLOCKED = "Synthetic client decision"
NEUTRAL_MILESTONE = "Synthetic expansion milestone"


def synthetic_raw(number, repo_body=True):
    return {
        "number": number, "state": "open", "draft": False,
        "created_at": "2026-10-10T15:00:00Z",
        "updated_at": PROBE_AS_OF,
        "head": {"sha": HEAD, "ref": "synthetic-probe"},
        "title": "Synthetic title",
        "body": "\n".join([
            "At a glance",
            "Priority: P0",
            "Blocks: " + NEUTRAL_BLOCKS,
            "Blocked by: " + NEUTRAL_BLOCKED,
            "Owner: Grok",
        ]),
        "milestone": {"title": NEUTRAL_MILESTONE},
    }


class AcceptanceTests(unittest.TestCase):
    def test_private_neutral_prose_stays_out_of_the_public_snapshot(self):
        conference = dict(
            board.scrub_pull("sfdc-24/conference", synthetic_raw(900001)),
            reviews=[], events=[], checks=None, required_checks=[])
        site = dict(
            board.scrub_pull("sfdc-24/sfdc24-site", synthetic_raw(3)),
            reviews=[], events=[], checks=None, required_checks=[])
        private_generation = board.build_generation([conference], PROBE_AS_OF)
        private = json.dumps(private_generation)
        for phrase in (NEUTRAL_BLOCKS, NEUTRAL_BLOCKED, NEUTRAL_MILESTONE):
            self.assertIn(phrase, private)
        self.assertEqual(private_generation["items"][0]["glance"]["owner"], "Greg")
        hidden = board.public_snapshot(private_generation, enabled=True)
        encoded = json.dumps(hidden)
        for phrase in (NEUTRAL_BLOCKS, NEUTRAL_BLOCKED, NEUTRAL_MILESTONE):
            self.assertNotIn(phrase, encoded)
        self.assertNotIn("conference#900001", encoded)
        self.assertNotIn('"priority"', json.dumps(hidden["rows"]))
        self.assertEqual(hidden["rows"], [])
        self.assertEqual(hidden["turnaround"]["rows"], [])
        self.assertNotIn("action", hidden)
        self.assertNotIn("closed_history", hidden)
        self.assertNotIn("next_action", encoded)
        generation = board.build_generation([conference, site], PROBE_AS_OF)
        public = board.public_snapshot(generation, enabled=True)
        by_pr = {row["pr"]: row for row in public["rows"]}
        self.assertNotIn("conference#900001", by_pr)
        self.assertNotIn("conference#", json.dumps(public["turnaround"]["rows"]))
        site_row = by_pr["sfdc24-site#3"]
        self.assertEqual(site_row["blocks"], NEUTRAL_BLOCKS)
        self.assertEqual(site_row["blocked_by"], NEUTRAL_BLOCKED)
        self.assertEqual(site_row["milestone"], NEUTRAL_MILESTONE)
        self.assertEqual(site_row["owner"], "Greg")
        action = board.action_snapshot(private_generation)
        self.assertEqual(action["audience"], "private")
        self.assertFalse(action["recommendations_execute"])
        self.assertIn(NEUTRAL_BLOCKS, json.dumps(action))

    def test_public_file_bytes_omit_private_prose(self):
        """--public-out drops private per-PR rows, including turnaround rows, before the write."""
        site = raw(3)
        site["body"] = "At a glance\nPriority: P1\nBlocks: The public homepage can open\nOwner: Cody\n"
        site["title"] = "Public homepage"
        site["milestone"] = {"title": "GATE-2"}

        def read(path):
            if "state=closed" in path or "/events?" in path:
                return []
            if "/reviews?" in path:
                return [{"id": 9, "state": "APPROVED", "commit_id": HEAD,
                         "submitted_at": "2026-10-07T18:00:00Z", "user": {"login": "aya"}}]
            match = re.search(r"[?&]page=(\d+)", path)
            page = int(match.group(1)) if match else 0
            if page != 1:
                return []
            if "sfdc-24/conference/pulls?" in path:
                return [synthetic_raw(900001)]
            if "sfdc-24/Blackboard/pulls?" in path:
                return [synthetic_raw(900002)]
            if "sfdc-24/sfdc24-site/pulls?" in path:
                return [site]
            return []

        with tempfile.TemporaryDirectory() as tmp:
            public_path = os.path.join(tmp, "pr-board-public.json")
            private_path = os.path.join(tmp, "pr-board-private.json")
            code = board.main(
                ["--enable", "--as-of", PROBE_AS_OF, "--public-out", public_path, "--out", private_path],
                read=read, env={})
            self.assertEqual(code, 0)
            self.assertFalse(os.path.exists(public_path))
            private_bytes = Path(private_path).read_bytes()
            for phrase in (NEUTRAL_BLOCKS, NEUTRAL_BLOCKED, NEUTRAL_MILESTONE, b"conference#", b"Blackboard#", b"900001", b"900002"):
                needle = phrase if isinstance(phrase, bytes) else phrase.encode("utf-8")
                self.assertIn(needle, private_bytes)
            projected = board.run(PROBE_AS_OF, read, enabled_flag=True, env={})
            self.assertIs(projected["public_publish"], False)
            board.write_public_file(public_path, board.public_snapshot(projected["generation"], enabled=True))
            public_bytes = Path(public_path).read_bytes()
            self.assertIn(b'"enabled": true', public_bytes)
            for phrase in (NEUTRAL_BLOCKS, NEUTRAL_BLOCKED, NEUTRAL_MILESTONE, b"conference#", b"Blackboard#", b"900001", b"900002"):
                needle = phrase if isinstance(phrase, bytes) else phrase.encode("utf-8")
                self.assertNotIn(needle, public_bytes)
            self.assertNotIn(b'"pr": "conference#', public_bytes)
            self.assertNotIn(b'"pr": "Blackboard#', public_bytes)
            parsed = json.loads(public_bytes)
            self.assertEqual([row["pr"] for row in parsed["rows"]], ["sfdc24-site#3"])
            self.assertEqual([row["pr"] for row in parsed["turnaround"]["rows"]], ["sfdc24-site#3"])
            self.assertEqual(parsed["turnaround"]["rows"][0]["first_review"], "2 h")
            self.assertNotIn("conference#", json.dumps(parsed["turnaround"]["rows"]))
            self.assertNotIn("Blackboard#", json.dumps(parsed["turnaround"]["rows"]))
        shipped = (ROOT / "data" / "pr-board-public.json").read_bytes()
        self.assertIn(b'"enabled": false', shipped)
        self.assertIn(b'"rows": []', shipped)
        for phrase in (NEUTRAL_BLOCKS, NEUTRAL_BLOCKED, NEUTRAL_MILESTONE):
            self.assertNotIn(phrase.encode("utf-8"), shipped)

    def test_readiness_gates_fail_closed_on_the_collector_path(self):
        approval = {"id": 9, "state": "APPROVED", "commit_id": HEAD, "submitted_at": CREATED, "user": {"login": "aya"}}
        rows = {
            11: dict(raw(11), draft=True, mergeable=False, milestone={"title": "GATE-2"},
                     access={"state": "denied", "observed_at": AS_OF, "evidence": "okf:ACC-1"}),
            13: dict(raw(13), draft=False, milestone={"title": "GATE-2"},
                     access={"state": "allowed", "observed_at": AS_OF, "evidence": "okf:ACC-3"}),
            14: dict(raw(14), draft=False, mergeable=True, milestone={"title": "GATE-2"}),
            12: dict(raw(12), draft=False, mergeable=True, milestone={"title": "GATE-2"},
                     access={"state": "allowed", "observed_at": AS_OF, "evidence": "okf:ACC-2"},
                     reviewer_policy="not_required"),
        }

        def read(path):
            if "state=closed" in path or "/events?" in path:
                return []
            if "/reviews?" in path:
                return [approval]
            match = re.search(r"[?&]page=(\d+)", path)
            page = int(match.group(1)) if match else 0
            if "sfdc-24/conference/pulls?" in path and page == 1:
                return [rows[number] for number in sorted(rows)]
            return []

        found = board.attach_activity(board.list_open(read, repos=("sfdc-24/conference",)), read)
        self.assertIs(next(item for item in found if item["number"] == 11)["draft"], True)
        self.assertIs(next(item for item in found if item["number"] == 11)["mergeable"], False)
        self.assertEqual(next(item for item in found if item["number"] == 11)["access"]["state"], "denied")
        self.assertEqual(next(item for item in found if item["number"] == 13)["mergeable"], "unknown")
        self.assertEqual(next(item for item in found if item["number"] == 14)["access"]["state"], "unknown")
        for item in found:
            item["checks"] = [{"name": "ci", "head_sha": HEAD, "status": "completed", "conclusion": "success"}]
            item["required_checks"] = ["ci"]
            item["reviewer_policy"] = "not_required"
        acks = []
        for number in rows:
            acks.append({"repo": "sfdc-24/conference", "number": number, "role": "implementation_owner",
                         "actor": "cursor", "acknowledged": True, "source": "okf:OWN-%d" % number})
            acks.append({"repo": "sfdc-24/conference", "number": number, "role": "reviewer",
                         "actor": "aya", "acknowledged": True, "source": "okf:REV-%d" % number})
        generation = board.build_generation(found, AS_OF, acknowledgments=acks, dependencies=[])
        by_number = {item["number"]: item["action"] for item in generation["items"]}
        self.assertNotEqual(by_number[11]["next_action"], "MERGE")
        self.assertEqual(by_number[11]["recommendation_basis"], "draft")
        self.assertEqual(by_number[11]["access_state"], "denied")
        self.assertNotEqual(by_number[13]["next_action"], "MERGE")
        self.assertEqual(by_number[13]["recommendation_basis"], "mergeable")
        self.assertNotEqual(by_number[14]["next_action"], "MERGE")
        self.assertEqual(by_number[14]["recommendation_basis"], "access")
        self.assertEqual(by_number[12]["next_action"], "MERGE")
        self.assertFalse(by_number[12]["recommendations_execute"])

    def test_collector_keeps_readiness_fields_or_marks_them_unknown(self):
        rich = dict(
            raw(21), mergeable=False,
            waiting_events=[{"id": 4, "event": "waiting", "created_at": "2026-10-09T15:00:00Z"}],
            access={"state": "denied", "observed_at": AS_OF, "evidence": "okf:ACC-1"},
            task={"state": "assessed", "kind": "issue", "number": 196, "repo": "sfdc-24/conference",
                  "evidence": "okf:TASK-1"},
            fix_url="https://github.com/sfdc-24/conference/pull/21/files",
            fix_evidence="okf:FIX-1",
            closure_case={"duplication": True, "rationale": "duplicate", "replacement": "okf:REPL-1",
                          "obligations_preserved": True, "evidence": "okf:CLOSE-1"},
        )
        bare = dict(raw(22))
        bare.pop("draft")

        def read(path):
            if "state=closed" in path or "/reviews?" in path:
                return []
            if "/issues/21/events?" in path:
                return [{"id": 1, "event": "closed", "created_at": "2026-10-08T17:00:00Z", "actor": {"login": "aya"}}]
            if "/issues/22/events?" in path:
                return [{"id": 2, "event": "reopened", "created_at": REOPENED}]
            match = re.search(r"[?&]page=(\d+)", path)
            page = int(match.group(1)) if match else 0
            if "sfdc-24/conference/pulls?" in path and page == 1:
                return [rich, bare]
            return []

        found = {item["number"]: item for item in board.attach_activity(
            board.list_open(read, repos=("sfdc-24/conference",)), read)}
        self.assertIs(found[21]["mergeable"], False)
        self.assertEqual(found[21]["waiting_events"][0]["event"], "waiting")
        self.assertEqual(found[21]["access"]["state"], "denied")
        self.assertEqual(found[21]["task"]["kind"], "issue")
        self.assertEqual(found[21]["fix_url"], "https://github.com/sfdc-24/conference/pull/21/files")
        self.assertEqual(found[21]["fix_evidence"], "okf:FIX-1")
        self.assertEqual(found[21]["closure_case"]["rationale"], "duplicate")
        self.assertEqual(found[21]["events"][0]["actor"], "aya")
        for key in ("mergeable", "waiting_events", "task", "fix_url", "fix_evidence", "closure_case", "draft"):
            self.assertEqual(found[22][key], "unknown")
        self.assertEqual(found[22]["access"]["state"], "unknown")
        self.assertEqual(found[22]["events"][0]["actor"], "unknown")
        generation = board.build_generation(list(found.values()), AS_OF, history_records=[])
        action = {row["number"]: row for row in board.action_snapshot(generation)["rows"]}
        self.assertEqual(action[21]["waiting"], "2 h")
        self.assertEqual(action[21]["waiting_basis"], "waiting_event")
        self.assertEqual(action[21]["closure_events"][0]["actor"], "aya")
        self.assertEqual(action[21]["access_state"], "denied")
        self.assertEqual(action[21]["links"]["work"], "https://github.com/sfdc-24/conference/issues/196")
        self.assertEqual(action[21]["links"]["fix"], "https://github.com/sfdc-24/conference/pull/21/files")
        self.assertNotEqual(action[21]["next_action"], "MERGE")
        self.assertEqual(action[22]["access_state"], "unknown")
        self.assertEqual(action[22]["closure_events"][0]["actor"], "unknown")

    def test_sentinels_are_not_closure_or_link_evidence(self):
        """list_open/scrub_pull: unknown, unassessed, None, and empty are not CLOSE, MERGE, FIX, or a link."""
        self.assertFalse(board._has_evidence(None))
        self.assertFalse(board._has_evidence(""))
        self.assertFalse(board._has_evidence("   "))
        self.assertFalse(board._has_evidence("unknown"))
        self.assertFalse(board._has_evidence("unassessed"))
        self.assertFalse(board._has_evidence("  Unknown  "))
        self.assertTrue(board._has_evidence("okf:CLOSE-1"))
        approval = {"id": 9, "state": "APPROVED", "commit_id": HEAD, "submitted_at": CREATED, "user": {"login": "aya"}}
        omitted = dict(
            raw(31), draft=False, mergeable=True,
            closure_case={"duplication": True, "rationale": "duplicate", "obligations_preserved": True},
            task={"state": "assessed", "kind": "issue", "number": 196, "repo": "sfdc-24/conference"},
            fix_url="https://github.com/sfdc-24/conference/pull/31/files")
        explicit = dict(
            raw(32), draft=False, mergeable=True,
            closure_case={"duplication": True, "rationale": "duplicate", "replacement": "unknown",
                          "obligations_preserved": True, "evidence": " Unknown "},
            task={"state": "assessed", "kind": "issue", "number": 196, "repo": "sfdc-24/conference",
                  "evidence": "", "work_id": "unknown"},
            fix_url="https://github.com/sfdc-24/conference/pull/32/files",
            fix_evidence="Unassessed")
        blank = dict(
            raw(34), draft=False, mergeable=True,
            closure_case={"duplication": True, "rationale": "duplicate", "obligations_preserved": True,
                          "replacement": None, "evidence": None},
            task={"state": "assessed", "kind": "pr", "number": 40, "repo": "sfdc-24/conference",
                  "evidence": None, "work_id": None},
            fix_url="https://github.com/sfdc-24/conference/pull/34/files",
            fix_evidence=None)
        real = dict(
            raw(33), draft=False, mergeable=True, milestone={"title": "GATE-2"},
            access={"state": "allowed", "observed_at": AS_OF, "evidence": "okf:ACC-33"},
            closure_case={"duplication": True, "rationale": "duplicate", "replacement": "okf:REPL-1",
                          "obligations_preserved": True, "evidence": "okf:CLOSE-1"},
            task={"state": "assessed", "kind": "issue", "number": 196, "repo": "sfdc-24/conference",
                  "evidence": "okf:TASK-1"},
            fix_url="https://github.com/sfdc-24/conference/pull/33/files",
            fix_evidence="okf:FIX-1")
        milestone_sentinel = dict(
            raw(35), draft=False, mergeable=True, milestone={"title": "unknown"},
            access={"state": "allowed", "observed_at": AS_OF, "evidence": "okf:ACC-35"},
            reviewer_policy="not_required")
        owner_sentinel = dict(
            raw(36), draft=False, mergeable=True, milestone={"title": "GATE-2"},
            access={"state": "allowed", "observed_at": AS_OF, "evidence": "okf:ACC-36"},
            reviewer_policy="not_required")
        closure_sentinel_merge = dict(
            raw(38), draft=False, mergeable=True, milestone={"title": "GATE-2"},
            access={"state": "allowed", "observed_at": AS_OF, "evidence": "okf:ACC-38"},
            reviewer_policy="not_required",
            closure_case={"duplication": True, "rationale": "duplicate", "replacement": "unassessed",
                          "obligations_preserved": True, "evidence": "unknown"})
        rows = {31: omitted, 32: explicit, 33: real, 34: blank, 35: milestone_sentinel,
                36: owner_sentinel, 38: closure_sentinel_merge}

        def read(path):
            if "state=closed" in path or "/events?" in path:
                return []
            if "/reviews?" in path:
                return [approval]
            match = re.search(r"[?&]page=(\d+)", path)
            page = int(match.group(1)) if match else 0
            if "sfdc-24/conference/pulls?" in path and page == 1:
                return [rows[number] for number in sorted(rows)]
            return []

        found = {item["number"]: item for item in board.attach_activity(
            board.list_open(read, repos=("sfdc-24/conference",)), read)}
        for number in (31, 32, 34):
            self.assertEqual(found[number]["closure_case"]["evidence"], "unknown")
            self.assertEqual(found[number]["closure_case"]["replacement"], "unknown")
            self.assertEqual(found[number]["task"]["evidence"], "unknown")
            self.assertEqual(found[number]["fix_evidence"], "unknown")
            self.assertEqual(found[number]["task"]["work_id"], "unknown")
        self.assertEqual(found[38]["closure_case"]["evidence"], "unknown")
        self.assertEqual(found[38]["closure_case"]["replacement"], "unknown")
        for item in found.values():
            item["checks"] = [{"name": "ci", "head_sha": HEAD, "status": "completed", "conclusion": "success"}]
            item["required_checks"] = ["ci"]
            item["reviewer_policy"] = "not_required"
        acks = []
        for number in rows:
            source = "unknown" if number == 36 else "okf:OWN-%d" % number
            acks.append({"repo": "sfdc-24/conference", "number": number, "role": "implementation_owner",
                         "actor": "cursor", "acknowledged": True, "source": source})
            acks.append({"repo": "sfdc-24/conference", "number": number, "role": "reviewer",
                         "actor": "aya", "acknowledged": True, "source": "okf:REV-%d" % number})
        generation = board.build_generation(list(found.values()), AS_OF, acknowledgments=acks, dependencies=[])
        action = {item["number"]: item["action"] for item in generation["items"]}
        for number in (31, 32, 34):
            self.assertNotEqual(action[number]["next_action"], "CLOSE")
            self.assertNotEqual(action[number]["next_action"], "MERGE")
            self.assertNotEqual(action[number]["next_action"], "FIX")
            self.assertNotEqual(action[number]["recommendation_basis"], "duplication_or_obsolescence")
            self.assertEqual(action[number]["links"]["work"], "unassessed")
            self.assertEqual(action[number]["links"]["fix"], "unassessed")
            self.assertEqual(action[number]["links"]["task_evidence"], "unassessed")
            self.assertNotIn("/issues/196", json.dumps(action[number]["links"]))
            self.assertNotIn("/pull/40", json.dumps(action[number]["links"]["work"]))
        self.assertEqual(action[33]["next_action"], "CLOSE")
        self.assertEqual(action[33]["recommendation_basis"], "duplication_or_obsolescence")
        self.assertEqual(action[33]["links"]["work"], "https://github.com/sfdc-24/conference/issues/196")
        self.assertEqual(action[33]["links"]["fix"], "https://github.com/sfdc-24/conference/pull/33/files")
        self.assertNotEqual(action[35]["next_action"], "MERGE")
        self.assertEqual(action[35]["recommendation_basis"], "milestone")
        self.assertNotEqual(action[36]["next_action"], "MERGE")
        self.assertEqual(action[36]["recommendation_basis"], "owner")
        self.assertEqual(action[38]["next_action"], "MERGE")
        self.assertNotEqual(action[38]["recommendation_basis"], "duplication_or_obsolescence")
        self.assertFalse(action[38]["recommendations_execute"])

    def test_head_readback_timeout_is_not_a_failed_write(self):
        generation = board.build_generation([record()], AS_OF)
        stored = {}

        def put(key, mapping):
            stored[key] = dict(mapping)
            return {"ok": True}

        def read_full(key):
            if key == board.HEAD_KEY and key in stored:
                raise TimeoutError("synthetic post-success head read timeout")
            return stored.get(key)

        receipt = board.write_generation(generation, put, read_full)
        self.assertEqual(receipt["status"], "stale")
        self.assertEqual(receipt["reason"], "head_readback_timeout")
        self.assertIsNone(receipt["wrote_head"])
        self.assertNotEqual(receipt["wrote_head"], False)
        self.assertEqual(receipt["head_retained"], "unknown")
        self.assertEqual(receipt["head_write"], {
            "attempted": True, "written": True, "confirmed": False, "audited": False})
        self.assertIn(board.HEAD_KEY, stored)
        self.assertEqual(stored[board.HEAD_KEY]["generation"], generation["id"])
        self.assertNotEqual(receipt["status"], "replay")

        fresh = {}

        def put_fresh(key, mapping):
            fresh[key] = dict(mapping)
            return {"ok": True}

        def read_fresh(key):
            if key == board.HEAD_KEY and key in fresh:
                raise TimeoutError("synthetic post-success head read timeout")
            return fresh.get(key)

        again = board.run(AS_OF, read=lambda path: [], put=put_fresh, read_full=read_fresh, enabled_flag=True)
        self.assertEqual(again["reason"], "head_readback_timeout")
        self.assertIsNone(again["wrote_head"])
        self.assertFalse(again["wrote"])
        self.assertNotEqual(again["status"], "replay")
        self.assertEqual(fresh[board.HEAD_KEY]["generation"], again["generation_id"])

    def test_head_readback_mismatch_stays_unconfirmed(self):
        generation = board.build_generation([record()], AS_OF)
        previous = {"advisory": "1", "complete": "1", "generation": "d" * 64}
        stored = {board.HEAD_KEY: dict(previous)}

        def put(key, mapping):
            stored[key] = dict(mapping)
            return {"ok": True}

        def read_full(key):
            if key == board.HEAD_KEY and stored[key].get("generation") == generation["id"]:
                return {"advisory": "1", "complete": "1", "generation": "f" * 64}
            return stored.get(key)

        receipt = board.write_generation(generation, put, read_full)
        self.assertEqual(receipt["reason"], "head_readback_mismatch")
        self.assertIsNone(receipt["wrote_head"])
        self.assertEqual(receipt["head_retained"], "unknown")
        self.assertFalse(receipt["head_write"]["confirmed"])
        self.assertFalse(receipt["head_write"]["audited"])
        self.assertTrue(receipt["head_write"]["written"])
        self.assertNotEqual(receipt["status"], "replay")

        stored = {board.HEAD_KEY: dict(previous)}

        def read_old(key):
            if key == board.HEAD_KEY and stored[key].get("generation") == generation["id"]:
                return dict(previous)
            return stored.get(key)

        kept = board.write_generation(generation, put, read_old)
        self.assertEqual(kept["reason"], "head_readback_mismatch")
        self.assertFalse(kept["wrote_head"])
        self.assertTrue(kept["head_retained"])
        self.assertFalse(kept["head_write"]["confirmed"])

    def test_cli_does_not_claim_the_previous_generation_on_an_unknown_head(self):
        stored = {}

        def put(key, mapping):
            stored[key] = dict(mapping)
            return {"ok": True}

        def read_full(key):
            if key == board.HEAD_KEY and key in stored:
                raise TimeoutError()
            return stored.get(key)

        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            code = board.main(["--enable", "--as-of", AS_OF], read=lambda path: [], put=put,
                              read_full=read_full, env={})
        self.assertEqual(code, 1)
        message = stderr.getvalue()
        self.assertIn("previous generation is not confirmed", message)
        self.assertNotIn("last good generation retained", message)
        self.assertIn(board.HEAD_KEY, stored)

    def test_public_sheet_refuses_private_action_before_base64(self):
        encoded = []
        original = board.base64.b64encode

        def spy(payload):
            encoded.append(payload)
            return original(payload)

        calls = []

        def execute(*args):
            calls.append(args)
            return {"ok": True}

        board.base64.b64encode = spy
        try:
            put = board.governed_put(execute, None, {}, via="public-sheet")
            action_key = board.NAMESPACE + "g:" + ("ab" * 8) + ":action:0"
            with self.assertRaises(board.InvalidEvidence):
                put(action_key, {"audience": "private", "rows": "[]", "generation": "ab" * 32})
            with self.assertRaises(board.InvalidEvidence):
                put(board.NAMESPACE + "g:" + ("ab" * 8) + ":closed:0", {"coverage": "complete"})
            with self.assertRaises(board.InvalidEvidence):
                put(board.HEAD_KEY, {"audience": "private", "generation": "ab" * 32})
            with self.assertRaises(board.InvalidEvidence):
                put(board.NAMESPACE + "g:" + ("ab" * 8) + ":manifest:0", {
                    "entries": "[]", "manifest_sha256": "ab" * 32, "page": "0"})
            with self.assertRaises(board.InvalidEvidence):
                put(board.NAMESPACE + "head", {
                    "manifest_root": "cd" * 32, "generation": "ab" * 32, "advisory": "1"})
            with self.assertRaises(board.InvalidEvidence):
                put(board.NAMESPACE + "g:" + ("ab" * 8) + ":receipt", {
                    "report_digest": "ab" * 32, "listed": "2", "root_digest": "cd" * 32})
            self.assertEqual(encoded, [])
            self.assertEqual(calls, [])
            private = board.governed_put(execute, None, {}, via="pr-board")
            self.assertTrue(private(action_key, {
                "audience": "private", "generation": "ab" * 32, "rows": "[]"})["ok"])
            self.assertEqual(len(encoded), 1)
            self.assertEqual(len(calls), 1)
        finally:
            board.base64.b64encode = original

    def test_action_advice_does_not_merge_or_close_from_a_weak_signal(self):
        old = self._action(record(
            reviews=[{"state": "APPROVED", "commit_id": HEAD, "submitted_at": CREATED, "login": "aya", "id": 9}],
            milestone="GATE-2",
        ))
        self.assertEqual(old["go_on_exact_head"], "yes")
        self.assertEqual(old["action"]["next_action"], "DEFER")
        self.assertNotEqual(old["action"]["next_action"], "MERGE")
        self.assertFalse(old["action"]["recommendations_execute"])
        self.assertNotEqual(old["action"]["links"]["review"], old["action"]["links"]["files"])
        self.assertIn("#pullrequestreview-9", old["action"]["links"]["review"])
        aged = self._action(record(created_at="2026-07-01T00:00:00Z", events=[]))
        self.assertNotEqual(aged["action"]["next_action"], "CLOSE")
        self.assertGreater(int(aged["action"]["age_days"]), 3)
        closed = self._action(record(
            closure_case={"duplication": True, "obsolete": False, "rationale": "duplicate",
                          "replacement": "okf:REPL-1", "obligations_preserved": True, "evidence": "okf:CLOSE-1"},
        ))
        self.assertEqual(closed["action"]["next_action"], "CLOSE")
        waiting = self._action(record(
            updated_at=AS_OF,
            waiting_events=[{"id": 4, "event": "waiting", "created_at": "2026-10-09T15:00:00Z"}],
            events=[],
        ))
        self.assertEqual(waiting["action"]["waiting"], "2 h")
        self.assertEqual(waiting["action"]["waiting_basis"], "waiting_event")
        untouched = self._action(record(updated_at="2026-10-01T00:00:00Z", events=[]))
        self.assertEqual(untouched["action"]["waiting"], "unknown")
        conflict = self._action(record(reviews=[
            {"state": "APPROVED", "commit_id": HEAD, "submitted_at": CREATED, "login": "aya"},
            {"state": "CHANGES_REQUESTED", "commit_id": HEAD, "submitted_at": CREATED, "login": "claude"},
        ]))
        self.assertEqual(conflict["action"]["next_action"], "DEFER")
        self.assertEqual(conflict["action"]["conflict_state"], "conflict")
        bare = self._action(record(work_id="WRK-1", task={"work_id": "WRK-1", "state": "assessed"}))
        self.assertEqual(bare["action"]["links"]["work"], "unassessed")
        self.assertNotIn("closure_source", board._compact(old))
        self.assertIn("owner_source", old["action"])

    def test_closed_history_keeps_reopens_and_does_not_truncate(self):
        reopened = record(events=[
            {"id": 1, "event": "closed", "created_at": "2026-10-08T17:00:00Z", "actor": "sfdc-24"},
            {"id": 2, "event": "reopened", "created_at": REOPENED, "actor": "aya"},
        ])
        active = board.build_generation([reopened], AS_OF, history_records=[])
        self.assertEqual(active["closed_history"]["coverage"], "complete")
        self.assertEqual(active["closed_history"]["rows"], [])
        self.assertFalse(active["closed_history"]["truncated"])
        action = board.action_snapshot(active)["rows"][0]
        self.assertEqual(action["id"], "sfdc-24/conference#7")
        self.assertEqual(action["closure_events"][1]["event"], "reopened")
        self.assertEqual(action["closure_events"][0]["actor"], "unknown")
        self.assertEqual(action["closure_events"][1]["actor"], "aya")
        missing = board.build_generation([record()], AS_OF)
        self.assertEqual(missing["closed_history"]["coverage"], "not_collected")
        self.assertIsNone(missing["closed_history"]["merged"])

        newer = dict(raw(2), state="closed", merged_at=AS_OF, closed_at="2026-10-08T12:00:00Z",
                     updated_at=AS_OF, merge_commit_sha=HEAD)
        older = dict(raw(1), state="closed", closed_at="2020-01-01T00:00:00Z", updated_at="2020-01-02T00:00:00Z")
        pages = {"1": [newer], "2": [older]}

        def read(path):
            self.assertIn("sort=updated", path)
            self.assertIn("direction=desc", path)
            page = re.search(r"[?&]page=(\d+)", path).group(1)
            if "sfdc-24/conference" not in path:
                return []
            return pages.get(page, [])

        original = board.PER_PAGE
        board.PER_PAGE = 1
        try:
            found = board.list_closed_history(read, repos=("sfdc-24/conference",), max_pages=5)
        finally:
            board.PER_PAGE = original
        self.assertEqual(sorted(item["number"] for item in found), [1, 2])
        generation = board.build_generation([], AS_OF, history_records=[
            dict(found[0], events=[{"id": 3, "event": "closed", "created_at": "2020-01-01T00:00:00Z"}]),
            dict(found[1], events=[{"id": 4, "event": "closed", "created_at": "2026-10-08T12:00:00Z"}]),
        ])
        history = generation["closed_history"]
        self.assertEqual(history["coverage"], "complete")
        self.assertFalse(history["truncated"])
        self.assertEqual(history["merged"], 1)
        self.assertEqual(history["closed_unmerged"], 1)
        by_number = {row["number"]: row for row in history["rows"]}
        self.assertEqual(by_number[2]["merged_commit"], HEAD)
        self.assertEqual(by_number[2]["head_at_close"], "unknown")
        self.assertNotEqual(by_number[2]["head_at_close"], HEAD)
        self.assertEqual(history["turnaround_sample_30d"]["window_days"], 30)
        self.assertEqual(history["turnaround_sample_30d"]["count"], 1)
        self.assertNotEqual(history["turnaround_sample_30d"]["label"], "7-day")

        def overflowing(path):
            return [dict(raw(1), state="closed", closed_at="2020-01-01T00:00:00Z", updated_at=AS_OF)]

        board.PER_PAGE = 1
        try:
            with self.assertRaises(ValueError):
                board.list_closed_history(overflowing, repos=("sfdc-24/conference",), max_pages=1)
        finally:
            board.PER_PAGE = original

    def test_consumer_assembles_one_complete_generation(self):
        generation = board.build_generation([record()], AS_OF, history_records=[])
        documents = board.redis_documents(generation)
        assembled = board.assemble_generation(documents)
        self.assertTrue(assembled["redis_read_back"])
        self.assertEqual(assembled["generation"], generation["id"])
        self.assertEqual(assembled["schema_version"], 1)
        partial = [pair for pair in documents if not pair[0].endswith(":action:0")]
        refused = board.assemble_generation(partial)
        self.assertFalse(refused["redis_read_back"])
        self.assertNotEqual(refused["reason"], "validated")
        local = board.local_projection(generation)
        self.assertEqual(local["delivery"], "local_only")
        self.assertFalse(local["redis_read_back"])
        for key, _mapping in documents:
            self.assertTrue(key.startswith("proj:pr-board:v1:"))
            self.assertNotIn("/", key)
            self.assertFalse(key.startswith("pr:"))

    def test_private_writer_keeps_the_generation_off_the_public_file(self):
        generation = board.build_generation([record()], AS_OF, history_records=[])
        store = Store()
        receipt = board.write_private_generation(generation, store.put, store.read_full)
        self.assertEqual(receipt["status"], "complete")
        self.assertFalse(receipt["public_written"])
        prefix = board.private_prefix(generation["id"])
        self.assertTrue(prefix.startswith("proj:pr-board:v1:g:"))
        self.assertNotIn("public", prefix)
        action_keys = [key for key in store.data if ":action:" in key]
        closed_keys = [key for key in store.data if ":closed:" in key]
        item_keys = [key for key in store.data if ":i:" in key]
        self.assertTrue(action_keys)
        self.assertTrue(closed_keys)
        self.assertTrue(item_keys)
        for key in action_keys + closed_keys + item_keys:
            self.assertTrue(key.startswith(prefix))
            self.assertNotIn("public", key)
        action = json.loads(store.data[action_keys[0]]["rows"])
        self.assertEqual(action["audience"], "private")
        self.assertIn("next_action", action["rows"][0])
        self.assertIn(generation["items"][0]["id"], json.dumps(action))
        closed = json.loads(store.data[closed_keys[0]]["rows"])
        self.assertEqual(closed["audience"], "private")
        self.assertIn("coverage", closed)
        self.assertNotIn("next_action", json.dumps(store.data[board.HEAD_KEY]))
        manifest_keys = [key for key in store.data if ":manifest:" in key]
        self.assertTrue(manifest_keys)
        for key in manifest_keys:
            self.assertTrue(key.startswith(prefix))
            self.assertEqual(store.data[key]["audience"], "private")
            encoded = json.dumps(store.data[key], sort_keys=True, separators=(",", ":"), ensure_ascii=False)
            self.assertLessEqual(len(encoded.encode("utf-8")), 2048)
            self.assertLessEqual(len(store.data[key]), 50)
        writes = store.writes
        replay = board.write_private_generation(generation, store.put, store.read_full)
        self.assertEqual(replay["status"], "replay")
        self.assertEqual(store.writes, writes)
        dropped = next(key for key in store.data if ":action:" in key)
        del store.data[dropped]
        refused = board.write_private_generation(generation, store.put, store.read_full)
        self.assertEqual(refused["status"], "stale")
        self.assertEqual(refused["reason"], "immutable_generation")
        self.assertEqual(store.writes, writes)
        self.assertEqual(store.data[board.HEAD_KEY]["generation"], generation["id"])
        with tempfile.TemporaryDirectory() as tmp:
            public_path = os.path.join(tmp, "pr-board-public.json")
            nested = os.path.join(tmp, "public", "board.json")
            os.makedirs(os.path.dirname(nested))
            with self.assertRaises(board.InvalidEvidence):
                board.write_public_file(public_path, generation)
            with self.assertRaises(board.InvalidEvidence):
                board.write_public_file(nested, generation)
            self.assertFalse(os.path.exists(public_path))
            self.assertFalse(os.path.exists(nested))
            board.write_public_file(public_path, board.public_snapshot(generation, enabled=True))
            public_text = Path(public_path).read_text(encoding="utf-8")
            self.assertNotIn("next_action", public_text)
            self.assertNotIn("closed_history", public_text)
            self.assertNotIn("recommendations_execute", public_text)
            self.assertNotIn('"audience": "private"', public_text)
            held = Store()
            code = board.main(
                ["--enable", "--as-of", AS_OF, "--out", public_path],
                read=lambda path: [], put=held.put, read_full=held.read_full, env={})
            self.assertEqual(code, 1)
            self.assertNotIn("next_action", Path(public_path).read_text(encoding="utf-8"))
            self.assertTrue(any(":action:" in key for key in held.data))

    def test_audited_readback_matches_the_written_generation(self):
        generation = board.build_generation([record()], AS_OF, history_records=[])
        store = Store()
        receipt = board.write_private_generation(generation, store.put, store.read_full)
        self.assertEqual(receipt["status"], "complete")
        audit = board.audit_private_readback(generation, store.read_full)
        self.assertTrue(audit["ok"])
        self.assertTrue(audit["page_ok"])
        self.assertFalse(audit["partial"])
        self.assertEqual(audit["read_back"], "full")
        self.assertFalse(audit["public_publish"])
        self.assertEqual(len(audit["report_sha256"]), 64)
        self.assertEqual(audit["report_digest"], audit["report_sha256"])
        self.assertNotIn("keys", audit)
        self.assertNotIn("proj:pr-board:", json.dumps(audit))
        self.assertEqual(audit["listed"], len(board.redis_documents(generation)))
        self.assertGreater(audit["page_count"], 1)
        self.assertEqual(len(audit["root_digest"]), 64)
        self.assertEqual(store.read_full(board.HEAD_KEY)["manifest_root"], audit["root_digest"])
        report_lines = []
        for key, mapping in board.redis_documents(generation):
            self.assertEqual(store.read_full(key), mapping)
            digest, length = board.canonical_hash_digest(mapping)
            self.assertNotIn(key, json.dumps(audit))
            report_lines.append((key, digest, length, "match"))
        self.assertEqual(audit["report_digest"], board._audit_report(report_lines)[0])
        self.assertEqual(store.read_full(board.HEAD_KEY)["generation"], generation["id"])
        with self.assertRaises(board.InvalidEvidence):
            board.canonical_hash_digest({"a\u0301": "x", "\u00e1": "y"})

        def missing(key):
            if ":action:" in key:
                return None
            return store.read_full(key)

        gap = board.audit_private_readback(generation, missing)
        self.assertFalse(gap["ok"])
        self.assertEqual(gap["read_back"], "unknown")
        self.assertFalse(gap["public_publish"])

        def preview(key):
            got = store.read_full(key)
            if ":action:" in key and isinstance(got, dict):
                got = dict(got)
                got["rows"] = got["rows"][:board.PREVIEW_CHARS] + "..."
            return got

        partial = board.audit_private_readback(generation, preview)
        self.assertFalse(partial["ok"])
        self.assertEqual(partial["read_back"], "unknown")
        self.assertFalse(partial["public_publish"])

        def broken(key):
            if ":closed:" in key:
                raise TimeoutError("synthetic read error")
            return store.read_full(key)

        erred = board.audit_private_readback(generation, broken)
        self.assertFalse(erred["ok"])
        self.assertEqual(erred["read_back"], "unknown")
        self.assertNotIn("synthetic", json.dumps(erred))
        with self.assertRaises(board.InvalidEvidence):
            board.audit_private_readback(generation, store.read_full, list_keys=lambda _prefix: list(store.data))

    def test_readback_mismatch_is_unknown_and_skips_the_public_file(self):
        store = Store()
        state = {"spoil": False}

        def put(key, mapping):
            result = store.put(key, mapping)
            if key == board.HEAD_KEY:
                state["spoil"] = True
            return result

        def read_full(key):
            if state["spoil"] and ":closed:" in key:
                return None
            return store.read_full(key)

        with tempfile.TemporaryDirectory() as tmp:
            public_path = os.path.join(tmp, "pr-board-public.json")
            code = board.main(
                ["--enable", "--as-of", AS_OF, "--public-out", public_path],
                read=lambda path: [], put=put, read_full=read_full, env={})
            self.assertEqual(code, 1)
            self.assertFalse(os.path.exists(public_path))
            self.assertTrue(any(":action:" in key for key in store.data))
            self.assertNotIn("next_action", json.dumps(store.data.get(board.HEAD_KEY)))

    def test_enrichment_adapter_does_not_invent_missing_evidence(self):
        invented = "Invented milestone from a private title"
        bare = dict(raw(41))
        rich = dict(raw(42))
        rows = {41: bare, 42: rich}
        missing = {
            "repo": "sfdc-24/conference", "number": 41, "title": invented, "body": "invent a task",
            "milestone": "unknown", "owner_actor": "cursor", "owner_source": "unassessed",
            "closure_actor": "aya", "closure_source": "",
            "closure": {"duplication": True, "rationale": "duplicate", "obligations_preserved": True,
                        "replacement": None, "evidence": ""},
            "task": {"state": "assessed", "kind": "issue", "number": 196, "repo": "sfdc-24/conference",
                     "evidence": "unknown", "work_id": "unknown"},
            "fix_url": "https://github.com/sfdc-24/conference/pull/41/files", "fix_evidence": None,
        }
        sourced = {
            "repo": "sfdc-24/conference", "number": 42, "milestone": "GATE-2",
            "owner_actor": "cursor", "owner_source": "okf:OWN-42",
            "closure_actor": "aya", "closure_source": "okf:CDR-42",
            "closure": {"duplication": True, "rationale": "duplicate", "replacement": "okf:REPL-42",
                        "obligations_preserved": True, "evidence": "okf:CLOSE-42"},
            "task": {"state": "assessed", "kind": "issue", "number": 196, "repo": "sfdc-24/conference",
                     "evidence": "okf:TASK-42"},
            "fix_url": "https://github.com/sfdc-24/conference/pull/42/files", "fix_evidence": "okf:FIX-42",
        }

        def read(path):
            if "state=closed" in path or "/events?" in path or "/reviews?" in path:
                return []
            match = re.search(r"[?&]page=(\d+)", path)
            page = int(match.group(1)) if match else 0
            if "sfdc-24/conference/pulls?" in path and page == 1:
                return [rows[number] for number in sorted(rows)]
            return []

        found = {item["number"]: item for item in board.attach_activity(
            board.list_open(read, repos=("sfdc-24/conference",)), read)}
        board.apply_enrichment(list(found.values()), [missing, sourced])
        self.assertEqual(found[41]["milestone"], "")
        self.assertEqual(found[41]["closure_case"]["evidence"], "unknown")
        self.assertEqual(found[41]["closure_case"]["replacement"], "unknown")
        self.assertEqual(found[41]["task"]["evidence"], "unknown")
        self.assertEqual(found[41]["fix_evidence"], "unknown")
        self.assertEqual(found[42]["milestone"], "GATE-2")
        self.assertEqual(found[42]["closure_case"]["evidence"], "okf:CLOSE-42")
        self.assertEqual(found[42]["task"]["evidence"], "okf:TASK-42")
        self.assertEqual(found[42]["fix_evidence"], "okf:FIX-42")
        acks = board.enrichment_acknowledgments([missing, sourced])
        self.assertEqual(sorted((row["number"], row["role"]) for row in acks),
                         [(42, "closure_driver"), (42, "implementation_owner")])
        generation = board.build_generation(list(found.values()), AS_OF, acknowledgments=acks, history_records=[])
        self.assertNotIn(invented, json.dumps(generation))
        action = {item["number"]: item["action"] for item in generation["items"]}
        self.assertNotEqual(action[41]["next_action"], "CLOSE")
        self.assertEqual(action[41]["links"]["work"], "unassessed")
        self.assertEqual(action[41]["links"]["fix"], "unassessed")
        self.assertEqual(action[41]["owner_source"], "unassessed")
        self.assertEqual(action[42]["next_action"], "CLOSE")
        self.assertEqual(action[42]["owner_source"], "okf:OWN-42")
        self.assertEqual(action[42]["closure_source"], "okf:CDR-42")
        self.assertEqual(action[42]["links"]["work"], "https://github.com/sfdc-24/conference/issues/196")
        self.assertEqual(action[42]["links"]["fix"], "https://github.com/sfdc-24/conference/pull/42/files")
        bare_item = next(item for item in generation["items"] if item["number"] == 41)
        self.assertEqual(bare_item["milestone"], "unassessed")

        def live(path):
            if "state=closed" in path or "/events?" in path or "/reviews?" in path:
                return []
            match = re.search(r"[?&]page=(\d+)", path)
            page = int(match.group(1)) if match else 0
            if "sfdc-24/conference/pulls?" in path and page == 1:
                return [raw(7)]
            return []

        receipt = board.run(AS_OF, live, enrichment=[sourced], repos=("sfdc-24/conference",), enabled_flag=True)
        self.assertEqual(receipt["status"], "projected_not_written")
        self.assertEqual(receipt["generation"]["items"][0]["milestone"], "unassessed")
        held = board.run(
            AS_OF, live, enrichment=[{
                "repo": "sfdc-24/conference", "number": 7, "milestone": "GATE-2",
                "owner_actor": "cursor", "owner_source": "okf:OWN-7",
            }], repos=("sfdc-24/conference",), enabled_flag=True)
        self.assertEqual(held["generation"]["items"][0]["milestone"], "GATE-2")
        self.assertEqual(held["generation"]["items"][0]["action"]["owner_source"], "okf:OWN-7")

    def test_action_consumer_only_advises(self):
        generation = board.build_generation([record(
            closure_case={"duplication": True, "obsolete": False, "rationale": "duplicate",
                          "replacement": "okf:REPL-1", "obligations_preserved": True, "evidence": "okf:CLOSE-1"},
        )], AS_OF, history_records=[])
        calls = []

        def effect(kind, row):
            calls.append((kind, row))

        local = board.consume_action(generation, effects=effect)
        self.assertEqual(calls, [])
        self.assertEqual(local["mode"], "advise")
        self.assertEqual(local["read_back"], "unknown")
        self.assertEqual(local["rows"], [])
        self.assertFalse(local["executes"])
        self.assertFalse(local["merges"])
        self.assertFalse(local["closes"])
        self.assertFalse(local["comments"])
        store = Store()
        written = board.write_private_generation(generation, store.put, store.read_full)
        self.assertEqual(written["status"], "complete")
        withheld = board.consume_action(generation, store.read_full, effects=effect, env={})
        self.assertEqual(calls, [])
        self.assertEqual(withheld["read_back"], "unknown")
        self.assertEqual(withheld["rows"], [])
        local = board.writer_receipt(generation, store.read_full)
        advised = board.consume_action(
            generation, store.read_full, effects=effect,
            backend_receipt=haudit_receipt(generation, local), env={board.VERIFY_FLAG: "1"})
        self.assertEqual(calls, [])
        self.assertEqual(advised["read_back"], "full")
        self.assertEqual(advised["rows"][0]["id"], "sfdc-24/conference#7")
        self.assertEqual(advised["rows"][0]["next_action"], "CLOSE")
        self.assertFalse(advised["merges"])
        self.assertFalse(advised["closes"])
        self.assertFalse(advised["comments"])

        def preview(key):
            got = store.read_full(key)
            if ":action:" in key and isinstance(got, dict):
                got = dict(got)
                got["rows"] = got["rows"][:board.PREVIEW_CHARS] + "..."
            return got

        unknown = board.consume_action(generation, preview, effects=effect)
        self.assertEqual(calls, [])
        self.assertEqual(unknown["read_back"], "unknown")
        self.assertEqual(unknown["rows"], [])
        self.assertFalse(unknown["executes"])
        bare = board.consume_action(board.build_generation([record()], AS_OF, history_records=[]), effects=effect)
        self.assertEqual(bare["rows"], [])
        self.assertEqual(bare["read_back"], "unknown")
        self.assertEqual(calls, [])

    def test_private_aggregates_are_absent_while_the_flag_is_off(self):
        self.assertFalse(board.private_aggregates_enabled(False, {}))
        self.assertFalse(board.private_aggregates_enabled(False, {"OPS_PR_BOARD_PRIVATE_AGGREGATES": "0"}))
        self.assertFalse(board.private_aggregates_enabled(False, {"OPS_PR_BOARD": "1"}))
        self.assertTrue(board.private_aggregates_enabled(False, {"OPS_PR_BOARD_PRIVATE_AGGREGATES": "1"}))
        self.assertTrue(board.private_aggregates_enabled(True, {}))
        generation = board.build_generation([
            record(events=[], reviews=[{
                "state": "APPROVED", "commit_id": HEAD, "submitted_at": "2026-10-07T18:00:00Z", "login": "aya"}]),
            record("sfdc-24/Blackboard", 9, events=[], reviews=[{
                "state": "APPROVED", "commit_id": HEAD, "submitted_at": "2026-10-08T14:00:00Z", "login": "grok"}]),
            record("sfdc-24/sfdc24-site", 3, events=[], reviews=[{
                "state": "APPROVED", "commit_id": HEAD, "submitted_at": "2026-10-07T18:00:00Z", "login": "aya"}]),
        ], AS_OF, history_records=[])
        public = board.public_snapshot(generation, enabled=True)
        encoded = json.dumps(public["turnaround"]["metrics"])
        self.assertNotIn('"conference"', encoded)
        self.assertNotIn('"Blackboard"', encoded)
        self.assertIn('"sfdc24-site"', encoded)
        self.assertEqual(public["rows"][0]["pr"], "sfdc24-site#3")
        self.assertNotIn("conference#", json.dumps(public["turnaround"]["rows"]))
        self.assertNotIn("Blackboard#", json.dumps(public["turnaround"]["rows"]))
        self.assertIn('"conference"', json.dumps(generation["turnaround_trend"]["metrics"]))
        authorized = board.public_snapshot(generation, enabled=True, private_aggregates=True)
        self.assertIn('"conference"', json.dumps(authorized["turnaround"]["metrics"]))
        self.assertIn('"Blackboard"', json.dumps(authorized["turnaround"]["metrics"]))
        off = board.public_snapshot(generation, enabled=False, private_aggregates=True)
        self.assertEqual(off["turnaround"], {"days": [], "metrics": {}, "rows": []})
        self.assertIn("var PUBLIC_PRIVATE_AGGREGATES = false;", (ROOT / "assets" / "ops-pr-board.js").read_text(encoding="utf-8"))

    def test_projected_run_does_not_publish_without_a_receipt(self):
        with tempfile.TemporaryDirectory() as tmp:
            public_path = os.path.join(tmp, "pr-board-public.json")
            code = board.main(
                ["--enable", "--as-of", AS_OF, "--public-out", public_path],
                read=lambda path: [], env={})
            self.assertEqual(code, 0)
            self.assertFalse(os.path.exists(public_path))
        receipt = board.run(AS_OF, lambda path: [], enabled_flag=True)
        self.assertEqual(receipt["status"], "projected_not_written")
        self.assertIs(receipt["public_publish"], False)
        self.assertEqual(receipt["read_back"], "unknown")
        self.assertFalse(receipt["wrote"])

    def test_unlisted_generation_key_is_ignored(self):
        generation = board.build_generation([record()], AS_OF, history_records=[])
        store = Store()
        written = board.write_private_generation(generation, store.put, store.read_full)
        self.assertEqual(written["status"], "complete")
        prefix = board.private_prefix(generation["id"])
        extra = prefix + "extra"
        store.data[extra] = {"audience": "private", "generation": generation["id"]}
        seen = []
        original = store.read_full

        def spy(key):
            seen.append(key)
            return original(key)

        receipt = board.writer_receipt(generation, spy)
        self.assertTrue(receipt["ok"])
        self.assertFalse(receipt["partial"])
        self.assertTrue(receipt["page_ok"])
        self.assertFalse(receipt["public_publish"])
        self.assertEqual(receipt["scope"], "generation")
        self.assertEqual(receipt["read_back"], "full")
        self.assertNotIn("keys", receipt)
        self.assertNotIn(extra, json.dumps(receipt))
        self.assertNotIn("proj:pr-board:", json.dumps(receipt))
        self.assertNotIn(extra, seen)
        self.assertIn(board.HEAD_KEY, seen)
        self.assertTrue(any(key.startswith(prefix + "manifest:") for key in seen))

    def test_deleted_head_blocks_action_consumption(self):
        generation = board.build_generation([record(
            closure_case={"duplication": True, "obsolete": False, "rationale": "duplicate",
                          "replacement": "okf:REPL-1", "obligations_preserved": True, "evidence": "okf:CLOSE-1"},
        )], AS_OF, history_records=[])
        store = Store()
        written = board.write_private_generation(generation, store.put, store.read_full)
        self.assertEqual(written["status"], "complete")
        del store.data[board.HEAD_KEY]
        seen = []
        original = store.read_full

        def spy(key):
            seen.append(key)
            return original(key)

        advice = board.consume_action(generation, spy, effects=lambda *_args: (_ for _ in ()).throw(AssertionError("effect")))
        self.assertEqual(advice["read_back"], "unknown")
        self.assertEqual(advice["rows"], [])
        self.assertFalse(advice["executes"])
        self.assertFalse(advice["merges"])
        self.assertFalse(advice["closes"])
        self.assertFalse(advice["comments"])
        self.assertEqual(seen, [])
        self.assertFalse(any(":action:" in key for key in seen))

    def test_private_review_does_not_move_the_public_reviewer_median(self):
        generation = board.build_generation([
            record("sfdc-24/conference", 7, events=[], reviews=[{
                "state": "APPROVED", "commit_id": HEAD, "submitted_at": "2026-10-07T18:00:00Z", "login": "aya"}]),
            record("sfdc-24/sfdc24-site", 3, events=[], reviews=[{
                "state": "APPROVED", "commit_id": HEAD, "submitted_at": "2026-10-07T20:00:00Z", "login": "aya"}]),
        ], AS_OF, history_records=[])
        mixed = generation["turnaround_trend"]["metrics"]["first_review"]["reviewer"]["Aya"]
        public_only = generation["public_turnaround_trend"]["metrics"]["first_review"]["reviewer"]["Aya"]
        self.assertEqual(mixed[4], "3 h")
        self.assertEqual(public_only[4], "4 h")
        public = board.public_snapshot(generation, enabled=True, private_aggregates=False)
        self.assertEqual(public["turnaround"]["metrics"]["first_review"]["reviewer"]["Aya"][4], "4 h")
        self.assertNotIn("conference", public["turnaround"]["metrics"]["first_review"]["repos"])
        self.assertNotEqual(public["turnaround"]["metrics"]["first_review"]["reviewer"]["Aya"][4], "2 h")
        authorized = board.public_snapshot(generation, enabled=True, private_aggregates=True)
        self.assertEqual(authorized["turnaround"]["metrics"]["first_review"]["reviewer"]["Aya"][4], "3 h")

    def test_generation_over_the_ceiling_is_refused_before_write(self):
        self.assertGreaterEqual(board.MAX_GENERATION_DOCUMENTS, 326)
        self.assertEqual(board.MAX_AUDIT_BATCH, 128)
        self.assertEqual(board.MANIFEST_PAGE_SIZE, 8)
        generation = board.build_generation([record()], AS_OF, history_records=[])
        self.assertGreater(len(board.redis_documents(generation)), 4)
        calls = []

        def put(key, mapping):
            calls.append(("put", key))
            return {"ok": True}

        def read_full(key):
            calls.append(("read", key))
            return None

        original = board.MAX_GENERATION_DOCUMENTS
        board.MAX_GENERATION_DOCUMENTS = 4
        try:
            with self.assertRaises(board.InvalidEvidence) as raised:
                board.write_private_generation(generation, put, read_full)
            self.assertIn("generation ceiling", str(raised.exception))
            self.assertEqual(calls, [])
        finally:
            board.MAX_GENERATION_DOCUMENTS = original

    def test_manifest_byte_bound_is_the_supported_maximum(self):
        self.assertEqual(board.MAX_MANIFEST_BYTES, 65536)
        self.assertEqual(board.MAX_GENERATION_DOCUMENTS, 474)
        under = board.build_generation(
            [record("sfdc-24/conference", number) for number in range(1, 234)],
            AS_OF, history_records=[])
        under_docs = board.redis_documents(under)
        self.assertEqual(len(under_docs), 474)
        under_flat, under_paged = board.manifest_lengths(under_docs)
        self.assertEqual(under_paged, 65400)
        self.assertEqual(under_flat, 64089)
        self.assertLessEqual(under_paged, 65536)
        store = Store()
        written = board.write_private_generation(under, store.put, store.read_full)
        self.assertEqual(written["status"], "complete")
        over = board.build_generation(
            [record("sfdc-24/conference", number) for number in range(1, 235)],
            AS_OF, history_records=[])
        over_docs = board.redis_documents(over)
        self.assertEqual(len(over_docs), 476)
        _over_flat, over_paged = board.manifest_lengths(over_docs)
        self.assertEqual(over_paged, 65671)
        self.assertGreater(over_paged, 65536)
        calls = []

        def put(key, mapping):
            calls.append(key)
            return {"ok": True}

        def read_full(key):
            calls.append(("read", key))
            return None

        with self.assertRaises(board.InvalidEvidence) as raised:
            board.write_private_generation(over, put, read_full)
        self.assertIn("65536", str(raised.exception))
        self.assertEqual(calls, [])
        edges = []

        def edge_put(key, mapping):
            edges.append(("put", key))
            return {"ok": True}

        def edge_read(key):
            edges.append(("read", key))
            return None

        original_lengths = board.manifest_lengths
        try:
            board.manifest_lengths = lambda documents: (65537, 64089)
            with self.assertRaises(board.InvalidEvidence) as raised_edge:
                board.write_private_generation(
                    board.build_generation([record()], AS_OF, history_records=[]),
                    edge_put, edge_read)
            self.assertIn("65536", str(raised_edge.exception))
            self.assertEqual(edges, [])
            board.manifest_lengths = lambda documents: (65536, 65536)
            edge_store = Store()
            passed = board.write_private_generation(
                board.build_generation([record()], AS_OF, history_records=[]),
                edge_store.put, edge_store.read_full)
            self.assertEqual(passed["status"], "complete")
        finally:
            board.manifest_lengths = original_lengths
        retired = board.build_generation(
            [record("sfdc-24/conference", number) for number in range(1, 253)],
            AS_OF, history_records=[])
        retired_docs = board.redis_documents(retired)
        self.assertEqual(len(retired_docs), 512)
        retired_flat, _retired_paged = board.manifest_lengths(retired_docs)
        self.assertEqual(retired_flat, 69238)
        self.assertGreater(retired_flat, 65536)

    def test_backend_receipt_is_required_to_publish_or_advise(self):
        def read(path):
            if "state=closed" in path or "/reviews?" in path or "/events?" in path:
                return []
            if path.startswith("repos/sfdc-24/conference/pulls?") and "page=1" in path:
                return [raw(7)]
            if "page=1" in path:
                return []
            return []

        store = Store()
        off = {}
        on = {board.VERIFY_FLAG: "1"}
        held = board.run(
            AS_OF, read, put=store.put, read_full=store.read_full, enabled_flag=True, env=off,
            repos=("sfdc-24/conference",))
        self.assertEqual(held["status"], "complete")
        self.assertFalse(held["ok"])
        self.assertFalse(held["public_publish"])
        self.assertEqual(held["read_back"], "unknown")
        local = board.writer_receipt(held["generation"], store.read_full)
        self.assertTrue(local["ok"])
        self.assertTrue(local["page_ok"])
        self.assertFalse(local["public_publish"])
        self.assertFalse(board.backend_receipt_accepts(None))
        self.assertFalse(board.backend_receipt_accepts(local))
        backend = haudit_receipt(held["generation"], local)
        self.assertTrue(board.backend_receipt_accepts(backend))
        os.environ.pop(board.VERIFY_FLAG, None)
        quiet = _FlagOffConn()
        refused = board.complete_receipt(
            quiet, _gov_acl(), "cursor", "pr-board", board.private_prefix(held["generation"]["id"]),
            "", "b64", held["generation"]["id"], "pair-off", board.HEAD_KEY)
        self.assertEqual(quiet.reads, 0)
        self.assertFalse(refused["ok"])
        self.assertTrue(refused.get("refused"))
        self.assertFalse(board.backend_receipt_accepts(refused))
        down = board.complete_receipt(
            _FlagOffConn(boom=True), _gov_acl(), "cursor", "pr-board",
            board.private_prefix(held["generation"]["id"]), "", "b64",
            held["generation"]["id"], "pair-off", board.HEAD_KEY)
        self.assertFalse(down["ok"])
        self.assertFalse(board.backend_receipt_accepts(down))
        flagged_off = board.consume_action(
            held["generation"], store.read_full, backend_receipt=refused, env=off)
        self.assertEqual(flagged_off["read_back"], "unknown")
        self.assertEqual(flagged_off["rows"], [])
        missing = board.consume_action(held["generation"], store.read_full, env=on)
        self.assertEqual(missing["read_back"], "unknown")
        self.assertEqual(missing["rows"], [])
        local_substitute = board.run(
            AS_OF, read, put=store.put, read_full=store.read_full, enabled_flag=True, env=on,
            repos=("sfdc-24/conference",), backend_receipt=local)
        self.assertEqual(local_substitute["status"], "replay")
        self.assertFalse(local_substitute["public_publish"])
        self.assertFalse(local_substitute["ok"])
        published = board.run(
            AS_OF, read, put=store.put, read_full=store.read_full, enabled_flag=True, env=off,
            repos=("sfdc-24/conference",), backend_receipt=backend)
        self.assertEqual(published["status"], "replay")
        self.assertTrue(published["ok"])
        self.assertTrue(published["page_ok"])
        self.assertTrue(published["public_publish"])
        self.assertEqual(published["read_back"], "full")
        still_off = board.run(
            AS_OF, read, put=store.put, read_full=store.read_full, enabled_flag=True,
            env={board.VERIFY_FLAG: "0"}, repos=("sfdc-24/conference",), backend_receipt=refused)
        self.assertFalse(still_off["public_publish"])
        self.assertFalse(still_off["ok"])
        no_receipt = board.run(
            AS_OF, read, put=store.put, read_full=store.read_full, enabled_flag=True, env=on,
            repos=("sfdc-24/conference",))
        self.assertFalse(no_receipt["public_publish"])
        self.assertFalse(no_receipt["ok"])
        ready = board.consume_action(
            held["generation"], store.read_full, backend_receipt=backend, env=off)
        self.assertEqual(ready["read_back"], "full")
        self.assertTrue(ready["rows"])
        self.assertFalse(ready["executes"])
        self.assertFalse(ready["merges"])
        self.assertFalse(ready["closes"])
        self.assertFalse(ready["comments"])

    def test_stale_326_receipt_is_refused_against_a_328_generation(self):
        store = Store()
        held = board.run(
            AS_OF, conference_read(159), put=store.put, read_full=store.read_full,
            enabled_flag=True, env={}, repos=("sfdc-24/conference",))
        self.assertEqual(held["status"], "complete")
        self.assertEqual(len(board.redis_documents(held["generation"])), 326)
        local = board.writer_receipt(held["generation"], store.read_full)
        receipt = haudit_receipt(held["generation"], local)
        self.assertTrue(board.backend_receipt_accepts(receipt))
        self.assertTrue(board._receipt_binds_current(held["generation"], receipt))
        published = board.run(
            AS_OF, conference_read(159), put=store.put, read_full=store.read_full,
            enabled_flag=True, env={}, repos=("sfdc-24/conference",), backend_receipt=receipt)
        self.assertEqual(published["status"], "replay")
        self.assertTrue(published["public_publish"])
        advice = board.consume_action(
            held["generation"], store.read_full, backend_receipt=receipt,
            effects=lambda *_args: (_ for _ in ()).throw(AssertionError("effect")))
        self.assertEqual(advice["read_back"], "full")
        self.assertEqual(len(advice["rows"]), 159)
        other = Store()
        moved = board.run(
            AS_OF, conference_read(160), put=other.put, read_full=other.read_full,
            enabled_flag=True, env={}, repos=("sfdc-24/conference",), backend_receipt=receipt)
        self.assertEqual(moved["status"], "complete")
        self.assertEqual(len(board.redis_documents(moved["generation"])), 328)
        self.assertNotEqual(moved["generation"]["id"], held["generation"]["id"])
        self.assertFalse(moved["public_publish"])
        self.assertFalse(moved["ok"])
        seen = []

        def spy(key):
            seen.append(key)
            return other.read_full(key)

        stale = board.consume_action(
            moved["generation"], spy, backend_receipt=receipt,
            effects=lambda *_args: (_ for _ in ()).throw(AssertionError("effect")))
        self.assertEqual(stale["read_back"], "unknown")
        self.assertEqual(stale["rows"], [])
        self.assertEqual(seen, [])
        self.assertFalse(stale["executes"])
        self.assertFalse(stale["merges"])
        self.assertFalse(stale["closes"])
        self.assertFalse(stale["comments"])

    def test_mutated_receipt_fields_are_refused_at_both_gates(self):
        store = Store()
        held = board.run(
            AS_OF, conference_read(1), put=store.put, read_full=store.read_full,
            enabled_flag=True, env={}, repos=("sfdc-24/conference",))
        self.assertEqual(held["status"], "complete")
        local = board.writer_receipt(held["generation"], store.read_full)
        receipt = haudit_receipt(held["generation"], local)
        self.assertTrue(board._receipt_binds_current(held["generation"], receipt))
        changes = {
            "generation": "ab" * 32,
            "manifest_root": "cd" * 32,
            "listed": receipt["listed"] + 1,
            "page_count": receipt["page_count"] + 1,
        }
        for field, value in changes.items():
            mutated = dict(receipt, **{field: value})
            self.assertFalse(board.backend_receipt_accepts(mutated), field)
            self.assertFalse(board._receipt_binds_current(held["generation"], mutated))
            published = board.run(
                AS_OF, conference_read(1), put=store.put, read_full=store.read_full,
                enabled_flag=True, env={}, repos=("sfdc-24/conference",), backend_receipt=mutated)
            self.assertEqual(published["status"], "replay")
            self.assertFalse(published["public_publish"], field)
            self.assertFalse(published["ok"], field)
            seen = []

            def spy(key, _seen=seen):
                _seen.append(key)
                return store.read_full(key)

            advice = board.consume_action(
                held["generation"], spy, backend_receipt=mutated,
                effects=lambda *_args: (_ for _ in ()).throw(AssertionError("effect")))
            self.assertEqual(advice["read_back"], "unknown", field)
            self.assertEqual(advice["rows"], [], field)
            self.assertEqual(seen, [], field)
            self.assertFalse(advice["executes"])
            self.assertFalse(advice["merges"])
            self.assertFalse(advice["closes"])
            self.assertFalse(advice["comments"])

    def test_repo_keys_match_the_governed_grammar(self):
        self.assertEqual(board.repo_key("sfdc-24/conference"), "sfdc-24:conference")
        self.assertEqual(board.repo_key("sfdc-24/Blackboard"), "sfdc-24:Blackboard")
        self.assertEqual(board.repo_key("sfdc-24/sfdc24-site"), "sfdc-24:sfdc24-site")
        self.assertEqual(board.VERIFIER_SHA, "ea85bffb45904d93bbaa2056ae29d73a5e3c50a9")
        self.assertIsNone(board.KEY_GRAMMAR.fullmatch("sfdc-24+conference"))
        self.assertTrue(board.KEY_GRAMMAR.fullmatch("sfdc-24:conference"))
        generation = board.build_generation([
            record("sfdc-24/conference", 7),
            record("sfdc-24/Blackboard", 3),
            record("sfdc-24/sfdc24-site", 5),
        ], AS_OF, history_records=[])
        store = Store()
        written = board.write_private_generation(generation, store.put, store.read_full)
        self.assertEqual(written["status"], "complete")
        self.assertTrue(any(key.endswith(":repo:sfdc-24:conference") for key in store.data))
        for key, mapping in store.data.items():
            self.assertTrue(board.KEY_GRAMMAR.fullmatch(key))
            self.assertNotIn("+", key)
            self.assertNotIn("/", key)
            for name, value in mapping.items():
                self.assertTrue(board.FIELD_GRAMMAR.fullmatch(name))
                self.assertIsInstance(value, str)

    def test_head_change_during_the_first_manifest_page_is_not_ok(self):
        generation = board.build_generation([record()], AS_OF, history_records=[])
        store = Store()
        written = board.write_private_generation(generation, store.put, store.read_full)
        self.assertEqual(written["status"], "complete")
        saved = dict(store.data[board.HEAD_KEY])
        seen = []
        original = store.read_full

        def spy(key):
            seen.append(key)
            if str(key).endswith(":manifest:0"):
                store.data[board.HEAD_KEY] = dict(saved, complete="0")
            return original(key)

        receipt = board.writer_receipt(generation, spy)
        self.assertFalse(receipt["ok"])
        self.assertFalse(receipt["public_publish"])
        self.assertEqual(receipt["read_back"], "unknown")
        self.assertFalse(any(":action:" in key or ":i:" in key or str(key).endswith(":manifest:1") for key in seen))
        store.data[board.HEAD_KEY] = dict(saved)
        seen = []

        def consume_spy(key):
            seen.append(key)
            if str(key).endswith(":manifest:0"):
                store.data[board.HEAD_KEY] = dict(saved, complete="0")
            return original(key)

        advice = board.consume_action(
            generation, consume_spy, effects=lambda *_args: (_ for _ in ()).throw(AssertionError("effect")))
        self.assertEqual(advice["read_back"], "unknown")
        self.assertEqual(advice["rows"], [])
        self.assertFalse(advice["executes"])
        self.assertFalse(advice["merges"])
        self.assertFalse(advice["closes"])
        self.assertFalse(advice["comments"])
        self.assertFalse(any(":action:" in key for key in seen))

    def test_public_route_rejects_the_private_generation_before_any_write(self):
        generation = board.build_generation(
            [record("sfdc-24/conference", 4242)], AS_OF, history_records=[])
        marker = "sfdc-24/conference#4242"
        self.assertIn(marker, json.dumps(generation))
        for via in ("public-sheet", "other"):
            encoded = []
            calls = []
            store = Store()

            def execute(conn, acl, principal, route, op, key, _field, raw, *_rest):
                calls.append((route, op, key, raw))
                store.data[key] = json.loads(base64.b64decode(raw))
                return {"ok": True}

            original = board.base64.b64encode

            def spy(payload):
                encoded.append(payload)
                return original(payload)

            board.base64.b64encode = spy
            try:
                put = board.governed_put(execute, None, {}, via=via)
                self.assertFalse(put.accepts_private)
                with self.assertRaises(board.InvalidEvidence) as raised:
                    board.write_private_generation(generation, put, store.read_full)
                self.assertIn("public route", str(raised.exception))
                with self.assertRaises(board.InvalidEvidence) as raised_again:
                    board.write_generation(generation, put, store.read_full)
                self.assertIn("public route", str(raised_again.exception))
            finally:
                board.base64.b64encode = original
            self.assertEqual(encoded, [])
            self.assertEqual(calls, [])
            self.assertEqual(store.data, {})
            self.assertNotIn("4242", json.dumps(calls))

    def test_private_out_under_data_is_refused(self):
        target = ROOT / "data" / "private-gen.json"
        self.assertFalse(target.exists())
        self.assertTrue(board.is_public_tree("data/private-gen.json"))
        self.assertTrue(board.is_public_tree(str(target)))
        try:
            code = board.main(
                ["--enable", "--as-of", AS_OF, "--out", "data/private-gen.json"],
                read=lambda path: [], env={})
            self.assertEqual(code, 1)
            self.assertFalse(target.exists())
        finally:
            if target.exists():
                target.unlink()

    def test_full_board_fixture_is_written_verified_and_published(self):
        records = [record("sfdc-24/conference", number) for number in range(1, 160)]
        generation = board.build_generation(records, AS_OF, history_records=[])
        documents = board.redis_documents(generation)
        self.assertEqual(len(documents), 326)
        flat_n, paged_n = board.manifest_lengths(documents)
        self.assertEqual(paged_n, 44928)
        self.assertEqual(flat_n, 44035)
        self.assertLessEqual(paged_n, board.MAX_MANIFEST_BYTES)
        rooted = board.paged_root(board._listed_entries(documents), board.MANIFEST_PAGE_SIZE)
        self.assertEqual(rooted["listed"], 326)
        self.assertEqual(rooted["page_count"], 41)
        self.assertGreater(rooted["root_len"], board.MAX_VALUE_BYTES)
        self.assertLessEqual(max(page["len"] for page in rooted["pages"]), board.MAX_VALUE_BYTES)
        store = Store()
        written = board.write_private_generation(generation, store.put, store.read_full)
        self.assertEqual(written["status"], "complete")
        self.assertFalse(written["public_written"])
        head = store.data[board.HEAD_KEY]
        self.assertEqual(head["listed"], "326")
        self.assertEqual(head["page_count"], "41")
        self.assertEqual(head["manifest_root"], rooted["root_sha256"])
        self.assertNotIn(rooted["root_text"], json.dumps(head))
        prefix = board.private_prefix(generation["id"])
        parsed_pages = []
        seen_keys = []
        for seq in range(41):
            page = store.data[prefix + "manifest:" + str(seq)]
            self.assertEqual(page["page"], str(seq))
            self.assertEqual(page["pages"], "41")
            encoded = json.dumps(page, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
            self.assertLessEqual(len(encoded.encode("utf-8")), 2048)
            rows = json.loads(page["entries"])
            if seq < 40:
                self.assertEqual(len(rows), 8)
            else:
                self.assertEqual(len(rows), 6)
            parsed_pages.append(rows)
            seen_keys.extend(row["key"] for row in rows)
        self.assertNotIn(prefix + "manifest:41", store.data)
        self.assertEqual(seen_keys, list(dict.fromkeys(seen_keys)))
        self.assertEqual(len(board._union_listed(parsed_pages)), 326)
        seen = []
        original = store.read_full

        def spy(key):
            seen.append(key)
            return original(key)

        receipt = board.writer_receipt(generation, spy)
        self.assertTrue(receipt["ok"])
        self.assertTrue(receipt["page_ok"])
        self.assertFalse(receipt["partial"])
        self.assertEqual(receipt["scope"], "generation")
        self.assertEqual(receipt["read_back"], "full")
        self.assertFalse(receipt["public_publish"])
        self.assertEqual(receipt["listed"], 326)
        self.assertEqual(receipt["page_count"], 41)
        self.assertEqual(receipt["root_digest"], rooted["root_sha256"])
        self.assertEqual(receipt["root_digest"], head["manifest_root"])
        self.assertEqual(len(receipt["report_digest"]), 64)
        self.assertNotIn("keys", receipt)
        self.assertNotIn("proj:pr-board:", json.dumps(receipt))
        self.assertEqual(seen[seen.index(prefix + "manifest:0") + 1], board.HEAD_KEY)
        document_run = 0
        longest = 0
        for key in seen:
            if key == board.HEAD_KEY or ":manifest:" in key:
                longest = max(longest, document_run)
                document_run = 0
            else:
                document_run += 1
        longest = max(longest, document_run)
        self.assertLessEqual(longest, board.MAX_AUDIT_BATCH)
        self.assertGreater(seen.count(board.HEAD_KEY), 1)
        public = board.public_snapshot(generation, enabled=True)
        self.assertEqual(public["rows"], [])
        self.assertTrue(public["enabled"])
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "pr-board-public.json")
            board.write_public_file(path, public)
            text = Path(path).read_text(encoding="utf-8")
            self.assertNotIn("conference#", text)
            self.assertNotIn("proj:pr-board:", text)
            self.assertNotIn(":manifest:", text)
            self.assertIn('"enabled": true', text)
        withheld = board.consume_action(generation, store.read_full, env={})
        self.assertEqual(withheld["read_back"], "unknown")
        self.assertEqual(withheld["rows"], [])
        advice = board.consume_action(
            generation, store.read_full, backend_receipt=haudit_receipt(generation, receipt),
            env={board.VERIFY_FLAG: "1"},
            effects=lambda *_args: (_ for _ in ()).throw(AssertionError("effect")))
        self.assertEqual(advice["read_back"], "full")
        self.assertFalse(advice["executes"])
        self.assertFalse(advice["merges"])
        self.assertFalse(advice["closes"])
        self.assertFalse(advice["comments"])
        self.assertEqual(len(advice["rows"]), 159)
        self.assertTrue(all(row["next_action"] != "CLOSE" for row in advice["rows"]))
        store.data[board.HEAD_KEY] = dict(head, advisory="0")
        spoiled = board.writer_receipt(generation, store.read_full)
        self.assertFalse(spoiled["ok"])
        self.assertFalse(spoiled["public_publish"])
        blocked = board.consume_action(generation, store.read_full)
        self.assertEqual(blocked["read_back"], "unknown")
        self.assertEqual(blocked["rows"], [])

    def test_exact_pair_fixture_uses_the_backend_complete_receipt(self):
        root = "09f6f05011d44c73ba16173297b80506070d2f7470f86b14eaf42203acb4c833"
        report = "786e44e7e7a82c9fd301d54c2e2d081c872608e4740332182dc2774691b6106a"
        import redis_gov
        self.assertEqual(inspect.getsourcelines(redis_gov.complete_receipt)[1], 361)
        self.assertEqual(inspect.getsourcelines(redis_gov.backend_receipt_accepts)[1], 394)
        self.assertIs(board.complete_receipt, redis_gov.complete_receipt)
        self.assertIs(board.backend_receipt_accepts, redis_gov.backend_receipt_accepts)
        records = [record("sfdc-24/conference", number) for number in range(1, 160)]
        generation = board.build_generation(records, AS_OF, history_records=[])
        documents = board.redis_documents(generation)
        self.assertEqual(len(documents), 326)
        specs = board._specs(board._listed_entries(documents))
        inventory = board.inventory_manifest(specs)
        self.assertEqual(len(inventory), 44928)
        self.assertEqual(len(board.manifest_body(specs)), 44035)
        store = Store()
        written = board.write_private_generation(generation, store.put, store.read_full)
        self.assertEqual(written["status"], "complete")
        local = board.writer_receipt(generation, store.read_full)
        self.assertTrue(local["page_ok"])
        self.assertTrue(local["ok"])
        self.assertFalse(local["public_publish"])
        self.assertFalse(board.backend_receipt_accepts(local))
        self.assertEqual(local["root_digest"], root)
        self.assertEqual(local["report_digest"], report)
        prefix = board.private_prefix(generation["id"])
        encoded = base64.b64encode(inventory).decode("ascii")
        os.environ.pop(board.VERIFY_FLAG, None)
        try:
            quiet = _FlagOffConn()
            refused = board.complete_receipt(
                quiet, _gov_acl(), "cursor", "pr-board", prefix, encoded, "b64",
                generation["id"], "pair-c23", board.HEAD_KEY)
            self.assertEqual(quiet.reads, 0)
            self.assertFalse(refused["ok"])
            self.assertFalse(board.backend_receipt_accepts(refused))
            self.assertFalse(board.backend_receipt_accepts(None))
            os.environ[board.VERIFY_FLAG] = "1"
            conn = GovRedis(store.data)
            receipt = board.complete_receipt(
                conn, _gov_acl(), "cursor", "pr-board", prefix, encoded, "b64",
                generation["id"], "pair-c23", board.HEAD_KEY)
            self.assertGreater(conn.reads, 0)
            self.assertTrue(conn.audits)
            self.assertTrue(receipt["ok"])
            self.assertTrue(receipt["page_ok"])
            self.assertFalse(receipt["partial"])
            self.assertFalse(receipt["moved"])
            self.assertFalse(receipt["timeout"])
            self.assertTrue(receipt["coverage"]["covered"])
            self.assertEqual(receipt["listed"], 326)
            self.assertEqual(receipt["page_count"], 41)
            self.assertEqual(receipt["manifest_root"], root)
            self.assertEqual(receipt["head_manifest_root"], root)
            self.assertEqual(receipt["digest"], report)
            self.assertEqual(receipt["head_generation"], generation["id"])
            self.assertTrue(board.backend_receipt_accepts(receipt))
            self.assertNotIn("proj:pr-board:", json.dumps(receipt))
            one_page = json.dumps(
                {"pages": [json.loads(inventory.decode("utf-8"))["pages"][0]]},
                sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
            page = board.complete_receipt(
                GovRedis(store.data), _gov_acl(), "cursor", "pr-board", prefix,
                base64.b64encode(one_page).decode("ascii"), "b64",
                generation["id"], "pair-c23-page", board.HEAD_KEY)
            self.assertTrue(page["page_ok"])
            self.assertFalse(page["ok"])
            self.assertFalse(board.backend_receipt_accepts(page))
        finally:
            os.environ.pop(board.VERIFY_FLAG, None)
        public = board.public_snapshot(generation, enabled=True)
        self.assertTrue(public["enabled"])
        self.assertEqual(public["rows"], [])
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "pr-board-public.json")
            board.write_public_file(path, public)
            text = Path(path).read_text(encoding="utf-8")
            self.assertNotIn("conference#", text)
            self.assertNotIn("proj:pr-board:", text)
        withheld = board.consume_action(generation, store.read_full, backend_receipt=local)
        self.assertEqual(withheld["read_back"], "unknown")
        self.assertEqual(withheld["rows"], [])
        advice = board.consume_action(
            generation, store.read_full, backend_receipt=receipt,
            effects=lambda *_args: (_ for _ in ()).throw(AssertionError("effect")))
        self.assertEqual(advice["read_back"], "full")
        self.assertEqual(len(advice["rows"]), 159)
        self.assertTrue(all(row["next_action"] != "CLOSE" for row in advice["rows"]))
        self.assertFalse(advice["executes"])
        self.assertFalse(advice["merges"])
        self.assertFalse(advice["closes"])
        self.assertFalse(advice["comments"])

    def test_vendored_receipt_rejects_malformed_fields_at_both_site_gates(self):
        generation = board.build_generation(
            [record("sfdc-24/conference", number) for number in range(1, 11)],
            AS_OF, history_records=[])
        store = Store()
        self.assertEqual(board.write_private_generation(generation, store.put, store.read_full)["status"],
                         "complete")
        local = board.writer_receipt(generation, store.read_full)
        receipt = haudit_receipt(generation, local)
        self.assertTrue(board.backend_receipt_accepts(receipt))
        self.assertTrue(board._receipt_binds_current(generation, receipt))
        changes = (
            ("coverage", "bad"), ("coverage", []), ("coverage", None),
            ("manifest_root", 1), ("head_manifest_root", []),
            ("pages", "bad"), ("page_count", "bad"), ("listed", "bad"),
            ("length", "bad"), ("ok", 1), ("partial", 0),
            ("coverage.covered", 1), ("coverage.matched", "bad"),
            ("coverage.seen", local["listed"] - 1),
        )
        for field, value in changes:
            damaged = json.loads(json.dumps(receipt))
            if field.startswith("coverage."):
                damaged["coverage"][field.split(".", 1)[1]] = value
            else:
                damaged[field] = value
            with self.subTest(field=field, value=value):
                self.assertIs(board.backend_receipt_accepts(damaged), False)
                self.assertIs(board._receipt_binds_current(generation, damaged), False)
                self.assertEqual(board.consume_action(
                    generation, store.read_full, backend_receipt=damaged)["read_back"], "unknown")

    def test_vendored_verifier_keeps_first_batch_watched_through_final_exec(self):
        class WatchError(Exception):
            pass

        class WatchedPipe(_GovPipe):
            def __init__(self, conn):
                super().__init__(conn)
                self.watched = {}
                self.resets = 0

            def watch(self, *keys):
                for key in keys:
                    self.watched[key] = self.conn.versions.get(key, 0)
                return True

            def execute(self, raise_on_error=False):
                self.conn.final_watches.append(set(self.watched))
                if any(self.conn.versions.get(key, 0) != version
                       for key, version in self.watched.items()):
                    raise WatchError("a listed document changed")
                return super().execute(raise_on_error=raise_on_error)

            def reset(self):
                self.resets += 1
                self.watched = {}
                super().reset()

        class WatchedConn(GovRedis):
            def __init__(self, data, names, first):
                super().__init__(data)
                self.names = names
                self.first = first
                self.versions = {}
                self.pipes = []
                self.final_watches = []
                self.documents_read = 0

            def pipeline(self, transaction=True):
                pipe = WatchedPipe(self)
                self.pipes.append(pipe)
                return pipe

            def hgetall(self, key):
                if key in self.names:
                    self.documents_read += 1
                    if self.documents_read == 129:
                        self.data[self.first]["n"] = "changed-after-first-batch"
                        self.versions[self.first] = self.versions.get(self.first, 0) + 1
                return super().hgetall(key)

        generation_id = "a" * 64
        prefix = board.private_prefix(generation_id)
        documents = [(prefix + "k%03d" % number, {"n": str(number)})
                     for number in range(129)]
        entries = board._listed_entries(documents)
        specs = board._specs(entries)
        rooted = board.paged_root(entries, board.MANIFEST_PAGE_SIZE)
        data = dict(documents)
        data[board.HEAD_KEY] = {
            "generation": generation_id, "manifest_root": rooted["root_sha256"],
            "page_count": str(rooted["page_count"]), "listed": "129",
        }
        names = set(specs)
        first = sorted(names)[0]
        conn = WatchedConn(data, names, first)
        encoded = base64.b64encode(board.inventory_manifest(specs)).decode("ascii")
        os.environ[board.VERIFY_FLAG] = "1"
        try:
            receipt = board.complete_receipt(
                conn, _gov_acl(), "cursor", "pr-board", prefix, encoded, "b64",
                generation_id, "site-race-129", board.HEAD_KEY)
        finally:
            os.environ.pop(board.VERIFY_FLAG, None)
        self.assertEqual(conn.documents_read, 129)
        self.assertFalse(receipt["ok"])
        self.assertTrue(receipt["moved"])
        self.assertFalse(board.backend_receipt_accepts(receipt))
        self.assertEqual(len(conn.final_watches), 1)
        self.assertEqual(len(conn.final_watches[0]), 130)
        self.assertIn(first, conn.final_watches[0])
        self.assertTrue(all(pipe.resets == 1 and not pipe.watched for pipe in conn.pipes))

    def test_shared_contract_cross_check_vector(self):
        vector = board.shared_contract_vector()
        self.assertEqual(vector["generation_id"], "0" * 64)
        self.assertEqual(vector["canonical"]["a"]["text"], '{"x":"1"}')
        self.assertEqual(vector["canonical"]["b"]["text"], '{"y":"\u00e9"}')
        self.assertEqual(vector["canonical"]["b"]["text"].encode("utf-8"), b'{"y":"\xc3\xa9"}')
        specs = {}
        for key, text in (("a", '{"x":"1"}'), ("b", '{"y":"\u00e9"}')):
            raw = text.encode("utf-8")
            digest = hashlib.sha256(raw).hexdigest()
            self.assertEqual(vector["canonical"][key]["sha256"], digest)
            self.assertEqual(vector["canonical"][key]["len"], len(raw))
            specs[key] = {"len": len(raw), "sha256": digest}
        manifest = json.dumps({"keys": specs}, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        self.assertEqual(vector["manifest_text"].encode("utf-8"), manifest)
        self.assertEqual(vector["manifest_sha256"], hashlib.sha256(manifest).hexdigest())
        self.assertEqual(vector["manifest_len"], len(manifest))
        report = "\n".join(
            "%s\t%s\t%d" % (key, specs[key]["sha256"], specs[key]["len"]) for key in ("a", "b")).encode("utf-8")
        self.assertEqual(vector["report_text"].encode("utf-8"), report)
        self.assertEqual(vector["report_sha256"], hashlib.sha256(report).hexdigest())
        self.assertEqual(vector["report_len"], len(report))
        self.assertNotIn("head", vector["report_text"])
        self.assertNotIn("\tmatch", vector["report_text"])
        self.assertNotIn(vector["generation_id"], vector["manifest_text"])
        self.assertNotIn(vector["generation_id"], vector["report_text"])
        self.assertEqual(vector["paging"], "paged")
        self.assertEqual(vector["page_size"], 8)
        self.assertEqual(vector["page_count"], 1)
        entries = [(key, specs[key]["sha256"], specs[key]["len"]) for key in ("a", "b")]
        page_text = json.dumps(
            [{"key": key, "len": specs[key]["len"], "sha256": specs[key]["sha256"]} for key in ("a", "b")],
            sort_keys=True, separators=(",", ":"), ensure_ascii=False)
        page_raw = page_text.encode("utf-8")
        page_sha = hashlib.sha256(page_raw).hexdigest()
        self.assertEqual(vector["pages"][0]["text"], page_text)
        self.assertEqual(vector["pages"][0]["sha256"], page_sha)
        root = json.dumps(
            {"listed": 2, "page_count": 1, "pages": [page_sha]},
            sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        self.assertEqual(vector["root_text"].encode("utf-8"), root)
        self.assertEqual(vector["root_sha256"], hashlib.sha256(root).hexdigest())
        self.assertEqual(vector["root_len"], len(root))
        self.assertNotIn(vector["generation_id"], vector["root_text"])
        two = vector["two_page"]
        self.assertEqual(two["page_count"], 2)
        self.assertEqual(two["listed"], 2)
        page_digests = []
        for key in ("a", "b"):
            one = json.dumps(
                [{"key": key, "len": specs[key]["len"], "sha256": specs[key]["sha256"]}],
                sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
            self.assertEqual(two["pages"][len(page_digests)]["text"].encode("utf-8"), one)
            page_digests.append(hashlib.sha256(one).hexdigest())
        two_root = json.dumps(
            {"listed": 2, "page_count": 2, "pages": page_digests},
            sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        self.assertEqual(two["root_text"].encode("utf-8"), two_root)
        self.assertEqual(two["root_sha256"], hashlib.sha256(two_root).hexdigest())
        self.assertNotEqual(two["root_sha256"], vector["root_sha256"])
        self.assertEqual(vector["manifest_sha256"], hashlib.sha256(manifest).hexdigest())
        self.assertEqual(vector["report_sha256"], hashlib.sha256(report).hexdigest())
        only_a = board.paged_root([entries[0]], 1)
        only_b = board.paged_root([entries[1]], 1)
        self.assertNotEqual(only_a["root_sha256"], only_b["root_sha256"])
        pinned = board.build_generation([record()], AS_OF, history_records=[])
        pinned_store = Store()
        self.assertEqual(
            board.write_private_generation(pinned, pinned_store.put, pinned_store.read_full)["status"],
            "complete")
        full = board.writer_receipt(pinned, pinned_store.read_full)
        self.assertTrue(full["page_ok"])
        self.assertTrue(full["ok"])
        self.assertFalse(full["public_publish"])
        one_page = board.writer_receipt(pinned, pinned_store.read_full, page=0)
        self.assertTrue(one_page["page_ok"])
        self.assertFalse(one_page["ok"])
        self.assertEqual(one_page["read_back"], "page")

    def test_two_manifest_roots_do_not_both_pass(self):
        generation = board.build_generation([record()], AS_OF, history_records=[])
        store = Store()
        written = board.write_private_generation(generation, store.put, store.read_full)
        self.assertEqual(written["status"], "complete")
        head = store.data[board.HEAD_KEY]
        self.assertEqual(len(head["manifest_root"]), 64)
        other = board.paged_root([("a", "ab" * 32, 9)], 1)
        self.assertNotEqual(other["root_sha256"], head["manifest_root"])
        seen = []
        original = store.read_full

        def spy(key):
            seen.append(key)
            return original(key)

        store.data[board.HEAD_KEY] = dict(head, manifest_root=other["root_sha256"])
        receipt = board.writer_receipt(generation, spy)
        self.assertFalse(receipt["ok"])
        self.assertFalse(receipt["page_ok"])
        self.assertFalse(receipt["public_publish"])
        self.assertEqual(seen, [board.HEAD_KEY])
        self.assertNotIn("proj:pr-board:", json.dumps(receipt))

    def test_one_page_is_not_a_full_generation_pass(self):
        generation = board.build_generation([record()], AS_OF, history_records=[])
        store = Store()
        written = board.write_private_generation(generation, store.put, store.read_full)
        self.assertEqual(written["status"], "complete")
        seen = []
        original = store.read_full

        def spy(key):
            seen.append(key)
            return original(key)

        page = board.writer_receipt(generation, spy, page=0)
        self.assertTrue(page["page_ok"])
        self.assertFalse(page["ok"])
        self.assertEqual(page["scope"], "page")
        self.assertFalse(page["public_publish"])
        self.assertEqual(page["read_back"], "page")
        self.assertNotIn("proj:pr-board:", json.dumps(page))
        self.assertTrue(any(key.endswith(":manifest:0") for key in seen))
        self.assertFalse(any(":manifest:1" in key or ":action:" in key or ":i:" in key for key in seen))
        prefix = board.private_prefix(generation["id"])
        del store.data[prefix + "manifest:1"]
        gap = board.writer_receipt(generation, store.read_full)
        self.assertFalse(gap["ok"])
        self.assertFalse(gap["page_ok"])
        self.assertFalse(gap["public_publish"])
        with self.assertRaises(board.InvalidEvidence):
            board._union_listed([[{"key": "a", "len": 1, "sha256": "ab" * 32}], None])
        with self.assertRaises(board.InvalidEvidence):
            board._union_listed([
                [{"key": "a", "len": 1, "sha256": "ab" * 32}],
                [{"key": "a", "len": 1, "sha256": "cd" * 32}],
            ])

    def test_head_and_root_must_stay_unchanged_across_the_reads(self):
        generation = board.build_generation([record()], AS_OF, history_records=[])
        store = Store()
        written = board.write_private_generation(generation, store.put, store.read_full)
        self.assertEqual(written["status"], "complete")
        calls = {"head": 0}
        original = store.read_full

        def spy(key):
            if key == board.HEAD_KEY:
                calls["head"] += 1
                if calls["head"] > 1:
                    changed = dict(original(key))
                    changed["manifest_root"] = "0" * 64
                    return changed
            return original(key)

        receipt = board.writer_receipt(generation, spy)
        self.assertFalse(receipt["ok"])
        self.assertFalse(receipt["public_publish"])
        self.assertGreater(calls["head"], 1)

    def test_oversize_document_is_refused_before_put(self):
        generation = board.build_generation([record()], AS_OF, history_records=[])
        calls = []

        def put(key, mapping):
            calls.append(key)
            return {"ok": True}

        def read_full(key):
            return None

        huge = {"blob": "x" * 2048, "witness": "readback-" + ("0" * 220)}
        encoded = json.dumps(huge, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
        self.assertGreater(len(encoded.encode("utf-8")), 2048)
        with self.assertRaises(board.InvalidEvidence) as raised:
            board.write_generation(
                generation, put, read_full,
                extra_documents=[(board.private_prefix(generation["id"]) + "extra", huge)])
        self.assertIn("2048", str(raised.exception))
        self.assertEqual(calls, [])

    def test_public_summary_omits_redis_key_names(self):
        generation = board.build_generation([
            record("sfdc-24/sfdc24-site", 3, events=[], reviews=[{
                "state": "APPROVED", "commit_id": HEAD, "submitted_at": "2026-10-07T18:00:00Z", "login": "aya"}]),
        ], AS_OF, history_records=[])
        public = board.public_snapshot(generation, enabled=True)
        text = json.dumps(public)
        self.assertNotIn("proj:pr-board:", text)
        self.assertNotIn(":manifest:", text)
        self.assertNotIn("sfdc-24+sfdc24-site", text)
        self.assertNotIn("sfdc-24:sfdc24-site", text)
        page = (ROOT / "assets" / "ops-pr-board.js").read_text(encoding="utf-8")
        shipped = (ROOT / "data" / "pr-board-public.json").read_text(encoding="utf-8")
        self.assertNotIn("proj:pr-board:", page)
        self.assertNotIn("proj:pr-board:", shipped)
        self.assertIn('"enabled": false', shipped)
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "pr-board-public.json")
            leaked = dict(public, rows=[{"pr": "proj:pr-board:v1:g:abcd:i:0"}])
            with self.assertRaises(board.InvalidEvidence):
                board.write_public_file(path, leaked)
            self.assertFalse(os.path.exists(path))

    def _action(self, row):
        return board.build_generation([row], AS_OF)["items"][0]


if __name__ == "__main__":
    unittest.main()
