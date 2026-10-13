#!/usr/bin/env python3
"""Proof-only entrypoint for an isolated PR board generation.

The command accepts --mode proof and nothing else. It does not activate the
production collector and it does not offer a production mode.

Read-only GitHub preflight is a separate step from Redis. The live capability
interface in pr_board_github_capability is an unverified prerequisite and is
not a synthetic probe. A synthetic token_facts probe, when a test supplies
one, is assessed first. No Redis client is constructed unless that assessment
passes and a proof write was requested.

Proof writes use proj:pr-board-proof:v1: only. A guarded connection screens
every Redis command, including WATCH, TYPE, and HGETALL inside the real
complete_receipt, and refuses a production key before any client call.
"""

from __future__ import annotations

import argparse
import base64
import os
import sys

import ops_pr_board as board
from pr_board_github_capability import LiveReadOnlyGitHub
from redis_gov import AUDIT_STREAM, complete_receipt, execute

# Fail closed. A command is forwarded only when its name is listed and every
# key argument is a string in an allowed position. Keyword keys, bytes keys,
# and unknown commands never reach a client.
_KEYED = {
    "get": frozenset(),
    "type": frozenset(),
    "hget": frozenset(),
    "hgetall": frozenset(),
    "hlen": frozenset(),
    "hkeys": frozenset(),
    "hstrlen": frozenset(),
    "xadd": frozenset({"maxlen", "approximate"}),
}
_NO_KEY = {
    "multi": frozenset(),
    "reset": frozenset(),
    "execute": frozenset({"raise_on_error"}),
}


def _refuse_command():
    raise board.InvalidEvidence("proof guard refused the command before Redis I/O")


def _screen(command, args, kwargs):
    """Allow one known command shape, or refuse before any client call."""
    if kwargs and command not in _KEYED and command != "watch" and command not in _NO_KEY:
        _refuse_command()
    if command == "watch":
        if kwargs or not args or not all(isinstance(arg, str) for arg in args):
            _refuse_command()
        for key in args:
            guard_proof_key(key)
        return
    if command in _NO_KEY:
        if args or not set(kwargs).issubset(_NO_KEY[command]):
            _refuse_command()
        return
    allowed = _KEYED.get(command)
    if allowed is None or not args or not isinstance(args[0], str) or not set(kwargs).issubset(allowed):
        _refuse_command()
    guard_proof_key(args[0])


def guard_proof_key(key):
    """Refuse anything except the proof prefix and the governor audit stream.

    The refusal happens before the caller touches a connection or a store.
    """
    if not isinstance(key, str) or not board.KEY_GRAMMAR.fullmatch(key):
        raise board.InvalidEvidence("proof guard refused the key before Redis I/O")
    if key == board.HEAD_KEY or key.startswith(board.NAMESPACE):
        raise board.InvalidEvidence("proof guard refused a production key before Redis I/O")
    if key.startswith(board.PROOF_NAMESPACE) or key == AUDIT_STREAM:
        return
    raise board.InvalidEvidence("proof guard refused a key outside the proof namespace before Redis I/O")


class GuardedPipeline:
    """Pipeline wrapper. The inner pipeline is opened only after every key passes."""

    def __init__(self, conn, transaction):
        self._conn = conn
        self._transaction = transaction
        self._pipe = None

    def _open(self):
        if self._pipe is None:
            self._pipe = self._conn.pipeline(transaction=self._transaction)
        return self._pipe

    def __getattr__(self, name):
        if name.startswith("_"):
            raise AttributeError(name)

        def call(*args, **kwargs):
            _screen(name, args, kwargs)
            if self._pipe is None and name in _NO_KEY:
                return [] if name == "execute" else None
            return getattr(self._open(), name)(*args, **kwargs)

        return call


class GuardedRedis:
    """Connection wrapper. Every command is screened before the inner client is used."""

    def __init__(self, conn):
        self._conn = conn

    def pipeline(self, transaction=True):
        return GuardedPipeline(self._conn, transaction)

    def __getattr__(self, name):
        if name.startswith("_"):
            raise AttributeError(name)

        def call(*args, **kwargs):
            _screen(name, args, kwargs)
            return getattr(self._conn, name)(*args, **kwargs)

        return call


