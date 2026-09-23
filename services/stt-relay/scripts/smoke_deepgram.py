"""Open a Nova-3 socket using DEEPGRAM_API_KEY.

Cloud Run supplies the name on the service. Local VANLAS smoke reads
C:\\Users\\salam\\Quantum\\Blackboard\\.env when the process does not already
have it. Does not print the key. Exits 2 when it is missing, 1 when Deepgram
rejects the connection, 0 when the socket accepts.
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.envfile import blackboard_label, resolve_deepgram_key  # noqa: E402
from app.upstream import DEEPGRAM_URL  # noqa: E402


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
    api_key, source = resolve_deepgram_key(ROOT / ".env")
    if not api_key:
        print(
            "DEEPGRAM_API_KEY is not in the process environment and was not in "
            f"{blackboard_label(ROOT / '.env')}. Cloud Run must set DEEPGRAM_API_KEY on the "
            "service. Do not commit .env.",
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
    where = "process environment" if source == "process" else source
    print(f"Deepgram Nova-3 accepted the socket. Key source: {where}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
