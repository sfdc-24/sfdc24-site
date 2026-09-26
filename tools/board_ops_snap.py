#!/usr/bin/env python3
"""Bake the Ops snapshot. No live bus, no Alpha DB.

The page at /ops/ polls a static JSON file. This tool writes that file.
It never calls the Apps Script bus. GitHub Actions (this repo's
GITHUB_TOKEN) and public health probes are enough; a sanitized export
may be passed with --export or BOARD_OPS_EXPORT when a board summary
already exists. Raw board rows, tokens, and transcripts are dropped.

The workflow (.github/workflows/board-ops-snap.yml) commits the file to
the board-ops-snap branch, never main, so a bake cannot rebuild Pages.

  python3 tools/board_ops_snap.py --sample --out data/board-ops-snap.json
  python3 tools/board_ops_snap.py --validate data/board-ops-snap.json
  python3 tools/board_ops_snap.py --bake --out data/board-ops-snap.json
  python3 tools/board_ops_snap.py --bake --offline --out /tmp/snap.json

Schema v1 is the allowlist in SNAP_KEYS. Codex may refine it; unknown
keys are stripped rather than rendered.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

# Keep these two hosts aligned with tools/speed_log.py (the post-deploy probes).
WWW = "https://www.sfdc24.com"
CONTROLLER = "https://sfdc24-studio-controller-96522051727.us-central1.run.app"
UA = "sfdc24-board-ops/1.0 (+https://www.sfdc24.com)"

MAX_BYTES = 12000
ID_PREFIX = 16
REFRESH_MIN, REFRESH_MAX = 60, 120
BAKE_EVERY_DEFAULT = 5

REPOS = (
    ("sfdc-24/sfdc24-site", "sfdc24-site"),
    ("sfdc-24/Blackboard", "Blackboard"),
)
ROSTER = ("grok", "claude-code-cli", "codex", "cursor")

SNAP_KEYS = {
    "v", "baked_at", "refresh_sec", "bake_every_min", "source",
    "agents", "open_work", "edges", "envs", "ci", "branches", "stats",
}
AGENT_KEYS = {"id", "last_seen", "writes_1h", "open_dispatch", "status"}
WORK_KEYS = {"id", "from", "to", "phase", "age_min", "pr"}
WORK_REQUIRED = {"id", "from", "to", "phase", "age_min"}
EDGE_KEYS = {"from", "to", "phase", "ts"}
ENV_KEYS = {"id", "label", "health", "note", "traffic_pct"}
ENV_REQUIRED = {"id", "label", "health"}
CI_KEYS = {"repo", "conclusion", "name", "url", "ts"}
CI_REQUIRED = {"repo", "conclusion", "name", "ts"}
STATS_KEYS = {
    "rows_sampled", "dispatch_open", "result_1h", "nogo_1h", "median_ack_min",
    "deploy_lead_min", "success_7d_pct", "error_rate_pct",
}
BRANCH_KEYS = {"name", "kind", "merged"}
BRANCH_KINDS = {"feature", "fix", "chore"}
BRANCH_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$")

STATUSES = {"hot", "warm", "cool", "quiet"}
PHASES = {"DISPATCH", "REVIEW", "RESULT", "NOGO", "ACK"}
HEALTHS = {"ok", "degraded", "unknown"}
CONCLUSIONS = {"success", "failure", "cancelled", "skipped", "unknown"}
SOURCES = {"sample", "bake"}
REPOS_SHORT = {"sfdc24-site", "Blackboard"}

TS_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")
IDENT_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,31}$")
LABEL_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 .,:/+-]{0,63}$")
URL_RE = re.compile(
    r"^https://github\.com/sfdc-24/(?:sfdc24-site|Blackboard)/[A-Za-z0-9._~:/?#\[\]@!$&'()*+,;=%-]{0,160}$"
)
RETIRED_RE = re.compile(r"foundry|azure", re.I)
EMAIL_RE = re.compile(r"[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}", re.I)
# Credential-shaped values. The prefixes are split so this source file does
# not itself contain a token literal a scanner would treat as live.
SECRET_VALUE_RE = re.compile(
    "|".join((
        "gh" + "p_",
        "github_" + "pat_",
        "gho" + "_",
        "glpat-",
        "xox[baprs]-",
        "sk-",
        "ya29.",
        "AKIA[0-9A-Z]{16}",
        "-----BEGIN ",
    )),
    re.I,
)
FORBIDDEN_KEYS = {
    "email", "e-mail", "mail", "token", "access_token", "refresh_token", "id_token",
    "secret", "password", "passwd", "credential", "credentials", "api_key", "apikey",
    "authorization", "auth", "transcript", "payload", "raw", "body", "cookie",
    "cookies", "session", "private_key", "bearer", "authorization_header",
}
# A bus URL must never be requested, even if an env var names one.
BUS_MARKERS = ("script.google.com", "script.googleusercontent.com", "spreadsheets", "/macros/", "alpha-db")

CAPS = {"agents": 12, "open_work": 16, "edges": 24, "envs": 6, "ci": 8, "branches": 8}


def now_utc() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _ts(value) -> bool:
    return isinstance(value, str) and bool(TS_RE.match(value))


def _ident(value) -> str | None:
    if not isinstance(value, str):
        return None
    text = value.strip().lower()
    if not IDENT_RE.match(text) or _retired(text) or _secretish(text):
        return None
    return text[:ID_PREFIX]


def _prefix_id(value) -> str | None:
    """Work ids keep their original case, cut to a prefix, and stay token-safe."""
    if not isinstance(value, str):
        return None
    text = value.strip()
    if not text or len(text) > 80 or _retired(text) or _secretish(text):
        return None
    if not re.match(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$", text):
        return None
    return text[:ID_PREFIX]


def _retired(value) -> bool:
    return isinstance(value, str) and bool(RETIRED_RE.search(value))


def _secretish(value) -> bool:
    return isinstance(value, str) and (bool(EMAIL_RE.search(value)) or bool(SECRET_VALUE_RE.search(value)))


def _forbidden_key(key) -> bool:
    if not isinstance(key, str):
        return True
    norm = key.strip().lower().replace("-", "_")
    return norm in FORBIDDEN_KEYS or norm.endswith("_token") or norm.endswith("_secret")


def _count(value, limit: int = 100000) -> int:
    if type(value) is not int or isinstance(value, bool):
        return 0
    if value < 0:
        return 0
    return value if value <= limit else limit


def _label(value, limit: int = 64) -> str | None:
    if not isinstance(value, str):
        return None
    text = " ".join(value.split())
    if not text or len(text) > limit or not LABEL_RE.match(text):
        return None
    if _retired(text) or _secretish(text):
        return None
    return text


def _phase(value) -> str | None:
    if not isinstance(value, str):
        return None
    phase = value.strip().upper()
    return phase if phase in PHASES else None


def _minutes_between(later: str, earlier: str) -> int | None:
    if not (_ts(later) and _ts(earlier)):
        return None
    a = datetime.strptime(later, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    b = datetime.strptime(earlier, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    return int((a - b).total_seconds() // 60)


def median(values) -> float | None:
    nums = []
    for value in values or []:
        if type(value) is bool or not isinstance(value, (int, float)):
            continue
        if value < 0:
            continue
        nums.append(float(value))
    if not nums:
        return None
    nums.sort()
    mid = len(nums) // 2
    if len(nums) % 2:
        picked = nums[mid]
    else:
        picked = (nums[mid - 1] + nums[mid]) / 2
    return round(picked, 1)


def _clean_agent(row) -> dict | None:
    if not isinstance(row, dict) or any(_forbidden_key(k) for k in row):
        if isinstance(row, dict) and any(_forbidden_key(k) for k in row):
            row = {k: v for k, v in row.items() if not _forbidden_key(k)}
        elif not isinstance(row, dict):
            return None
    ident = _ident(row.get("id"))
    if not ident:
        return None
    status = row.get("status") if row.get("status") in STATUSES else "quiet"
    last = row.get("last_seen")
    last_out = last if _ts(last) else None
    return {
        "id": ident,
        "last_seen": last_out,
        "writes_1h": _count(row.get("writes_1h")),
        "open_dispatch": _count(row.get("open_dispatch")),
        "status": status,
    }


def _clean_work(row) -> dict | None:
    if not isinstance(row, dict):
        return None
    if any(_forbidden_key(k) for k in row):
        row = {k: v for k, v in row.items() if not _forbidden_key(k)}
    ident = _prefix_id(row.get("id"))
    src = _ident(row.get("from"))
    phase = _phase(row.get("phase"))
    if not ident or not src or not phase:
        return None
    tos = []
    for item in row.get("to") or []:
        dest = _ident(item)
        if dest and dest not in tos:
            tos.append(dest)
    out = {
        "id": ident,
        "from": src,
        "to": tos[:6],
        "phase": phase,
        "age_min": _count(row.get("age_min"), 10080),
    }
    pr = row.get("pr")
    if type(pr) is int and not isinstance(pr, bool) and 1 <= pr <= 1000000:
        out["pr"] = pr
    return out


def _clean_edge(row) -> dict | None:
    if not isinstance(row, dict):
        return None
    if any(_forbidden_key(k) for k in row):
        row = {k: v for k, v in row.items() if not _forbidden_key(k)}
    src, dest = _ident(row.get("from")), _ident(row.get("to"))
    phase = _phase(row.get("phase"))
    if not src or not dest or not phase or not _ts(row.get("ts")):
        return None
    return {"from": src, "to": dest, "phase": phase, "ts": row["ts"]}


def _clean_env(row) -> dict | None:
    if not isinstance(row, dict):
        return None
    if any(_forbidden_key(k) for k in row):
        row = {k: v for k, v in row.items() if not _forbidden_key(k)}
    ident = _ident(row.get("id"))
    label = _label(row.get("label"))
    health = row.get("health") if row.get("health") in HEALTHS else None
    if not ident or not label or not health:
        return None
    out = {"id": ident, "label": label, "health": health}
    note = _label(row.get("note"), 80)
    if note:
        out["note"] = note
    pct = row.get("traffic_pct")
    if type(pct) is int and not isinstance(pct, bool) and 0 <= pct <= 100:
        out["traffic_pct"] = pct
    return out


def _clean_ci(row) -> dict | None:
    if not isinstance(row, dict):
        return None
    if any(_forbidden_key(k) for k in row):
        row = {k: v for k, v in row.items() if not _forbidden_key(k)}
    repo = row.get("repo") if row.get("repo") in REPOS_SHORT else None
    conclusion = row.get("conclusion") if row.get("conclusion") in CONCLUSIONS else None
    name = _label(row.get("name"))
    if not repo or not conclusion or not name or not _ts(row.get("ts")):
        return None
    if _retired(name):
        return None
    out = {"repo": repo, "conclusion": conclusion, "name": name, "ts": row["ts"]}
    url = row.get("url")
    if isinstance(url, str) and URL_RE.match(url) and not _secretish(url):
        out["url"] = url
    return out


def _metric(value, lo: float, hi: float):
    """A presentation number, or None. Whole values stay ints so the file stays stable."""
    if type(value) is bool or not isinstance(value, (int, float)):
        return None
    if value < lo or value > hi:
        return None
    rounded = round(float(value), 1)
    if rounded == int(rounded):
        return int(rounded)
    return rounded


def _clean_branch(row) -> dict | None:
    if not isinstance(row, dict):
        return None
    if any(_forbidden_key(k) for k in row):
        row = {k: v for k, v in row.items() if not _forbidden_key(k)}
    name = row.get("name")
    kind = row.get("kind")
    if not isinstance(name, str) or not BRANCH_NAME_RE.match(name):
        return None
    if _retired(name) or _secretish(name) or kind not in BRANCH_KINDS:
        return None
    return {"name": name, "kind": kind, "merged": row.get("merged") is True}


def _clean_stats(row, fallback_rows: int) -> dict:
    src = row if isinstance(row, dict) else {}
    median_ack = src.get("median_ack_min")
    if type(median_ack) is bool or not isinstance(median_ack, (int, float)) or median_ack < 0:
        median_out = None
    else:
        median_out = round(float(median_ack), 1)
        if median_out == int(median_out):
            median_out = int(median_out)
    return {
        "rows_sampled": _count(src.get("rows_sampled")) or fallback_rows,
        "dispatch_open": _count(src.get("dispatch_open")),
        "result_1h": _count(src.get("result_1h")),
        "nogo_1h": _count(src.get("nogo_1h")),
        "median_ack_min": median_out,
        "deploy_lead_min": _metric(src.get("deploy_lead_min"), 0, 10080),
        "success_7d_pct": _metric(src.get("success_7d_pct"), 0, 100),
        "error_rate_pct": _metric(src.get("error_rate_pct"), 0, 100),
    }


def _take(rows, kind: str) -> list:
    if not isinstance(rows, list):
        return []
    return rows[: CAPS[kind]]


def sanitize(raw) -> dict | None:
    """Return an allowlisted snap, or None when nothing renderable remains."""
    if not isinstance(raw, dict) or raw.get("v") != 1:
        return None
    if not _ts(raw.get("baked_at")):
        return None
    refresh = raw.get("refresh_sec")
    if type(refresh) is not int or isinstance(refresh, bool):
        refresh = 120
    refresh = min(REFRESH_MAX, max(REFRESH_MIN, refresh))
    every = raw.get("bake_every_min")
    if type(every) is not int or isinstance(every, bool) or not 1 <= every <= 30:
        every = BAKE_EVERY_DEFAULT
    source = raw.get("source") if raw.get("source") in SOURCES else "bake"
    agents = [a for a in (_clean_agent(r) for r in _take(raw.get("agents"), "agents")) if a]
    work = [w for w in (_clean_work(r) for r in _take(raw.get("open_work"), "open_work")) if w]
    edges = [e for e in (_clean_edge(r) for r in _take(raw.get("edges"), "edges")) if e]
    envs = [e for e in (_clean_env(r) for r in _take(raw.get("envs"), "envs")) if e]
    ci = [c for c in (_clean_ci(r) for r in _take(raw.get("ci"), "ci")) if c]
    branches = [b for b in (_clean_branch(r) for r in _take(raw.get("branches"), "branches")) if b]
    stats = _clean_stats(raw.get("stats"), len(agents) + len(work) + len(edges) + len(ci))
    snap = {
        "v": 1,
        "baked_at": raw["baked_at"],
        "refresh_sec": refresh,
        "bake_every_min": every,
        "source": source,
        "agents": agents,
        "open_work": work,
        "edges": edges,
        "envs": envs,
        "ci": ci,
        "branches": branches,
        "stats": stats,
    }
    return fit(snap)


def compact_len(snap: dict) -> int:
    return len(json.dumps(snap, separators=(",", ":"), sort_keys=True).encode("utf-8"))


def fit(snap: dict) -> dict:
    """Drop the oldest tail rows until the compact form is within the byte budget."""
    while compact_len(snap) > MAX_BYTES:
        if len(snap["edges"]) > 1:
            snap["edges"].pop()
        elif len(snap["open_work"]) > 1:
            snap["open_work"].pop()
        elif len(snap["ci"]) > 1:
            snap["ci"].pop()
        elif len(snap["agents"]) > 1:
            snap["agents"].pop()
        else:
            break
    return snap


def problems(snap) -> list[str]:
    """Why a snap is not a clean v1 file. Empty when it is."""
    if not isinstance(snap, dict):
        return ["snap must be an object"]
    out = []
    if set(snap) != SNAP_KEYS:
        extra = sorted(set(snap) - SNAP_KEYS)
        missing = sorted(SNAP_KEYS - set(snap))
        if extra:
            out.append("unknown keys: " + ", ".join(extra))
        if missing:
            out.append("missing keys: " + ", ".join(missing))
        return out
    if snap["v"] != 1:
        out.append("v must be 1")
    if not _ts(snap["baked_at"]):
        out.append("baked_at must be UTC like 2026-09-26T06:30:00Z")
    if type(snap["refresh_sec"]) is not int or not REFRESH_MIN <= snap["refresh_sec"] <= REFRESH_MAX:
        out.append("refresh_sec must be an int from 60 to 120")
    if type(snap["bake_every_min"]) is not int or not 1 <= snap["bake_every_min"] <= 30:
        out.append("bake_every_min must be an int from 1 to 30")
    if snap["source"] not in SOURCES:
        out.append("source must be sample or bake")
    out.extend(_row_problems("agents", snap["agents"], AGENT_KEYS, AGENT_KEYS))
    out.extend(_row_problems("open_work", snap["open_work"], WORK_REQUIRED, WORK_KEYS))
    out.extend(_row_problems("edges", snap["edges"], EDGE_KEYS, EDGE_KEYS))
    out.extend(_row_problems("envs", snap["envs"], ENV_REQUIRED, ENV_KEYS))
    out.extend(_row_problems("ci", snap["ci"], CI_REQUIRED, CI_KEYS))
    out.extend(_row_problems("branches", snap["branches"], BRANCH_KEYS, BRANCH_KEYS))
    if not isinstance(snap["stats"], dict) or set(snap["stats"]) != STATS_KEYS:
        out.append("stats keys must be exactly " + ", ".join(sorted(STATS_KEYS)))
    elif sanitize(snap) != snap:
        out.append("snap is not stable under sanitize")
    if compact_len(snap) > MAX_BYTES:
        out.append("compact JSON exceeds %d bytes" % MAX_BYTES)
    return out


def _row_problems(name: str, rows, required: set, allowed: set) -> list[str]:
    if not isinstance(rows, list):
        return ["%s must be a list" % name]
    if len(rows) > CAPS[name]:
        return ["%s exceeds the cap of %d" % (name, CAPS[name])]
    bad = []
    for i, row in enumerate(rows):
        if not isinstance(row, dict):
            bad.append("%s[%d] must be an object" % (name, i))
            continue
        keys = set(row)
        if not required <= keys or not keys <= allowed:
            bad.append("%s[%d] keys must stay inside the allowlist" % (name, i))
    return bad


def quiet_roster(stamp: str) -> list[dict]:
    return [
        {"id": name, "last_seen": None, "writes_1h": 0, "open_dispatch": 0, "status": "quiet"}
        for name in ROSTER
    ]


def derive_status(writes_1h: int, open_dispatch: int, last_seen: str | None, baked_at: str) -> str:
    age = _minutes_between(baked_at, last_seen) if last_seen else None
    if writes_1h >= 3 or (open_dispatch >= 1 and age is not None and age <= 15):
        return "hot"
    if writes_1h >= 1 or (age is not None and age <= 60):
        return "warm"
    if age is not None and age <= 24 * 60:
        return "cool"
    return "quiet"


def _recent(ts: str, baked_at: str, window: int = 60) -> bool:
    age = _minutes_between(baked_at, ts)
    return age is not None and 0 <= age <= window


def recompute_stats(snap: dict, ack_minutes, rows_sampled, metrics=None) -> None:
    agents, work, edges, ci = snap["agents"], snap["open_work"], snap["edges"], snap["ci"]
    shown = len(agents) + len(work) + len(edges) + len(ci)
    sampled = rows_sampled if type(rows_sampled) is int and rows_sampled >= shown else shown
    metrics = metrics if isinstance(metrics, dict) else {}
    snap["stats"] = {
        "rows_sampled": sampled,
        "dispatch_open": sum(1 for row in work if row["phase"] == "DISPATCH"),
        "result_1h": sum(1 for row in edges if row["phase"] == "RESULT" and _recent(row["ts"], snap["baked_at"])),
        "nogo_1h": sum(1 for row in edges if row["phase"] == "NOGO" and _recent(row["ts"], snap["baked_at"])),
        "median_ack_min": median(ack_minutes),
        "deploy_lead_min": _metric(metrics.get("deploy_lead_min"), 0, 10080),
        "success_7d_pct": _metric(metrics.get("success_7d_pct"), 0, 100),
        "error_rate_pct": _metric(metrics.get("error_rate_pct"), 0, 100),
    }


def bake(baked_at: str, ci=None, envs=None, export=None, source: str = "bake") -> dict:
    """Assemble a snap from already-fetched pieces. No network."""
    export = export if isinstance(export, dict) else {}
    ack = export.get("ack_minutes") if isinstance(export.get("ack_minutes"), list) else []
    rows_sampled = export.get("rows_sampled")
    raw_agents = export.get("agents")
    if isinstance(raw_agents, list) and raw_agents:
        agents = []
        for row in raw_agents:
            clean = _clean_agent(row)
            if not clean:
                continue
            if "status" not in (row or {}) or row.get("status") not in STATUSES:
                clean["status"] = derive_status(
                    clean["writes_1h"], clean["open_dispatch"], clean["last_seen"], baked_at
                )
            agents.append(clean)
    else:
        agents = quiet_roster(baked_at)
    raw = {
        "v": 1,
        "baked_at": baked_at,
        "refresh_sec": 120,
        "bake_every_min": BAKE_EVERY_DEFAULT,
        "source": source,
        "agents": agents,
        "open_work": export.get("open_work") if isinstance(export.get("open_work"), list) else [],
        "edges": export.get("edges") if isinstance(export.get("edges"), list) else [],
        "envs": envs if isinstance(envs, list) else [],
        "ci": ci if isinstance(ci, list) else [],
        "branches": export.get("branches") if isinstance(export.get("branches"), list) else [],
        "stats": {},
    }
    snap = sanitize(raw)
    if snap is None:
        snap = sanitize({
            "v": 1, "baked_at": baked_at, "refresh_sec": 120, "source": source,
            "agents": quiet_roster(baked_at), "open_work": [], "edges": [],
            "envs": [], "ci": [], "branches": [], "stats": {},
        })
    assert snap is not None
    nested = export.get("stats") if isinstance(export.get("stats"), dict) else {}
    metrics = {
        "deploy_lead_min": export.get("deploy_lead_min", nested.get("deploy_lead_min")),
        "success_7d_pct": export.get("success_7d_pct", nested.get("success_7d_pct")),
        "error_rate_pct": export.get("error_rate_pct", nested.get("error_rate_pct")),
    }
    recompute_stats(snap, ack, rows_sampled, metrics)
    return fit(snap)


def sample_snap() -> dict:
    """A reviewable snap. Labelled sample so the page does not pretend it is live."""
    baked = "2026-09-26T06:30:00Z"
    snap = bake(
        baked,
        source="sample",
        ci=[
            {
                "repo": "sfdc24-site", "conclusion": "success", "name": "honesty-dom-test",
                "url": "https://github.com/sfdc-24/sfdc24-site/actions/runs/1",
                "ts": "2026-09-26T06:10:00Z",
            },
            {
                "repo": "sfdc24-site", "conclusion": "success", "name": "site-positioning-test",
                "url": "https://github.com/sfdc-24/sfdc24-site/actions/runs/2",
                "ts": "2026-09-26T06:11:00Z",
            },
            {
                "repo": "Blackboard", "conclusion": "failure", "name": "example-check",
                "url": "https://github.com/sfdc-24/Blackboard/actions/runs/3",
                "ts": "2026-09-26T05:40:00Z",
            },
        ],
        envs=[
            {"id": "www", "label": "www.sfdc24.com", "health": "ok", "note": "Pages from main"},
            {"id": "pages", "label": "GitHub Pages", "health": "ok", "note": "same host as www"},
            {"id": "studio-r6", "label": "studio-controller r6", "health": "ok", "traffic_pct": 100},
        ],
        export={
            "rows_sampled": 40,
            "ack_minutes": [4, 7, 12],
            "deploy_lead_min": 14,
            "success_7d_pct": 96,
            "error_rate_pct": 1.8,
            "branches": [
                {"name": "feature/ops-polish", "kind": "feature", "merged": True},
                {"name": "fix/staging-gate", "kind": "fix", "merged": True},
                {"name": "chore/snap-bake", "kind": "chore", "merged": True},
            ],
            "agents": [
                {"id": "grok", "last_seen": "2026-09-26T06:28:00Z", "writes_1h": 4, "open_dispatch": 1, "status": "hot"},
                {"id": "claude-code-cli", "last_seen": "2026-09-26T06:22:00Z", "writes_1h": 2, "open_dispatch": 0, "status": "warm"},
                {"id": "codex", "last_seen": "2026-09-26T05:50:00Z", "writes_1h": 1, "open_dispatch": 0, "status": "cool"},
                {"id": "cursor", "last_seen": "2026-09-26T04:10:00Z", "writes_1h": 0, "open_dispatch": 0, "status": "quiet"},
            ],
            "open_work": [
                {"id": "GROK-OPS-0142", "from": "grok", "to": ["claude-code-cli"], "phase": "DISPATCH", "age_min": 12, "pr": 482},
                {"id": "CODEX-REV-0901", "from": "claude-code-cli", "to": ["codex"], "phase": "REVIEW", "age_min": 28},
            ],
            "edges": [
                {"from": "grok", "to": "claude-code-cli", "phase": "DISPATCH", "ts": "2026-09-26T06:28:00Z"},
                {"from": "claude-code-cli", "to": "codex", "phase": "REVIEW", "ts": "2026-09-26T06:18:00Z"},
                {"from": "codex", "to": "grok", "phase": "RESULT", "ts": "2026-09-26T06:05:00Z"},
            ],
        },
    )
    # The sample's dispatch count matches the one DISPATCH row on the diagram.
    # rows_sampled stays at 40: the diagram shows a slice, the strip says so.
    snap["stats"]["rows_sampled"] = 40
    snap["stats"]["dispatch_open"] = 1
    snap["stats"]["median_ack_min"] = 7
    snap["stats"]["deploy_lead_min"] = 14
    snap["stats"]["success_7d_pct"] = 96
    snap["stats"]["error_rate_pct"] = 1.8
    return snap


def ci_from_payload(repo_short: str, payload) -> list[dict]:
    if not isinstance(payload, dict):
        return []
    rows = []
    for run in payload.get("workflow_runs") or []:
        if not isinstance(run, dict):
            continue
        conclusion = run.get("conclusion") or "unknown"
        if conclusion not in CONCLUSIONS:
            conclusion = "unknown"
        stamp = run.get("updated_at") or run.get("created_at") or ""
        if isinstance(stamp, str) and stamp.endswith("+00:00"):
            stamp = stamp[:-6] + "Z"
        if isinstance(stamp, str) and "." in stamp and stamp.endswith("Z"):
            stamp = stamp.split(".", 1)[0] + "Z"
        name = run.get("name") or run.get("display_title") or "workflow"
        url = run.get("html_url") or ""
        rows.append({
            "repo": repo_short,
            "conclusion": conclusion,
            "name": name if isinstance(name, str) else "workflow",
            "url": url if isinstance(url, str) else "",
            "ts": stamp if isinstance(stamp, str) else "",
        })
    return rows


def _bus_refused(url: str) -> bool:
    low = url.lower()
    return any(marker in low for marker in BUS_MARKERS)


def _get_json(url: str, token: str | None, opener, timeout: float):
    """GET JSON. A token that cannot see another repo is retried once, unauthenticated.

    GITHUB_TOKEN is limited to this repository. Public Actions runs on
    Blackboard are still readable without it. A bus URL is refused before
    any request.
    """
    if _bus_refused(url):
        return None

    def once(tok):
        headers = {"Accept": "application/vnd.github+json", "User-Agent": UA}
        if tok:
            headers["Authorization"] = "Bearer " + tok
        request = urllib.request.Request(url, headers=headers, method="GET")
        try:
            with opener(request, timeout=timeout) as response:
                return json.loads(response.read().decode("utf-8"))
        except Exception:
            return None

    got = once(token)
    if got is None and token:
        return once(None)
    return got


def fetch_ci(token: str | None, opener=urllib.request.urlopen, timeout: float = 8.0, repos=REPOS) -> list[dict]:
    rows = []
    for full, short in repos:
        payload = _get_json(
            "https://api.github.com/repos/%s/actions/runs?per_page=8" % full,
            token, opener, timeout,
        )
        rows.extend(ci_from_payload(short, payload))
    return rows


def _status_of(url: str, opener, timeout: float) -> str:
    if _bus_refused(url):
        return "unknown"
    request = urllib.request.Request(url, method="GET", headers={"User-Agent": UA, "Cache-Control": "no-cache"})
    try:
        with opener(request, timeout=timeout) as response:
            status = int(response.status)
            response.read(32)
    except urllib.error.HTTPError as exc:
        status = int(exc.code)
    except Exception:
        return "unknown"
    if 200 <= status < 300:
        return "ok"
    if status == 0:
        return "unknown"
    return "degraded"


def probe_envs(opener=urllib.request.urlopen, timeout: float = 8.0) -> list[dict]:
    www = _status_of(WWW + "/", opener, timeout)
    ctl = _status_of(CONTROLLER + "/health?probe=1", opener, timeout)
    studio = {
        "id": "studio-r6",
        "label": "studio-controller r6",
        "health": ctl,
    }
    if ctl == "ok":
        studio["traffic_pct"] = 100
    return [
        {"id": "www", "label": "sfdc24.com", "health": www, "note": "Pages from main"},
        {"id": "pages", "label": "GitHub Pages", "health": www, "note": "same host as www"},
        studio,
    ]


def dumps(snap: dict) -> str:
    return json.dumps(snap, indent=2, sort_keys=True) + "\n"


def load_export(path: Path | None) -> dict | None:
    if path is None or not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def validate(path: Path) -> list[str]:
    try:
        snap = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        return ["not JSON: %s" % exc]
    return problems(snap)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Bake or validate the Ops snapshot")
    ap.add_argument("--out", type=Path, help="Where to write the snap")
    ap.add_argument("--sample", action="store_true", help="Write the committed sample snap")
    ap.add_argument("--validate", type=Path, metavar="FILE", help="Check a snap against schema v1")
    ap.add_argument("--bake", action="store_true", help="Build a snap from probes, Actions, and an optional export")
    ap.add_argument("--export", type=Path, help="Sanitized board summary (not a raw bus payload)")
    ap.add_argument("--offline", action="store_true", help="Skip network; quiet fleet, no CI")
    ap.add_argument("--timeout", type=float, default=8.0)
    args = ap.parse_args(argv)
    if args.validate:
        bad = validate(args.validate)
        for item in bad:
            print(item)
        print("ok" if not bad else "%d problem(s)" % len(bad))
        return 1 if bad else 0
    if not args.out:
        ap.error("--out is required unless --validate")
    if args.sample:
        snap = sample_snap()
    elif args.bake:
        export_path = args.export
        if export_path is None and os.environ.get("BOARD_OPS_EXPORT"):
            export_path = Path(os.environ["BOARD_OPS_EXPORT"])
        export = load_export(export_path)
        if args.offline:
            ci, envs = [], probe_envs(opener=_offline_opener, timeout=args.timeout)
        else:
            token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN") or ""
            # An explicit bus URL is ignored. This process does not call it.
            ci = fetch_ci(token or None, timeout=args.timeout)
            envs = probe_envs(timeout=args.timeout)
        snap = bake(now_utc(), ci=ci, envs=envs, export=export, source="bake")
    else:
        ap.error("one of --sample, --bake, or --validate is required")
    bad = problems(snap)
    if bad:
        for item in bad:
            print(item)
        return 1
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(dumps(snap), encoding="utf-8")
    print("wrote %s (%d bytes compact)" % (args.out, compact_len(snap)))
    return 0


def _offline_opener(request, timeout=None):
    raise TimeoutError("offline")


if __name__ == "__main__":
    sys.exit(main())
