"""Synthetic proof adapter. No live GitHub call and no live Redis call."""
import importlib.util
import io
import os
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
spec = importlib.util.spec_from_file_location("pr_board_adapter", ROOT / "tools/pr_board_adapter.py")
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)
import ops_pr_board as board  # noqa: E402
import pr_board_github_capability as live  # noqa: E402
import redis_gov  # noqa: E402

AS_OF = "2026-10-11T21:00:00Z"
HEAD = "a" * 40
BASE = "c" * 40
CREATED = "2026-10-07T16:00:00Z"


def raw(number):
    return {
        "number": number, "state": "open", "draft": False, "created_at": CREATED,
        "updated_at": "2026-10-11T20:59:00Z", "title": "Launch plan",
        "body": "notes", "head": {"sha": HEAD, "ref": "cursor/pr-board"},
        "base": {"sha": BASE}, "user": {"login": "sfdc-24"},
        "assignees": [{"login": "cursor"}], "requested_reviewers": [],
        "labels": [{"name": "security"}],
    }


def github_read(path):
    if "state=closed" in path or "/reviews?" in path or "/events?" in path:
        return []
    if path.startswith("repos/sfdc-24/conference/pulls?") and "page=1" in path:
        return [raw(1), raw(2), raw(3)]
    if "page=" in path:
        return []
    raise AssertionError(path)


class SyntheticProbe:
    def __init__(self, facts=None, pulls=None, boom=False):
        self.facts = facts if facts is not None else {
            "type": "installation",
            "can_write": False,
            "repos": list(board.REPOS),
        }
        self._pulls = pulls
        self.boom = boom
        self.pull_calls = []

    def token_facts(self):
        if self.boom:
            raise RuntimeError("synthetic probe failed")
        return self.facts

    def pulls(self, repo):
        self.pull_calls.append(repo)
        if self._pulls is not None:
            return self._pulls(repo)
        return {"status": 200, "body": []}


def acl():
    return {
        "readable": True,
        "principals": {"cursor": {"read": ["proj:"], "write": ["proj:"]}},
        "aliases": {},
        "ttl_seconds": {},
        "max_value_bytes": 2048,
        "digest": "",
    }


class SpyConn:
    def __init__(self):
        self.commands = []

    def _touch(self, name, args):
        self.commands.append((name, args))

    def type(self, key):
        self._touch("type", (key,))
        return "none"

    def hget(self, key, field):
        self._touch("hget", (key, field))
        return None

    def hgetall(self, key):
        self._touch("hgetall", (key,))
        return {}

    def hlen(self, key):
        self._touch("hlen", (key,))
        return 0

    def hkeys(self, key):
        self._touch("hkeys", (key,))
        return []

    def hstrlen(self, key, field):
        self._touch("hstrlen", (key, field))
        return 0

    def xadd(self, stream, fields, maxlen=None, approximate=None):
        self._touch("xadd", (stream,))
        return "1-1"

    def pipeline(self, transaction=True):
        self._touch("pipeline", ())
        return SpyPipe(self)


class SpyPipe:
    def __init__(self, conn):
        self.conn = conn
        self.queued = False
        self.ops = []

    def watch(self, *keys):
        self.conn._touch("watch", keys)

    def reset(self):
        self.conn._touch("reset", ())
        self.queued = False
        self.ops = []

    def multi(self):
        self.conn._touch("multi", ())
        self.queued = True

    def _direct(self, name, args):
        self.conn._touch(name, args)
        if name == "type":
            return "none"
        if name == "hgetall":
            return {}
        if name == "hlen":
            return 0
        if name == "hkeys":
            return []
        if name == "hstrlen":
            return 0
        return None

    def type(self, key):
        return self._direct("type", (key,))

    def hget(self, key, field):
        return self._direct("hget", (key, field))

    def hlen(self, key):
        return self._direct("hlen", (key,))

    def hkeys(self, key):
        return self._direct("hkeys", (key,))

    def hstrlen(self, key, field):
        return self._direct("hstrlen", (key, field))

    def hgetall(self, key):
        return self._direct("hgetall", (key,))

    def execute(self, raise_on_error=False):
        self.conn._touch("execute", ())
        return []


