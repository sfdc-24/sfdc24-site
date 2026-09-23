"""Find DEEPGRAM_API_KEY without writing it down.

Cloud Run and any other remote host set the name on the service. A process
environment value always wins. Local VANLAS smoke, where that variable is not
already exported, reads it from the Blackboard .env on the laptop. The file
is never committed and the value is never printed.
"""

from __future__ import annotations

import os
from pathlib import Path

# Mr Salam's laptop Blackboard file. VANLAS only. Not present on Cloud Run.
VANLAS_BLACKBOARD_ENV = r"C:\Users\salam\Quantum\Blackboard\.env"

_VANLAS_PATHS = (
    VANLAS_BLACKBOARD_ENV,
    "C:/Users/salam/Quantum/Blackboard/.env",
    "/mnt/c/Users/salam/Quantum/Blackboard/.env",
    "/c/Users/salam/Quantum/Blackboard/.env",
)


def candidate_paths(relay_env: Path | None = None) -> list[Path]:
    """Blackboard paths, then an optional relay-local .env.

    BLACKBOARD_ENV replaces the laptop path. When it is unset, the VANLAS
    Blackboard locations are tried. A relay-local .env is only a fallback for
    DEEPGRAM_API_KEY and is never required.
    """
    override = os.environ.get("BLACKBOARD_ENV", "").strip()
    if override:
        paths = [Path(override)]
    else:
        paths = [Path(item) for item in _VANLAS_PATHS]
    if relay_env is not None:
        paths.append(relay_env)
    return paths


def _read_name(path: Path, name: str) -> str:
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return ""
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        if key.strip() != name:
            continue
        return value.strip().strip('"').strip("'")
    return ""


def resolve_deepgram_key(relay_env: Path | None = None) -> tuple[str, str]:
    """Return (key, source). Source is 'process' or the file path. Key may be empty."""
    current = os.environ.get("DEEPGRAM_API_KEY", "").strip()
    if current:
        return current, "process"
    for path in candidate_paths(relay_env):
        if not path.is_file():
            continue
        found = _read_name(path, "DEEPGRAM_API_KEY")
        if not found:
            continue
        os.environ["DEEPGRAM_API_KEY"] = found
        return found, str(path)
    return "", ""


def load_unset(path: Path, names: tuple[str, ...]) -> None:
    """Fill selected unset names from a relay-local .env. Does not override."""
    if not path.is_file():
        return
    for name in names:
        if os.environ.get(name, "").strip():
            continue
        found = _read_name(path, name)
        if found:
            os.environ[name] = found
