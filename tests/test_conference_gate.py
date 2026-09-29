"""Host gate: server-side host lookup, one joiner, server-minted room JWT."""

from __future__ import annotations

import importlib.util
import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "conference_gate",
    ROOT / "services" / "conference_gate" / "gate.py",
)
gate = importlib.util.module_from_spec(SPEC)
sys.modules["conference_gate"] = gate
SPEC.loader.exec_module(gate)


def settings(**extra):
    env = {
        "HOST_CONFERENCE_CODE": "unit-host-code",
        "GATE_AUTH_SECRET": "unit-auth-secret",
        "HOST_EMAIL": "",
    }
    env.update(extra)
    return gate.Settings.from_env(env)


class ConferenceGateTest(unittest.TestCase):
    def test_other_codes_are_rejected_and_the_host_code_is_not_echoed(self):
        cfg = settings()
        status, body = gate.unlock(cfg, "some-other-code")
        self.assertEqual(status, 401)
        self.assertNotIn("unit-host-code", json.dumps(body))
        self.assertNotIn("some-other-code", json.dumps(body))

    def test_the_host_code_maps_to_the_contact_mailbox(self):
        cfg = settings()
        self.assertEqual(cfg.host_email, "abdus@sfdc24.com")
        status, body = gate.unlock(cfg, "unit-host-code")
        self.assertEqual(status, 200)
        self.assertEqual(body["email"], "abdus@sfdc24.com")
        self.assertNotIn("unit-host-code", json.dumps(body))
        self.assertTrue(body["session"])
        self.assertNotIn("unit-auth-secret", body["session"])

    def test_unconfigured_gate_mints_nothing(self):
        cfg = gate.Settings.from_env({})
        status, body = gate.unlock(cfg, "unit-host-code")
        self.assertEqual(status, 503)
        self.assertIsNone(gate.mint_room_jwt(cfg, "guest", "room"))

    def test_one_joiner_and_a_server_jwt(self):
        cfg = settings(
            LIVEKIT_API_KEY="lk-key",
            LIVEKIT_API_SECRET="lk-secret-value",
            LIVEKIT_URL="wss://rooms.example/live",
        )
        state = gate.State()
        _, unlocked = gate.unlock(cfg, "unit-host-code")
        status, minted = gate.mint(
            cfg,
            state,
            unlocked["session"],
            "Ada Lovelace",
            "ada@example.com",
            "Ship the floor",
        )
        self.assertEqual(status, 200)
        self.assertEqual(minted["joiners_max"], 1)
        self.assertNotIn("unit-host-code", minted["code"])
        self.assertRegex(minted["code"], r"^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$")
        self.assertTrue(minted["join_hash"].startswith("c="))

        first, joined = gate.join(cfg, state, minted["code"])
        self.assertEqual(first, 200)
        self.assertEqual(joined["role"], "guest")
        self.assertEqual(joined["joiners_max"], 1)
        self.assertTrue(joined["room_token"])
        self.assertNotIn("lk-secret-value", joined["room_token"])
        self.assertNotIn(minted["code"], joined["room_token"])
        self.assertEqual(joined["url"], "wss://rooms.example/live")
        payload = joined["room_token"].split(".")[1]
        pad = "=" * (-len(payload) % 4)
        import base64
        body = json.loads(base64.urlsafe_b64decode(payload + pad))
        self.assertLessEqual(body["exp"] - body["nbf"], 900)
        self.assertEqual(body["video"]["roomJoin"], True)

        second, again = gate.join(cfg, state, minted["code"])
        self.assertEqual(second, 409)
        self.assertEqual(again["error"], "used")

        host_status, host = gate.join(cfg, state, "unit-host-code")
        self.assertEqual(host_status, 200)
        self.assertEqual(host["role"], "host")
        again_host, host2 = gate.join(cfg, state, "unit-host-code")
        self.assertEqual(again_host, 200)
        self.assertEqual(host2["role"], "host")
        self.assertNotIn("unit-host-code", json.dumps(host))

    def test_without_livekit_env_the_code_stays_unused_and_no_token_is_invented(self):
        cfg = settings()
        state = gate.State()
        _, unlocked = gate.unlock(cfg, "unit-host-code")
        _, minted = gate.mint(cfg, state, unlocked["session"], "Ada", "ada@example.com", "Listen once")
        status, joined = gate.join(cfg, state, minted["code"])
        self.assertEqual(status, 503)
        self.assertEqual(joined["error"], "room_token_unconfigured")
        self.assertNotIn("room_token", joined)
        _, listed = gate.list_codes(cfg, state, unlocked["session"])
        self.assertFalse(listed["codes"][0]["used"])
        again, still = gate.join(cfg, state, minted["code"])
        self.assertEqual(again, 503)
        self.assertEqual(still["error"], "room_token_unconfigured")
        host_status, host = gate.join(cfg, state, "unit-host-code")
        self.assertEqual(host_status, 503)
        self.assertEqual(host["error"], "room_token_unconfigured")

    def test_redeem_marks_the_code_used_once(self):
        cfg = settings(
            LIVEKIT_API_KEY="lk-key",
            LIVEKIT_API_SECRET="lk-secret-value",
            LIVEKIT_URL="wss://rooms.example/live",
        )
        state = gate.State()
        _, unlocked = gate.unlock(cfg, "unit-host-code")
        _, minted = gate.mint(cfg, state, unlocked["session"], "Ada", "ada@example.com", "Listen once")
        status, joined = gate.dispatch(cfg, state, "POST", "/v1/redeem", {"code": minted["code"]}, {})
        self.assertEqual(status, 200)
        self.assertTrue(joined["room_token"])
        self.assertLessEqual(joined["room_token"].count("."), 2)
        self.assertNotIn("lk-secret-value", joined["room_token"])
        _, listed = gate.list_codes(cfg, state, unlocked["session"])
        self.assertTrue(listed["codes"][0]["used"])
        second, again = gate.dispatch(cfg, state, "POST", "/v1/join", {"code": minted["code"]}, {})
        self.assertEqual(second, 409)
        self.assertEqual(again["error"], "used")

    def test_builtin_host_lookup_stays_off_the_client_and_out_of_the_source_literal(self):
        src = (ROOT / "services" / "conference_gate" / "gate.py").read_text(encoding="utf-8")
        secret = gate.builtin_host_code()
        self.assertNotIn(secret, src)
        cfg = gate.Settings.from_env({"GATE_AUTH_SECRET": "unit-auth-secret"})
        self.assertTrue(gate.codes_match(secret, cfg.host_code))
        status, body = gate.unlock(cfg, secret)
        self.assertEqual(status, 200)
        self.assertEqual(body["email"], "abdus@sfdc24.com")
        self.assertNotIn(secret, json.dumps(body))
        for path in (
            ROOT / "conference" / "index.html",
            ROOT / "conference" / "create" / "index.html",
            ROOT / "assets" / "conference-join.js",
            ROOT / "assets" / "conference-room.js",
            ROOT / "assets" / "conference-gate.js",
            ROOT / "assets" / "conference-create.js",
        ):
            self.assertNotIn(secret, path.read_text(encoding="utf-8"))

    def test_list_is_limited_to_the_host_session(self):
        cfg = settings()
        state = gate.State()
        _, unlocked = gate.unlock(cfg, "unit-host-code")
        gate.mint(cfg, state, unlocked["session"], "Ada", "ada@example.com", "Listen once")
        status, listed = gate.list_codes(cfg, state, unlocked["session"])
        self.assertEqual(status, 200)
        self.assertEqual(len(listed["codes"]), 1)
        self.assertFalse(listed["codes"][0]["used"])
        missing, _ = gate.list_codes(cfg, state, "nope")
        self.assertEqual(missing, 401)


if __name__ == "__main__":
    unittest.main()