class GovRedis:
    def __init__(self, data):
        self.data = {key: dict(value) for key, value in data.items()}
        self.commands = []
        self.audits = []

    def _touch(self, name, key):
        self.commands.append((name, key))

    def type(self, key):
        self._touch("type", key)
        return "hash" if key in self.data else "none"

    def hget(self, key, field):
        self._touch("hget", key)
        return (self.data.get(key) or {}).get(field)

    def hlen(self, key):
        self._touch("hlen", key)
        return len(self.data.get(key) or {})

    def hkeys(self, key):
        self._touch("hkeys", key)
        return list((self.data.get(key) or {}).keys())

    def hstrlen(self, key, field):
        self._touch("hstrlen", key)
        value = (self.data.get(key) or {}).get(field, "")
        return len(str(value).encode("utf-8"))

    def hgetall(self, key):
        self._touch("hgetall", key)
        return dict(self.data.get(key) or {})

    def xadd(self, stream, fields, maxlen=None, approximate=None):
        self._touch("xadd", stream)
        self.audits.append(stream)
        return "1-1"

    def pipeline(self, transaction=True):
        self._touch("pipeline", "")
        return _GovPipe(self)


class _GovPipe:
    def __init__(self, conn):
        self.conn = conn
        self.queued = False
        self.ops = []

    def watch(self, *keys):
        for key in keys:
            self.conn._touch("watch", key)
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


class Memory:
    def __init__(self):
        self.data = {}
        self.calls = []

    def put(self, key, mapping):
        self.calls.append(("put", key))
        self.data[key] = dict(mapping)
        return {"ok": True, "op": "hput", "key": key}

    def read_full(self, key):
        self.calls.append(("read", key))
        got = self.data.get(key)
        return None if got is None else dict(got)


