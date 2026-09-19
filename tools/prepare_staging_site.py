#!/usr/bin/env python3
"""Prepare a static checkout for staging preview (no model).

Modes:
  relative  — depth-aware rewrite of root-absolute href/src (jsDelivr / raw.githack)
  prefix    — rewrite root-absolute href/src to {prefix}/... (project Pages or /staging/)

Also: strip CNAME, inject noindex + visible STAGING banner, write STAGING.json.
Fails closed on known present-tense live-org claim phrases.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

SKIP_DIRS = {".git", ".github", "node_modules", "tests", "test-results", ".cursor"}
SKIP_NAMES = {"CNAME", "package-lock.json"}

FORBIDDEN = [
    re.compile(p, re.I)
    for p in [
        r"scores? a live org",
        r"reading your (live )?org",
        r"connected to your (salesforce )?org",
        r"scans? your (live )?org",
        r"pulls? from your (salesforce )?org",
    ]
]

BANNER = (
    '<div id="sfdc24-staging-banner" role="status" '
    'style="position:sticky;top:0;z-index:99999;background:#7a1f1f;color:#fff;'
    'font:600 13px/1.4 system-ui,sans-serif;padding:8px 12px;text-align:center">'
    'STAGING — not www.sfdc24.com production. Do not treat as live-org proof.'
    '</div>\n'
)

META_NOINDEX = '<meta name="robots" content="noindex,nofollow">\n'
ATTR_URL_RE = re.compile(r"""\b(href|src|action)=(["'])([^"']*)\2""", re.I)


def should_copy(path: Path, root: Path) -> bool:
    rel = path.relative_to(root)
    if any(p in SKIP_DIRS for p in rel.parts):
        return False
    if path.name in SKIP_NAMES:
        return False
    if path.suffix.lower() in {".map", ".log"}:
        return False
    return True


def root_abs_to_relative(html_rel: Path, url_path: str) -> str:
    if not url_path.startswith("/") or url_path.startswith("//"):
        return url_path
    target = url_path[1:]
    start_dir = "." if html_rel.parent == Path(".") else str(html_rel.parent).replace("\\", "/")
    if target == "" or target.endswith("/"):
        file_target = (target + "index.html") if target else "index.html"
        rel = os.path.relpath(file_target, start=start_dir).replace("\\", "/")
        if rel.endswith("index.html"):
            rel = rel[: -len("index.html")]
            if rel == "":
                rel = "./"
        return rel
    rel = os.path.relpath(target, start=start_dir).replace("\\", "/")
    return rel


def rewrite_urls(text: str, mode: str, prefix: str, html_rel: Path) -> str:
    def repl(m: re.Match[str]) -> str:
        attr, quote, path = m.group(1), m.group(2), m.group(3)
        if path.startswith("/") and not path.startswith("//"):
            if mode == "prefix":
                pref = prefix.rstrip("/")
                return f"{attr}={quote}{pref}{path}{quote}"
            return f"{attr}={quote}{root_abs_to_relative(html_rel, path)}{quote}"
        return m.group(0)

    return ATTR_URL_RE.sub(repl, text)


def inject_head_body(html: str) -> str:
    if "sfdc24-staging-banner" not in html:
        if re.search(r"<body[^>]*>", html, re.I):
            html = re.sub(r"(<body[^>]*>)", r"\1\n" + BANNER, html, count=1, flags=re.I)
        else:
            html = BANNER + html
    if re.search(r'name=["\']robots["\']', html, re.I) is None:
        if re.search(r"<head[^>]*>", html, re.I):
            html = re.sub(r"(<head[^>]*>)", r"\1\n" + META_NOINDEX, html, count=1, flags=re.I)
        else:
            html = META_NOINDEX + html
    html = re.sub(
        r"""<link\s+rel=["']canonical["'][^>]*>""",
        '<meta name="sfdc24-staging" content="1">',
        html,
        flags=re.I,
    )
    return html


def scan_forbidden(root: Path) -> list[str]:
    hits: list[str] = []
    for p in root.rglob("*.html"):
        if any(x in p.parts for x in SKIP_DIRS):
            continue
        text = p.read_text(encoding="utf-8", errors="replace")
        for rx in FORBIDDEN:
            m = rx.search(text)
            if m:
                hits.append(f"{p.relative_to(root)}: {m.group(0)}")
    return hits


def prepare(src: Path, out: Path, mode: str, prefix: str) -> dict:
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)

    copied = 0
    html_n = 0
    for path in src.rglob("*"):
        if not path.is_file() or not should_copy(path, src):
            continue
        rel = path.relative_to(src)
        dest = out / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        if path.suffix.lower() in {".html", ".htm"}:
            text = path.read_text(encoding="utf-8", errors="replace")
            text = inject_head_body(text)
            text = rewrite_urls(text, mode, prefix, rel)
            dest.write_text(text, encoding="utf-8")
            html_n += 1
        else:
            shutil.copy2(path, dest)
        copied += 1

    (out / ".nojekyll").write_text("", encoding="utf-8")
    meta = {
        "role": "staging",
        "prepared_at": datetime.now(timezone.utc).isoformat(),
        "mode": mode,
        "prefix": prefix if mode == "prefix" else None,
        "files": copied,
        "html_files": html_n,
        "production": "https://www.sfdc24.com/",
        "note": "STAGING only — not production; no live-org claims.",
    }
    (out / "STAGING.json").write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")

    hits = scan_forbidden(out)
    if hits:
        print("FORBIDDEN live-org claim phrases in staging output:", file=sys.stderr)
        for h in hits:
            print(" ", h, file=sys.stderr)
        raise SystemExit(2)
    return meta


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--src", type=Path, default=Path("."))
    ap.add_argument("--out", type=Path, default=Path("_staging_out"))
    ap.add_argument("--mode", choices=("relative", "prefix"), default="relative")
    ap.add_argument("--prefix", default="/staging")
    args = ap.parse_args()
    meta = prepare(args.src.resolve(), args.out.resolve(), args.mode, args.prefix)
    print(json.dumps(meta))


if __name__ == "__main__":
    main()
