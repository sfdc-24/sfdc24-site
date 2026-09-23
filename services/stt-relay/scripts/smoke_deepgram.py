"""Open a Nova-3 socket using DEEPGRAM_API_KEY from the environment.

Does not print the key. Exits 2 when the variable is missing, 1 when Deepgram
rejects the connection, 0 when the socket accepts.
"""

from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.upstream import DEEPGRAM_URL  # noqa: E402


def load_env_file(path: Path) -> None:
    """Fill unset names from a gitignored .env. Existing process env wins."""
    if not path.is_file():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        if not key or key in os.environ:
            continue
        os.environ[key] = value.strip().strip('"').strip("'")


async def probe(api_key: str) -> None:
    import websockets

    async with websockets.connect(
        DEEPGRAM_URL,
        additional_headers={"Authorization": "Token " + api_key},
        open_timeout=10,
    ) as socket:
        await socket.send(b"\x00\x00" * 1600)
        try:
            await asyncio.wait_for(socket.recv(), timeout=8)
        except asyncio.TimeoutError:
            return


def main() -> int:
    load_env_file(ROOT / ".env")
    api_key = os.environ.get("DEEPGRAM_API_KEY", "").strip()
    if not api_key:
        print(
            "DEEPGRAM_API_KEY is not set. Export it in the environment, or copy "
            ".env.example to .env on this host and fill that name. Do not commit .env.",
            file=sys.stderr,
        )
        return 2
    if "nova-3" not in DEEPGRAM_URL:
        print("relay is not pointed at Nova-3", file=sys.stderr)
        return 1
    try:
        asyncio.run(probe(api_key))
    except Exception as exc:
        print(f"Deepgram connection failed: {type(exc).__name__}", file=sys.stderr)
        return 1
    print("Deepgram Nova-3 accepted the socket.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
