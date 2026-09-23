"""The echo relay is started and spoken to, not merely imported.

A py_compile check proves the file parses. It proves nothing about whether the
handshake is right, and a websocket handshake is exactly the kind of thing that
is plausible and wrong: the Sec-WebSocket-Accept digest, the masking of client
frames, the two-byte length escape. So this starts the real process, completes a
real handshake against it, sends real masked binary frames and reads what comes
back.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import socket
import struct
import subprocess
import sys
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RELAY = ROOT / "tools" / "stt_echo_relay.py"
GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
PORT = 8901


def free_port(start: int) -> int:
    for port in range(start, start + 40):
        with socket.socket() as probe:
            try:
                probe.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    raise RuntimeError("no free port")


def send_masked(sock: socket.socket, payload: bytes, opcode: int) -> None:
    mask = os.urandom(4)
    masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
    header = bytearray([0x80 | opcode])
    n = len(payload)
    if n < 126:
        header.append(0x80 | n)
    elif n < (1 << 16):
        header.append(0x80 | 126)
        header += struct.pack(">H", n)
    else:
        header.append(0x80 | 127)
        header += struct.pack(">Q", n)
    sock.sendall(bytes(header) + mask + masked)


class Client:
    """A buffered websocket client.

    THE BUFFER IS THE POINT, AND IT IS WHY THIS CLASS EXISTS.

    The first version read the handshake with a single recv() and then read
    frames straight from the socket. TCP is a stream: on a Linux runner that one
    read returned the 101 response AND the ready frame sitting behind it, so the
    frame reader started after bytes it had already consumed and waited ten
    seconds for a message that had arrived before the test was looking. It
    passed on Windows, where the two happened to land in separate reads.

    Every byte after the header terminator is kept and served to the frame
    reader first.
    """

    def __init__(self, port: int) -> None:
        self.key = base64.b64encode(os.urandom(16)).decode("ascii")
        self.sock = socket.create_connection(("127.0.0.1", port), timeout=10)
        self.buf = b""
        request = (
            "GET / HTTP/1.1\r\n"
            "Host: 127.0.0.1\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            "Sec-WebSocket-Key: " + self.key + "\r\n"
            "Sec-WebSocket-Version: 13\r\n\r\n"
        )
        self.sock.sendall(request.encode("ascii"))
        terminator = b"\r\n\r\n"
        while terminator not in self.buf:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise ConnectionError("closed during handshake")
            self.buf += chunk
        head, self.buf = self.buf.split(terminator, 1)
        self.response = head.decode("latin-1")

    def _take(self, n: int) -> bytes:
        while len(self.buf) < n:
            chunk = self.sock.recv(max(4096, n - len(self.buf)))
            if not chunk:
                raise ConnectionError("closed while reading")
            self.buf += chunk
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def frame(self) -> bytes:
        head = self._take(2)
        length = head[1] & 0x7F
        if length == 126:
            length = struct.unpack(">H", self._take(2))[0]
        elif length == 127:
            length = struct.unpack(">Q", self._take(8))[0]
        return self._take(length) if length else b""

    def json(self) -> dict:
        return json.loads(self.frame())

    def send(self, payload: bytes, opcode: int) -> None:
        send_masked(self.sock, payload, opcode)

    def close(self) -> None:
        try:
            self.sock.close()
        except OSError:
            pass


class EchoRelaySpeaksWebsocket(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.port = free_port(PORT)
        cls.proc = subprocess.Popen(
            [sys.executable, str(RELAY), "--port", str(cls.port),
             "--script", "alpha bravo charlie delta"],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        deadline = time.time() + 20
        while time.time() < deadline:
            try:
                socket.create_connection(("127.0.0.1", cls.port), timeout=0.5).close()
                return
            except OSError:
                time.sleep(0.2)
        cls.proc.terminate()
        raise RuntimeError("relay never started listening")

    @classmethod
    def tearDownClass(cls) -> None:
        cls.proc.terminate()
        try:
            cls.proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            cls.proc.kill()

    def connect(self) -> Client:
        client = Client(self.port)
        self.addCleanup(client.close)
        return client

    def test_handshake_is_rfc_6455_and_the_digest_is_right(self):
        c = self.connect()
        self.assertIn("101 Switching Protocols", c.response)
        expected = base64.b64encode(
            hashlib.sha1((c.key + GUID).encode("ascii")).digest()).decode("ascii")
        self.assertIn(expected, c.response,
                      "Sec-WebSocket-Accept is wrong; a browser will refuse this")

    def test_it_announces_itself_as_an_echo_before_any_audio(self):
        hello = self.connect().json()
        self.assertEqual(hello["type"], "ready")
        self.assertTrue(hello["echo"],
                        "the page keys its scripted-transcript banner on this flag")

    def test_audio_reveals_the_script_and_every_frame_is_flagged(self):
        c = self.connect()
        c.json()                                        # the ready frame
        c.send(b"\x00" * 12000, 0x2)
        first = c.json()
        self.assertEqual(first["type"], "interim")
        self.assertEqual(first["text"], "alpha")
        self.assertTrue(first["echo"])
        c.send(b"\x00" * 12000, 0x2)
        second = c.json()
        self.assertTrue(second["text"].startswith("alpha bravo"))
        self.assertTrue(second["echo"])

    def test_the_last_word_arrives_as_a_final_not_an_interim(self):
        c = self.connect()
        c.json()
        last = None
        for _ in range(8):
            c.send(b"\x00" * 12000, 0x2)
            last = c.json()
            if last["type"] == "final":
                break
        self.assertIsNotNone(last)
        self.assertEqual(last["type"], "final",
                         "the script ran out without ever sending a final")
        self.assertEqual(last["text"], "alpha bravo charlie delta")

    def test_a_stop_message_closes_with_whatever_was_heard(self):
        c = self.connect()
        c.json()
        c.send(b"\x00" * 12000, 0x2)
        c.json()
        c.send(json.dumps({"type": "stop"}).encode("utf-8"), 0x1)
        final = c.json()
        self.assertEqual(final["type"], "final")
        self.assertEqual(final["text"], "alpha")

    def test_a_frame_over_125_bytes_uses_the_two_byte_length(self):
        # The escape everyone gets wrong. A 12 kB audio frame is the normal case
        # here, so if this were broken nothing would work at all - which is
        # precisely why it deserves its own named test rather than being assumed
        # from the tests above.
        c = self.connect()
        c.json()
        c.send(b"\x01" * 20000, 0x2)
        got = c.json()
        self.assertGreaterEqual(got["bytes"], 20000)


if __name__ == "__main__":
    unittest.main()
