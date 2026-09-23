"""Authenticated websocket relay. Browser PCM in, Deepgram Nova-3 out, lead JSON at the end.

The visitor cap is three minutes. DEEPGRAM_API_KEY is read from the environment
on this process only.
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any, Callable

import httpx
from fastapi import FastAPI, Request, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.leads import LeadStore, build_lead
from app.settings import Settings
from app.tokens import TokenError, issue_receipt, issue_token, new_session_id, read_receipt, read_token
from app.upstream import DeepgramUpstream, FakeUpstream, StreamClosed

log = logging.getLogger("stt_relay")

MAX_AUDIO_BYTES = 64 * 1024
# The browser posts the lead 2.5s after Stop if no cap arrives. Finalize plus the
# 1s drain stay inside that window. Close is bounded so a stalled provider cannot
# hold the browser socket open after the cap.
FINALIZE_DEADLINE_S = 1.0
CLOSE_DEADLINE_S = 1.0
HttpFactory = Callable[..., httpx.AsyncClient]


def create_app(
    settings: Settings | None = None,
    *,
    upstream_factory: Callable[[], Any] | None = None,
    http_client_factory: HttpFactory | None = None,
) -> FastAPI:
    settings = settings or Settings.from_env()
    if not settings.relay_auth_secret.strip():
        log.warning("RELAY_AUTH_SECRET is unset; session tokens will not be minted")
    if settings.production and not settings.durable_forwarder:
        log.warning("STT_RUNTIME=production without OMNISTUDIO_LEAD_URL; sessions will be refused")

    app = FastAPI(title="sfdc24-stt-relay", docs_url=None, redoc_url=None)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(settings.allowed_origins),
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["*"],
    )
    app.state.settings = settings
    app.state.store = LeadStore(settings.lead_sink_path)
    app.state.sessions = {}
    app.state.live = set()
    app.state.spent = {}
    app.state.hits = {}
    app.state.http_client_factory = http_client_factory or (lambda **kwargs: httpx.AsyncClient(**kwargs))

    def make_upstream():
        if settings.production and settings.fake_upstream:
            raise RuntimeError("fake_upstream_forbidden")
        if upstream_factory is not None:
            return upstream_factory()
        if settings.fake_upstream:
            return FakeUpstream()
        return DeepgramUpstream(settings.deepgram_api_key)

    app.state.make_upstream = make_upstream

    @app.get("/healthz")
    async def healthz() -> dict:
        return {
            "ok": True,
            "max_seconds": settings.max_seconds,
            "warn_seconds": settings.warn_seconds,
            "speech_configured": settings.speech_configured,
            "omnistudio_configured": settings.durable_forwarder,
            "fake_upstream": settings.fake_upstream,
            "runtime": _runtime_name(settings),
            "hosted": settings.hosted,
            "durable_forwarder": settings.durable_forwarder,
            "lead_sink": "forwarder" if settings.durable_forwarder else "development-only",
            "accepting_sessions": settings.accepting_sessions,
            "production_exposure": "blocked" if settings.production else "local",
        }

    @app.post("/v1/session")
    async def open_session(request: Request) -> JSONResponse:
        origin = request.headers.get("origin", "")
        if origin not in settings.allowed_origins:
            return JSONResponse({"error": "origin_not_allowed"}, status_code=403)
        _prune_sessions(app)
        if not settings.relay_auth_secret.strip():
            return JSONResponse({"error": "relay_auth_secret_missing"}, status_code=503)
        if settings.runtime_invalid:
            return JSONResponse({"error": "runtime_invalid"}, status_code=503)
        if settings.production and settings.fake_upstream:
            return JSONResponse({"error": "fake_upstream_forbidden"}, status_code=503)
        if settings.production and not settings.durable_forwarder:
            return JSONResponse({"error": "production_forwarder_missing"}, status_code=503)
        if not settings.speech_configured:
            return JSONResponse({"error": "speech_relay_unconfigured"}, status_code=503)
        if settings.production:
            # Origin plus the in-memory window is not a host-level quota.
            # Refuse public sessions until that control is actually available.
            return JSONResponse({"error": "production_exposure_blocked"}, status_code=503)
        ip = request.client.host if request.client else "unknown"
        if not _allow(app, ip):
            return JSONResponse({"error": "rate_limited"}, status_code=429)
        session_id = new_session_id()
        try:
            token = issue_token(
                settings.relay_auth_secret,
                session_id=session_id,
                ttl_seconds=settings.session_ttl,
                max_seconds=settings.max_seconds,
            )
        except TokenError:
            return JSONResponse({"error": "relay_auth_secret_missing"}, status_code=500)
        app.state.sessions[session_id] = {
            "transcript": "",
            "duration_s": 0,
            "cap_reason": "",
            "closed": False,
            "expires_at": _now(app) + settings.session_ttl,
        }
        return JSONResponse(
            {
                "session_id": session_id,
                "token": token,
                "stream_path": "/v1/stream",
                "max_seconds": settings.max_seconds,
                "warn_seconds": settings.warn_seconds,
            }
        )

    @app.websocket("/v1/stream")
    async def stream(websocket: WebSocket) -> None:
        origin = websocket.headers.get("origin", "")
        if origin not in settings.allowed_origins:
            await websocket.close(code=4403)
            return
        await websocket.accept()
        try:
            raw = await asyncio.wait_for(websocket.receive_text(), timeout=5)
        except (asyncio.TimeoutError, Exception):
            await _close(websocket, 4401)
            return
        try:
            import json

            auth = json.loads(raw)
        except Exception:
            await _close(websocket, 4401)
            return
        if not isinstance(auth, dict) or auth.get("type") != "auth":
            await _close(websocket, 4401)
            return
        try:
            claims = read_token(settings.relay_auth_secret, str(auth.get("token") or ""))
        except TokenError:
            await _close(websocket, 4401)
            return
        session_id = str(claims["sid"])
        if session_id in app.state.live or not _holds_open_stream(app, session_id):
            await _close(websocket, 4409)
            return
        # One stream authorization on this process. The expiry matches the token.
        # This map is not shared with another instance.
        row = app.state.sessions.get(session_id)
        expires_at = row.get("expires_at") if isinstance(row, dict) else None
        app.state.spent[session_id] = float(expires_at) if expires_at is not None else None
        app.state.live.add(session_id)
        try:
            await _run_stream(websocket, app, session_id)
        finally:
            app.state.live.discard(session_id)

    @app.post("/v1/leads")
    async def post_lead(request: Request) -> JSONResponse:
        origin = request.headers.get("origin", "")
        if origin not in settings.allowed_origins:
            return JSONResponse({"error": "origin_not_allowed"}, status_code=403)
        _prune_sessions(app)
        try:
            body = await request.json()
        except Exception:
            return JSONResponse({"error": "invalid_json"}, status_code=400)
        if not isinstance(body, dict):
            return JSONResponse({"error": "invalid_json"}, status_code=400)
        try:
            claims = read_token(settings.relay_auth_secret, str(body.get("token") or ""))
        except TokenError as exc:
            return JSONResponse({"error": str(exc)}, status_code=401)
        session_id = str(claims["sid"])
        if settings.production and not settings.durable_forwarder:
            return JSONResponse(
                {"ok": False, "error": "production_forwarder_missing", "durable": False},
                status_code=503,
            )
        heard = _heard_transcript(app, session_id, body)
        if isinstance(heard, JSONResponse):
            return heard
        visitor = body.get("visitor") if isinstance(body.get("visitor"), dict) else {}
        need = body.get("need") if isinstance(body.get("need"), str) else ""
        lead = build_lead(
            session_id=session_id,
            transcript=heard["transcript"],
            visitor=visitor,
            need=need,
            duration_s=heard["duration_s"],
            cap_reason=heard["cap_reason"],
        )
        if not settings.production:
            existing = app.state.store.get(session_id)
            if existing and existing.get("forwarded"):
                # Development file only. A later contact update must not forward twice
                # from this same process. Another instance does not see this flag.
                lead["omnistudio"] = existing.get("omnistudio") or lead["omnistudio"]
                lead["forwarded"] = True
                saved = app.state.store.upsert(lead)
                return _lead_response(settings, saved)
        saved = await _commit_lead(app, lead)
        if saved.get("forwarded") and session_id not in app.state.live:
            # The lead has left this process. Drop the transcript copy.
            # A signed receipt can still rebuild it on a later POST.
            app.state.sessions.pop(session_id, None)
        status = saved["omnistudio"].get("status")
        if settings.production and status != "forwarded":
            return JSONResponse(
                {
                    "ok": False,
                    "error": "forward_failed",
                    "sink": status,
                    "durable": False,
                    "runtime": "production",
                    "session_id": session_id,
                },
                status_code=502,
            )
        return _lead_response(settings, saved)

    @app.get("/v1/leads")
    async def list_leads(request: Request) -> JSONResponse:
        if settings.production or settings.runtime_invalid:
            return JSONResponse({"error": "development_sink_disabled"}, status_code=404)
        admin = request.headers.get("x-relay-admin", "")
        secret = settings.relay_admin_secret
        if not secret.strip() or not admin or not _eq(admin, secret):
            return JSONResponse({"error": "unauthorized"}, status_code=401)
        return JSONResponse(
            {
                "leads": app.state.store.list(),
                "runtime": "development",
                "durable": False,
                "lead_sink": "development-only",
            }
        )

    return app


def _eq(left: str, right: str) -> bool:
    import hmac

    a = left.encode("utf-8")
    b = right.encode("utf-8")
    if len(a) != len(b):
        hmac.compare_digest(a, a)
        return False
    return hmac.compare_digest(a, b)


def _runtime_name(settings: Settings) -> str:
    if settings.runtime_invalid:
        return "invalid"
    return "production" if settings.production else "development"


def _now(app: FastAPI) -> float:
    clock = getattr(app.state, "clock", None)
    if clock is not None:
        return float(clock())
    return time.time()


def _prune_sessions(app: FastAPI) -> None:
    """Drop abandoned in-memory sessions after their token TTL. Live sockets stay.

    This is process memory only. It is not a retention policy and not a database.
    A signed receipt still recovers a closed transcript after the row is gone.
    """
    now = _now(app)
    live = app.state.live
    stale = [
        sid
        for sid, row in app.state.sessions.items()
        if sid not in live and isinstance(row, dict) and row.get("expires_at") is not None and float(row["expires_at"]) <= now
    ]
    for sid in stale:
        app.state.sessions.pop(sid, None)
    spent = app.state.spent
    if isinstance(spent, dict):
        expired = [
            sid
            for sid, exp in spent.items()
            if sid not in live and exp is not None and float(exp) <= now
        ]
        for sid in expired:
            spent.pop(sid, None)


def _lead_response(settings: Settings, saved: dict) -> JSONResponse:
    status = saved["omnistudio"].get("status", "staged")
    return JSONResponse(
        {
            "ok": True,
            "sink": status,
            "durable": status == "forwarded",
            "runtime": _runtime_name(settings),
            "session_id": saved["session_id"],
            "lead": saved,
        }
    )


def _heard_transcript(app: FastAPI, session_id: str, body: dict) -> dict | JSONResponse:
    """Closed memory on this process, or a signed receipt. Never an empty success."""
    settings: Settings = app.state.settings
    receipt = None
    raw_receipt = body.get("receipt")
    if isinstance(raw_receipt, str) and raw_receipt.strip():
        try:
            receipt = read_receipt(settings.relay_auth_secret, raw_receipt.strip())
        except TokenError:
            return JSONResponse({"ok": False, "error": "invalid_receipt", "durable": False}, status_code=401)
        if str(receipt.get("sid") or "") != session_id:
            return JSONResponse({"ok": False, "error": "invalid_receipt", "durable": False}, status_code=401)
    sess = app.state.sessions.get(session_id)
    if sess and sess.get("closed"):
        return {
            "transcript": str(sess.get("transcript") or ""),
            "duration_s": float(sess.get("duration_s") or 0),
            "cap_reason": str(sess.get("cap_reason") or "visitor_stop"),
        }
    if receipt is not None:
        return {
            "transcript": str(receipt.get("transcript") or ""),
            "duration_s": float(receipt.get("duration_s") or 0),
            "cap_reason": str(receipt.get("cap_reason") or "visitor_stop"),
        }
    return JSONResponse(
        {
            "ok": False,
            "error": "session_not_retained",
            "durable": False,
            "runtime": _runtime_name(settings),
        },
        status_code=409,
    )


def _holds_open_stream(app: FastAPI, session_id: str) -> bool:
    """True only when this process still has an unclosed session row.

    ``spent`` maps a session id to the token expiry on this process. It is not
    cross-instance replay protection. A token this process does not hold, or
    has already used, does not open a provider stream. Production does not
    grow a shared store to answer that. Entries leave memory once the token
    can no longer be valid.
    """
    if session_id in app.state.spent:
        return False
    row = app.state.sessions.get(session_id)
    return isinstance(row, dict) and not row.get("closed")


def _allow(app: FastAPI, ip: str) -> bool:
    now = time.time()
    window = [stamp for stamp in app.state.hits.get(ip, []) if now - stamp < 3600]
    if len(window) >= 30:
        app.state.hits[ip] = window
        return False
    window.append(now)
    app.state.hits[ip] = window
    return True


async def _close(websocket: WebSocket, code: int) -> None:
    try:
        await websocket.close(code=code)
    except Exception:
        return


async def _send(websocket: WebSocket, payload: dict) -> bool:
    try:
        await websocket.send_json(payload)
        return True
    except Exception:
        return False


def _join_transcript(finals: list[str], interim: str) -> str:
    parts = [piece.strip() for piece in finals if piece and piece.strip()]
    if interim and interim.strip():
        parts.append(interim.strip())
    return " ".join(parts)


async def _run_stream(websocket: WebSocket, app: FastAPI, session_id: str) -> None:
    settings: Settings = app.state.settings
    upstream = app.state.make_upstream()
    try:
        await upstream.connect()
    except Exception:
        log.warning("upstream_connect_failed session=%s", session_id[:8])
        await _send(websocket, {"type": "error", "error": "upstream_unavailable"})
        await _close(websocket, 1011)
        return

    started = time.monotonic()
    finals: list[str] = []
    interim = {"text": ""}
    reason = {"value": ""}

    await _send(
        websocket,
        {
            "type": "ready",
            "session_id": session_id,
            "max_seconds": settings.max_seconds,
            "warn_seconds": settings.warn_seconds,
        },
    )

    async def from_upstream() -> None:
        while True:
            try:
                event = await upstream.recv()
            except StreamClosed:
                return
            if event is None:
                continue
            if event.is_final:
                finals.append(event.text)
                interim["text"] = ""
            else:
                interim["text"] = event.text
            await _send(
                websocket,
                {"type": "transcript", "text": event.text, "is_final": event.is_final},
            )

    async def from_client() -> None:
        import json

        while True:
            message = await websocket.receive()
            if message.get("type") == "websocket.disconnect":
                reason["value"] = reason["value"] or "disconnect"
                return
            data = message.get("bytes")
            if data:
                if len(data) > MAX_AUDIO_BYTES:
                    continue
                if time.monotonic() - started >= settings.max_seconds:
                    reason["value"] = "elapsed"
                    return
                try:
                    await upstream.send_audio(data)
                except Exception:
                    reason["value"] = reason["value"] or "upstream_lost"
                    return
                continue
            text = message.get("text")
            if not text:
                continue
            try:
                payload = json.loads(text)
            except json.JSONDecodeError:
                continue
            if isinstance(payload, dict) and payload.get("type") == "stop":
                reason["value"] = "visitor_stop"
                return

    async def clock() -> None:
        warn_after = max(0.0, settings.max_seconds - settings.warn_seconds)
        if settings.warn_seconds > 0 and warn_after > 0:
            await asyncio.sleep(warn_after)
            await _send(
                websocket,
                {"type": "warn", "remaining_s": round(settings.warn_seconds, 3)},
            )
            await asyncio.sleep(settings.max_seconds - warn_after)
        else:
            await asyncio.sleep(settings.max_seconds)
        reason["value"] = "elapsed"

    async def keepalive() -> None:
        while True:
            await asyncio.sleep(3)
            try:
                await upstream.keepalive()
            except Exception:
                return

    up_task = asyncio.create_task(from_upstream())
    client_task = asyncio.create_task(from_client())
    clock_task = asyncio.create_task(clock())
    keep_task = asyncio.create_task(keepalive())
    try:
        done, _pending = await asyncio.wait(
            {client_task, clock_task, up_task},
            return_when=asyncio.FIRST_COMPLETED,
        )
        if clock_task in done and not reason["value"]:
            reason["value"] = "elapsed"
        if up_task in done and not reason["value"]:
            reason["value"] = "upstream_lost"
        await _cancel_tasks(client_task, clock_task, keep_task, up_task)
        try:
            await asyncio.wait_for(upstream.finalize(), timeout=FINALIZE_DEADLINE_S)
        except Exception:
            log.warning("upstream_finalize_failed session=%s", session_id[:8])
        await _drain_upstream(upstream, websocket, finals, interim, timeout=1.0)
        cap_reason = reason["value"] or "visitor_stop"
        duration = min(settings.max_seconds, max(0.0, time.monotonic() - started))
        transcript = _join_transcript(finals, interim["text"])
        previous = app.state.sessions.get(session_id) if isinstance(app.state.sessions.get(session_id), dict) else {}
        app.state.sessions[session_id] = {
            "transcript": transcript,
            "duration_s": round(duration, 3),
            "cap_reason": cap_reason,
            "closed": True,
            "expires_at": previous.get("expires_at") or (_now(app) + settings.session_ttl),
        }
        if not settings.production:
            # Development file only. Production keeps the transcript in memory
            # on this process and in the signed receipt, then forwards on POST.
            _stage_development(app, session_id, transcript, duration, cap_reason)
        try:
            receipt = issue_receipt(
                settings.relay_auth_secret,
                session_id=session_id,
                transcript=transcript,
                duration_s=duration,
                cap_reason=cap_reason,
                ttl_seconds=settings.session_ttl,
            )
        except TokenError:
            receipt = ""
        await _send(
            websocket,
            {
                "type": "cap",
                "reason": cap_reason,
                "remaining_s": 0,
                "session_id": session_id,
                "receipt": receipt,
            },
        )
    finally:
        await _cancel_tasks(client_task, up_task, clock_task, keep_task)
        try:
            await asyncio.wait_for(upstream.close(), timeout=CLOSE_DEADLINE_S)
        except Exception:
            log.warning("upstream_close_failed session=%s", session_id[:8])
        await _close(websocket, 1000)


async def _cancel_tasks(*tasks: asyncio.Task) -> None:
    pending = []
    for task in tasks:
        if task is None or task.done():
            continue
        task.cancel()
        pending.append(task)
    if pending:
        await asyncio.gather(*pending, return_exceptions=True)


def _apply_transcript(finals: list[str], interim: dict, event) -> None:
    if event.is_final:
        finals.append(event.text)
        interim["text"] = ""
    else:
        interim["text"] = event.text


async def _drain_upstream(upstream, websocket: WebSocket, finals: list[str], interim: dict, timeout: float) -> None:
    """Read transcripts that arrive after Finalize, then stop. Do not close first."""
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while True:
        remaining = deadline - loop.time()
        if remaining <= 0:
            return
        try:
            event = await asyncio.wait_for(upstream.recv(), timeout=remaining)
        except asyncio.TimeoutError:
            return
        except StreamClosed:
            return
        if event is None:
            continue
        _apply_transcript(finals, interim, event)
        await _send(
            websocket,
            {"type": "transcript", "text": event.text, "is_final": event.is_final},
        )


def _stage_development(app: FastAPI, session_id: str, transcript: str, duration: float, cap_reason: str) -> None:
    existing = app.state.store.get(session_id)
    if existing is None:
        staged = build_lead(
            session_id=session_id,
            transcript=transcript,
            visitor={},
            need="",
            duration_s=duration,
            cap_reason=cap_reason,
        )
        staged["omnistudio"] = {"contract": "stt-lead-v1", "status": "staged"}
        app.state.store.upsert(staged)
        return
    existing["transcript"] = transcript or existing.get("transcript") or ""
    existing["duration_s"] = round(duration, 3)
    existing["cap_reason"] = cap_reason
    existing["summary"] = build_lead(
        session_id=session_id,
        transcript=existing["transcript"],
        visitor=existing.get("visitor") or {},
        need=existing.get("need") or "",
        duration_s=duration,
        cap_reason=cap_reason,
    )["summary"]
    app.state.store.upsert(existing)


def _handoff_confirmed(payload: object, lead: dict) -> bool:
    """Strict acknowledgment from the handoff. A JSON object is not enough.

    ``ok`` must be the boolean true. The body must name this contract, return
    the accepted record id, and echo this lead's session id.
    """
    if not isinstance(payload, dict):
        return False
    if payload.get("ok") is not True:
        return False
    if payload.get("contract") != "stt-lead-v1":
        return False
    record_id = payload.get("id")
    if not isinstance(record_id, str) or not record_id.strip():
        return False
    return payload.get("session_id") == lead.get("session_id")


async def _forward(app: FastAPI, lead: dict) -> dict:
    settings: Settings = app.state.settings
    url = settings.omnistudio_lead_url
    if not url:
        return {"contract": "stt-lead-v1", "status": "staged", "target": None}
    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    if settings.omnistudio_lead_token:
        headers["Authorization"] = "Bearer " + settings.omnistudio_lead_token
    try:
        async with app.state.http_client_factory(timeout=10, follow_redirects=False) as client:
            response = await client.post(url, json=lead, headers=headers)
    except Exception as exc:
        log.warning("omnistudio_forward_failed session=%s err=%s", lead["session_id"][:8], type(exc).__name__)
        return {
            "contract": "stt-lead-v1",
            "status": "staged_forward_failed",
            "target": "omnistudio",
            "error": type(exc).__name__,
        }
    if response.status_code < 200 or response.status_code >= 300:
        return {
            "contract": "stt-lead-v1",
            "status": "staged_forward_failed",
            "target": "omnistudio",
            "http_status": response.status_code,
        }
    try:
        payload = response.json()
    except Exception:
        return {
            "contract": "stt-lead-v1",
            "status": "staged_forward_failed",
            "target": "omnistudio",
            "http_status": response.status_code,
            "error": "malformed_handoff",
        }
    if not _handoff_confirmed(payload, lead):
        return {
            "contract": "stt-lead-v1",
            "status": "staged_forward_failed",
            "target": "omnistudio",
            "http_status": response.status_code,
            "error": "malformed_handoff",
        }
    return {
        "contract": "stt-lead-v1",
        "status": "forwarded",
        "target": "omnistudio",
        "http_status": response.status_code,
    }


async def _commit_lead(app: FastAPI, lead: dict) -> dict:
    outcome = await _forward(app, lead)
    lead["omnistudio"] = outcome
    lead["forwarded"] = outcome.get("status") == "forwarded"
    # Development "staged" is handled for this process's file only, so a later
    # POST does not write a second row. A failed forward stays retryable.
    # Production does not write that file and does not treat it as the record.
    if not app.state.settings.production and outcome.get("status") == "staged":
        lead["forwarded"] = True
    log.info("lead_result session=%s sink=%s", lead["session_id"][:8], outcome.get("status"))
    if app.state.settings.production:
        return lead
    return app.state.store.upsert(lead)


app = create_app()
