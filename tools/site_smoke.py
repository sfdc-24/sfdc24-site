#!/usr/bin/env python3
"""HTTP smoke for www.sfdc24.com. No model calls.

Cycle: Detect → Script → Validate N cycles → Measure → Retire model path
(docs/python-offload.md). TTFB is the measurement; models still judge honesty.

Probes the homepage plus key live assets. Prints TTFB per URL. Exit 1 on any
non-200 (or network error).

  python3 tools/site_smoke.py
  python3 tools/site_smoke.py --base https://www.sfdc24.com --timeout 8
"""
from __future__ import annotations

import argparse
import sys
import time
import urllib.error
import urllib.request

DEFAULT_BASE = "https://www.sfdc24.com"
DEFAULT_PATHS = (
    "/",
    "/assets/next-deploy.js",
    "/history/",
    "/assets/cabinet.js",
)
UA = "sfdc24-site-smoke/1.0 (+https://www.sfdc24.com)"


def probe(url: str, timeout: float) -> dict:
    req = urllib.request.Request(url, method="GET", headers={"User-Agent": UA})
    t0 = time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            ttfb_ms = (time.perf_counter() - t0) * 1000
            body = resp.read(64)
            return {
                "url": url,
                "ok": 200 <= resp.status < 300,
                "status": resp.status,
                "ttfb_ms": round(ttfb_ms, 1),
                "bytes": len(body),
                "error": None,
            }
    except urllib.error.HTTPError as exc:
        ttfb_ms = (time.perf_counter() - t0) * 1000
        return {
            "url": url,
            "ok": False,
            "status": exc.code,
            "ttfb_ms": round(ttfb_ms, 1),
            "bytes": 0,
            "error": str(exc.reason or exc),
        }
    except Exception as exc:  # noqa: BLE001 — smoke must fail closed
        ttfb_ms = (time.perf_counter() - t0) * 1000
        return {
            "url": url,
            "ok": False,
            "status": 0,
            "ttfb_ms": round(ttfb_ms, 1),
            "bytes": 0,
            "error": f"{type(exc).__name__}: {exc}",
        }


def join(base: str, path: str) -> str:
    return base.rstrip("/") + (path if path.startswith("/") else "/" + path)


def run(base: str, paths: list[str], timeout: float) -> int:
    results = [probe(join(base, p), timeout) for p in paths]
    failed = 0
    home_ttfb = None
    for row in results:
        mark = "OK  " if row["ok"] else "FAIL"
        extra = "" if row["ok"] else f"  {row['error']}"
        print(f"{mark}  {row['ttfb_ms']:7.1f}ms  {row['status']:3}  {row['url']}{extra}")
        if not row["ok"]:
            failed += 1
        if row["url"].rstrip("/").endswith("www.sfdc24.com") or row["url"].endswith(base.rstrip("/") + "/"):
            home_ttfb = row["ttfb_ms"]
    if home_ttfb is None and results:
        home_ttfb = results[0]["ttfb_ms"]
    print(f"TTFB homepage={home_ttfb}ms  failed={failed}/{len(results)}")
    return 1 if failed else 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="HTTP smoke www.sfdc24.com + key assets")
    ap.add_argument("--base", default=DEFAULT_BASE, help="Origin (default: production)")
    ap.add_argument("--timeout", type=float, default=10.0, help="Per-request timeout seconds")
    ap.add_argument(
        "--path",
        action="append",
        dest="paths",
        help="Extra path to probe (defaults: homepage, next-deploy.js, /history/, cabinet.js)",
    )
    args = ap.parse_args(argv)
    paths = list(DEFAULT_PATHS)
    if args.paths:
        paths.extend(args.paths)
    return run(args.base, paths, args.timeout)


if __name__ == "__main__":
    raise SystemExit(main())
