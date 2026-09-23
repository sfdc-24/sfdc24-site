"""Relay contract: authenticated stream, 180s hard cap, staging lead sink."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.leads import build_lead, extract_contacts  # noqa: E402
from app.main import create_app  # noqa: E402
from app.settings import HARD_CAP_SECONDS, Settings  # noqa: E402
from app.tokens import issue_token, read_token  # noqa: E402
from app.upstream import FakeUpstream, parse_deepgram_message  # noqa: E402
from app.upstream import DEEPGRAM_URL  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402


def _settings(path: str, **overrides) -> Settings:
    base = dict(
        deepgram_api_key="unit-test-speech-key",
        relay_auth_secret="unit-test-secret",
        allowed_origins=("http://testserver",),
        max_seconds=180.0,
        warn_seconds=30.0,
        session_ttl=240,
        lead_sink_path=path,
        omnistudio_lead_url="",
        omnistudio_lead_token="",
        fake_upstream=False,
    )
    base.update(overrides)
    return Settings(**base)


class SettingsTests(unittest.TestCase):
    def test_hard_cap_cannot_exceed_three_minutes(self) -> None:
        previous = os.environ.get("STT_MAX_SECONDS")
        os.environ["STT_MAX_SECONDS"] = "9999"
        try:
            settings = Settings.from_env()
        finally:
            if previous is None:
                os.environ.pop("STT_MAX_SECONDS", None)
            else:
                os.environ["STT_MAX_SECONDS"] = previous
        self.assertEqual(settings.max_seconds, HARD_CAP_SECONDS)

    def test_default_cap_is_180(self) -> None:
        os.environ.pop("STT_MAX_SECONDS", None)
        self.assertEqual(Settings.from_env().max_seconds, 180.0)
        self.assertEqual(Settings.from_env().warn_seconds, 30.0)


class LeadShapeTests(unittest.TestCase):
    def test_callback_fields_prefer_the_form_and_fall_back_to_speech(self) -> None:
        found = extract_contacts("please call 416 555 0199 or ada@example.com")
        self.assertEqual(found["emails"], ["ada@example.com"])
        self.assertTrue(any("416" in phone for phone in found["phones"]))
        lead = build_lead(
            session_id="abc",
            transcript="please call 416 555 0199 or ada@example.com about the close",
            visitor={"name": "Ada Lovelace", "company": "", "email": "", "phone": ""},
            need="quarter close",
            duration_s=12.2,
            cap_reason="visitor_stop",
        )
        self.assertEqual(lead["contract"], "stt-lead-v1")
        self.assertEqual(lead["salesforce"]["object"], "Lead")
        self.assertEqual(lead["salesforce"]["LastName"], "Lovelace")
        self.assertEqual(lead["salesforce"]["Company"], "Unknown")
        self.assertEqual(lead["visitor"]["email"], "ada@example.com")
        self.assertIn("416", lead["visitor"]["phone"])
        self.assertIn("quarter close", lead["summary"])
        self.assertNotIn("unit-test-speech-key", json.dumps(lead))

    def test_empty_name_still_makes_a_lead(self) -> None:
        lead = build_lead(
            session_id="abc",
            transcript="",
            visitor={},
            need="",
            duration_s=180,
            cap_reason="elapsed",
        )
        self.assertEqual(lead["salesforce"]["LastName"], "Callback")
        self.assertEqual(lead["max_seconds"], 180)


class UpstreamContractTests(unittest.TestCase):
    def test_nova3_url_keeps_the_key_out_of_the_query(self) -> None:
        self.assertIn("model=nova-3", DEEPGRAM_URL)
        self.assertIn("linear16", DEEPGRAM_URL)
        self.assertIn("sample_rate=16000", DEEPGRAM_URL)
        self.assertNotIn("token", DEEPGRAM_URL.lower())

    def test_parse_final_transcript(self) -> None:
        raw = json.dumps(
            {
                "type": "Results",
                "is_final": True,
                "channel": {"alternatives": [{"transcript": "hello there"}]},
            }
        )
        event = parse_deepgram_message(raw)
        self.assertIsNotNone(event)
        assert event is not None
        self.assertTrue(event.is_final)
        self.assertEqual(event.text, "hello there")
        self.assertIsNone(parse_deepgram_message(json.dumps({"type": "Metadata"})))


class RelayTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.path = str(Path(self.tmp.name) / "leads.jsonl")

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _app(self, **overrides):
        holder = {"upstream": None}

        def factory():
            holder["upstream"] = FakeUpstream()
            return holder["upstream"]

        app = create_app(_settings(self.path, **overrides), upstream_factory=factory)
        return app, holder

    def test_missing_speech_key_refuses_a_session(self) -> None:
        app = create_app(
            _settings(self.path, deepgram_api_key="", fake_upstream=False),
            upstream_factory=FakeUpstream,
        )
        with TestClient(app) as client:
            response = client.post("/v1/session", headers={"Origin": "http://testserver"})
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json()["error"], "speech_relay_unconfigured")
        self.assertNotIn("unit-test-speech-key", response.text)

    def test_origin_is_required(self) -> None:
        app, _holder = self._app()
        with TestClient(app) as client:
            response = client.post("/v1/session")
        self.assertEqual(response.status_code, 403)

    def test_health_does_not_leak_the_key(self) -> None:
        app, _holder = self._app()
        with TestClient(app) as client:
            response = client.get("/healthz")
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["speech_configured"])
        self.assertNotIn("unit-test-speech-key", response.text)

    def test_cap_warns_then_stops_and_stages_the_transcript(self) -> None:
        app, holder = self._app(max_seconds=0.6, warn_seconds=0.3, session_ttl=30)
        with TestClient(app) as client:
            opened = client.post("/v1/session", headers={"Origin": "http://testserver"})
            self.assertEqual(opened.status_code, 200)
            body = opened.json()
            self.assertEqual(body["max_seconds"], 0.6)
            self.assertNotIn("unit-test-speech-key", opened.text)
            kinds = []
            with client.websocket_connect("/v1/stream", headers={"origin": "http://testserver"}) as ws:
                ws.send_json({"type": "auth", "token": body["token"]})
                ws.send_bytes(b"\x00\x01" * 20)
                deadline = time.time() + 3
                while time.time() < deadline and "cap" not in kinds:
                    kinds.append(ws.receive_json()["type"])
            self.assertIn("ready", kinds)
            self.assertIn("transcript", kinds)
            self.assertIn("warn", kinds)
            self.assertIn("cap", kinds)
            self.assertLess(kinds.index("warn"), kinds.index("cap"))
            listed = client.get("/v1/leads", headers={"X-Relay-Admin": "unit-test-secret"})
            self.assertEqual(listed.status_code, 200)
            leads = listed.json()["leads"]
            self.assertEqual(len(leads), 1)
            self.assertIn("automation", leads[0]["transcript"])
            self.assertEqual(leads[0]["cap_reason"], "elapsed")
            self.assertEqual(leads[0]["omnistudio"]["status"], "staged")
            posted = client.post(
                "/v1/leads",
                headers={"Origin": "http://testserver"},
                json={
                    "token": body["token"],
                    "visitor": {"name": "Ada Lovelace", "company": "Northwind", "email": "", "phone": "4165550199"},
                    "need": "call back about the close",
                },
            )
            self.assertEqual(posted.status_code, 200)
            lead = posted.json()["lead"]
            self.assertEqual(lead["visitor"]["name"], "Ada Lovelace")
            self.assertEqual(lead["visitor"]["phone"], "4165550199")
            self.assertEqual(lead["salesforce"]["Company"], "Northwind")
            self.assertIn("automation", lead["transcript"])
            self.assertEqual(posted.json()["sink"], "staged")
            again = client.get("/v1/leads", headers={"X-Relay-Admin": "unit-test-secret"})
            self.assertEqual(len(again.json()["leads"]), 1)
        self.assertIsNotNone(holder["upstream"])
        self.assertTrue(holder["upstream"].closed)

    def test_bad_token_is_rejected(self) -> None:
        app, _holder = self._app()
        with TestClient(app) as client:
            with client.websocket_connect("/v1/stream", headers={"origin": "http://testserver"}) as ws:
                ws.send_json({"type": "auth", "token": "nope"})
                with self.assertRaises(Exception):
                    ws.receive_json()

    def test_admin_list_requires_the_relay_secret(self) -> None:
        app, _holder = self._app()
        with TestClient(app) as client:
            denied = client.get("/v1/leads")
        self.assertEqual(denied.status_code, 401)

    def test_forwards_to_omnistudio_when_configured(self) -> None:
        seen = {}

        def handler(request: httpx.Request) -> httpx.Response:
            seen["auth"] = request.headers.get("authorization")
            seen["body"] = json.loads(request.content.decode("utf-8"))
            return httpx.Response(201, json={"id": "00Q000000000001"})

        def factory(**kwargs):
            return httpx.AsyncClient(transport=httpx.MockTransport(handler))

        app, _holder = self._app(
            omnistudio_lead_url="https://example.test/services/apexrest/stt/lead/v1",
            omnistudio_lead_token="omni-token",
        )
        app.state.http_client_factory = factory
        with TestClient(app) as client:
            opened = client.post("/v1/session", headers={"Origin": "http://testserver"})
            token = opened.json()["token"]
            claims = read_token("unit-test-secret", token)
            app.state.sessions[claims["sid"]] = {
                "transcript": "need a call back",
                "duration_s": 8,
                "cap_reason": "visitor_stop",
                "closed": True,
            }
            posted = client.post(
                "/v1/leads",
                headers={"Origin": "http://testserver"},
                json={"token": token, "visitor": {"name": "Grace Hopper", "company": "Navy", "email": "grace@example.com", "phone": ""}, "need": "automation"},
            )
        self.assertEqual(posted.status_code, 200)
        self.assertEqual(posted.json()["sink"], "forwarded")
        self.assertEqual(seen["auth"], "Bearer omni-token")
        self.assertEqual(seen["body"]["salesforce"]["Email"], "grace@example.com")
        self.assertNotIn("unit-test-speech-key", json.dumps(seen["body"]))
        self.assertNotIn("omni-token", json.dumps(seen["body"]))

    def test_token_round_trip(self) -> None:
        token = issue_token("unit-test-secret", session_id="abc", ttl_seconds=60, max_seconds=180)
        body = read_token("unit-test-secret", token)
        self.assertEqual(body["sid"], "abc")
        self.assertEqual(body["max"], 180)


class EnvTemplateTests(unittest.TestCase):
    def test_example_names_the_key_and_leaves_it_empty(self) -> None:
        example = (ROOT / ".env.example").read_text(encoding="utf-8")
        self.assertIn("DEEPGRAM_API_KEY=\n", example)
        self.assertNotRegex(example, r"DEEPGRAM_API_KEY=\S")
        script = (ROOT / "scripts" / "smoke_deepgram.py").read_text(encoding="utf-8")
        self.assertNotIn('DEEPGRAM_API_KEY="', script)
        self.assertIn("nova-3", script)

    def test_smoke_exits_when_the_variable_is_missing(self) -> None:
        env = os.environ.copy()
        env.pop("DEEPGRAM_API_KEY", None)
        self.assertFalse((ROOT / ".env").exists(), ".env must not be committed or left in the tree")
        result = subprocess.run(
            [sys.executable, str(ROOT / "scripts" / "smoke_deepgram.py")],
            cwd=ROOT,
            env=env,
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertIn("DEEPGRAM_API_KEY is not set", result.stderr)
        self.assertNotIn("Token", result.stderr)

    def test_dotenv_does_not_override_the_process_environment(self) -> None:
        from scripts.smoke_deepgram import load_env_file

        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / ".env"
            path.write_text("DEEPGRAM_API_KEY=from-file\nRELAY_AUTH_SECRET=from-file\n", encoding="utf-8")
            previous_key = os.environ.get("DEEPGRAM_API_KEY")
            previous_secret = os.environ.get("RELAY_AUTH_SECRET")
            os.environ["DEEPGRAM_API_KEY"] = "from-process"
            os.environ.pop("RELAY_AUTH_SECRET", None)
            try:
                load_env_file(path)
                self.assertEqual(os.environ["DEEPGRAM_API_KEY"], "from-process")
                self.assertEqual(os.environ["RELAY_AUTH_SECRET"], "from-file")
            finally:
                if previous_key is None:
                    os.environ.pop("DEEPGRAM_API_KEY", None)
                else:
                    os.environ["DEEPGRAM_API_KEY"] = previous_key
                if previous_secret is None:
                    os.environ.pop("RELAY_AUTH_SECRET", None)
                else:
                    os.environ["RELAY_AUTH_SECRET"] = previous_secret


if __name__ == "__main__":
    unittest.main()
