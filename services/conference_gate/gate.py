"""Conference host gate.

The host code is read from HOST_CONFERENCE_CODE. It is not embedded here.
A matching code unlocks the site contact mailbox (HOST_EMAIL, default the
public contact address). Guest codes are opaque, single-use, and bound to
the name, email, and objective from that host session. Room JWTs are minted
only when the LiveKit signing values are present in the environment.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import threading
import time
import uuid
from dataclasses import dataclass, field


HOST_EMAIL_DEFAULT = "abdus@sfdc24.com"
TOKEN_TTL = 900
MAX_CODE_LEN = 128
MAX_PER_SESSION = 30


@dataclass
class Settings:
    host_code: str
    host_email: str
    auth_secret: str
    livekit_key: str
    livekit_secret: str
    livekit_url: str

    @classmethod
    def from_env(cls, env: dict | None = None) -> "Settings":
        import os

        src = env if env is not None else os.environ
        return cls(
            host_code=str(src.get("HOST_CONFERENCE_CODE", "")).strip(),
            host_email=str(src.get("HOST_EMAIL", HOST_EMAIL_DEFAULT)).strip() or HOST_EMAIL_DEFAULT,
            auth_secret=str(src.get("GATE_AUTH_SECRET", "")).strip(),
            livekit_key=str(src.get("LIVEKIT_API_KEY", "")).strip(),
            livekit_secret=str(src.get("LIVEKIT_API_SECRET", "")).strip(),
            livekit_url=str(src.get("LIVEKIT_URL", "")).strip(),
        )

    @property
    def configured(self) -> bool:
        return bool(self.host_code and self.auth_secret)


@dataclass
class State:
    lock: threading.Lock = field(default_factory=threading.Lock)
    codes: dict = field(default_factory=dict)
    by_session: dict = field(default_factory=dict)


def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _unb64(text: str) -> bytes:
    pad = "=" * (-len(text) % 4)
    return base64.urlsafe_b64decode(text + pad)


def codes_match(got: str, expected: str) -> bool:
    if not got or not expected:
        return False
    a = hashlib.sha256(got.encode("utf-8")).digest()
    b = hashlib.sha256(expected.encode("utf-8")).digest()
    return hmac.compare_digest(a, b)


def _clean_name(raw: str) -> str:
    text = " ".join(str(raw or "").split())
    out = []
    for ch in text:
        if ch.isalpha() or ch in " .'-":
            out.append(ch)
    return "".join(out).strip()[:80]


def _clean_email(raw: str) -> str:
    text = "".join(str(raw or "").split())
    if len(text) < 6 or len(text) > 120 or text.count("@") != 1:
        return ""
    local, domain = text.split("@", 1)
    if not local or "." not in domain or ".." in text:
        return ""
    allowed = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._%+-@")
    if any(ch not in allowed for ch in text):
        return ""
    return text


def _clean_objective(raw: str) -> str:
    text = str(raw or "").replace("<", " ").replace(">", " ")
    text = " ".join(text.split())
    if "eyJ" in text:
        return ""
    return text[:200]


def sign_session(secret: str, sid: str, ttl: int = TOKEN_TTL) -> str:
    body = {"exp": int(time.time()) + int(ttl), "role": "host", "sid": sid}
    raw = _b64(json.dumps(body, separators=(",", ":"), sort_keys=True).encode("utf-8"))
    sig = hmac.new(secret.encode("utf-8"), raw.encode("ascii"), hashlib.sha256).hexdigest()
    return raw + "." + sig


def read_session(secret: str, token: str) -> dict | None:
    if not secret or not token or "." not in token:
        return None
    raw, sig = token.split(".", 1)
    expect = hmac.new(secret.encode("utf-8"), raw.encode("ascii"), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expect, sig):
        return None
    try:
        body = json.loads(_unb64(raw))
    except (json.JSONDecodeError, ValueError):
        return None
    if int(body.get("exp", 0)) < int(time.time()):
        return None
    if body.get("role") != "host" or not body.get("sid"):
        return None
    return body


def mint_room_jwt(settings: Settings, identity: str, room: str, now: int | None = None) -> str | None:
    if not settings.livekit_key or not settings.livekit_secret:
        return None
    if not settings.livekit_url.startswith("wss://"):
        return None
    stamp = int(time.time()) if now is None else int(now)
    header = {"alg": "HS256", "typ": "JWT"}
    payload = {
        "exp": stamp + TOKEN_TTL,
        "iss": settings.livekit_key,
        "nbf": stamp,
        "sub": identity[:64],
        "video": {
            "canPublish": True,
            "canPublishData": True,
            "canSubscribe": True,
            "room": room,
            "roomJoin": True,
        },
    }
    head = _b64(json.dumps(header, separators=(",", ":")).encode("utf-8"))
    body = _b64(json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8"))
    sig = hmac.new(settings.livekit_secret.encode("utf-8"), f"{head}.{body}".encode("ascii"), hashlib.sha256).digest()
    return f"{head}.{body}.{_b64(sig)}"


def room_name(code: str) -> str:
    return "c" + hashlib.sha256(code.encode("utf-8")).hexdigest()[:12]


def _bearer(headers: dict) -> str:
    raw = ""
    for key, value in headers.items():
        if str(key).lower() == "authorization":
            raw = str(value)
            break
    if raw.lower().startswith("bearer "):
        return raw[7:].strip()
    return ""


def _admit(settings: Settings, role: str, identity: str, room: str) -> dict:
    token = mint_room_jwt(settings, identity, room)
    body = {
        "ok": True,
        "admitted": True,
        "role": role,
        "joiners_max": 1,
        "room_token": token,
        "url": settings.livekit_url if token else "",
        "reason": "" if token else "room_token_unconfigured",
    }
    return body


def unlock(settings: Settings, code: str) -> tuple[int, dict]:
    if not settings.configured:
        return 503, {"ok": False, "error": "gate_unconfigured"}
    if not codes_match(str(code or ""), settings.host_code):
        return 401, {"ok": False, "error": "rejected"}
    session = sign_session(settings.auth_secret, uuid.uuid4().hex)
    return 200, {"ok": True, "email": settings.host_email, "session": session}


def mint(settings: Settings, state: State, session: str, name: str, email: str, objective: str) -> tuple[int, dict]:
    ident = read_session(settings.auth_secret, session)
    if not ident:
        return 401, {"ok": False, "error": "rejected"}
    clean_name = _clean_name(name)
    clean_email = _clean_email(email)
    clean_objective = _clean_objective(objective)
    if not clean_name or not clean_email or not clean_objective:
        return 400, {"ok": False, "error": "incomplete"}
    with state.lock:
        made = state.by_session.setdefault(ident["sid"], [])
        if len(made) >= MAX_PER_SESSION:
            return 429, {"ok": False, "error": "limited"}
        code = secrets.token_urlsafe(18)
        while code in state.codes or codes_match(code, settings.host_code):
            code = secrets.token_urlsafe(18)
        state.codes[code] = {
            "name": clean_name,
            "email": clean_email,
            "objective": clean_objective,
            "joiners": 0,
            "sid": ident["sid"],
        }
        made.append(code)
    return 200, {
        "ok": True,
        "code": code,
        "joiners_max": 1,
        "join_hash": "c=" + code,
        "name": clean_name,
        "email": clean_email,
        "objective": clean_objective,
    }


def list_codes(settings: Settings, state: State, session: str) -> tuple[int, dict]:
    ident = read_session(settings.auth_secret, session)
    if not ident:
        return 401, {"ok": False, "error": "rejected"}
    with state.lock:
        made = list(state.by_session.get(ident["sid"], []))
        rows = []
        for code in made:
            row = state.codes.get(code)
            if not row:
                continue
            rows.append({
                "code": code,
                "name": row["name"],
                "email": row["email"],
                "objective": row["objective"],
                "used": row["joiners"] >= 1,
            })
    return 200, {"ok": True, "codes": rows}


def join(settings: Settings, state: State, code: str) -> tuple[int, dict]:
    text = str(code or "").strip()
    if not text or len(text) > MAX_CODE_LEN:
        return 401, {"ok": False, "error": "rejected"}
    if settings.host_code and codes_match(text, settings.host_code):
        return 200, _admit(settings, "host", "host", "host-floor")
    with state.lock:
        row = state.codes.get(text)
        if not row:
            return 401, {"ok": False, "error": "rejected"}
        if row["joiners"] >= 1:
            return 409, {"ok": False, "error": "used"}
        row["joiners"] = 1
        identity = row["email"]
    return 200, _admit(settings, "guest", identity, room_name(text))


def dispatch(settings: Settings, state: State, method: str, path: str, body: dict | None, headers: dict | None) -> tuple[int, dict]:
    payload = body if isinstance(body, dict) else {}
    hdrs = headers or {}
    if method == "GET" and path == "/healthz":
        return 200, {"ok": True, "configured": settings.configured}
    if method == "POST" and path == "/v1/host/unlock":
        return unlock(settings, str(payload.get("code", "")))
    if method == "POST" and path == "/v1/codes":
        return mint(
            settings,
            state,
            _bearer(hdrs),
            str(payload.get("name", "")),
            str(payload.get("email", "")),
            str(payload.get("objective", "")),
        )
    if method == "GET" and path == "/v1/codes":
        return list_codes(settings, state, _bearer(hdrs))
    if method == "POST" and path == "/v1/join":
        return join(settings, state, str(payload.get("code", "")))
    return 404, {"ok": False, "error": "not_found"}
