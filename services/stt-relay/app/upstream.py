"""Deepgram Nova-3 streaming client, plus a fake used when STT_FAKE_UPSTREAM=1."""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass

import websockets

DEEPGRAM_URL = (
    "wss://api.deepgram.com/v1/listen"
    "?model=nova-3"
    "&encoding=linear16"
    "&sample_rate=16000"
    "&channels=1"
    "&interim_results=true"
    "&punctuate=true"
    "&smart_format=true"
    "&endpointing=300"
)


@dataclass
class Transcript:
    text: str
    is_final: bool


def parse_deepgram_message(raw: str) -> Transcript | None:
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return None
    kind = data.get("type")
    if kind not in (None, "Results"):
        return None
    channel = data.get("channel") or {}
    alternatives = channel.get("alternatives") or []
    if not alternatives:
        return None
    text = str(alternatives[0].get("transcript") or "").strip()
    if not text:
        return None
    is_final = bool(data.get("is_final") or data.get("speech_final"))
    return Transcript(text=text, is_final=is_final)


class DeepgramUpstream:
    def __init__(self, api_key: str):
        self._api_key = api_key
        self._ws = None

    async def connect(self) -> None:
        # The key travels as a header, not a query parameter.
        self._ws = await websockets.connect(
            DEEPGRAM_URL,
            additional_headers={"Authorization": "Token " + self._api_key},
            open_timeout=10,
        )

    async def send_audio(self, pcm: bytes) -> None:
        if self._ws is not None and pcm:
            await self._ws.send(pcm)

    async def keepalive(self) -> None:
        if self._ws is not None:
            await self._ws.send(json.dumps({"type": "KeepAlive"}))

    async def recv(self) -> Transcript | None:
        if self._ws is None:
            return None
        raw = await self._ws.recv()
        if isinstance(raw, bytes):
            return None
        return parse_deepgram_message(raw)

    async def close(self) -> None:
        if self._ws is not None:
            await self._ws.close()
            self._ws = None


class FakeUpstream:
    """Emits one final line on connect so a browser test can see words without a mic."""

    def __init__(self) -> None:
        self.audio = bytearray()
        self.queue: asyncio.Queue = asyncio.Queue()
        self.connected = False
        self.closed = False
        self.keepalives = 0

    async def connect(self) -> None:
        self.connected = True
        await self.queue.put(Transcript("please call back about automation", True))

    async def send_audio(self, pcm: bytes) -> None:
        self.audio.extend(pcm)

    async def keepalive(self) -> None:
        self.keepalives += 1

    async def recv(self) -> Transcript | None:
        return await self.queue.get()

    async def close(self) -> None:
        self.closed = True
        await self.queue.put(None)
