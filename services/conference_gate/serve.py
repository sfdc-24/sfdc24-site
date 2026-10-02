"""Run the conference gate. The host code is resolved on the server."""

from __future__ import annotations

import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

from gate import Settings, State, dispatch


def origin_ok(origin: str) -> bool:
    if origin in {"https://www.sfdc24.com", "https://sfdc24.com", "https://portal.sfdc24.com", "http://site.test"}:
        return True
    try:
        parsed = urlparse(origin)
    except ValueError:
        return False
    if parsed.scheme == "http" and parsed.hostname in {"127.0.0.1", "localhost"}:
        return True
    return False


def make_handler(settings: Settings, state: State):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, fmt, *args):
            sys.stderr.write("%s %s\n" % (self.command, self.path.split("?", 1)[0]))

        def _cors(self):
            origin = self.headers.get("Origin", "")
            if origin and origin_ok(origin):
                self.send_header("Access-Control-Allow-Origin", origin)
                self.send_header("Vary", "Origin")
                self.send_header("Access-Control-Allow-Headers", "content-type, authorization, accept")
                self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
                self.send_header("Access-Control-Allow-Private-Network", "true")

        def _send(self, status, payload):
            raw = json.dumps(payload).encode("utf-8")
            self.send_response(status)
            self._cors()
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def do_OPTIONS(self):
            self.send_response(204)
            self._cors()
            self.send_header("Content-Length", "0")
            self.end_headers()

        def do_GET(self):
            path = urlparse(self.path).path
            status, payload = dispatch(settings, state, "GET", path, {}, dict(self.headers))
            self._send(status, payload)

        def do_POST(self):
            path = urlparse(self.path).path
            try:
                length = int(self.headers.get("Content-Length") or "0")
            except ValueError:
                length = 0
            if length < 0 or length > 8000:
                self._send(413, {"ok": False, "error": "too_large"})
                return
            raw = self.rfile.read(length) if length else b"{}"
            try:
                body = json.loads(raw.decode("utf-8") or "{}")
            except (UnicodeDecodeError, json.JSONDecodeError):
                self._send(400, {"ok": False, "error": "bad_json"})
                return
            if not isinstance(body, dict):
                self._send(400, {"ok": False, "error": "bad_json"})
                return
            status, payload = dispatch(settings, state, "POST", path, body, dict(self.headers))
            self._send(status, payload)

    return Handler


def serve(port: int | None = None) -> None:
    settings = Settings.from_env()
    state = State()
    chosen = int(port if port is not None else os.environ.get("PORT", "8787"))
    httpd = ThreadingHTTPServer(("127.0.0.1", chosen), make_handler(settings, state))
    sys.stderr.write("conference-gate %s\n" % httpd.server_address[1])
    httpd.serve_forever()


if __name__ == "__main__":
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    serve()