class AdapterTests(unittest.TestCase):
    def test_help_lists_proof_and_not_a_production_mode(self):
        buf = io.StringIO()
        err = io.StringIO()
        stdout, stderr = sys.stdout, sys.stderr
        sys.stdout, sys.stderr = buf, err
        try:
            code = adapter.main(["--help"])
        finally:
            sys.stdout, sys.stderr = stdout, stderr
        text = buf.getvalue() + err.getvalue()
        self.assertEqual(code, 0)
        self.assertIn("--mode {proof}", text)
        self.assertNotIn("--mode production", text)
        self.assertNotIn("{proof,production}", text)

    def test_production_mode_argument_exits_before_a_client(self):
        calls = []

        def factory():
            calls.append("redis")

        code = adapter.main(
            ["--mode", "production", "--as-of", AS_OF, "--write"],
            probe=SyntheticProbe(), redis_factory=factory, read=github_read,
            put=lambda *_: calls.append("put"), read_full=lambda *_: calls.append("read"),
            acl=acl())
        self.assertEqual(code, 2)
        self.assertEqual(calls, [])

    def test_malformed_as_of_exits_2(self):
        calls = []
        code = adapter.main(
            ["--mode", "proof", "--as-of", "yesterday", "--preflight-only"],
            probe=SyntheticProbe(), redis_factory=lambda: calls.append("redis"))
        self.assertEqual(code, 2)
        self.assertEqual(calls, [])

    def test_default_run_stops_on_unverified_live_capability_before_redis(self):
        calls = []
        code = adapter.main(
            ["--mode", "proof", "--as-of", AS_OF, "--write"],
            redis_factory=lambda: calls.append("redis"),
            read=github_read, put=Memory().put, read_full=Memory().read_full, acl=acl())
        self.assertEqual(code, 3)
        self.assertEqual(calls, [])

    def test_live_interface_methods_are_not_implemented(self):
        client = live.LiveReadOnlyGitHub()
        result = client.assess()
        self.assertFalse(result["ok"])
        self.assertFalse(result["network"])
        self.assertIn("unverified", result["reason"])
        for method in (client.token_type, client.scopes):
            with self.assertRaises(live.LiveCapabilityUnavailable):
                method()
        with self.assertRaises(live.LiveCapabilityUnavailable):
            client.list_pulls("sfdc-24/conference")

    def test_synthetic_token_facts_accept_installation_shape(self):
        result = adapter.assess_token_facts(SyntheticProbe())
        self.assertTrue(result["ok"])
        self.assertFalse(result["network"])
        fine = SyntheticProbe(facts={
            "type": "fine_grained", "can_write": False, "repos": list(board.REPOS),
        })
        self.assertTrue(adapter.assess_token_facts(fine)["ok"])

    def test_synthetic_token_facts_refuse_classic_shape(self):
        probe = SyntheticProbe(facts={
            "type": "classic", "can_write": False, "repos": list(board.REPOS),
        })
        result = adapter.assess_token_facts(probe)
        self.assertFalse(result["ok"])
        self.assertEqual(probe.pull_calls, [])

    def test_synthetic_token_facts_refuse_write_capability(self):
        probe = SyntheticProbe(facts={
            "type": "installation", "can_write": True, "repos": list(board.REPOS),
        })
        self.assertFalse(adapter.assess_token_facts(probe)["ok"])
        self.assertEqual(probe.pull_calls, [])

    def test_synthetic_token_facts_refuse_extra_repository(self):
        probe = SyntheticProbe(facts={
            "type": "installation", "can_write": False,
            "repos": list(board.REPOS) + ["sfdc-24/other"],
        })
        self.assertFalse(adapter.assess_token_facts(probe)["ok"])
        self.assertEqual(probe.pull_calls, [])

    def test_synthetic_token_facts_refuse_missing_repository(self):
        probe = SyntheticProbe(facts={
            "type": "installation", "can_write": False, "repos": ["sfdc-24/conference"],
        })
        self.assertFalse(adapter.assess_token_facts(probe)["ok"])
        self.assertEqual(probe.pull_calls, [])

    def test_synthetic_token_facts_refuse_http_403(self):
        def pulls(repo):
            if repo == "sfdc-24/Blackboard":
                return {"status": 403, "body": []}
            return {"status": 200, "body": []}

        self.assertFalse(adapter.assess_token_facts(SyntheticProbe(pulls=pulls))["ok"])

    def test_synthetic_token_facts_refuse_when_probe_raises(self):
        self.assertFalse(adapter.assess_token_facts(SyntheticProbe(boom=True))["ok"])

    def test_preflight_only_does_not_construct_redis(self):
        calls = []
        code = adapter.main(
            ["--mode", "proof", "--as-of", AS_OF, "--preflight-only"],
            probe=SyntheticProbe(), redis_factory=lambda: calls.append("redis"))
        self.assertEqual(code, 0)
        self.assertEqual(calls, [])

    def test_failed_synthetic_facts_do_not_construct_redis(self):
        calls = []
        probe = SyntheticProbe(facts={
            "type": "classic", "can_write": False, "repos": list(board.REPOS),
        })
        code = adapter.main(
            ["--mode", "proof", "--as-of", AS_OF, "--write"],
            probe=probe, redis_factory=lambda: calls.append("redis"),
            read=github_read, put=Memory().put, read_full=Memory().read_full, acl=acl())
        self.assertEqual(code, 3)
        self.assertEqual(calls, [])
        self.assertEqual(probe.pull_calls, [])

    def test_forbidden_key_commands_perform_no_io(self):
        spy = SpyConn()
        guarded = adapter.GuardedRedis(spy)
        forbidden = [
            lambda: guarded.type(board.HEAD_KEY),
            lambda: guarded.hgetall(board.HEAD_KEY),
            lambda: guarded.xadd(board.NAMESPACE + "g:abcd", {"a": "b"}),
            lambda: guarded.pipeline().watch(board.HEAD_KEY),
            lambda: guarded.pipeline().type(board.HEAD_KEY),
            lambda: guarded.pipeline().hgetall(board.HEAD_KEY),
        ]
        for call in forbidden:
            with self.assertRaises(board.InvalidEvidence):
                call()
        self.assertEqual(spy.commands, [])

    def test_unlisted_commands_and_hidden_keys_perform_no_io(self):
        spy = SpyConn()
        guarded = adapter.GuardedRedis(spy)
        refused = [
            lambda: guarded.flushall(),
            lambda: guarded.ping(),
            lambda: guarded.get(key=board.HEAD_KEY),
            lambda: guarded.type(b"proj:pr-board-proof:v1:head"),
            lambda: guarded.hgetall(**{"key": board.PROOF_HEAD}),
            lambda: guarded.pipeline().eval("return 1"),
            lambda: guarded.pipeline().watch(),
            lambda: guarded.pipeline().get(name=board.PROOF_HEAD),
            lambda: guarded.xadd(board.PROOF_HEAD, {"a": "b"}, unknown=1),
        ]
        for call in refused:
            with self.assertRaises(board.InvalidEvidence):
                call()
        self.assertEqual(spy.commands, [])

    def test_forbidden_key_during_complete_receipt_performs_no_key_io(self):
        spy = SpyConn()
        guarded = adapter.GuardedRedis(spy)
        generation_id = "ab" * 32
        with self.assertRaises(board.InvalidEvidence):
            adapter.guard_proof_key(board.HEAD_KEY)
        os.environ[board.VERIFY_FLAG] = "1"
        try:
            receipt = redis_gov.complete_receipt(
                guarded, acl(), "cursor", "pr-board",
                board.private_prefix(generation_id), "", "b64",
                generation_id, "proof-local", board.HEAD_KEY)
        finally:
            os.environ.pop(board.VERIFY_FLAG, None)
        self.assertFalse(receipt["ok"])
        self.assertFalse(board.backend_receipt_accepts(receipt))
        self.assertFalse(any(name in {"watch", "type", "hgetall", "hget"} for name, _args in spy.commands))
        seen = [key for _name, args in spy.commands for key in args if isinstance(key, str)]
        self.assertNotIn(board.HEAD_KEY, seen)
        self.assertFalse(any(key.startswith(board.NAMESPACE) for key in seen))

    def test_guard_allows_audit_stream_and_proof_head(self):
        spy = SpyConn()
        guarded = adapter.GuardedRedis(spy)
        guarded.xadd(redis_gov.AUDIT_STREAM, {"ok": "1"})
        guarded.pipeline().type(board.PROOF_HEAD)
        self.assertEqual(spy.commands[0][0], "xadd")
        self.assertIn(redis_gov.AUDIT_STREAM, spy.commands[0][1])
        self.assertTrue(any(name == "type" and board.PROOF_HEAD in args for name, args in spy.commands))

    def test_proof_write_exercises_complete_receipt_on_proof_keys(self):
        memory = Memory()
        seen = {}

        def factory():
            seen["conn"] = GovRedis(memory.data)
            return seen["conn"]

        code = adapter.main(
            ["--mode", "proof", "--as-of", AS_OF, "--write"],
            probe=SyntheticProbe(), redis_factory=factory, read=github_read,
            put=memory.put, read_full=memory.read_full, acl=acl())
        self.assertEqual(code, 0)
        self.assertIn("conn", seen)
        keys = list(memory.data)
        self.assertTrue(keys)
        self.assertTrue(all(key.startswith(board.PROOF_NAMESPACE) for key in keys))
        self.assertNotIn(board.HEAD_KEY, keys)
        self.assertIn(board.PROOF_HEAD, keys)
        touched = [key for _name, key in seen["conn"].commands if isinstance(key, str) and key]
        self.assertTrue(any(key == board.PROOF_HEAD for key in touched))
        self.assertTrue(any(name in {"watch", "type", "hgetall"} for name, _key in seen["conn"].commands))
        self.assertFalse(any(key == board.HEAD_KEY or key.startswith(board.NAMESPACE) for key in touched))
        self.assertEqual(seen["conn"].audits, [redis_gov.AUDIT_STREAM])
        self.assertIs(adapter.complete_receipt, redis_gov.complete_receipt)
        blob = (ROOT / "tools/redis_gov.py").read_bytes()
        self.assertEqual(len(blob), 64744)

    def test_vendored_governor_blob_matches_the_pin(self):
        import hashlib
        import subprocess
        blob = subprocess.check_output(
            ["git", "hash-object", "tools/redis_gov.py"], cwd=ROOT, text=True).strip()
        self.assertEqual(blob, "31abc4066e27fead030090b7627ec18bc52d76c2")
        digest = hashlib.sha256((ROOT / "tools/redis_gov.py").read_bytes()).hexdigest()
        self.assertEqual(len(digest), 64)
        self.assertEqual(redis_gov.complete_receipt.__code__.co_firstlineno, 361)


if __name__ == "__main__":
    unittest.main()
