"""Lead payload for a Salesforce Lead / Omnistudio handoff, plus the staging file."""

from __future__ import annotations

import json
import re
import threading
from datetime import datetime, timezone
from pathlib import Path

EMAIL_RE = re.compile(r"[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}", re.I)
PHONE_RE = re.compile(r"(?:\+?\d[\d\s().\-]{7,}\d)")

TRANSCRIPT_CAP = 20000
SUMMARY_SAID_CAP = 1200


def extract_contacts(text: str) -> dict:
    blob = text or ""
    emails = []
    for match in EMAIL_RE.findall(blob):
        if match not in emails:
            emails.append(match)
    phones = []
    for match in PHONE_RE.findall(blob):
        compact = re.sub(r"\s+", " ", match).strip()
        digits = re.sub(r"\D", "", compact)
        if len(digits) < 8:
            continue
        if compact not in phones:
            phones.append(compact)
    return {"emails": emails, "phones": phones}


def _clean(value: object, limit: int = 200) -> str:
    text = re.sub(r"\s+", " ", str(value or "")).strip()
    return text[:limit]


def summarize(transcript: str, visitor: dict, need: str) -> str:
    bits = []
    if visitor.get("name"):
        bits.append("Name: " + visitor["name"])
    if visitor.get("company"):
        bits.append("Company: " + visitor["company"])
    if visitor.get("email"):
        bits.append("Email: " + visitor["email"])
    if visitor.get("phone"):
        bits.append("Phone: " + visitor["phone"])
    if need:
        bits.append("Need: " + need)
    said = re.sub(r"\s+", " ", transcript or "").strip()
    if said:
        bits.append("Said: " + said[:SUMMARY_SAID_CAP])
    return " | ".join(bits) if bits else "No speech captured."


def build_lead(
    *,
    session_id: str,
    transcript: str,
    visitor: dict | None,
    need: str,
    duration_s: float,
    cap_reason: str,
    captured_at: str | None = None,
) -> dict:
    visitor = visitor or {}
    found = extract_contacts(transcript or "")
    name = _clean(visitor.get("name"), 120)
    company = _clean(visitor.get("company"), 120) or "Unknown"
    email = _clean(visitor.get("email"), 160) or (found["emails"][0] if found["emails"] else "")
    phone = _clean(visitor.get("phone"), 40) or (found["phones"][0] if found["phones"] else "")
    need_text = _clean(need, 500)
    transcript_text = (transcript or "").strip()[:TRANSCRIPT_CAP]
    parts = name.split()
    last_name = parts[-1] if parts else "Callback"
    summary = summarize(
        transcript_text,
        {"name": name, "company": company if company != "Unknown" else "", "email": email, "phone": phone},
        need_text,
    )
    description = summary[:32000]
    return {
        "source": "sfdc24-stream-stt",
        "contract": "stt-lead-v1",
        "session_id": session_id,
        "captured_at": captured_at or datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "duration_s": round(max(0.0, float(duration_s)), 3),
        "cap_reason": cap_reason or "unknown",
        "max_seconds": 180,
        "visitor": {
            "name": name,
            "company": company,
            "email": email,
            "phone": phone,
        },
        "need": need_text,
        "transcript": transcript_text,
        "summary": summary,
        "salesforce": {
            "object": "Lead",
            "LastName": last_name,
            "Company": company,
            "Email": email,
            "Phone": phone,
            "LeadSource": "www.sfdc24.com/stream",
            "Description": description,
        },
        "omnistudio": {"contract": "stt-lead-v1", "status": "pending"},
        "forwarded": False,
    }


class LeadStore:
    """JSONL sink. One object per session id. Safe for the staging host."""

    def __init__(self, path: str):
        self.path = Path(path)
        self._lock = threading.Lock()
        self._rows: dict[str, dict] = {}
        self._load()

    def _load(self) -> None:
        if not self.path.is_file():
            return
        for line in self.path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            sid = row.get("session_id")
            if sid:
                self._rows[sid] = row

    def _flush(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        data = "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in self._rows.values())
        self.path.write_text(data, encoding="utf-8")

    def get(self, session_id: str) -> dict | None:
        with self._lock:
            row = self._rows.get(session_id)
            return json.loads(json.dumps(row)) if row else None

    def upsert(self, lead: dict) -> dict:
        with self._lock:
            self._rows[lead["session_id"]] = lead
            self._flush()
            return json.loads(json.dumps(lead))

    def list(self, limit: int = 50) -> list[dict]:
        with self._lock:
            rows = list(self._rows.values())
        return rows[-limit:]
