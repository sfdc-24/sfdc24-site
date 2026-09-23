"""Short-lived HMAC tokens for the browser websocket. Not the speech key."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
import uuid


class TokenError(Exception):
    pass


def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _unb64(text: str) -> bytes:
    pad = "=" * (-len(text) % 4)
    return base64.urlsafe_b64decode(text + pad)


def issue_token(secret: str, *, session_id: str, ttl_seconds: int, max_seconds: float) -> str:
    if not secret:
        raise TokenError("relay_auth_secret_missing")
    body = {
        "exp": int(time.time()) + int(ttl_seconds),
        "max": max_seconds,
        "sid": session_id,
    }
    raw = _b64(json.dumps(body, separators=(",", ":"), sort_keys=True).encode("utf-8"))
    sig = hmac.new(secret.encode("utf-8"), raw.encode("ascii"), hashlib.sha256).hexdigest()
    return raw + "." + sig


def read_token(secret: str, token: str) -> dict:
    if not secret or not token or "." not in token:
        raise TokenError("invalid_token")
    raw, sig = token.split(".", 1)
    expect = hmac.new(secret.encode("utf-8"), raw.encode("ascii"), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expect, sig):
        raise TokenError("invalid_token")
    try:
        body = json.loads(_unb64(raw))
    except (json.JSONDecodeError, ValueError) as exc:
        raise TokenError("invalid_token") from exc
    if int(body.get("exp", 0)) < int(time.time()):
        raise TokenError("expired_token")
    if not body.get("sid"):
        raise TokenError("invalid_token")
    return body


def new_session_id() -> str:
    return uuid.uuid4().hex
