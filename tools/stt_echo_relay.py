#!/usr/bin/env python3
"""A local echo relay, so the streaming page can be built before the key exists.

WHAT THIS IS
    The real relay is codex-cloud's and lives on Cloud Run: it forwards audio to
    a transcription provider and streams transcripts back. It cannot be built
    here, because the provider key must never reach a browser and does not yet
    exist. This stands in for it and speaks the same wire contract, so the page
    can be finished, exercised and rehearsed, and then re-pointed at the real
    endpoint by changing one URL.

WHAT IT IS NOT
    It does not transcribe anything. It counts audio and reveals a scripted
    sentence in step with it. Every message it sends carries "echo": true, and
    the page renders a banner whenever it sees that flag, so a scripted
    transcript can never be mistaken for a real one on a call.

WHY IT HAS NO DEPENDENCIES
    websockets and ws are both absent on this box, and a demo fixture that needs
    an install is a fixture that does not get run. This is RFC 6455 over the
    standard library: a handshake, masked client frames in, unmasked server
    frames out. It is deliberately the smallest thing that is correct.

    python tools/stt_echo_relay.py            # ws://127.0.0.1:8787
    python tools/stt_echo_relay.py --port 9001 --script "your sentence here"
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import socket
import struct
import threading
import time

GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

# The rehearsal script. Access Haiti is the first case this demo has to carry,
# and the question is the one a client would actually speak.
DEFAULT_SCRIPT = (
    "our visual flow on the work order cannot pull the serial number "
    "and it faults when the technician submits the form"
)

# How much audio buys one more word. 16 kHz mono 16-bit is 32000 bytes/second,
# so this reveals roughly three words a second - close enough to speech that the
# interim rendering gets exercised honestly.
BYTES_PER_WORD = 11000


def accept_key(key: str) -> str:
    digest = hashlib.sha1((key + GUID).encode("ascii")).digest()
    return base64.b64encode(digest).decode("ascii")


def read_exactly(conn: socket.socket, n: int) -> bytes:
    buf = b""
    while len(buf) < n:
        chunk = conn.recv(n - len(buf))
        if not chunk:
            raise ConnectionError("closed while reading")
        buf += chunk
    return buf


def read_frame(conn: socket.socket):
    """Returns (opcode, payload). Client frames are always masked."""
    head = read_exactly(conn, 2)
    fin_op, mask_len = head[0], head[1]
    opcode = fin_op & 0x0F
    masked = bool(mask_len & 0x80)
    length = mask_len & 0x7F
    if length == 126:
        length = struct.unpack(">H", read_exactly(conn, 2))[0]
    elif length == 127:
        length = struct.unpack(">Q", read_exactly(conn, 8))[0]
    mask = read_exactly(conn, 4) if masked else b""
    payload = read_exactly(conn, length) if length else b""
    if masked:
        payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
    return opcode, payload


def send_frame(conn: socket.socket, payload: bytes, opcode: int = 0x1) -> None:
    header = bytearray([0x80 | opcode])
    n = len(payload)
    if n < 126:
        header.append(n)
    elif n < (1 << 16):
        header.append(126)
        header += struct.pack(">H", n)
    else:
        header.append(127)
        header += struct.pack(">Q", n)
    conn.sendall(bytes(header) + payload)


def send_json(conn: socket.socket, obj: dict) -> None:
    obj = dict(obj)
    # NEVER let a scripted transcript look real. The page keys its banner on it.
    obj["echo"] = True
    send_frame(conn, json.dumps(obj).encode("utf-8"), 0x1)


def serve_one(conn: socket.socket, addr, script: str) -> None:
    words = script.split()
    try:
        request = b""
        while b"\r\n\r\n" not in request:
            request += conn.recv(4096)
        headers = {}
        for line in request.decode("latin-1").split("\r\n")[1:]:
            if ": " in line:
                k, v = line.split(": ", 1)
                headers[k.lower()] = v
        key = headers.get("sec-websocket-key")
        if not key:
            conn.sendall(b"HTTP/1.1 400 Bad Request\r\n\r\n")
            return
        handshake = (
            "HTTP/1.1 101 Switching Protocols\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            "Sec-WebSocket-Accept: %s\r\n\r\n" % accept_key(key)
        )
        conn.sendall(handshake.encode("ascii"))

        print("  [echo] %s:%s connected" % addr)
        send_json(conn, {"type": "ready", "note": "echo relay, not a transcriber"})

        audio_bytes = 0
        shown = 0
        while True:
            opcode, payload = read_frame(conn)
            if opcode == 0x8:                      # close
                break
            if opcode == 0x9:                      # ping
                send_frame(conn, payload, 0xA)
                continue
            if opcode == 0x1:                      # text: control from the page
                try:
                    msg = json.loads(payload.decode("utf-8"))
                except Exception:
                    continue
                if msg.get("type") == "stop":
                    send_json(conn, {"type": "final",
                                     "text": " ".join(words[:shown]) or ""})
                    break
                continue
            if opcode != 0x2:                      # only binary audio from here
                continue

            audio_bytes += len(payload)
            want = min(len(words), audio_bytes // BYTES_PER_WORD)
            if want > shown:
                shown = want
                done = shown >= len(words)
                send_json(conn, {
                    "type": "final" if done else "interim",
                    "text": " ".join(words[:shown]),
                    "bytes": audio_bytes,
                })
    except (ConnectionError, OSError):
        pass
    finally:
        try:
            conn.close()
        except OSError:
            pass
        print("  [echo] %s:%s closed" % addr)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8787)
    ap.add_argument("--script", default=DEFAULT_SCRIPT,
                    help="the sentence revealed in step with the audio")
    args = ap.parse_args()

    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind((args.host, args.port))
    srv.listen(4)
    print("echo relay on ws://%s:%d" % (args.host, args.port))
    print("  it does not transcribe. every message carries echo:true.")
    print("  script: %s" % args.script)
    try:
        while True:
            conn, addr = srv.accept()
            threading.Thread(target=serve_one, args=(conn, addr, args.script),
                             daemon=True).start()
    except KeyboardInterrupt:
        print("\nstopped")
    finally:
        srv.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