def _refuse(reason):
    return {"ok": False, "reason": reason, "network": False}


def assess_token_facts(probe):
    """Assess a synthetic probe object. This does not read a live token or its scopes."""
    try:
        facts = probe.token_facts()
    except Exception:
        return _refuse("synthetic probe failed")
    if not isinstance(facts, dict):
        return _refuse("synthetic facts are missing")
    if facts.get("type") not in ("installation", "fine_grained"):
        return _refuse("synthetic facts are not an installation or fine-grained shape")
    if facts.get("can_write") is not False:
        return _refuse("synthetic facts include a write capability")
    repos = facts.get("repos")
    if not isinstance(repos, (list, tuple)) or set(repos) != set(board.REPOS) or len(repos) != len(board.REPOS):
        return _refuse("synthetic repo set is not the three required repositories")
    try:
        for repo in board.REPOS:
            response = probe.pulls(repo)
            if not isinstance(response, dict) or response.get("status") != 200 or not isinstance(response.get("body"), list):
                return _refuse("synthetic list did not return HTTP 200 with a list")
    except Exception:
        return _refuse("synthetic probe failed")
    return {"ok": True, "reason": "synthetic facts accepted", "network": False}


def _wrap_put(put):
    def wrapped(key, mapping):
        guard_proof_key(key)
        return put(key, mapping)

    wrapped.accepts_private = getattr(put, "accepts_private", True)
    return wrapped


def _wrap_read(read_full):
    def wrapped(key):
        guard_proof_key(key)
        return read_full(key)

    return wrapped


PROOF_RELAY_KEY = board.PROOF_NAMESPACE + "marker"
PROOF_RELAY_ACTOR = "grok"
PROOF_RELAY_VALUE = "Cody"
PROOF_RELAY_VIA = "pr-board-proof"


def proof_relay_payloads():
    """The isolated proof write and its readback. Grok posts these. Cody is the value.

    The audit actor is grok because that is the raw tag. This function does not
    open Redis. enc=b64 is the governor spelling of the plain value Cody.
    """
    encoded = base64.b64encode(PROOF_RELAY_VALUE.encode("utf-8")).decode("ascii")
    write = {
        "op": "xadd",
        "key": PROOF_RELAY_KEY,
        "raw_tag": PROOF_RELAY_ACTOR,
        "via": PROOF_RELAY_VIA,
        "enc": "b64",
        "val": encoded,
    }
    read = {
        "op": "xrange",
        "key": PROOF_RELAY_KEY,
        "raw_tag": PROOF_RELAY_ACTOR,
        "via": PROOF_RELAY_VIA,
        "count": 1,
    }
    return write, read


def evidence_receipt(written, seen):
    """Synthetic evidence only. A green CI run is not a Redis board."""
    rows = seen.get("value") if isinstance(seen, dict) else None
    row = rows[0] if isinstance(rows, list) and rows and isinstance(rows[0], dict) else {}
    return {
        "schema": "pr-board-proof-evidence-1",
        "live_redis": False,
        "ci_is_not_a_redis_board": True,
        "public_rows": False,
        "namespace": board.PROOF_NAMESPACE,
        "head": board.PROOF_HEAD,
        "key": PROOF_RELAY_KEY,
        "actor": row.get("by") if row.get("by") == PROOF_RELAY_ACTOR else "",
        "value": row.get("text") if row.get("text") == PROOF_RELAY_VALUE else "",
        "write_ok": isinstance(written, dict) and written.get("ok") is True and written.get("audit") == "ok",
        "read_ok": isinstance(seen, dict) and seen.get("ok") is True and row.get("text") == PROOF_RELAY_VALUE and row.get("by") == PROOF_RELAY_ACTOR,
        "production_namespace": board.NAMESPACE,
    }


