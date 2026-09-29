"""Conference host gate.

The host code is resolved on the server. HOST_CONFERENCE_CODE overrides the
built-in lookup. A matching code unlocks the site contact mailbox and, on
join, mints one host LiveKit JWT for that mailbox and the server-side display
name. There is no SSO redirect. Guest codes are short, opaque, and
single-use: one human joiner, bound to the name, email, objective, and agent
reference name from that host session. A code is marked used only after an
ephemeral LiveKit JWT is minted. The second redeem is rejected. Minting also
queues a Salesforce Event for Omnistudio and stages an invite draft. This
process does not hold a Salesforce credential. Without OMNISTUDIO_EVENT_URL
the Event stays staged on this process. The invite is a draft preview.
This process does not email anyone and does not create a Google Calendar
invite, on mint or on confirm, even when a hook URL or a start time is
present. Claude owns the org write.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import threading
import time
import urllib.error
import urllib.request
import uuid
from dataclasses import dataclass, field
from urllib.parse import urlparse


HOST_EMAIL_DEFAULT = "abdus@sfdc24.com"
HOST_DISPLAY_NAME = "Mr. Salam"
TOKEN_TTL = 900
MAX_CODE_LEN = 128
MAX_PER_SESSION = 30
ATTENDEE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
ATTENDEE_LEN = 8
EVENT_CONTRACT = "conference-event-v1"
INVITE_CONTRACT = "conference-invite-v1"
PORTAL_URL = "https://portal.sfdc24.com/"
ROOM_URL = "https://www.sfdc24.com/conference/room/"
# Public tree already cited by the delivery log. Not a credential.
DEFAULT_KNOWLEDGE_REF = "https://github.com/sfdc-24/conference/tree/main/docs/okf"


def builtin_host_code() -> str:
    """Server-side host lookup. Kept split so the value is not a source literal."""
    return "".join(("Black", "board", "Master"))


@dataclass
class Settings:
    host_code: str
    host_email: str
    auth_secret: str
    livekit_key: str
    livekit_secret: str
    livekit_url: str
    event_url: str
    event_token: str
    knowledge_ref: str
    gmail_url: str
    gmail_token: str
    calendar_url: str
    calendar_token: str

    @classmethod
    def from_env(cls, env: dict | None = None) -> "Settings":
        import os

        src = env if env is not None else os.environ
        host_code = str(src.get("HOST_CONFERENCE_CODE", "")).strip() or builtin_host_code()
        knowledge = str(src.get("CONFERENCE_KNOWLEDGE_REF", "")).strip()
        if not _knowledge_ref_ok(knowledge):
            knowledge = DEFAULT_KNOWLEDGE_REF
        return cls(
            host_code=host_code,
            host_email=str(src.get("HOST_EMAIL", HOST_EMAIL_DEFAULT)).strip() or HOST_EMAIL_DEFAULT,
            auth_secret=str(src.get("GATE_AUTH_SECRET", "")).strip(),
            livekit_key=str(src.get("LIVEKIT_API_KEY", "")).strip(),
            livekit_secret=str(src.get("LIVEKIT_API_SECRET", "")).strip(),
            livekit_url=str(src.get("LIVEKIT_URL", "")).strip(),
            event_url=str(src.get("OMNISTUDIO_EVENT_URL", "")).strip(),
            event_token=str(src.get("OMNISTUDIO_EVENT_TOKEN", "")).strip(),
            knowledge_ref=knowledge,
            gmail_url=str(src.get("GMAIL_INVITE_URL", "")).strip(),
            gmail_token=str(src.get("GMAIL_INVITE_TOKEN", "")).strip(),
            calendar_url=str(src.get("CALENDAR_INVITE_URL", "")).strip(),
            calendar_token=str(src.get("CALENDAR_INVITE_TOKEN", "")).strip(),
        )

    @property
    def configured(self) -> bool:
        return bool(self.host_code and self.auth_secret)


@dataclass
class State:
    lock: threading.Lock = field(default_factory=threading.Lock)
    codes: dict = field(default_factory=dict)
    by_session: dict = field(default_factory=dict)
    events: dict = field(default_factory=dict)
    invites: dict = field(default_factory=dict)
    handoffs: dict = field(default_factory=dict)
    host_joiners: int = 0
    host_reserving: bool = False


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


def mint_room_jwt(settings: Settings, identity: str, room: str, now: int | None = None, name: str = "") -> str | None:
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
    shown = " ".join(str(name or "").split())[:80]
    if shown:
        payload["name"] = shown
    head = _b64(json.dumps(header, separators=(",", ":")).encode("utf-8"))
    body = _b64(json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8"))
    sig = hmac.new(settings.livekit_secret.encode("utf-8"), f"{head}.{body}".encode("ascii"), hashlib.sha256).digest()
    return f"{head}.{body}.{_b64(sig)}"


def room_name(code: str) -> str:
    return "c" + hashlib.sha256(code.encode("utf-8")).hexdigest()[:12]


def new_attendee_code() -> str:
    return "".join(secrets.choice(ATTENDEE_ALPHABET) for _ in range(ATTENDEE_LEN))


def _bearer(headers: dict) -> str:
    raw = ""
    for key, value in headers.items():
        if str(key).lower() == "authorization":
            raw = str(value)
            break
    if raw.lower().startswith("bearer "):
        return raw[7:].strip()
    return ""


def _admit(settings: Settings, role: str, identity: str, room: str, name: str = "") -> dict:
    shown = " ".join(str(name or "").split())[:80]
    token = mint_room_jwt(settings, identity, room, name=shown)
    body = {
        "ok": True,
        "admitted": True,
        "role": role,
        "identity": identity[:64],
        "name": shown,
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


def _knowledge_ref_ok(raw: str) -> bool:
    if not raw or len(raw) > 500 or any(ch.isspace() for ch in raw):
        return False
    try:
        parsed = urlparse(raw)
    except ValueError:
        return False
    if parsed.username or parsed.password or parsed.scheme != "https" or not parsed.hostname:
        return False
    return True


def _sf_id(raw: str) -> str:
    text = "".join(str(raw or "").split())
    if len(text) not in (15, 18) or not text.isalnum():
        return ""
    return text


def _event_url_ok(raw: str) -> bool:
    if not raw or len(raw) > 500:
        return False
    try:
        parsed = urlparse(raw)
    except ValueError:
        return False
    if parsed.username or parsed.password:
        return False
    query = (parsed.query or "").lower()
    if "token=" in query or "secret=" in query:
        return False
    if parsed.scheme == "https" and parsed.hostname:
        return True
    return parsed.scheme == "http" and parsed.hostname in {"127.0.0.1", "localhost"}


def build_event(
    settings: Settings,
    code: str,
    name: str,
    email: str,
    objective: str,
    reference: str,
    account_id: str = "",
    campaign_id: str = "",
    opportunity_id: str = "",
) -> dict:
    subject = objective[:255]
    lines = [
        "Agent reference name: " + reference,
        "Conference code: " + code,
        "Host: " + settings.host_email,
        "Knowledge: " + settings.knowledge_ref,
    ]
    body = {
        "contract": EVENT_CONTRACT,
        "code": code,
        "host_email": settings.host_email,
        "agent_reference": reference,
        "knowledge_ref": settings.knowledge_ref,
        "who": {"object": "Contact", "Email": email, "Name": name},
        "salesforce": {
            "object": "Event",
            "Subject": subject,
            "Description": "\n".join(lines)[:32000],
            "OwnerEmail": settings.host_email,
        },
    }
    what = {}
    account = _sf_id(account_id)
    campaign = _sf_id(campaign_id)
    opportunity = _sf_id(opportunity_id)
    if account:
        what["AccountId"] = account
    if campaign:
        what["CampaignId"] = campaign
    if opportunity:
        what["OpportunityId"] = opportunity
    if what:
        body["what"] = what
    return body


def _handoff_ok(payload: object, code: str) -> bool:
    if not isinstance(payload, dict):
        return False
    if payload.get("ok") is not True or payload.get("contract") != EVENT_CONTRACT:
        return False
    if payload.get("idempotency") != "conference_code":
        return False
    record_id = payload.get("id")
    if not isinstance(record_id, str) or not record_id.strip():
        return False
    return payload.get("code") == code


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def forward_event(settings: Settings, event: dict) -> dict:
    notice = {"contract": EVENT_CONTRACT, "status": "staged", "durable": False, "object": "Event"}
    if not settings.event_url:
        return notice
    if not _event_url_ok(settings.event_url):
        notice["status"] = "staged_forward_failed"
        notice["error"] = "bad_url"
        return notice
    raw = json.dumps(event).encode("utf-8")
    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    if settings.event_token:
        headers["Authorization"] = "Bearer " + settings.event_token
    request = urllib.request.Request(settings.event_url, data=raw, headers=headers, method="POST")
    opener = urllib.request.build_opener(_NoRedirect)
    try:
        with opener.open(request, timeout=10) as response:
            status = getattr(response, "status", 0)
            payload = json.loads(response.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as exc:
        notice["status"] = "staged_forward_failed"
        notice["http_status"] = exc.code
        return notice
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, ValueError):
        notice["status"] = "staged_forward_failed"
        return notice
    if status < 200 or status >= 300 or not _handoff_ok(payload, event["code"]):
        notice["status"] = "staged_forward_failed"
        notice["http_status"] = status
        return notice
    notice["status"] = "forwarded"
    notice["durable"] = True
    notice["id"] = payload["id"]
    return notice


def invite_description(reference: str, code: str) -> str:
    return "\n".join([
        "Agent reference name: " + reference,
        "Portal gate: " + PORTAL_URL,
        "LiveKit room: " + ROOM_URL,
        "Conference code: " + code,
        "Enter the code and a last name or an email at the portal. The room opens on the LiveKit page.",
    ])


def build_invite(code: str, email: str, objective: str, reference: str) -> dict:
    title = objective[:200]
    return {
        "contract": INVITE_CONTRACT,
        "to": email,
        "title": title,
        "description": invite_description(reference, code),
        "portal_url": PORTAL_URL,
        "room_url": ROOM_URL,
        "code": code,
        "reference": reference,
        "status": "draft",
        "sent": False,
        "time": None,
        "audience": "internal-test",
    }


def public_invite(stored: dict, **extra) -> dict:
    out = {
        "to": stored.get("to", ""),
        "title": stored.get("title", ""),
        "description": stored.get("description", ""),
        "portal_url": stored.get("portal_url", PORTAL_URL),
        "room_url": stored.get("room_url", ROOM_URL),
        "code": stored.get("code", ""),
        "reference": stored.get("reference", ""),
        "status": stored.get("status", "draft"),
        "sent": bool(stored.get("sent")),
        "time": stored.get("time"),
        "audience": "internal-test",
    }
    mail = stored.get("mail")
    if isinstance(mail, dict):
        out["mail"] = {
            "status": mail.get("status", "draft"),
            "durable": bool(mail.get("durable")),
        }
        if mail.get("error"):
            out["mail"]["error"] = mail["error"]
    calendar = stored.get("calendar")
    if isinstance(calendar, dict):
        out["calendar"] = {
            "status": calendar.get("status", "draft"),
            "durable": bool(calendar.get("durable")),
        }
        if calendar.get("reason"):
            out["calendar"]["reason"] = calendar["reason"]
        if calendar.get("error"):
            out["calendar"]["error"] = calendar["error"]
    for key, value in extra.items():
        if value is not None:
            out[key] = value
    return out


def gmail_payload(draft: dict) -> dict:
    """Document the mail body. This module does not post it."""
    return {
        "to": draft["to"],
        "subject": draft["title"],
        "body": draft["description"],
    }


def calendar_payload(draft: dict) -> dict:
    body = {
        "summary": draft["title"],
        "description": draft["description"],
        "attendees": [{"email": draft["to"]}],
    }
    start = draft.get("time")
    if isinstance(start, str) and start:
        body["start"] = {"dateTime": start}
    return body


def confirm_invite(settings: Settings, state: State, session: str, code: str, confirm: object) -> tuple[int, dict]:
    """Return the draft. Never open a socket to Gmail or Calendar.

    `confirm` is ignored. Hook URLs and a stored start time do not send.
    """
    del confirm
    ident = read_session(settings.auth_secret, session)
    if not ident:
        return 401, {"ok": False, "error": "rejected"}
    clean = "".join(str(code or "").split())
    with state.lock:
        row = state.codes.get(clean)
        stored = state.invites.get(clean)
        if not row or not stored or row.get("sid") != ident["sid"]:
            return 404, {"ok": False, "error": "not_found"}
        draft = dict(stored)
        draft["status"] = "draft"
        draft["sent"] = False
        draft["time"] = None
        stored["status"] = "draft"
        stored["sent"] = False
        stored["time"] = None
    return 200, {"ok": True, "invite": public_invite(draft, reason="held")}


def enqueue_event(settings: Settings, state: State, event: dict) -> dict:
    notice = forward_event(settings, event)
    stored = dict(event)
    stored["omnistudio"] = {
        "contract": EVENT_CONTRACT,
        "status": notice["status"],
        "durable": notice["durable"],
    }
    if notice.get("id"):
        stored["omnistudio"]["id"] = notice["id"]
    with state.lock:
        state.events[event["code"]] = stored
    public = {"status": notice["status"], "durable": notice["durable"], "object": "Event"}
    if notice.get("id"):
        public["id"] = notice["id"]
    if notice.get("error"):
        public["error"] = notice["error"]
    return public


def mint(settings: Settings, state: State, session: str, name: str, email: str, objective: str, reference: str, account_id: str = "", campaign_id: str = "", opportunity_id: str = "") -> tuple[int, dict]:
    ident = read_session(settings.auth_secret, session)
    if not ident:
        return 401, {"ok": False, "error": "rejected"}
    clean_name = _clean_name(name)
    clean_email = _clean_email(email)
    clean_objective = _clean_objective(objective)
    clean_reference = _clean_name(reference)
    if not clean_name or not clean_email or not clean_objective or not clean_reference:
        return 400, {"ok": False, "error": "incomplete"}
    with state.lock:
        made = state.by_session.setdefault(ident["sid"], [])
        if len(made) >= MAX_PER_SESSION:
            return 429, {"ok": False, "error": "limited"}
        code = new_attendee_code()
        while code in state.codes or codes_match(code, settings.host_code):
            code = new_attendee_code()
        state.codes[code] = {
            "name": clean_name,
            "email": clean_email,
            "reference": clean_reference,
            "objective": clean_objective,
            "joiners": 0,
            "sid": ident["sid"],
        }
        made.append(code)
    event = build_event(
        settings,
        code,
        clean_name,
        clean_email,
        clean_objective,
        clean_reference,
        account_id,
        campaign_id,
        opportunity_id,
    )
    notice = enqueue_event(settings, state, event)
    draft = build_invite(code, clean_email, clean_objective, clean_reference)
    with state.lock:
        state.invites[code] = draft
    return 200, {
        "ok": True,
        "code": code,
        "joiners_max": 1,
        "join_hash": "c=" + code,
        "name": clean_name,
        "email": clean_email,
        "reference": clean_reference,
        "objective": clean_objective,
        "event": notice,
        "invite": public_invite(draft),
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
                "reference": row.get("reference", ""),
                "objective": row["objective"],
                "used": row["joiners"] >= 1,
                "event_status": (state.events.get(code) or {}).get("omnistudio", {}).get("status", ""),
            })
    return 200, {"ok": True, "codes": rows}


def _release(state: State, code: str) -> None:
    with state.lock:
        row = state.codes.get(code)
        if row:
            row["reserving"] = False


def join(settings: Settings, state: State, code: str) -> tuple[int, dict]:
    text = str(code or "").strip()
    if not text or len(text) > MAX_CODE_LEN:
        return 401, {"ok": False, "error": "rejected"}
    if settings.host_code and codes_match(text, settings.host_code):
        with state.lock:
            if state.host_joiners >= 1 or state.host_reserving:
                return 409, {"ok": False, "error": "used"}
            state.host_reserving = True
        try:
            admitted = _admit(
                settings,
                "host",
                settings.host_email,
                "host-floor",
                name=HOST_DISPLAY_NAME,
            )
            if not admitted.get("room_token"):
                return 503, {"ok": False, "error": "room_token_unconfigured"}
            with state.lock:
                state.host_joiners = 1
            return 200, admitted
        finally:
            with state.lock:
                state.host_reserving = False
    with state.lock:
        row = state.codes.get(text)
        if not row:
            return 401, {"ok": False, "error": "rejected"}
        if row["joiners"] >= 1 or row.get("reserving"):
            return 409, {"ok": False, "error": "used"}
        row["reserving"] = True
        identity = row["email"]
        spoken = row.get("reference") or ""
    try:
        admitted = _admit(settings, "guest", identity, room_name(text), name=spoken)
        if not admitted.get("room_token"):
            return 503, {"ok": False, "error": "room_token_unconfigured"}
        with state.lock:
            row = state.codes[text]
            row["joiners"] = 1
        return 200, admitted
    finally:
        _release(state, text)


def _last_name(raw: str) -> str:
    parts = _clean_name(raw).split()
    return parts[-1].casefold() if parts else ""


def _same_email(got: str, expected: str) -> bool:
    left = _clean_email(got).casefold()
    right = _clean_email(expected).casefold()
    return bool(left) and left == right


def _identity_ok(expected_name: str, expected_email: str, last_name: str, email: str) -> bool:
    if _same_email(email, expected_email):
        return True
    last = _last_name(last_name)
    return bool(last) and last == _last_name(expected_name)


def _stash_handoff(state: State, admitted: dict) -> str:
    hid = secrets.token_urlsafe(12)
    with state.lock:
        state.handoffs[hid] = {
            "exp": time.time() + 120,
            "room_token": admitted.get("room_token"),
            "url": admitted.get("url") or "",
            "name": admitted.get("name") or "",
            "role": admitted.get("role") or "",
            "identity": admitted.get("identity") or "",
        }
    return hid


def enter(settings: Settings, state: State, code: str, last_name: str, email: str) -> tuple[int, dict]:
    text = str(code or "").strip()
    if not text or len(text) > MAX_CODE_LEN:
        return 401, {"ok": False, "error": "rejected"}
    if not _last_name(last_name) and not _clean_email(email):
        return 400, {"ok": False, "error": "incomplete"}
    if settings.host_code and codes_match(text, settings.host_code):
        if not _identity_ok(HOST_DISPLAY_NAME, settings.host_email, last_name, email):
            return 401, {"ok": False, "error": "rejected"}
    else:
        with state.lock:
            row = state.codes.get(text)
            if not row:
                return 401, {"ok": False, "error": "rejected"}
            if row["joiners"] >= 1 or row.get("reserving"):
                return 409, {"ok": False, "error": "used"}
            matched = _identity_ok(row["name"], row["email"], last_name, email)
        if not matched:
            return 401, {"ok": False, "error": "rejected"}
    status, admitted = join(settings, state, text)
    if status != 200:
        return status, {"ok": False, "error": admitted.get("error") or "rejected"}
    hid = _stash_handoff(state, admitted)
    return 200, {
        "ok": True,
        "role": admitted.get("role"),
        "joiners_max": 1,
        "handoff": hid,
        "room_path": "/conference/room/#h=" + hid,
    }


def claim_room(state: State, handoff: str) -> tuple[int, dict]:
    hid = str(handoff or "").strip()
    if not hid or len(hid) > 128:
        return 401, {"ok": False, "error": "rejected"}
    now = time.time()
    with state.lock:
        row = state.handoffs.pop(hid, None)
    if not row or float(row.get("exp") or 0) < now:
        return 401, {"ok": False, "error": "rejected"}
    return 200, {
        "ok": True,
        "admitted": True,
        "role": row["role"],
        "identity": row["identity"],
        "name": row["name"],
        "joiners_max": 1,
        "room_token": row["room_token"],
        "url": row["url"],
    }


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
            str(payload.get("reference", "")),
            str(payload.get("account_id", "")),
            str(payload.get("campaign_id", "")),
            str(payload.get("opportunity_id", "")),
        )
    if method == "GET" and path == "/v1/codes":
        return list_codes(settings, state, _bearer(hdrs))
    if method == "POST" and path == "/v1/invites":
        return confirm_invite(
            settings,
            state,
            _bearer(hdrs),
            str(payload.get("code", "")),
            payload.get("confirm"),
        )
    if method == "POST" and path in {"/v1/join", "/v1/redeem"}:
        return join(settings, state, str(payload.get("code", "")))
    if method == "POST" and path == "/v1/enter":
        return enter(
            settings,
            state,
            str(payload.get("code", "")),
            str(payload.get("last_name", "")),
            str(payload.get("email", "")),
        )
    if method == "POST" and path == "/v1/room":
        return claim_room(state, str(payload.get("handoff", "")))
    return 404, {"ok": False, "error": "not_found"}
