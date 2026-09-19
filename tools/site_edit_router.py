#!/usr/bin/env python3
"""Tier-zero site edit router — NO model calls.

Input JSON: {intent, target, kind: find_replace|css_var|static_section|triage_answer, ...}
Cheap path: apply patch. Escalate: print Claude hand-off packet; do not call Claude.
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "data" / "site-manifest.json"

ORG_NOUN = re.compile(r"\b(salesforce|org|tenant|instance|environment)\b", re.I)
FIRST_PERSON = re.compile(r"\b(I|me|my|mine|myself)\b")

ESCALATE_KINDS_FORCE = {
    "triage_routing", "crew_dol", "chrome_logic", "new_page", "ambiguous",
}


def load_manifest() -> dict:
    if not MANIFEST.is_file():
        raise SystemExit(f"missing {MANIFEST} — run tools/build_site_manifest.py first")
    return json.loads(MANIFEST.read_text(encoding="utf-8"))


def handoff(ask: str, slice_: dict, rule: str, why: str) -> dict:
    packet = {
        "handoff": "claude",
        "original_ask": ask,
        "manifest_slice": slice_,
        "firing_rule": rule,
        "why_not_cheap": why,
    }
    print(json.dumps(packet, indent=2, ensure_ascii=False))
    return packet


def allowed_target(manifest: dict, target: str) -> bool:
    paths = manifest.get("paths") or {}
    allowed = set(paths.values()) | {"index.html"}
    return target in allowed


def would_trip_guards(text: str) -> str | None:
    if ORG_NOUN.search(text or ""):
        return "new visitor-visible claim hits ORG_NOUN guard"
    if FIRST_PERSON.search(text or ""):
        return "new visitor-visible claim hits first-person guard"
    return None


def git(cmd: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, cwd=ROOT, text=True, capture_output=True)


def apply_find_replace(path: Path, find: str, replace: str, dry: bool) -> str:
    text = path.read_text(encoding="utf-8")
    if find not in text:
        raise SystemExit(f"find string not present in {path}")
    count = text.count(find)
    new = text.replace(find, replace)
    patch = f"--- {path}\n+++ {path}\n@@ find_replace x{count} @@\n-{find}\n+{replace}\n"
    if not dry:
        path.write_text(new, encoding="utf-8")
    return patch


def apply_css_var(path: Path, var: str, value: str, dry: bool) -> str:
    text = path.read_text(encoding="utf-8")
    pat = re.compile(rf"({re.escape(var)}\s*:\s*)([^;]+)(;)")
    m = pat.search(text)
    if not m:
        raise SystemExit(f"css var {var} not found in {path}")
    old = m.group(0)
    new_frag = f"{m.group(1)}{value}{m.group(3)}"
    new = pat.sub(new_frag, text, count=1)
    patch = f"--- {path}\n+++ {path}\n-{old}\n+{new_frag}\n"
    if not dry:
        path.write_text(new, encoding="utf-8")
    return patch


def apply_static_section(path: Path, section_id: str, cls: str, body: str, dry: bool) -> str:
    text = path.read_text(encoding="utf-8")
    if f'id="{section_id}"' in text:
        raise SystemExit(f"section id={section_id} already exists")
    block = f'<section class="{cls}" id="{section_id}">\n{body}\n</section>\n'
    anchor = "<!-- /.hero -->"
    if anchor not in text:
        raise SystemExit("homepage hero sentinel missing — cannot place section")
    new = text.replace(anchor, anchor + "\n" + block, 1)
    patch = f"--- {path}\n+++ insert after hero\n+{block}\n"
    if not dry:
        path.write_text(new, encoding="utf-8")
    return patch


def apply_triage_answer(triage_id: str, answer: str, dry: bool) -> str:
    py = ROOT / "assets" / "triage.py"
    text = py.read_text(encoding="utf-8")
    pat = re.compile(
        rf'("id"\s*:\s*"{re.escape(triage_id)}"[\s\S]*?"answer"\s*:\s*")([^"]*)(")',
        re.M,
    )
    m = pat.search(text)
    if not m:
        raise SystemExit(f"triage id {triage_id!r} answer not found for safe swap")
    old = m.group(2)
    new_text = text[: m.start(2)] + answer + text[m.end(2) :]
    patch = f"--- assets/triage.py\n- answer: {old}\n+ answer: {answer}\n"
    if not dry:
        py.write_text(new_text, encoding="utf-8")
        try:
            sys.path.insert(0, str(ROOT / "assets"))
            import triage as tri  # type: ignore
            problems = []
            if hasattr(tri, "check") and hasattr(tri, "RULES"):
                problems = list(tri.check(tri.RULES))
            if problems:
                py.write_text(text, encoding="utf-8")
                raise SystemExit(f"triage check() failed: {problems[:3]}")
        except SystemExit:
            raise
        except Exception as e:
            patch += f"# note: triage.check not executed ({e})\n"
    return patch


def maybe_commit(branch: str | None, message: str, dry: bool) -> None:
    if dry or not branch:
        return
    git(["git", "checkout", "-B", branch])
    git(["git", "add", "-A"])
    git(["git", "commit", "-m", message])


def route(req: dict) -> int:
    t0 = time.perf_counter()
    manifest = load_manifest()
    intent = str(req.get("intent") or "")
    target = str(req.get("target") or "index.html")
    kind = str(req.get("kind") or "")
    dry = bool(req.get("dry_run", False))

    if not kind or not intent:
        handoff(intent or req, {"scope": manifest.get("scope")}, "ambiguous_no_manifest_target",
                "intent or kind missing — no single cheap operation")
        return 2

    if kind in ESCALATE_KINDS_FORCE or kind in {
        "triage_routing", "crew_dol_wiring", "chrome_js", "liveflow", "wakeFleet", "estimator", "new_page"
    }:
        handoff(intent, {"paths": manifest.get("paths")}, kind,
                "request touches routing/CREW/DoL/chrome logic/new pages — not tier-zero")
        return 2

    if not allowed_target(manifest, target):
        handoff(intent, {"target": target, "allowed": list((manifest.get("paths") or {}).values())},
                "ambiguous_no_manifest_target",
                "target outside homepage manifest scope")
        return 2

    probe = " ".join(str(req.get(k) or "") for k in ("replace", "value", "section_body", "answer"))
    trip = would_trip_guards(probe)
    if trip and kind in {"find_replace", "static_section", "triage_answer"}:
        find = str(req.get("find") or "")
        if kind == "find_replace" and ORG_NOUN.search(str(req.get("replace") or "")) and not ORG_NOUN.search(find):
            handoff(intent, {"find": find, "replace": req.get("replace")},
                    "new_org_noun_or_first_person_claim", trip)
            return 2
        if kind != "find_replace" and trip:
            handoff(intent, {"probe": probe[:200]}, "new_org_noun_or_first_person_claim", trip)
            return 2

    path = ROOT / target
    if kind == "find_replace":
        patch = apply_find_replace(path, str(req["find"]), str(req["replace"]), dry)
    elif kind == "css_var":
        patch = apply_css_var(path, str(req["var"]), str(req["value"]), dry)
    elif kind == "static_section":
        patch = apply_static_section(
            path, str(req["section_id"]), str(req.get("section_cls") or "added"),
            str(req["section_body"]), dry,
        )
    elif kind == "triage_answer":
        patch = apply_triage_answer(str(req["triage_id"]), str(req["answer"]), dry)
    else:
        handoff(intent, {"kind": kind}, "ambiguous_no_manifest_target",
                f"unknown kind {kind!r}")
        return 2

    ms = (time.perf_counter() - t0) * 1000
    maybe_commit(req.get("branch"), f"router: {intent}", dry)
    print(json.dumps({
        "ok": True,
        "dry_run": dry,
        "intent": intent,
        "target": target,
        "kind": kind,
        "elapsed_ms": round(ms, 2),
        "patch": patch,
    }, indent=2, ensure_ascii=False))
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Tier-zero homepage edit router")
    ap.add_argument("--request", "-r", help="JSON file or inline JSON")
    ap.add_argument("--stdin", action="store_true", help="Read JSON request from stdin")
    args = ap.parse_args(argv)
    if args.stdin:
        req = json.load(sys.stdin)
    elif args.request:
        raw = args.request
        p = Path(raw)
        req = json.loads(p.read_text(encoding="utf-8") if p.is_file() else raw)
    else:
        ap.error("provide --request or --stdin")
        return 2
    return route(req)


if __name__ == "__main__":
    raise SystemExit(main())
