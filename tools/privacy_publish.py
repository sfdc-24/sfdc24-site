"""Public projection for TASK ID: C69.

The site is public. Refreshed delivery data may carry counts by status,
planned versus actual dates, velocity, and estimate ratios. It must not carry
owner tasks, owner quotes, guest details, case text, board row ids, pull
request numbers, branch names, compliance failures, or a fleet-pack source.
"""
from __future__ import annotations

import re
from typing import Any

OWNER = re.compile(r"\b(owner|you|abdus|salam)\b", re.I)
CASE = re.compile(r"\bcase[\s_-]*\d+\b", re.I)
PR_NUMBER = re.compile(r"(?:/pull/\d+\b|\bpull/\d+\b|\bPR\s*#?\d+\b|#\d{2,}\b)", re.I)
BRANCH = re.compile(r"\b(?:cursor|grok|claude-code-cli|codex|gemini|copilot)/", re.I)
BOARD_ROW = re.compile(r"\b(?:board[_-]?row|row[_-]?id)[:\s_-]*[A-Za-z0-9-]+\b", re.I)
SECRET = re.compile(r"(?:gh[pousr]_|github_pat_|sk-[A-Za-z0-9]|xox[baprs]-|-----BEGIN |Bearer\s+)", re.I)
EMAIL = re.compile(r"[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}", re.I)
PHONE = re.compile(r"\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b")

BANNED_KEYS = {"source", "board_rows_by_phase", "board_rows_by_agent"}
STATUS_KEYS = {
    "planned": "planned",
    "pending": "planned",
    "scheduled": "planned",
    "active": "active",
    "in_progress": "active",
    "doing": "active",
    "done": "done",
    "completed": "done",
    "passed": "done",
    "closed": "done",
}


def problems(text: str) -> list[str]:
    """Names of banned patterns present in a published string."""
    found = []
    checks = (
        ("owner-or-guest", OWNER),
        ("case", CASE),
        ("pull-request-number", PR_NUMBER),
        ("branch-name", BRANCH),
        ("board-row", BOARD_ROW),
        ("secret", SECRET),
        ("email", EMAIL),
        ("phone", PHONE),
    )
    for name, pattern in checks:
        if pattern.search(text or ""):
            found.append(name)
    if "board_rows_by_phase" in (text or ""):
        found.append("board-rows-by-phase")
    return found


def _owner_row(row: dict) -> bool:
    blob = " ".join(str(row.get(key) or "") for key in ("owner", "assignee", "by", "who", "title"))
    return OWNER.search(blob) is not None


def _status_bucket(value: Any) -> str:
    key = str(value or "").strip().lower().replace(" ", "_")
    return STATUS_KEYS.get(key, "other")


def reduce_tracker(doc: dict | None) -> dict:
    """Collapse a task tracker to status counts. Owner rows are left out."""
    counts = {"planned": 0, "active": 0, "done": 0, "other": 0}
    rows = []
    if isinstance(doc, dict):
        raw = doc.get("tasks") or doc.get("rows") or doc.get("items") or []
        if isinstance(raw, list):
            rows = [row for row in raw if isinstance(row, dict)]
    kept = 0
    for row in rows:
        if _owner_row(row):
            continue
        counts[_status_bucket(row.get("status"))] += 1
        kept += 1
    return {
        "aggregate": True,
        "counts_by_status": counts,
        "rows_counted": kept,
        "rows_withheld": len(rows) - kept,
        "withheld": [
            "per-task rows",
            "personal rows",
            "identifiers",
            "branch names",
            "case text",
        ],
    }


def strip_published(value: Any) -> Any:
    """Drop source, board-row counts, and other private keys at every level."""
    if isinstance(value, list):
        return [strip_published(item) for item in value]
    if not isinstance(value, dict):
        return value
    out = {}
    for key, item in value.items():
        if key in BANNED_KEYS or "board_row" in key.lower():
            continue
        out[key] = strip_published(item)
    return out


def road_title(title: str, index: int) -> str:
    """Timeline labels stay 'Test N' and do not name Owner or You."""
    text = OWNER.sub(" ", str(title or ""))
    text = re.sub(r"\s+", " ", text).strip(" -·")
    if not text:
        return "Test %d" % (index + 1)
    return text
