#!/usr/bin/env python3
"""Poll GitHub Pages until a path returns 200 (optional body hash).

Cycle: Detect → Script → Validate N cycles → Measure → Retire model path
(docs/python-offload.md). Replaces the “is it live yet?” token loop.

Use after merge so models do not sit in a loop asking “is it live yet?”

  python3 tools/pages_wait.py --path /assets/cabinet.js
  python3 tools/pages_wait.py --path /assets/next-deploy.js --sha256 <hex>
  python3 tools/pages_wait.py --path /history/ --timeout 180 --interval 5
"""
from __future__ import annotations

import argparse
import hashlib
import sys
import time
import urllib.error
import urllib.request

DEFAULT_BASE = "https://www.sfdc24.com"
UA = "sfdc24-pages-wait/1.0 (+https://www.sfdc24.com)"


def fetch(url: str, timeout: float) -> tuple[int, bytes, float, str | None]:
    req = urllib.request.Request(url, method="GET", headers={"User-Agent": UA})
    t0 = time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read()
            ttfb_ms = (time.perf_counter() - t0) * 1000
            return resp.status, body, ttfb_ms, None
    except urllib.error.HTTPError as exc:
        ttfb_ms = (time.perf_counter() - t0) * 1000
        return exc.code, b"", ttfb_ms, str(exc.reason or exc)
    except Exception as exc:  # noqa: BLE001 — wait loop must keep polling
        ttfb_ms = (time.perf_counter() - t0) * 1000
        return 0, b"", ttfb_ms, f"{type(exc).__name__}: {exc}"


def join(base: str, path: str) -> str:
    if path.startswith("http://") or path.startswith("https://"):
        return path
    return base.rstrip("/") + (path if path.startswith("/") else "/" + path)


def match_hash(body: bytes, expect: str | None) -> bool:
    if not expect:
        return True
    digest = hashlib.sha256(body).hexdigest()
    want = expect.lower().removeprefix("sha256:")
    return digest == want


def wait(
    url: str,
    *,
    timeout: float,
    interval: float,
    request_timeout: float,
    sha256: str | None,
) -> int:
    deadline = time.monotonic() + timeout
    attempt = 0
    last = "not started"
    while True:
        attempt += 1
        status, body, ttfb_ms, err = fetch(url, request_timeout)
        hashed = hashlib.sha256(body).hexdigest()[:12] if body else "-"
        if status == 200 and match_hash(body, sha256):
            print(
                f"LIVE  attempt={attempt}  {ttfb_ms:.1f}ms  200  {url}  sha256={hashed}…"
            )
            return 0
        why = err or f"status={status}"
        if status == 200 and sha256:
            why = f"hash mismatch (got {hashed}…)"
        last = why
        left = deadline - time.monotonic()
        print(f"wait  attempt={attempt}  {ttfb_ms:.1f}ms  {why}  {url}")
        if left <= 0:
            print(f"TIMEOUT after {timeout:.0f}s  last={last}", file=sys.stderr)
            return 1
        time.sleep(min(interval, max(0.1, left)))


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Poll Pages until path/hash is 200")
    ap.add_argument("--base", default=DEFAULT_BASE)
    ap.add_argument("--path", required=True, help="URL path or absolute URL")
    ap.add_argument("--sha256", help="Optional expected SHA-256 of the response body")
    ap.add_argument("--timeout", type=float, default=180.0, help="Total wait seconds")
    ap.add_argument("--interval", type=float, default=5.0, help="Sleep between probes")
    ap.add_argument("--request-timeout", type=float, default=10.0)
    args = ap.parse_args(argv)
    return wait(
        join(args.base, args.path),
        timeout=args.timeout,
        interval=args.interval,
        request_timeout=args.request_timeout,
        sha256=args.sha256,
    )


if __name__ == "__main__":
    raise SystemExit(main())
