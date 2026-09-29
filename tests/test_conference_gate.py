"""Host gate: server-side host lookup, one joiner, server-minted room JWT."""

from __future__ import annotations

import importlib.util
import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def _jwt_payload(token: str) -> dict:
    import base64

    payload = token.split(".")[1]
    pad = "=" * (-len(payload) % 4)
    return json.loads(base64.urlsafe_b64decode(payload + pad))
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
            "Dr. Ada",
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
        self.assertEqual(body["sub"], "ada@example.com")
        self.assertEqual(body["name"], "Dr. Ada")
        self.assertEqual(minted["reference"], "Dr. Ada")
        self.assertEqual(minted["name"], "Ada Lovelace")
        self.assertEqual(joined["identity"], "ada@example.com")

        second, again = gate.join(cfg, state, minted["code"])
        self.assertEqual(second, 409)
        self.assertEqual(again["error"], "used")

        host_status, host = gate.join(cfg, state, "unit-host-code")
        self.assertEqual(host_status, 200)
        self.assertEqual(host["role"], "host")
        self.assertEqual(host["identity"], "abdus@sfdc24.com")
        self.assertEqual(host["name"], gate.HOST_DISPLAY_NAME)
        host_body = _jwt_payload(host["room_token"])
        self.assertEqual(host_body["sub"], "abdus@sfdc24.com")
        self.assertEqual(host_body["name"], gate.HOST_DISPLAY_NAME)
        self.assertEqual(host_body["video"]["roomJoin"], True)
        self.assertLessEqual(host_body["exp"] - host_body["nbf"], 900)
        dumped = json.dumps(host).lower()
        self.assertNotIn("oauth", dumped)
        self.assertNotIn("redirect", dumped)
        self.assertNotIn("unit-host-code", json.dumps(host))
        again_host, host2 = gate.join(cfg, state, "unit-host-code")
        self.assertEqual(again_host, 409)
        self.assertEqual(host2["error"], "used")
        unlock_again, _ = gate.unlock(cfg, "unit-host-code")
        self.assertEqual(unlock_again, 200)

    def test_without_livekit_env_the_code_stays_unused_and_no_token_is_invented(self):
        cfg = settings()
        state = gate.State()
        _, unlocked = gate.unlock(cfg, "unit-host-code")
        _, minted = gate.mint(cfg, state, unlocked["session"], "Ada", "ada@example.com", "Listen once", "Dr. Ada")
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
        host_again, host_still = gate.join(cfg, state, "unit-host-code")
        self.assertEqual(host_again, 503)
        self.assertEqual(host_still["error"], "room_token_unconfigured")

    def test_redeem_marks_the_code_used_once(self):
        cfg = settings(
            LIVEKIT_API_KEY="lk-key",
            LIVEKIT_API_SECRET="lk-secret-value",
            LIVEKIT_URL="wss://rooms.example/live",
        )
        state = gate.State()
        _, unlocked = gate.unlock(cfg, "unit-host-code")
        _, minted = gate.mint(cfg, state, unlocked["session"], "Ada", "ada@example.com", "Listen once", "Dr. Ada")
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
            ROOT / "conference" / "room" / "index.html",
            ROOT / "assets" / "conference-live.js",
        ):
            text = path.read_text(encoding="utf-8")
            self.assertNotIn(secret, text)
            if path == ROOT / "conference" / "create" / "index.html":
                self.assertEqual(text.count(gate.HOST_DISPLAY_NAME), 1)
            else:
                self.assertNotIn(gate.HOST_DISPLAY_NAME, text)

    def test_list_is_limited_to_the_host_session(self):
        cfg = settings()
        state = gate.State()
        _, unlocked = gate.unlock(cfg, "unit-host-code")
        gate.mint(cfg, state, unlocked["session"], "Ada", "ada@example.com", "Listen once", "Dr. Ada")
        status, listed = gate.list_codes(cfg, state, unlocked["session"])
        self.assertEqual(status, 200)
        self.assertEqual(len(listed["codes"]), 1)
        self.assertFalse(listed["codes"][0]["used"])
        self.assertEqual(listed["codes"][0]["reference"], "Dr. Ada")
        self.assertEqual(listed["codes"][0]["event_status"], "staged")
        missing_ref, _ = gate.mint(cfg, state, unlocked["session"], "Ada", "ada@example.com", "Listen once", "")
        self.assertEqual(missing_ref, 400)
        missing, _ = gate.list_codes(cfg, state, "nope")
        self.assertEqual(missing, 401)

    def test_portal_gate_hands_off_to_the_livekit_page_without_a_token(self):
        cfg = settings(
            LIVEKIT_API_KEY="lk-key",
            LIVEKIT_API_SECRET="lk-secret-value",
            LIVEKIT_URL="wss://rooms.example/live",
        )
        state = gate.State()
        _, unlocked = gate.unlock(cfg, "unit-host-code")
        _, minted = gate.mint(
            cfg, state, unlocked["session"], "Ada Lovelace", "ada@example.com", "Hear once", "Dr. Ada"
        )
        wrong, _ = gate.enter(cfg, state, minted["code"], "Other", "")
        self.assertEqual(wrong, 401)
        _, listed = gate.list_codes(cfg, state, unlocked["session"])
        self.assertFalse(listed["codes"][0]["used"])
        status, body = gate.enter(cfg, state, minted["code"], "", "Ada@Example.com")
        self.assertEqual(status, 200)
        self.assertTrue(body["room_path"].startswith("/conference/room/#h="))
        self.assertNotIn("room_token", body)
        self.assertNotIn("eyJ", json.dumps(body))
        self.assertNotIn("wss://", json.dumps(body))
        claimed, room = gate.claim_room(state, body["handoff"])
        self.assertEqual(claimed, 200)
        self.assertTrue(room["room_token"])
        self.assertEqual(room["url"], "wss://rooms.example/live")
        self.assertEqual(room["name"], "Dr. Ada")
        again, _ = gate.claim_room(state, body["handoff"])
        self.assertEqual(again, 401)
        second, _ = gate.enter(cfg, state, minted["code"], "Lovelace", "")
        self.assertEqual(second, 409)
        missed, _ = gate.enter(cfg, state, "unit-host-code", "Other", "nope@example.com")
        self.assertEqual(missed, 401)
        host_status, host = gate.enter(cfg, state, "unit-host-code", "", "abdus@sfdc24.com")
        self.assertEqual(host_status, 200)
        self.assertNotIn("room_token", host)
        self.assertNotIn("unit-host-code", json.dumps(host))

    def test_mint_stages_an_event_and_does_not_send_the_knowledge_path_to_the_client(self):
        cfg = settings()
        state = gate.State()
        _, unlocked = gate.unlock(cfg, "unit-host-code")
        status, minted = gate.mint(
            cfg,
            state,
            unlocked["session"],
            "Ada Lovelace",
            "ada@example.com",
            "Ship the floor",
            "Dr. Ada",
            "not-an-id",
            "",
            "006000000000001AAA",
        )
        self.assertEqual(status, 200)
        self.assertEqual(minted["event"]["status"], "staged")
        self.assertFalse(minted["event"]["durable"])
        self.assertEqual(minted["event"]["object"], "Event")
        self.assertNotIn("okf", json.dumps(minted).lower())
        stored = state.events[minted["code"]]
        self.assertEqual(stored["salesforce"]["Subject"], "Ship the floor")
        self.assertEqual(stored["salesforce"]["OwnerEmail"], "abdus@sfdc24.com")
        self.assertEqual(stored["who"]["Email"], "ada@example.com")
        self.assertEqual(stored["who"]["Name"], "Ada Lovelace")
        self.assertEqual(stored["what"], {"OpportunityId": "006000000000001AAA"})
        description = stored["salesforce"]["Description"]
        self.assertIn("Dr. Ada", description)
        self.assertIn(minted["code"], description)
        self.assertIn("abdus@sfdc24.com", description)
        self.assertIn("docs/okf", stored["knowledge_ref"])
        self.assertNotIn("not-an-id", json.dumps(stored["what"]))

    def test_a_non_local_http_url_is_not_called(self):
        cfg = settings(OMNISTUDIO_EVENT_URL="http://example.test/event")
        state = gate.State()
        _, unlocked = gate.unlock(cfg, "unit-host-code")
        status, minted = gate.mint(
            cfg, state, unlocked["session"], "Ada", "ada@example.com", "Listen once", "Dr. Ada"
        )
        self.assertEqual(status, 200)
        self.assertEqual(minted["event"]["status"], "staged_forward_failed")
        self.assertEqual(minted["event"]["error"], "bad_url")
        self.assertFalse(minted["event"]["durable"])

    def test_a_local_ack_marks_the_event_forwarded_without_echoing_the_token(self):
        from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
        import threading

        seen = {}

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                length = int(self.headers.get("Content-Length") or "0")
                body = json.loads(self.rfile.read(length).decode("utf-8"))
                seen["auth"] = self.headers.get("Authorization")
                seen["code"] = body["code"]
                payload = json.dumps({
                    "ok": True,
                    "contract": "conference-event-v1",
                    "idempotency": "conference_code",
                    "id": "00U000000000001AAA",
                    "code": body["code"],
                }).encode("utf-8")
                self.send_response(201)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def log_message(self, fmt, *args):
                return

        httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        port = httpd.server_address[1]
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        try:
            cfg = settings(
                OMNISTUDIO_EVENT_URL="http://127.0.0.1:%s/conference/event/v1" % port,
                OMNISTUDIO_EVENT_TOKEN="unit-event-token",
            )
            state = gate.State()
            _, unlocked = gate.unlock(cfg, "unit-host-code")
            status, minted = gate.mint(
                cfg, state, unlocked["session"], "Ada", "ada@example.com", "Listen once", "Dr. Ada"
            )
            self.assertEqual(status, 200)
            self.assertEqual(minted["event"]["status"], "forwarded")
            self.assertTrue(minted["event"]["durable"])
            self.assertEqual(minted["event"]["id"], "00U000000000001AAA")
            self.assertEqual(seen["auth"], "Bearer unit-event-token")
            self.assertEqual(seen["code"], minted["code"])
            self.assertNotIn("unit-event-token", json.dumps(minted))
            self.assertNotIn("okf", json.dumps(minted).lower())
        finally:
            httpd.shutdown()
            httpd.server_close()

    def test_mint_stages_an_invite_draft_and_confirm_does_not_send(self):
        cfg = settings()
        state = gate.State()
        _, unlocked = gate.unlock(cfg, "unit-host-code")
        status, minted = gate.mint(
            cfg, state, unlocked["session"], "Ada Lovelace", "ada@example.com", "Hear the floor once", "Dr. Ada"
        )
        self.assertEqual(status, 200)
        invite = minted["invite"]
        self.assertEqual(invite["status"], "draft")
        self.assertFalse(invite["sent"])
        self.assertIsNone(invite["time"])
        self.assertEqual(invite["title"], "Hear the floor once")
        self.assertEqual(invite["to"], "ada@example.com")
        self.assertIn("Agent reference name: Dr. Ada", invite["description"])
        self.assertIn("https://portal.sfdc24.com/", invite["description"])
        self.assertIn("https://www.sfdc24.com/conference/room/", invite["description"])
        self.assertIn(minted["code"], invite["description"])
        self.assertNotIn("#h=", json.dumps(invite))
        self.assertNotIn("eyJ", json.dumps(invite))
        self.assertNotIn("okf", json.dumps(invite).lower())
        self.assertNotIn("unit-host-code", json.dumps(minted))
        headers = {"authorization": "Bearer " + unlocked["session"]}
        kept_status, kept = gate.dispatch(
            cfg, state, "POST", "/v1/invites", {"code": minted["code"], "confirm": False}, headers
        )
        self.assertEqual(kept_status, 200)
        self.assertFalse(kept["invite"]["sent"])
        self.assertEqual(kept["invite"]["reason"], "held")
        sent_status, sent = gate.dispatch(
            cfg, state, "POST", "/v1/invites", {"code": minted["code"], "confirm": True}, headers
        )
        self.assertEqual(sent_status, 200)
        self.assertEqual(sent["invite"]["reason"], "held")
        self.assertFalse(sent["invite"]["sent"])
        self.assertEqual(sent["invite"]["status"], "draft")
        self.assertIsNone(sent["invite"]["time"])
        self.assertEqual(sent["invite"]["room_url"], "https://www.sfdc24.com/conference/room/")
        missing, _ = gate.dispatch(cfg, state, "POST", "/v1/invites", {"code": minted["code"], "confirm": True}, {})
        self.assertEqual(missing, 401)

    def test_confirm_never_calls_gmail_or_calendar(self):
        from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
        import threading

        seen = {"gmail": [], "calendar": []}

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                length = int(self.headers.get("Content-Length") or "0")
                body = json.loads(self.rfile.read(length).decode("utf-8"))
                if self.path.startswith("/gmail"):
                    seen["gmail"].append(body)
                    seen["gmail_auth"] = self.headers.get("Authorization")
                else:
                    seen["calendar"].append(body)
                payload = json.dumps({"ok": True, "contract": "conference-invite-v1"}).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def log_message(self, fmt, *args):
                return

        httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        port = httpd.server_address[1]
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        try:
            cfg = settings(
                GMAIL_INVITE_URL="http://127.0.0.1:%s/gmail" % port,
                GMAIL_INVITE_TOKEN="unit-gmail-token",
                CALENDAR_INVITE_URL="http://127.0.0.1:%s/calendar" % port,
                CALENDAR_INVITE_TOKEN="unit-calendar-token",
            )
            state = gate.State()
            _, unlocked = gate.unlock(cfg, "unit-host-code")
            status, minted = gate.mint(
                cfg, state, unlocked["session"], "Ada Lovelace", "ada@example.com", "Hear the floor once", "Dr. Ada"
            )
            self.assertEqual(status, 200)
            self.assertEqual(seen["gmail"], [])
            self.assertEqual(seen["calendar"], [])
            headers = {"authorization": "Bearer " + unlocked["session"]}
            sent_status, sent = gate.dispatch(
                cfg, state, "POST", "/v1/invites", {"code": minted["code"], "confirm": True}, headers
            )
            self.assertEqual(sent_status, 200)
            self.assertFalse(sent["invite"]["sent"])
            self.assertEqual(sent["invite"]["status"], "draft")
            self.assertEqual(sent["invite"]["reason"], "held")
            self.assertIsNone(sent["invite"]["time"])
            self.assertNotIn("mail", sent["invite"])
            self.assertNotIn("calendar", sent["invite"])
            self.assertEqual(seen["gmail"], [])
            self.assertEqual(seen["calendar"], [])
            self.assertNotIn("unit-gmail-token", json.dumps(sent))
            self.assertNotIn("unit-calendar-token", json.dumps(sent))
            self.assertNotIn("okf", json.dumps(sent).lower())

            state.invites[minted["code"]]["time"] = "2026-09-30T15:00:00Z"
            both_status, both = gate.dispatch(
                cfg, state, "POST", "/v1/invites", {"code": minted["code"], "confirm": True, "time": "2026-09-30T15:00:00Z"}, headers
            )
            self.assertEqual(both_status, 200)
            self.assertFalse(both["invite"]["sent"])
            self.assertEqual(both["invite"]["reason"], "held")
            self.assertIsNone(both["invite"]["time"])
            self.assertEqual(seen["gmail"], [])
            self.assertEqual(seen["calendar"], [])
            self.assertNotIn("unit-host-code", json.dumps(both))
        finally:
            httpd.shutdown()
            httpd.server_close()

    def test_a_public_gmail_url_is_not_called(self):
        cfg = settings(GMAIL_INVITE_URL="http://example.test/gmail", CALENDAR_INVITE_URL="http://example.test/calendar")
        state = gate.State()
        _, unlocked = gate.unlock(cfg, "unit-host-code")
        _, minted = gate.mint(
            cfg, state, unlocked["session"], "Ada", "ada@example.com", "Listen once", "Dr. Ada"
        )
        status, body = gate.dispatch(
            cfg,
            state,
            "POST",
            "/v1/invites",
            {"code": minted["code"], "confirm": True, "time": "2026-10-01T15:00:00Z"},
            {"authorization": "Bearer " + unlocked["session"]},
        )
        self.assertEqual(status, 200)
        self.assertFalse(body["invite"]["sent"])
        self.assertEqual(body["invite"]["reason"], "held")
        self.assertNotIn("mail", body["invite"])
        self.assertIsNone(body["invite"]["time"])


if __name__ == "__main__":
    unittest.main()