def apply_proof_relay(conn, acl, now=None):
    """Exercise the relay payloads on an injected connection. No live Redis."""
    write, read = proof_relay_payloads()
    guard_proof_key(write["key"])
    guard_proof_key(read["key"])
    written = execute(
        conn, acl, write["raw_tag"], write["via"], write["op"], write["key"],
        raw_value=write["val"], enc=write["enc"], now=now)
    seen = execute(
        conn, acl, read["raw_tag"], read["via"], read["op"], read["key"],
        count=read["count"], now=now)
    return evidence_receipt(written, seen)


def proof_complete_receipt(conn, acl, generation, correlation="proof-local"):
    """Run the real complete_receipt against one proof generation."""
    prefix = board.private_prefix(generation["id"], namespace=board.PROOF_NAMESPACE)
    documents = board.redis_documents(generation, namespace=board.PROOF_NAMESPACE)
    encoded = base64.b64encode(
        board.inventory_manifest(board._specs(board._listed_entries(documents)))
    ).decode("ascii")
    previous = os.environ.get(board.VERIFY_FLAG)
    os.environ[board.VERIFY_FLAG] = "1"
    try:
        return complete_receipt(
            conn, acl, "cursor", "pr-board", prefix, encoded, "b64",
            generation["id"], correlation, board.PROOF_HEAD)
    finally:
        if previous is None:
            os.environ.pop(board.VERIFY_FLAG, None)
        else:
            os.environ[board.VERIFY_FLAG] = previous


def _parser():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mode", required=True, choices=("proof",))
    parser.add_argument("--as-of", required=True, help="Explicit UTC timestamp, YYYY-MM-DDTHH:MM:SSZ")
    parser.add_argument("--preflight-only", action="store_true",
                        help="Stop after the read-only preflight. Do not construct Redis.")
    parser.add_argument("--write", action="store_true",
                        help="After preflight passes, write the isolated proof namespace.")
    return parser


def _preflight(probe, live_client=None):
    # A supplied probe is synthetic token_facts. It is not the live plan, and
    # a passing probe does not execute a token or open Redis. The live client
    # loads the Cursor-managed ghs_ token and still returns ok false.
    if probe is None:
        client = live_client if live_client is not None else LiveReadOnlyGitHub()
        return client.assess()
    return assess_token_facts(probe)


def main(argv=None, probe=None, redis_factory=None, read=None, put=None, read_full=None, acl=None, live_client=None):
    """Proof-only command. Exit 0 ok, 1 collection or receipt failed, 2 bad args, 3 preflight refused, 4 guard."""
    try:
        args = _parser().parse_args(argv)
    except SystemExit as exc:
        code = exc.code
        return 2 if code is None else int(code)
    if args.mode != "proof" or (args.write and args.preflight_only):
        return 2
    try:
        board.instant(args.as_of)
    except (board.InvalidEvidence, ValueError, TypeError):
        return 2
    scope = _preflight(probe, live_client)
    if not scope.get("ok"):
        return 3
    if not args.write:
        return 0
    if redis_factory is None or read is None or put is None or read_full is None or acl is None:
        return 3
    try:
        collected = board.run(
            args.as_of, read, put=_wrap_put(put), read_full=_wrap_read(read_full),
            enabled_flag=True, namespace=board.PROOF_NAMESPACE)
    except board.InvalidEvidence:
        return 4
    generation = collected.get("generation") if isinstance(collected, dict) else None
    if not isinstance(generation, dict) or collected.get("status") not in {"complete", "replay"}:
        return 1
    if collected.get("public_publish") is True:
        return 1
    try:
        conn = GuardedRedis(redis_factory())
        receipt = proof_complete_receipt(conn, acl, generation)
    except board.InvalidEvidence:
        return 4
    if board.backend_receipt_accepts(receipt) and board._receipt_binds_current(
            generation, receipt, namespace=board.PROOF_NAMESPACE):
        return 0
    return 1


if __name__ == "__main__":
    sys.exit(main())
