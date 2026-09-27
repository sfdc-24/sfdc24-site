#!/usr/bin/env python3
"""Living /ops project board: open PRs → open_work, agent tasks, merge with export.

Imported by tools/board_ops_snap.py during --bake so every in-flight PR shows
on /ops (sprint/release map + stage flow + agent tasks). No bus calls.
"""
from __future__ import annotations

import re
import urllib.request
from typing import Callable

ID_PREFIX = 16
ROSTER = ("grok", "claude-code-cli", "codex", "cursor", "gemini", "meta")
BRANCH_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$")
REPOS = (
    ("sfdc-24/sfdc24-site", "sfdc24-site"),
    ("sfdc-24/Blackboard", "Blackboard"),
)

LOGIN_TO_AGENT = {
    "grok": "grok",
    "grok-bot": "grok",
    "xai-grok": "grok",
    "claude": "claude-code-cli",
    "claude-code": "claude-code-cli",
    "anthropic": "claude-code-cli",
    "codex": "codex",
    "openai": "codex",
    "cursor": "cursor",
    "gemini": "gemini",
    "google-gemini": "gemini",
    "meta": "meta",
}

AGENT_LOGIN_HINTS = (
    ("grok", "grok"),
    ("claude", "claude-code-cli"),
    ("codex", "codex"),
    ("cursor", "cursor"),
    ("gemini", "gemini"),
    ("meta", "meta"),
)


def _login_to_agent(login: str | None) -> str | None:
    if not isinstance(login, str):
        return None
    key = login.strip().lower()
    if key in LOGIN_TO_AGENT:
        return LOGIN_TO_AGENT[key]
    for needle, agent in AGENT_LOGIN_HINTS:
        if needle in key:
            return agent
    return None


def _kind_of_branch(name: str) -> str:
    low = name.lower()
    if low.startswith("fix/") or "/fix/" in low or low.startswith("fix-"):
        return "fix"
    if low.startswith("chore/") or low.startswith("deps/") or low.startswith("ci/"):
        return "chore"
    return "feature"


def _phase_from_pr(pr: dict) -> str:
    if pr.get("draft") is True:
        return "DISPATCH"
    return "REVIEW"


def projects_from_pulls(payload, baked_at: str, minutes_between: Callable) -> tuple[list[dict], list[dict]]:
    """Turn open pull requests into living open_work + branch rows for /ops."""
    if not isinstance(payload, list):
        return [], []
    work, branches, seen_branch = [], [], set()
    for pr in payload:
        if not isinstance(pr, dict):
            continue
        if pr.get("state") and pr.get("state") != "open":
            continue
        number = pr.get("number")
        if type(number) is not int or number < 1:
            continue
        title = pr.get("title") if isinstance(pr.get("title"), str) else "Open pull request"
        user = (pr.get("user") or {}) if isinstance(pr.get("user"), dict) else {}
        author = _login_to_agent(user.get("login")) or "grok"
        tos = []
        for a in pr.get("assignees") or []:
            if isinstance(a, dict):
                dest = _login_to_agent(a.get("login"))
                if dest and dest not in tos and dest != author:
                    tos.append(dest)
        if not tos:
            tos = ["cursor"] if author != "cursor" else ["codex"]
        updated = pr.get("updated_at") or pr.get("created_at") or ""
        if isinstance(updated, str) and updated.endswith("+00:00"):
            updated = updated[:-6] + "Z"
        if isinstance(updated, str) and "." in updated and updated.endswith("Z"):
            updated = updated.split(".", 1)[0] + "Z"
        age = minutes_between(baked_at, updated) if isinstance(updated, str) else None
        if age is None:
            age = 0
        labels = []
        for lab in pr.get("labels") or []:
            if isinstance(lab, dict) and isinstance(lab.get("name"), str):
                labels.append(lab["name"].lower())
            elif isinstance(lab, str):
                labels.append(lab.lower())
        cooking = any(x in labels for x in ("cooking", "priority", "next", "sprint", "release"))
        if not cooking and age <= 2 * 24 * 60 and "backlog" not in labels:
            cooking = True
        if "backlog" in labels:
            cooking = False
        head = pr.get("head") if isinstance(pr.get("head"), dict) else {}
        branch_name = head.get("ref") if isinstance(head.get("ref"), str) else ""
        work_id = ("PR-%d" % number)[:ID_PREFIX]
        row = {
            "id": work_id,
            "from": author,
            "to": tos[:6],
            "phase": _phase_from_pr(pr),
            "age_min": int(age),
            "pr": number,
            "title": title[:159],
        }
        if cooking:
            row["next"] = True
            row["lane"] = "cooking"
        else:
            row["lane"] = "backlog"
        work.append(row)
        if branch_name and BRANCH_NAME_RE.match(branch_name) and branch_name not in seen_branch:
            seen_branch.add(branch_name)
            branches.append({
                "name": branch_name[:64],
                "kind": _kind_of_branch(branch_name),
                "merged": False,
            })
    return work, branches


