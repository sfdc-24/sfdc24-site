"""Runtime settings. The speech key stays here, never in the browser."""

from __future__ import annotations

import os
from pathlib import Path
from dataclasses import dataclass

from app.envfile import load_unset, resolve_deepgram_key

_RELAY_ROOT = Path(__file__).resolve().parents[1]
_RELAY_DOTENV = _RELAY_ROOT / ".env"
_LOCAL_NAMES = (
    "RELAY_AUTH_SECRET",
    "RELAY_ADMIN_SECRET",
    "OMNISTUDIO_LEAD_URL",
    "OMNISTUDIO_LEAD_TOKEN",
    "LEAD_SINK_PATH",
    "ALLOWED_ORIGINS",
    "STT_MAX_SECONDS",
    "STT_WARN_SECONDS",
    "STT_SESSION_TTL",
    "STT_FAKE_UPSTREAM",
    "STT_RUNTIME",
)

HARD_CAP_SECONDS = 180.0
DEFAULT_WARN_SECONDS = 30.0

DEFAULT_ORIGINS = (
    "https://www.sfdc24.com",
    "https://sfdc24.com",
    "http://localhost:4173",
    "http://127.0.0.1:4173",
    "http://localhost:8000",
    "http://127.0.0.1:8000",
    "http://localhost:8765",
    "http://127.0.0.1:8765",
)


def _clamp_max(raw: float) -> float:
    # A deploy cannot raise the visitor cap past three minutes.
    if raw != raw:  # NaN
        return HARD_CAP_SECONDS
    return min(HARD_CAP_SECONDS, max(0.2, raw))


def _origins(raw: str | None) -> tuple[str, ...]:
    if not raw:
        return DEFAULT_ORIGINS
    items = tuple(part.strip() for part in raw.split(",") if part.strip())
    return items or DEFAULT_ORIGINS


@dataclass(frozen=True)
class Settings:
    deepgram_api_key: str
    relay_auth_secret: str
    relay_admin_secret: str
    allowed_origins: tuple[str, ...]
    max_seconds: float
    warn_seconds: float
    session_ttl: int
    lead_sink_path: str
    omnistudio_lead_url: str
    omnistudio_lead_token: str
    fake_upstream: bool
    production: bool
    hosted: bool
    runtime_invalid: bool

    @property
    def speech_configured(self) -> bool:
        # A fake provider is not speech configuration in production.
        if self.production and self.fake_upstream:
            return False
        return self.fake_upstream or bool(self.deepgram_api_key)

    @property
    def durable_forwarder(self) -> bool:
        return bool(self.omnistudio_lead_url)

    @property
    def accepting_sessions(self) -> bool:
        if self.runtime_invalid or not self.relay_auth_secret.strip():
            return False
        if self.production and self.fake_upstream:
            return False
        if not self.speech_configured:
            return False
        if self.production and not self.durable_forwarder:
            return False
        # The 30-session memory window is per process. It is not a host quota.
        # Production stays closed until that control exists. No environment
        # switch turns this into an approval.
        if self.production:
            return False
        return True

    @classmethod
    def from_env(cls) -> Settings:
        # Process env wins, including Cloud Run. VANLAS falls through to Blackboard .env.
        resolve_deepgram_key(_RELAY_DOTENV)
        load_unset(_RELAY_DOTENV, _LOCAL_NAMES)
        max_seconds = _clamp_max(float(os.environ.get("STT_MAX_SECONDS", str(HARD_CAP_SECONDS))))
        warn = float(os.environ.get("STT_WARN_SECONDS", str(DEFAULT_WARN_SECONDS)))
        if warn != warn or warn <= 0:
            warn = DEFAULT_WARN_SECONDS
        warn = min(warn, max_seconds)
        ttl = int(os.environ.get("STT_SESSION_TTL", "240"))
        if ttl < int(max_seconds) + 30:
            ttl = int(max_seconds) + 30
        runtime_raw = os.environ.get("STT_RUNTIME", "").strip().lower()
        hosted = bool(os.environ.get("K_SERVICE", "").strip())
        # Cloud Run sets K_SERVICE. An omitted or development value there still
        # uses production safeguards, so the development sink cannot open by
        # accident. An unrecognized value is invalid on every host. A laptop
        # with K_SERVICE unset keeps omitted and development as local offline mode.
        known = {"", "development", "production"}
        runtime_invalid = runtime_raw not in known
        if runtime_invalid:
            production = False
        elif hosted:
            production = True
        else:
            production = runtime_raw == "production"
        return cls(
            deepgram_api_key=os.environ.get("DEEPGRAM_API_KEY", "").strip(),
            relay_auth_secret=os.environ.get("RELAY_AUTH_SECRET", "").strip(),
            relay_admin_secret=os.environ.get("RELAY_ADMIN_SECRET", "").strip(),
            allowed_origins=_origins(os.environ.get("ALLOWED_ORIGINS")),
            max_seconds=max_seconds,
            warn_seconds=warn,
            session_ttl=ttl,
            lead_sink_path=os.environ.get("LEAD_SINK_PATH", "/tmp/stt-leads.jsonl"),
            omnistudio_lead_url=os.environ.get("OMNISTUDIO_LEAD_URL", "").strip(),
            omnistudio_lead_token=os.environ.get("OMNISTUDIO_LEAD_TOKEN", "").strip(),
            fake_upstream=os.environ.get("STT_FAKE_UPSTREAM", "").strip() == "1",
            production=production,
            hosted=hosted,
            runtime_invalid=runtime_invalid,
        )
