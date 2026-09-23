"""Relay contract: authenticated stream, 180s hard cap, staging lead sink."""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.leads import build_lead, extract_contacts  # noqa: E402
from app.main import _run_stream, create_app  # noqa: E402
from app.settings import HARD_CAP_SECONDS, Settings  # noqa: E402
from app.tokens import issue_receipt, issue_token, read_token  # noqa: E402
from app.upstream import DEEPGRAM_URL, FakeUpstream, Transcript, parse_deepgram_message  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from starlette.websockets import WebSocketDisconnect  # noqa: E402


def _settings(path: str, **overrides) -> Settings:
    base = dict(
        deepgram_api_key="unit-test-speech-key",
        relay_auth_secret="unit-test-secret",
        relay_admin_secret="unit-test-admin",
        allowed_origins=("http://testserver",),
        max_seconds=180.0,
        warn_seconds=30.0,
        session_ttl=240,
        lead_sink_path=path,
        omnistudio_lead_url="",
        omnistudio_lead_token="",
        fake_upstream=False,
        production=False,
        hosted=False,
        runtime_invalid=False,
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


class SessionLeadBook:
    """One Lead per session id, shared by every relay process.

    This models the Apex upsert. It is not the relay's memory.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.rows: dict[str, dict] = {}
        self.inserts = 0
        self.fail_before: set[str] = set()
        self.lose_ack: set[str] = set()

    def handle(self, request: httpx.Request) -> httpx.Response:
        lead = json.loads(request.content.decode("utf-8"))
        session_id = str(lead.get("session_id") or "")
        with self._lock:
            if session_id in self.fail_before:
                self.fail_before.discard(session_id)
                raise httpx.ConnectError("before write")
            row = self.rows.get(session_id)
            if row is None:
                self.inserts += 1
                row = {"id": f"00Q{self.inserts:015d}", "fields": {}}
                self.rows[session_id] = row
            salesforce = lead.get("salesforce") if isinstance(lead.get("salesforce"), dict) else {}
            for key in ("LastName", "Company", "Email", "Phone", "LeadSource", "Description"):
                value = salesforce.get(key)
                if isinstance(value, str) and value.strip():
                    row["fields"][key] = value.strip()
            record_id = row["id"]
            lost = session_id in self.lose_ack
            if lost:
                self.lose_ack.discard(session_id)
        if lost:
            raise httpx.ReadTimeout("ack lost after commit")
        return httpx.Response(
            201,
            json={
                "ok": True,
                "contract": "stt-lead-v1",
                "idempotency": "session_id",
                "id": record_id,
                "session_id": session_id,
            },
        )


class RelayTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.path = str(Path(self.tmp.name) / "leads.jsonl")

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _plant_closed(self, app, transcript: str = "need a call back"):
        session_id = "planted-" + str(len(app.state.sessions) + 1)
        token = issue_token(
            "unit-test-secret",
            session_id=session_id,
            ttl_seconds=600,
            max_seconds=180,
        )
        app.state.sessions[session_id] = {
            "transcript": transcript,
            "duration_s": 4,
            "cap_reason": "visitor_stop",
            "closed": True,
            "expires_at": time.time() + 600,
        }
        return token, session_id

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
            listed = client.get("/v1/leads", headers={"X-Relay-Admin": "unit-test-admin"})
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
            self.assertFalse(posted.json()["durable"])
            self.assertEqual(posted.json()["runtime"], "development")
            again = client.get("/v1/leads", headers={"X-Relay-Admin": "unit-test-admin"})
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
            wrong = client.get("/v1/leads", headers={"X-Relay-Admin": "not-the-admin-secret"})
            signing = client.get("/v1/leads", headers={"X-Relay-Admin": "unit-test-secret"})
            allowed = client.get("/v1/leads", headers={"X-Relay-Admin": "unit-test-admin"})
        self.assertEqual(denied.status_code, 401)
        self.assertEqual(wrong.status_code, 401)
        self.assertEqual(signing.status_code, 401)
        self.assertEqual(allowed.status_code, 200)
        self.assertFalse(allowed.json()["durable"])
        self.assertEqual(allowed.json()["lead_sink"], "development-only")

    def test_blank_secrets_fail_closed(self) -> None:
        source = (ROOT / "app" / "main.py").read_text(encoding="utf-8")
        self.assertNotIn("ephemeral-dev-secret", source)
        app = create_app(
            _settings(self.path, relay_auth_secret="   ", relay_admin_secret=""),
            upstream_factory=FakeUpstream,
        )
        with TestClient(app) as client:
            opened = client.post("/v1/session", headers={"Origin": "http://testserver"})
            listed = client.get("/v1/leads", headers={"X-Relay-Admin": "ephemeral-dev-secret"})
            health = client.get("/healthz")
        self.assertEqual(opened.status_code, 503)
        self.assertEqual(opened.json()["error"], "relay_auth_secret_missing")
        self.assertNotIn("token", opened.json())
        self.assertEqual(listed.status_code, 401)
        self.assertNotIn("ephemeral-dev-secret", opened.text + listed.text + health.text)
        self.assertFalse(health.json()["accepting_sessions"])

    def test_production_without_a_forwarder_refuses_sessions(self) -> None:
        app = create_app(
            _settings(self.path, production=True, omnistudio_lead_url=""),
            upstream_factory=FakeUpstream,
        )
        with TestClient(app) as client:
            health = client.get("/healthz")
            opened = client.post("/v1/session", headers={"Origin": "http://testserver"})
            listed = client.get("/v1/leads", headers={"X-Relay-Admin": "unit-test-admin"})
        self.assertEqual(health.json()["runtime"], "production")
        self.assertFalse(health.json()["durable_forwarder"])
        self.assertEqual(health.json()["lead_sink"], "development-only")
        self.assertFalse(health.json()["accepting_sessions"])
        self.assertEqual(opened.status_code, 503)
        self.assertEqual(opened.json()["error"], "production_forwarder_missing")
        self.assertEqual(listed.status_code, 404)
        self.assertEqual(listed.json()["error"], "development_sink_disabled")

    def test_production_refuses_the_fake_provider(self) -> None:
        app = create_app(
            _settings(
                self.path,
                production=True,
                fake_upstream=True,
                deepgram_api_key="unit-test-speech-key",
                omnistudio_lead_url="https://example.test/services/apexrest/stt/lead/v1",
            )
        )
        with TestClient(app) as client:
            opened = client.post("/v1/session", headers={"Origin": "http://testserver"})
        self.assertEqual(opened.status_code, 503)
        self.assertEqual(opened.json()["error"], "fake_upstream_forbidden")
        self.assertFalse(app.state.settings.accepting_sessions)
        with self.assertRaises(RuntimeError):
            app.state.make_upstream()

    def test_hosted_runtime_does_not_open_the_development_sink(self) -> None:
        keys = (
            "K_SERVICE",
            "STT_RUNTIME",
            "RELAY_AUTH_SECRET",
            "RELAY_ADMIN_SECRET",
            "DEEPGRAM_API_KEY",
            "OMNISTUDIO_LEAD_URL",
            "STT_FAKE_UPSTREAM",
            "LEAD_SINK_PATH",
            "ALLOWED_ORIGINS",
        )
        saved = {key: os.environ.get(key) for key in keys}

        def restore() -> None:
            for key, value in saved.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value

        def boot(runtime: str | None, *, hosted: bool, url: str = "", fake: str = "") -> TestClient:
            if hosted:
                os.environ["K_SERVICE"] = "fixture-cloud-run"
            else:
                os.environ.pop("K_SERVICE", None)
            if runtime is None:
                os.environ.pop("STT_RUNTIME", None)
            else:
                os.environ["STT_RUNTIME"] = runtime
            os.environ["RELAY_AUTH_SECRET"] = "unit-test-secret"
            os.environ["RELAY_ADMIN_SECRET"] = "unit-test-admin"
            os.environ["DEEPGRAM_API_KEY"] = "unit-test-speech-key"
            os.environ["STT_FAKE_UPSTREAM"] = fake
            os.environ["LEAD_SINK_PATH"] = self.path
            os.environ["ALLOWED_ORIGINS"] = "http://testserver"
            if url:
                os.environ["OMNISTUDIO_LEAD_URL"] = url
            else:
                os.environ.pop("OMNISTUDIO_LEAD_URL", None)
            app = create_app(Settings.from_env(), upstream_factory=FakeUpstream)
            return TestClient(app), app

        try:
            for runtime in (None, "development"):
                client, app = boot(runtime, hosted=True)
                with client:
                    opened = client.post("/v1/session", headers={"Origin": "http://testserver"})
                    listed = client.get("/v1/leads", headers={"X-Relay-Admin": "unit-test-admin"})
                self.assertTrue(app.state.settings.hosted)
                self.assertTrue(app.state.settings.production)
                self.assertEqual(opened.status_code, 503)
                self.assertEqual(opened.json()["error"], "production_forwarder_missing")
                self.assertEqual(listed.status_code, 404)
            client, app = boot("not-a-runtime", hosted=True, url="https://example.test/lead")
            with client:
                opened = client.post("/v1/session", headers={"Origin": "http://testserver"})
                listed = client.get("/v1/leads", headers={"X-Relay-Admin": "unit-test-admin"})
            self.assertTrue(app.state.settings.runtime_invalid)
            self.assertEqual(opened.status_code, 503)
            self.assertEqual(opened.json()["error"], "runtime_invalid")
            self.assertEqual(listed.status_code, 404)
            client, app = boot("production", hosted=True, url="https://example.test/lead", fake="1")
            with client:
                opened = client.post("/v1/session", headers={"Origin": "http://testserver"})
            self.assertEqual(opened.status_code, 503)
            self.assertEqual(opened.json()["error"], "fake_upstream_forbidden")
            with self.assertRaises(RuntimeError):
                app.state.make_upstream()
            client, app = boot(None, hosted=False, fake="1")
            with client:
                opened = client.post("/v1/session", headers={"Origin": "http://testserver"})
                listed = client.get("/v1/leads", headers={"X-Relay-Admin": "unit-test-admin"})
            self.assertFalse(app.state.settings.production)
            self.assertEqual(opened.status_code, 200)
            self.assertEqual(listed.status_code, 200)
            self.assertFalse(listed.json()["durable"])
            client, app = boot("development", hosted=False, fake="1")
            with client:
                opened = client.post("/v1/session", headers={"Origin": "http://testserver"})
            self.assertEqual(opened.status_code, 200)
            client, app = boot("staging", hosted=False, fake="1")
            with client:
                opened = client.post("/v1/session", headers={"Origin": "http://testserver"})
                listed = client.get("/v1/leads", headers={"X-Relay-Admin": "unit-test-admin"})
            self.assertEqual(opened.status_code, 503)
            self.assertEqual(opened.json()["error"], "runtime_invalid")
            self.assertNotEqual(listed.status_code, 200)
        finally:
            restore()

    def test_redirect_and_malformed_handoff_are_not_durable(self) -> None:
        calls = {"n": 0}

        def handler(request: httpx.Request) -> httpx.Response:
            calls["n"] += 1
            if calls["n"] == 1:
                return httpx.Response(302, headers={"location": "https://example.test/elsewhere"})
            return httpx.Response(200, content=b"not-json")

        def http_factory(**kwargs):
            self.assertFalse(kwargs.get("follow_redirects", True))
            return httpx.AsyncClient(transport=httpx.MockTransport(handler), follow_redirects=False)

        app, _holder = self._app(
            production=True,
            omnistudio_lead_url="https://example.test/services/apexrest/stt/lead/v1",
        )
        app.state.http_client_factory = http_factory
        token, _sid = self._plant_closed(app)
        with TestClient(app) as client:
            redirected = client.post(
                "/v1/leads",
                headers={"Origin": "http://testserver"},
                json={"token": token, "visitor": {"name": "Ada Lovelace", "company": "Northwind"}, "need": "automation"},
            )
            malformed = client.post(
                "/v1/leads",
                headers={"Origin": "http://testserver"},
                json={"token": token, "visitor": {"name": "Ada Lovelace", "company": "Northwind"}, "need": "automation"},
            )
        self.assertEqual(redirected.status_code, 502)
        self.assertFalse(redirected.json()["durable"])
        self.assertEqual(redirected.json()["error"], "forward_failed")
        self.assertEqual(malformed.status_code, 502)
        self.assertFalse(malformed.json()["durable"])
        self.assertEqual(calls["n"], 2)

    def test_lead_body_must_be_an_object(self) -> None:
        app, _holder = self._app()
        with TestClient(app) as client:
            for payload in ("[]", "null", '"text"', "42"):
                response = client.post(
                    "/v1/leads",
                    content=payload,
                    headers={"Origin": "http://testserver", "Content-Type": "application/json"},
                )
                self.assertEqual(response.status_code, 400, payload)
                self.assertEqual(response.json()["error"], "invalid_json")

    def test_abandoned_sessions_expire_without_dropping_a_live_one_or_a_receipt(self) -> None:
        from app.tokens import issue_receipt

        app, _holder = self._app(session_ttl=240)
        now = {"t": 1_000_000.0}
        app.state.clock = lambda: now["t"]
        with TestClient(app) as client:
            opened = client.post("/v1/session", headers={"Origin": "http://testserver"})
            abandoned = opened.json()["session_id"]
            token = opened.json()["token"]
            app.state.sessions["active"] = {
                "transcript": "still talking",
                "duration_s": 1,
                "cap_reason": "",
                "closed": False,
                "expires_at": now["t"] - 10,
            }
            app.state.live.add("active")
            now["t"] += 3600
            later = client.post("/v1/session", headers={"Origin": "http://testserver"})
            self.assertNotIn(abandoned, app.state.sessions)
            self.assertIn("active", app.state.sessions)
            app.state.live.discard("active")
            client.post("/v1/session", headers={"Origin": "http://testserver"})
            self.assertNotIn("active", app.state.sessions)
            receipt = issue_receipt(
                "unit-test-secret",
                session_id=abandoned,
                transcript="please call back about automation",
                duration_s=3,
                cap_reason="visitor_stop",
                ttl_seconds=600,
            )
            kept = client.post(
                "/v1/leads",
                headers={"Origin": "http://testserver"},
                json={"token": token, "receipt": receipt, "visitor": {"name": "Ada"}, "need": "automation"},
            )
        self.assertEqual(kept.status_code, 200)
        self.assertIn("automation", kept.json()["lead"]["transcript"])
        self.assertNotIn(abandoned, app.state.sessions)

    def test_a_restarted_process_does_not_invent_an_empty_transcript(self) -> None:
        app, _holder = self._app(max_seconds=30, warn_seconds=5, session_ttl=120)
        with TestClient(app) as client:
            opened = client.post("/v1/session", headers={"Origin": "http://testserver"})
            self.assertEqual(opened.status_code, 200)
            token = opened.json()["token"]
            session_id = opened.json()["session_id"]
            receipt = ""
            with client.websocket_connect("/v1/stream", headers={"origin": "http://testserver"}) as ws:
                ws.send_json({"type": "auth", "token": token})
                deadline = time.time() + 3
                while time.time() < deadline and not receipt:
                    msg = ws.receive_json()
                    if msg["type"] == "ready":
                        ws.send_json({"type": "stop"})
                    if msg["type"] == "cap":
                        receipt = msg["receipt"]
            self.assertTrue(receipt)
        other_path = str(Path(self.tmp.name) / "restarted.jsonl")
        other = create_app(_settings(other_path), upstream_factory=FakeUpstream)
        other.state.store.upsert(
            build_lead(
                session_id=session_id,
                transcript="",
                visitor={},
                need="",
                duration_s=0,
                cap_reason="visitor_stop",
            )
        )
        with TestClient(other) as client:
            missing = client.post(
                "/v1/leads",
                headers={"Origin": "http://testserver"},
                json={"token": token, "visitor": {"name": "Ada Lovelace"}, "need": "automation"},
            )
            self.assertEqual(missing.status_code, 409)
            self.assertFalse(missing.json()["ok"])
            self.assertEqual(missing.json()["error"], "session_not_retained")
            self.assertNotIn("lead", missing.json())
            self.assertFalse(missing.json()["durable"])
            tampered = receipt[:-1] + ("a" if receipt[-1] != "a" else "b")
            bad = client.post(
                "/v1/leads",
                headers={"Origin": "http://testserver"},
                json={"token": token, "receipt": tampered, "visitor": {"name": "Ada Lovelace"}, "need": "automation"},
            )
            self.assertEqual(bad.status_code, 401)
            self.assertEqual(bad.json()["error"], "invalid_receipt")
            kept = client.post(
                "/v1/leads",
                headers={"Origin": "http://testserver"},
                json={"token": token, "receipt": receipt, "visitor": {"name": "Ada Lovelace"}, "need": "automation"},
            )
        self.assertEqual(kept.status_code, 200)
        self.assertIn("automation", kept.json()["lead"]["transcript"])
        self.assertFalse(kept.json()["durable"])
        self.assertEqual(kept.json()["runtime"], "development")

    def test_finalize_drains_a_delayed_terminal_transcript(self) -> None:
        class LateUpstream(FakeUpstream):
            def __init__(self) -> None:
                super().__init__()
                self.marks: list[str] = []

            async def connect(self) -> None:
                self.connected = True

            async def finalize(self) -> None:
                self.finalized = True
                self.marks.append("finalize")

                async def later() -> None:
                    await asyncio.sleep(0.05)
                    await self.queue.put(Transcript("late final from the provider", True))
                    await self.queue.put(None)

                asyncio.create_task(later())

            async def close(self) -> None:
                self.marks.append("close")
                await super().close()

        holder = {"upstream": None}

        def factory():
            holder["upstream"] = LateUpstream()
            return holder["upstream"]

        app = create_app(_settings(self.path, max_seconds=30, warn_seconds=5, session_ttl=60), upstream_factory=factory)
        with TestClient(app) as client:
            opened = client.post("/v1/session", headers={"Origin": "http://testserver"})
            token = opened.json()["token"]
            with client.websocket_connect("/v1/stream", headers={"origin": "http://testserver"}) as ws:
                ws.send_json({"type": "auth", "token": token})
                cap = None
                deadline = time.time() + 3
                while time.time() < deadline and cap is None:
                    msg = ws.receive_json()
                    if msg["type"] == "ready":
                        ws.send_json({"type": "stop"})
                    if msg["type"] == "cap":
                        cap = msg
            posted = client.post(
                "/v1/leads",
                headers={"Origin": "http://testserver"},
                json={"token": token, "receipt": cap["receipt"], "visitor": {"name": "Ada"}, "need": "late"},
            )
        self.assertEqual(holder["upstream"].marks, ["finalize", "close"])
        self.assertIn("late final from the provider", posted.json()["lead"]["transcript"])

    def _stop_until_cap(self, app, session_id: str) -> dict:
        """Fail if a stalled provider never releases the socket. No SIGALRM."""

        class BoundSocket:
            def __init__(self) -> None:
                self.sent: list[dict] = []
                self.closed = None
                self._stopped = False

            async def send_json(self, payload: dict) -> None:
                self.sent.append(payload)

            async def close(self, code: int = 1000) -> None:
                self.closed = code

            async def receive(self) -> dict:
                while not any(item.get("type") == "ready" for item in self.sent):
                    await asyncio.sleep(0.001)
                if not self._stopped:
                    self._stopped = True
                    return {"type": "websocket.receive", "text": json.dumps({"type": "stop"})}
                await asyncio.Event().wait()
                return {"type": "websocket.disconnect"}

        socket = BoundSocket()
        started = time.monotonic()
        asyncio.run(asyncio.wait_for(_run_stream(socket, app, session_id), timeout=6))
        caps = [item for item in socket.sent if item.get("type") == "cap"]
        return {"cap": caps[-1], "elapsed": time.monotonic() - started, "closed": socket.closed}

    def test_a_hanging_finalize_still_caps_with_words_already_heard(self) -> None:
        class HangFinalize(FakeUpstream):
            def __init__(self) -> None:
                super().__init__()
                self.finalize_returned = False

            async def finalize(self) -> None:
                await asyncio.Event().wait()
                self.finalize_returned = True

        holder = {"upstream": None}

        def factory():
            holder["upstream"] = HangFinalize()
            return holder["upstream"]

        app = create_app(_settings(self.path, max_seconds=30, warn_seconds=5), upstream_factory=factory)
        with TestClient(app) as client:
            opened = client.post("/v1/session", headers={"Origin": "http://testserver"})
        session_id = opened.json()["session_id"]
        done = self._stop_until_cap(app, session_id)
        row = app.state.sessions.get(session_id)
        self.assertLess(done["elapsed"], 5.5)
        self.assertEqual(done["closed"], 1000)
        self.assertFalse(holder["upstream"].finalize_returned)
        self.assertTrue(holder["upstream"].closed)
        self.assertIsNotNone(row)
        self.assertTrue(row["closed"])
        self.assertIn("automation", row["transcript"])
        self.assertEqual(done["cap"]["type"], "cap")
        self.assertTrue(done["cap"]["receipt"])

    def test_a_hanging_close_still_releases_the_browser_socket(self) -> None:
        class HangClose(FakeUpstream):
            def __init__(self) -> None:
                super().__init__()
                self.close_returned = False

            async def close(self) -> None:
                await asyncio.Event().wait()
                self.close_returned = True

        holder = {"upstream": None}

        def factory():
            holder["upstream"] = HangClose()
            return holder["upstream"]

        app = create_app(_settings(self.path, max_seconds=30, warn_seconds=5), upstream_factory=factory)
        with TestClient(app) as client:
            opened = client.post("/v1/session", headers={"Origin": "http://testserver"})
        session_id = opened.json()["session_id"]
        done = self._stop_until_cap(app, session_id)
        row = app.state.sessions.get(session_id)
        self.assertLess(done["elapsed"], 4.5)
        self.assertEqual(done["closed"], 1000)
        self.assertTrue(holder["upstream"].finalized)
        self.assertFalse(holder["upstream"].close_returned)
        self.assertTrue(row["closed"])
        self.assertIn("automation", row["transcript"])
        self.assertEqual(done["cap"]["reason"], "visitor_stop")

    def test_spent_ids_leave_memory_only_after_the_token_expires(self) -> None:
        app, _holder = self._app(session_ttl=240, max_seconds=30, warn_seconds=5)
        now = {"t": 1_000_000.0}
        app.state.clock = lambda: now["t"]
        with TestClient(app) as client:
            opened = client.post("/v1/session", headers={"Origin": "http://testserver"})
            token = opened.json()["token"]
            session_id = opened.json()["session_id"]
            with client.websocket_connect("/v1/stream", headers={"origin": "http://testserver"}) as ws:
                ws.send_json({"type": "auth", "token": token})
                receipt = ""
                while not receipt:
                    msg = ws.receive_json()
                    if msg["type"] == "ready":
                        ws.send_json({"type": "stop"})
                    if msg["type"] == "cap":
                        receipt = msg["receipt"]
            self.assertEqual(app.state.spent[session_id], 1_000_240.0)
            now["t"] += 60
            app.state.spent["still-live"] = now["t"] - 1
            app.state.live.add("still-live")
            client.post("/v1/session", headers={"Origin": "http://testserver"})
            self.assertIn(session_id, app.state.spent)
            self.assertIn("still-live", app.state.spent)
            with self.assertRaises(WebSocketDisconnect) as replay:
                with client.websocket_connect("/v1/stream", headers={"origin": "http://testserver"}) as ws:
                    ws.send_json({"type": "auth", "token": token})
                    ws.receive_json()
            self.assertEqual(replay.exception.code, 4409)
            posted = client.post(
                "/v1/leads",
                headers={"Origin": "http://testserver"},
                json={"token": token, "receipt": receipt, "visitor": {"name": "Ada"}, "need": "automation"},
            )
            self.assertEqual(posted.status_code, 200)
            self.assertIn("automation", posted.json()["lead"]["transcript"])
            self.assertNotIn(session_id, app.state.sessions)
            self.assertIn(session_id, app.state.spent)
            now["t"] = 1_000_241.0
            app.state.live.discard("still-live")
            client.post("/v1/session", headers={"Origin": "http://testserver"})
            self.assertNotIn(session_id, app.state.spent)
            self.assertNotIn("still-live", app.state.spent)
            with self.assertRaises(WebSocketDisconnect) as expired:
                with client.websocket_connect("/v1/stream", headers={"origin": "http://testserver"}) as again:
                    again.send_json({"type": "auth", "token": token})
                    again.receive_json()
            self.assertEqual(expired.exception.code, 4409)

    def test_production_forward_failure_is_not_a_durable_success(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(503, json={"ok": False})

        def http_factory(**kwargs):
            return httpx.AsyncClient(transport=httpx.MockTransport(handler))

        app, _holder = self._app(
            production=True,
            omnistudio_lead_url="https://example.test/services/apexrest/stt/lead/v1",
            omnistudio_lead_token="omni-token",
        )
        app.state.http_client_factory = http_factory
        token, _sid = self._plant_closed(app)
        with TestClient(app) as client:
            posted = client.post(
                "/v1/leads",
                headers={"Origin": "http://testserver"},
                json={"token": token, "visitor": {"name": "Grace Hopper", "company": "Navy"}, "need": "automation"},
            )
            self.assertFalse(app.state.store.path.is_file())
        self.assertEqual(posted.status_code, 502)
        self.assertFalse(posted.json()["ok"])
        self.assertFalse(posted.json()["durable"])
        self.assertEqual(posted.json()["error"], "forward_failed")

    def test_forwards_to_omnistudio_when_configured(self) -> None:
        seen = {}

        def handler(request: httpx.Request) -> httpx.Response:
            seen["auth"] = request.headers.get("authorization")
            seen["body"] = json.loads(request.content.decode("utf-8"))
            return httpx.Response(201, json={
                "ok": True,
                "contract": "stt-lead-v1",
                "idempotency": "session_id",
                "id": "00Q000000000001",
                "session_id": seen["body"]["session_id"],
            })

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
        self.assertTrue(posted.json()["durable"])
        self.assertEqual(seen["auth"], "Bearer omni-token")
        self.assertEqual(seen["body"]["salesforce"]["Email"], "grace@example.com")
        self.assertNotIn("unit-test-speech-key", json.dumps(seen["body"]))
        self.assertNotIn("omni-token", json.dumps(seen["body"]))

    def test_handoff_requires_a_boolean_ack_and_record_identity(self) -> None:
        script = [
            {},
            {"error": "not_saved"},
            {"ok": 0},
            {"ok": "false"},
            {
                "ok": True,
                "contract": "stt-lead-v1",
                "id": "00Q000000000008",
                "session_id": None,
            },
            {
                "ok": True,
                "contract": "stt-lead-v1",
                "idempotency": "session_id",
                "id": "00Q000000000009",
                "session_id": None,
            },
        ]

        def handler(request: httpx.Request) -> httpx.Response:
            body = json.loads(request.content.decode("utf-8"))
            payload = script.pop(0)
            if payload.get("session_id") is None and payload.get("ok") is True:
                payload = dict(payload)
                payload["session_id"] = body["session_id"]
            return httpx.Response(200, json=payload)

        def http_factory(**kwargs):
            self.assertFalse(kwargs.get("follow_redirects", True))
            return httpx.AsyncClient(transport=httpx.MockTransport(handler), follow_redirects=False)

        app, _holder = self._app(
            production=True,
            omnistudio_lead_url="https://example.test/services/apexrest/stt/lead/v1",
        )
        app.state.http_client_factory = http_factory
        token, _sid = self._plant_closed(app, transcript="please call back about automation")
        with TestClient(app) as client:
            for _case in range(5):
                posted = client.post(
                    "/v1/leads",
                    headers={"Origin": "http://testserver"},
                    json={"token": token, "visitor": {"name": "Ada Lovelace", "company": "Northwind"}, "need": "automation"},
                )
                self.assertEqual(posted.status_code, 502)
                self.assertFalse(posted.json()["ok"])
                self.assertFalse(posted.json()["durable"])
                self.assertEqual(posted.json()["error"], "forward_failed")
            confirmed = client.post(
                "/v1/leads",
                headers={"Origin": "http://testserver"},
                json={"token": token, "visitor": {"name": "Ada Lovelace", "company": "Northwind"}, "need": "automation"},
            )
        self.assertEqual(confirmed.status_code, 200)
        self.assertTrue(confirmed.json()["ok"])
        self.assertTrue(confirmed.json()["durable"])
        self.assertEqual(confirmed.json()["sink"], "forwarded")
        self.assertEqual(script, [])

    def test_one_session_key_is_one_lead_including_a_lost_ack(self) -> None:
        book = SessionLeadBook()

        def http_factory(**kwargs):
            self.assertFalse(kwargs.get("follow_redirects", True))
            return httpx.AsyncClient(transport=httpx.MockTransport(book.handle), follow_redirects=False)

        def boot():
            app, _holder = self._app(
                production=True,
                omnistudio_lead_url="https://example.test/services/apexrest/stt/lead/v1",
                omnistudio_lead_token="omni-token",
            )
            app.state.http_client_factory = http_factory
            return app

        def minted(session_id: str):
            token = issue_token("unit-test-secret", session_id=session_id, ttl_seconds=600, max_seconds=180)
            receipt = issue_receipt(
                "unit-test-secret",
                session_id=session_id,
                transcript="please call back about automation",
                duration_s=4,
                cap_reason="visitor_stop",
                ttl_seconds=600,
            )
            return token, receipt

        def post(app, token: str, receipt: str, visitor: dict):
            with TestClient(app) as client:
                return client.post(
                    "/v1/leads",
                    headers={"Origin": "http://testserver"},
                    json={"token": token, "receipt": receipt, "visitor": visitor, "need": "automation"},
                )

        token, receipt = minted("sess-same")
        first = post(boot(), token, receipt, {"name": "Ada Lovelace", "company": "Northwind"})
        second = post(boot(), token, receipt, {"name": "Ada Lovelace", "company": "Northwind", "phone": "4165550199"})
        third = post(boot(), token, receipt, {"name": "Ada Lovelace", "company": "Northwind", "email": "ada@example.com"})
        self.assertEqual(first.status_code, 200)
        self.assertTrue(first.json()["durable"])
        lead_id = first.json()["lead"]["omnistudio"]["id"]
        self.assertEqual(second.json()["lead"]["omnistudio"]["id"], lead_id)
        self.assertEqual(third.json()["lead"]["omnistudio"]["id"], lead_id)
        self.assertTrue(third.json()["durable"])
        self.assertEqual(book.inserts, 1)
        self.assertEqual(book.rows["sess-same"]["fields"]["Phone"], "4165550199")
        self.assertEqual(book.rows["sess-same"]["fields"]["Email"], "ada@example.com")

        token_c, receipt_c = minted("sess-race")
        raced: list = []

        def race(app) -> None:
            raced.append(post(app, token_c, receipt_c, {"name": "Grace Hopper", "company": "Navy"}))

        workers = [threading.Thread(target=race, args=(boot(),)), threading.Thread(target=race, args=(boot(),))]
        for worker in workers:
            worker.start()
        for worker in workers:
            worker.join()
        self.assertEqual(len(raced), 2)
        self.assertTrue(all(item.status_code == 200 and item.json()["durable"] for item in raced))
        self.assertEqual(raced[0].json()["lead"]["omnistudio"]["id"], raced[1].json()["lead"]["omnistudio"]["id"])
        self.assertEqual(book.inserts, 2)

        token_e, receipt_e = minted("sess-lost")
        book.lose_ack.add("sess-lost")
        lost = post(boot(), token_e, receipt_e, {"name": "Ada Lovelace", "company": "Northwind"})
        self.assertEqual(lost.status_code, 502)
        self.assertEqual(lost.json()["error"], "handoff_unknown")
        self.assertFalse(lost.json()["durable"])
        self.assertIn("sess-lost", book.rows)
        after_loss = book.inserts
        recovered = post(boot(), token_e, receipt_e, {"name": "Ada Lovelace", "company": "Northwind", "phone": "4165550100"})
        self.assertEqual(recovered.status_code, 200)
        self.assertEqual(recovered.json()["lead"]["omnistudio"]["id"], book.rows["sess-lost"]["id"])
        self.assertEqual(book.inserts, after_loss)
        self.assertEqual(book.rows["sess-lost"]["fields"]["Phone"], "4165550100")

        token_f, receipt_f = minted("sess-early")
        book.fail_before.add("sess-early")
        early = post(boot(), token_f, receipt_f, {"name": "Ada Lovelace", "company": "Northwind"})
        self.assertEqual(early.status_code, 502)
        self.assertEqual(early.json()["error"], "forward_failed")
        self.assertFalse(early.json()["durable"])
        self.assertNotIn("sess-early", book.rows)
        retried = post(boot(), token_f, receipt_f, {"name": "Ada Lovelace", "company": "Northwind"})
        self.assertEqual(retried.status_code, 200)
        self.assertTrue(retried.json()["durable"])
        self.assertEqual(book.inserts, after_loss + 1)

        token_g, receipt_g = minted("sess-other")
        other = post(boot(), token_g, receipt_g, {"name": "Katherine Johnson", "company": "NACA"})
        self.assertEqual(other.status_code, 200)
        self.assertNotEqual(other.json()["lead"]["omnistudio"]["id"], lead_id)
        self.assertEqual(book.inserts, after_loss + 2)

        source = (ROOT / "handoff" / "SttLeadIntake.cls").read_text(encoding="utf-8")
        self.assertIn("upsert row Stt_Session_Id__c", source)
        self.assertNotIn("insert row;", source)
        self.assertIn("'idempotency' => 'session_id'", source)
        field = (ROOT / "handoff" / "objects" / "Lead" / "fields" / "Stt_Session_Id__c.field-meta.xml").read_text(encoding="utf-8")
        self.assertIn("<externalId>true</externalId>", field)
        self.assertIn("<unique>true</unique>", field)
        self.assertIn("not executed against an org", source)

    def test_a_closed_token_does_not_open_a_second_upstream(self) -> None:
        created = []

        def factory():
            upstream = FakeUpstream()
            created.append(upstream)
            return upstream

        app = create_app(_settings(self.path), upstream_factory=factory)
        with TestClient(app) as client:
            opened = client.post("/v1/session", headers={"Origin": "http://testserver"})
            token = opened.json()["token"]
            session_id = opened.json()["session_id"]
            receipt = ""
            with client.websocket_connect("/v1/stream", headers={"origin": "http://testserver"}) as ws:
                ws.send_json({"type": "auth", "token": token})
                while True:
                    msg = ws.receive_json()
                    if msg["type"] == "ready":
                        ws.send_json({"type": "stop"})
                    if msg["type"] == "cap":
                        receipt = msg["receipt"]
                        break
            self.assertEqual(len(created), 1)
            with self.assertRaises(WebSocketDisconnect) as closed:
                with client.websocket_connect("/v1/stream", headers={"origin": "http://testserver"}) as ws:
                    ws.send_json({"type": "auth", "token": token})
                    ws.receive_json()
            self.assertEqual(closed.exception.code, 4409)
            self.assertEqual(len(created), 1)
            posted = client.post(
                "/v1/leads",
                headers={"Origin": "http://testserver"},
                json={"token": token, "receipt": receipt, "visitor": {"name": "Ada"}, "need": "automation"},
            )
            self.assertEqual(posted.status_code, 200)
            self.assertIn("automation", posted.json()["lead"]["transcript"])
            self.assertNotIn(session_id, app.state.sessions)
            with self.assertRaises(WebSocketDisconnect):
                with client.websocket_connect("/v1/stream", headers={"origin": "http://testserver"}) as ws:
                    ws.send_json({"type": "auth", "token": token})
                    ws.receive_json()
            self.assertEqual(len(created), 1)

    def test_production_refuses_a_stream_it_does_not_hold(self) -> None:
        created = []

        def factory():
            created.append(FakeUpstream())
            return created[-1]

        app = create_app(
            _settings(
                self.path,
                production=True,
                omnistudio_lead_url="https://example.test/services/apexrest/stt/lead/v1",
            ),
            upstream_factory=factory,
        )
        token = issue_token("unit-test-secret", session_id="other-instance", ttl_seconds=600, max_seconds=180)
        with TestClient(app) as client:
            with self.assertRaises(WebSocketDisconnect) as closed:
                with client.websocket_connect("/v1/stream", headers={"origin": "http://testserver"}) as ws:
                    ws.send_json({"type": "auth", "token": token})
                    ws.receive_json()
        self.assertEqual(closed.exception.code, 4409)
        self.assertEqual(created, [])

    def test_rate_limit_is_per_process_and_production_stays_closed(self) -> None:
        first, _holder = self._app()
        with TestClient(first) as client:
            statuses = [
                client.post("/v1/session", headers={"Origin": "http://testserver"}).status_code
                for _ in range(31)
            ]
        self.assertEqual(statuses[:30], [200] * 30)
        self.assertEqual(statuses[30], 429)
        second, _other = self._app()
        with TestClient(second) as client:
            fresh = client.post("/v1/session", headers={"Origin": "http://testserver"})
        self.assertEqual(fresh.status_code, 200)
        blocked, _blocked = self._app(
            production=True,
            omnistudio_lead_url="https://example.test/services/apexrest/stt/lead/v1",
            deepgram_api_key="unit-test-speech-key",
        )
        with TestClient(blocked) as client:
            health = client.get("/healthz")
            opened = client.post("/v1/session", headers={"Origin": "http://testserver"})
        self.assertFalse(health.json()["accepting_sessions"])
        self.assertEqual(health.json()["production_exposure"], "blocked")
        self.assertEqual(opened.status_code, 503)
        self.assertEqual(opened.json()["error"], "production_exposure_blocked")
        doc = (ROOT.parents[1] / "docs" / "STT-STREAM.md").read_text(encoding="utf-8")
        self.assertIn("production_exposure_blocked", doc)
        self.assertIn("not a host-level quota", doc)

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
        repo = ROOT.parents[1]
        workflow = (repo / ".github" / "workflows" / "stt-stream.yml").read_text(encoding="utf-8")
        self.assertNotIn("actions/setup-python@v6\n", workflow)
        self.assertEqual(workflow.count("actions/setup-python@ece7cb06caefa5fff74198d8649806c4678c61a1 # v6.3.0"), 2)
        doc = (repo / "docs" / "STT-STREAM.md").read_text(encoding="utf-8")
        self.assertIn("^|^", doc)
        self.assertNotIn("RELAY_AUTH_SECRET=REPLACE,ALLOWED_ORIGINS", doc)
        self.assertNotIn("local-dev-secret", doc)

    def test_smoke_exits_when_the_variable_is_missing(self) -> None:
        env = os.environ.copy()
        env.pop("DEEPGRAM_API_KEY", None)
        # Do not fall through to the laptop Blackboard file during this test.
        env["BLACKBOARD_ENV"] = str(ROOT / "missing-blackboard.env")
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
        self.assertIn("DEEPGRAM_API_KEY is not in the process environment", result.stderr)
        self.assertIn(str(ROOT / "missing-blackboard.env"), result.stderr)
        self.assertNotIn("Token", result.stderr)
        from app.envfile import VANLAS_BLACKBOARD_ENV, blackboard_label

        previous_board = os.environ.get("BLACKBOARD_ENV")
        os.environ.pop("BLACKBOARD_ENV", None)
        try:
            self.assertEqual(blackboard_label(None), VANLAS_BLACKBOARD_ENV)
        finally:
            if previous_board is None:
                os.environ.pop("BLACKBOARD_ENV", None)
            else:
                os.environ["BLACKBOARD_ENV"] = previous_board

    def test_vanlas_blackboard_file_supplies_the_key_without_overriding_process_env(self) -> None:
        from app.envfile import VANLAS_BLACKBOARD_ENV, resolve_deepgram_key

        self.assertEqual(VANLAS_BLACKBOARD_ENV, r"C:\Users\salam\Quantum\Blackboard\.env")
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / ".env"
            path.write_text(
                "DEEPGRAM_API_KEY=from-blackboard\nOTHER_SECRET=do-not-load\n",
                encoding="utf-8",
            )
            previous_key = os.environ.get("DEEPGRAM_API_KEY")
            previous_board = os.environ.get("BLACKBOARD_ENV")
            previous_other = os.environ.get("OTHER_SECRET")
            os.environ.pop("DEEPGRAM_API_KEY", None)
            os.environ.pop("OTHER_SECRET", None)
            os.environ["BLACKBOARD_ENV"] = str(path)
            try:
                key, source = resolve_deepgram_key(None)
                self.assertEqual(key, "from-blackboard")
                self.assertEqual(source, str(path))
                self.assertNotIn("OTHER_SECRET", os.environ)
                os.environ["DEEPGRAM_API_KEY"] = "from-process"
                key, source = resolve_deepgram_key(None)
                self.assertEqual(key, "from-process")
                self.assertEqual(source, "process")
            finally:
                if previous_key is None:
                    os.environ.pop("DEEPGRAM_API_KEY", None)
                else:
                    os.environ["DEEPGRAM_API_KEY"] = previous_key
                if previous_board is None:
                    os.environ.pop("BLACKBOARD_ENV", None)
                else:
                    os.environ["BLACKBOARD_ENV"] = previous_board
                if previous_other is None:
                    os.environ.pop("OTHER_SECRET", None)
                else:
                    os.environ["OTHER_SECRET"] = previous_other

    def test_dotenv_does_not_override_the_process_environment(self) -> None:
        from app.envfile import load_unset

        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / ".env"
            path.write_text("RELAY_AUTH_SECRET=from-file\n", encoding="utf-8")
            previous_secret = os.environ.get("RELAY_AUTH_SECRET")
            os.environ["RELAY_AUTH_SECRET"] = "from-process"
            try:
                load_unset(path, ("RELAY_AUTH_SECRET",))
                self.assertEqual(os.environ["RELAY_AUTH_SECRET"], "from-process")
                os.environ.pop("RELAY_AUTH_SECRET", None)
                load_unset(path, ("RELAY_AUTH_SECRET",))
                self.assertEqual(os.environ["RELAY_AUTH_SECRET"], "from-file")
            finally:
                if previous_secret is None:
                    os.environ.pop("RELAY_AUTH_SECRET", None)
                else:
                    os.environ["RELAY_AUTH_SECRET"] = previous_secret


if __name__ == "__main__":
    unittest.main()