def quiet_roster(stamp: str) -> list[dict]:
    return [
        {"id": name, "last_seen": None, "writes_1h": 0, "open_dispatch": 0, "status": "quiet"}
        for name in ROSTER
    ]


def agents_from_projects(work: list[dict], baked_at: str, base_agents: list[dict] | None = None) -> list[dict]:
    """Keep roster present; attach live task text from cooking work when busy."""
    by_id = {row["id"]: dict(row) for row in (base_agents or quiet_roster(baked_at)) if isinstance(row, dict) and row.get("id")}
    for name in ROSTER:
        by_id.setdefault(name, {"id": name, "last_seen": None, "writes_1h": 0, "open_dispatch": 0, "status": "quiet"})
    for row in sorted(work, key=lambda r: r.get("age_min", 99999)):
        if row.get("lane") != "cooking" and not row.get("next"):
            continue
        title = row.get("title") or row.get("id")
        phase = row.get("phase") or "DISPATCH"
        targets = list(row.get("to") or [])
        if row.get("from"):
            targets.append(row["from"])
        for agent_id in targets:
            ag = by_id.get(agent_id)
            if not ag:
                continue
            if ag.get("task"):
                continue
            ag["task"] = title
            ag["phase"] = phase
            ag["open_dispatch"] = max(int(ag.get("open_dispatch") or 0), 1)
            if ag.get("status") in (None, "quiet", "cool"):
                ag["status"] = "warm"
            if not ag.get("last_seen"):
                ag["last_seen"] = baked_at
    return [by_id[name] for name in ROSTER if name in by_id]


def merge_export_with_live(export: dict | None, live_work: list[dict], live_branches: list[dict], baked_at: str) -> dict:
    """Combine sanitized export with live PR projects so every open project shows."""
    export = dict(export) if isinstance(export, dict) else {}
    existing = export.get("open_work") if isinstance(export.get("open_work"), list) else []
    seen_pr, seen_id, merged_work = set(), set(), []
    for row in existing:
        if not isinstance(row, dict):
            continue
        merged_work.append(row)
        if type(row.get("pr")) is int:
            seen_pr.add(row["pr"])
        if isinstance(row.get("id"), str):
            seen_id.add(row["id"])
    for row in live_work:
        if row.get("pr") in seen_pr or row.get("id") in seen_id:
            continue
        merged_work.append(row)
        if type(row.get("pr")) is int:
            seen_pr.add(row["pr"])
        seen_id.add(row.get("id"))
    existing_br = export.get("branches") if isinstance(export.get("branches"), list) else []
    seen_br = {b.get("name") for b in existing_br if isinstance(b, dict)}
    merged_br = list(existing_br)
    for b in live_branches:
        if b.get("name") not in seen_br:
            merged_br.append(b)
            seen_br.add(b.get("name"))
    export["open_work"] = merged_work
    export["branches"] = merged_br
    base_agents = export.get("agents") if isinstance(export.get("agents"), list) else None
    export["agents"] = agents_from_projects(merged_work, baked_at, base_agents)
    return export


def fetch_open_pulls(token: str | None, get_json: Callable, opener=urllib.request.urlopen, timeout: float = 8.0, repos=None) -> list[dict]:
    """Fetch open PRs across tracked repos (living project board source)."""
    repos = repos or REPOS
    rows = []
    for full, short in repos:
        payload = get_json(
            "https://api.github.com/repos/%s/pulls?state=open&per_page=24&sort=updated" % full,
            token, opener, timeout,
        )
        if isinstance(payload, list):
            for pr in payload:
                if isinstance(pr, dict):
                    pr = dict(pr)
                    pr["_repo_short"] = short
                    rows.append(pr)
    return rows
