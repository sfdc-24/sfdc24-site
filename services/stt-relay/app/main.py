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
from app.tokens import TokenError, issue_token, new_session_id, read_token
from app.upstream import DeepgramUpstream, FakeUpstream

log = logging.getLogger("stt_relay")

MAX_AUDIO_BYTES = 64 * 1024
HttpFactory = Callable[..., httpx.AsyncClient]


def create_app(
    settings: Settings | None = None,
    *,
    upstream_factory: Callable[[], Any] | None = None,
    http_client_factory: HttpFactory | None = None,
) -> FastAPI:
    settings = settings or Settings.from_env()
    if not settings.relay_auth_secret:
        # Ephemeral secret so a local process can still mint tokens.
        # Cloud Run must set RELAY_AUTH_SECRET or tokens die on restart
        # and admin reads of the sink stay closed across instances.
        settings = Settings(
            deepgram_api_key=settings.deepgram_api_key,
            relay_auth_secret="ephemeral-dev-secret",
            allowed_origins=settings.allowed_origins,
            max_seconds=settings.max_seconds,
            warn_seconds=settings.warn_seconds,
            session_ttl=settings.session_ttl,
            lead_sink_path=settings.lead_sink_path,
            omnistudio_lead_url=settings.omnistudio_lead_url,
            omnistudio_lead_token=settings.omnistudio_lead_token,
            fake_upstream=settings.fake_upstream,
        )
        log.warning("RELAY_AUTH_SECRET is unset; using an ephemeral process secret")

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
    app.state.hits = {}
    app.state.http_client_factory = http_client_factory or (lambda **kwargs: httpx.AsyncClient(**kwargs))

    def make_upstream():
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
            "omnistudio_configured": bool(settings.omnistudio_lead_url),
            "fake_upstream": settings.fake_upstream,
        }

    @app.post("/v1/session")
    async def open_session(request: Request) -> JSONResponse:
        origin = request.headers.get("origin", "")
        if origin not in settings.allowed_origins:
            return JSONResponse({"error": "origin_not_allowed"}, status_code=403)
        if not settings.speech_configured:
            return JSONResponse({"error": "speech_relay_unconfigured"}, status_code=503)
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
        if session_id in app.state.live:
            await _close(websocket, 4409)
            return
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
        try:
            body = await request.json()
        except Exception:
            return JSONResponse({"error": "invalid_json"}, status_code=400)
        try:
            claims = read_token(settings.relay_auth_secret, str(body.get("token") or ""))
        except TokenError as exc:
            return JSONResponse({"error": str(exc)}, status_code=401)
        session_id = str(claims["sid"])
        sess = app.state.sessions.get(session_id) or {}
        visitor = body.get("visitor") if isinstance(body.get("visitor"), dict) else {}
        need = body.get("need") if isinstance(body.get("need"), str) else ""
        lead = build_lead(
            session_id=session_id,
            transcript=str(sess.get("transcript") or ""),
            visitor=visitor,
            need=need,
            duration_s=float(sess.get("duration_s") or 0),
            cap_reason=str(sess.get("cap_reason") or "visitor_stop"),
        )
        existing = app.state.store.get(session_id)
        if existing and existing.get("forwarded"):
            # Keep the first forward. Refresh the stored copy with contact fields.
            lead["omnistudio"] = existing.get("omnistudio") or lead["omnistudio"]
            lead["forwarded"] = True
            saved = app.state.store.upsert(lead)
            return JSONResponse({"ok": True, "sink": lead["omnistudio"].get("status", "staged"), "session_id": session_id, "lead": saved})
        saved = await _commit_lead(app, lead)
        return JSONResponse(
            {
                "ok": True,
                "sink": saved["omnistudio"]["status"],
                "session_id": session_id,
                "lead": saved,
            }
        )

    @app.get("/v1/leads")
    async def list_leads(request: Request) -> JSONResponse:
        admin = request.headers.get("x-relay-admin", "")
        secret = settings.relay_auth_secret
        if not secret or not admin or not _eq(admin, secret):
            return JSONResponse({"error": "unauthorized"}, status_code=401)
        return JSONResponse({"leads": app.state.store.list()})

    return app


def _eq(left: str, right: str) -> bool:
    import hmac

    return hmac.compare_digest(left.encode("utf-8"), right.encode("utf-8"))


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
            event = await upstream.recv()
            if event is None:
                return
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
        cap_reason = reason["value"] or "visitor_stop"
        duration = min(settings.max_seconds, max(0.0, time.monotonic() - started))
        transcript = _join_transcript(finals, interim["text"])
        app.state.sessions[session_id] = {
            "transcript": transcript,
            "duration_s": round(duration, 3),
            "cap_reason": cap_reason,
            "closed": True,
        }
        # Stage immediately so a dropped browser still leaves a verifiable row.
        # Omnistudio forward waits for POST /v1/leads, which carries the callback fields.
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
        else:
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
        await _send(
            websocket,
            {"type": "cap", "reason": cap_reason, "remaining_s": 0, "session_id": session_id},
        )
    finally:
        for task in (client_task, up_task, clock_task, keep_task):
            if not task.done():
                task.cancel()
        await asyncio.gather(client_task, up_task, clock_task, keep_task, return_exceptions=True)
        try:
            await upstream.close()
        except Exception:
            pass
        await _close(websocket, 1000)


async def _forward(app: FastAPI, lead: dict) -> dict:
    settings: Settings = app.state.settings
    url = settings.omnistudio_lead_url
    if not url:
        return {"contract": "stt-lead-v1", "status": "staged", "target": None}
    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    if settings.omnistudio_lead_token:
        headers["Authorization"] = "Bearer " + settings.omnistudio_lead_token
    try:
        async with app.state.http_client_factory(timeout=10) as client:
            response = await client.post(url, json=lead, headers=headers)
    except Exception as exc:
        log.warning("omnistudio_forward_failed session=%s err=%s", lead["session_id"][:8], type(exc).__name__)
        return {
            "contract": "stt-lead-v1",
            "status": "staged_forward_failed",
            "target": "omnistudio",
            "error": type(exc).__name__,
        }
    if response.status_code >= 400:
        return {
            "contract": "stt-lead-v1",
            "status": "staged_forward_failed",
            "target": "omnistudio",
            "http_status": response.status_code,
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
    lead["forwarded"] = outcome.get("status") in ("staged", "forwarded")
    # "staged" counts as handled for the local sink so a later POST does not
    # double-write. Omnistudio failures stay unforwarded so a retry can run.
    if outcome.get("status") == "staged_forward_failed":
        lead["forwarded"] = False
    saved = app.state.store.upsert(lead)
    log.info("lead_stored session=%s sink=%s", lead["session_id"][:8], outcome.get("status"))
    return saved


app = create_app()
