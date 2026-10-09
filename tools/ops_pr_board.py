#!/usr/bin/env python3
"""Metadata-only PR board generations for the governed Redis projection.

Walks every open pull request in conference, Blackboard, and sfdc24-site,
with full page walks past 100. Rolls each one up by repository and project
with queue owner, closure driver, stage, and hours/days open as of an
explicit timestamp. Each item also carries a glance record for the Ops
table: priority (P0, P1, or P2), what it blocks, what blocks it, owner,
closure driver, status, and days open. Unassessed fields say unassessed.
Writes immutable generations through a redis_gov-compatible
hput under the existing proj: grant (proj:pr-board:v1:). Does not edit
redis_acl.json, does not use the milestones-sync principal, and does not
touch the public Ops feed or its site-scoped token.

The flag defaults off. With neither --enable nor OPS_PR_BOARD=1 this process
does not read GitHub and does not write Redis.

Rollback: stop passing --enable (the default is off) and do not merge. A
generation already stored under proj:pr-board:v1: is left to the existing
proj: TTL of 30 days. Do not add a delete grant, do not retarget
milestones-sync, and do not give the public Ops workflow a conference token.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import re
import sys
from ops_delivery import SECRET, InvalidEvidence, instant
from ops_delivery_collect import SHA, collect, timestamp

REPOS = ("sfdc-24/conference", "sfdc-24/Blackboard", "sfdc-24/sfdc24-site")
PROJECTS = {
    "sfdc-24/conference": "Conference",
    "sfdc-24/Blackboard": "Blackboard",
    "sfdc-24/sfdc24-site": "SFDC24.com",
}
# Joint queue ownership from the owner-directed routing. Alphabetical so a
# generation id does not depend on dict order. A closure driver is never
# implied by this pair.
QUEUES = {
    "sfdc-24/conference": ("cursor", "grok"),
    "sfdc-24/Blackboard": ("claude",),
    "sfdc-24/sfdc24-site": ("cursor", "grok"),
}
# The issue's verified inventory. Actual counts are what collection measured;
# a difference is reported and is not rewritten to match this note.
STATED_INVENTORY = {
    "sfdc-24/conference": 69,
    "sfdc-24/Blackboard": 56,
    "sfdc-24/sfdc24-site": 34,
}
PER_PAGE = 100
MAX_PAGES = 20
# Mirrors scripts/redis_gov.py. These caps are enforced here so a generation
# fits the writer that already exists. They are not a new ACL.
MAX_PUT_FIELDS = 50
MAX_VALUE_BYTES = 2048
PREVIEW_CHARS = 200
NAMESPACE = "proj:pr-board:v1:"
HEAD_KEY = NAMESPACE + "head"
FORBIDDEN_PRINCIPAL = "milestones-sync"
FAIL_CONCLUSIONS = {
    "failure", "cancelled", "timed_out", "action_required", "stale", "startup_failure",
}
TYPES = {
    "ux:joining", "ux:interaction", "ux:loading", "ux:artifact", "ux:audio",
    "security", "redis", "salesforce", "infrastructure",
}
PRIORITIES = {"HIGH", "MEDIUM", "LOW"}
GLANCE_PRIORITIES = {"P0", "P1", "P2"}
UNASSESSED = "unassessed"
GLANCE_HEADING = re.compile(r"^(?:#{1,6}\s*)?at a glance\s*:?(?:\s*\([^)]*\))?\s*$", re.I)
GLANCE_FIELD = re.compile(r"^(?:[-*]\s*)?(priority|blocks|blocked by|owner)\s*:\s*(.*)$", re.I)
GLANCE_OTHER = re.compile(r"^(?:[-*]\s*)?[A-Za-z][A-Za-z /-]{0,40}:\s*.*$")
GLANCE_COMMENT = re.compile(r"^<!--.*?-->$")
GLANCE_PRIORITY = re.compile(r"^(P[012])(?:\s*[-–—]\s*blocks\s*:\s*(.*))?$", re.I)
LABEL_RANK = {"p0": "P0", "p1": "P1", "p2": "P2"}
OWNER_NAMES = {
    "grok": "Greg", "greg": "Greg",
    "cursor": "Cody", "cody": "Cody",
    "claude": "Claude",
    "aya": "Aya",
    "gemini": "Jenny", "jenny": "Jenny",
    "owner": "Owner",
}
STATUS_LINE = {
    "open": "Open",
    "review": "In review",
    "review_stale": "Review is out of date",
    "checks_blocked": "Checks failed",
    "checks_pending": "Checks still running",
    "checks_recorded": "Checks passed, not live yet",
    "merged_undelivered": "Merged, not live yet",
    "closed_unmerged": "Closed without merge",
}
EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
ACK_ROLES = {"closure_driver", "implementation_owner", "reviewer"}
SHARED_LOGINS = {"sfdc-24"}
LOGIN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9-]{0,38}$")
ACTOR = re.compile(r"^[a-z][a-z0-9-]{0,40}$")
OPAQUE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:#/-]{0,120}$")
REF = re.compile(r"^https://github\.com/sfdc-24/(?:conference|Blackboard|sfdc24-site)/pull/[1-9][0-9]*$")
BRANCH = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/-]{0,80}$")
BANNED_FIELDS = {
    "title", "body", "comment", "comments", "review_body", "diff", "patch",
    "transcript", "email", "token", "secret", "private",
}


def enabled(flag, env=None):
    env = os.environ if env is None else env
    return bool(flag) or env.get("OPS_PR_BOARD") == "1"


def _login(value):
    if not isinstance(value, str) or not LOGIN.fullmatch(value):
        return ""
    return value


def _logins(value, required):
    if value is None and not required:
        return []
    if not isinstance(value, list):
        raise ValueError("GitHub metadata read failed")
    return [login for login in (_login((row or {}).get("login") if isinstance(row, dict) else row) for row in value) if login]


def _shown(value):
    if not isinstance(value, str) or not value.strip():
        return UNASSESSED
    return value.strip()


def public_phrase(text, title=""):
    """A plain one-liner safe to show, or unassessed when the text is sensitive."""
    if not isinstance(text, str):
        return UNASSESSED
    line = " ".join(text.split())
    if not line or len(line) > 160:
        return UNASSESSED
    if SECRET.search(line) or EMAIL.search(line) or any(ord(char) < 32 for char in line):
        return UNASSESSED
    if any(char in line for char in "<>{}\\`"):
        return UNASSESSED
    if re.search(r"\b(private|confidential|secret)\b", line, re.I):
        return UNASSESSED
    title_norm = " ".join((title or "").split()).lower()
    folded = line.lower()
    if title_norm and (folded == title_norm or (len(title_norm) >= 12 and title_norm in folded)):
        return UNASSESSED
    return line


def _canon_refs(text):
    parts = [part.strip() for part in str(text or "").split(",") if part.strip()]
    if not parts:
        return ""
    shown = []
    names = {"conference": "conference", "blackboard": "Blackboard", "sfdc24-site": "sfdc24-site", "site": "sfdc24-site"}
    for part in parts:
        match = re.fullmatch(r"(?:sfdc-24/)?(conference|blackboard|sfdc24-site|site)#(\d+)", part, re.I)
        if not match:
            return ""
        shown.append("%s#%s" % (names[match.group(1).lower()], match.group(2)))
    return ", ".join(shown)


def _glance_text(line):
    """Drop a blockquote marker and bold markers. The words stay."""
    text = line.strip()
    if text.startswith(">"):
        text = text[1:].strip()
    return text.replace("**", "").strip()


def _owner_name(value):
    """One allowlisted name. A line that names two people stays unassessed."""
    text = " ".join(str(value or "").split())
    direct = OWNER_NAMES.get(text.lower())
    if direct:
        return direct
    owner_part = re.split(r"\s*(?:·|\||;|\bclosure driver\b)\s*", text, maxsplit=1, flags=re.I)[0]
    found = []
    for token in re.findall(r"[A-Za-z][A-Za-z-]*", owner_part):
        name = OWNER_NAMES.get(token.lower())
        if name and name not in found:
            found.append(name)
    if len(found) == 1:
        return found[0]
    return None


def parse_at_a_glance(body, title=""):
    """Read priority, blocks, blocked by, and owner from a block at the top.

    The first content line must be the heading. A leading at-a-glance comment
    is still the top. Later prose is ignored. A field that is sensitive, or
    that repeats the pull request title, is dropped.
    """
    if not isinstance(body, str) or not body.strip():
        return {}
    lines = body.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    index = 0
    while index < len(lines):
        stripped = lines[index].strip()
        if not stripped or GLANCE_COMMENT.fullmatch(stripped):
            index += 1
            continue
        break
    if index >= len(lines) or not GLANCE_HEADING.fullmatch(_glance_text(lines[index])):
        return {}
    found = {}
    for line in lines[index + 1:]:
        stripped = _glance_text(line)
        if not stripped or GLANCE_COMMENT.fullmatch(line.strip()):
            if GLANCE_COMMENT.fullmatch(line.strip() or ""):
                continue
            break
        match = GLANCE_FIELD.fullmatch(stripped)
        if not match:
            # A later field such as status is not a display source. Prose ends the block.
            if GLANCE_OTHER.fullmatch(stripped):
                continue
            break
        key = "blocked_by" if match.group(1).lower() == "blocked by" else match.group(1).lower()
        found.setdefault(key, match.group(2).strip())
    priority_line = found.get("priority", "")
    combined = GLANCE_PRIORITY.fullmatch(priority_line)
    if combined:
        found["priority"] = combined.group(1)
        if combined.group(2) and combined.group(2).strip():
            found.setdefault("blocks", combined.group(2).strip())
    safe = {}
    if found.get("priority", "").upper() in GLANCE_PRIORITIES:
        safe["priority"] = found["priority"].upper()
    blocks = public_phrase(found.get("blocks", ""), title) if "blocks" in found else ""
    if blocks and blocks != UNASSESSED:
        safe["blocks"] = blocks
    if "blocked_by" in found:
        refs = _canon_refs(found["blocked_by"])
        phrase = refs or public_phrase(found["blocked_by"], title)
        if phrase and phrase != UNASSESSED:
            safe["blocked_by"] = phrase
    owner = _owner_name(found.get("owner"))
    if owner:
        safe["owner"] = owner
    return safe


def allowlisted_labels(labels):
    """Only P0, P1, P2, and blocked. Other label text can be private and is dropped."""
    if not isinstance(labels, list):
        return []
    found = []
    for label in labels:
        name = label.get("name") if isinstance(label, dict) else label
        if isinstance(name, str) and name.strip().lower() in {"p0", "p1", "p2", "blocked"}:
            found.append(name.strip().lower())
    return found


def scrub_pull(repo, row):
    """Copy the allowlisted PR metadata. Titles and bodies never leave."""
    if not isinstance(row, dict) or repo not in PROJECTS:
        raise ValueError("GitHub metadata read failed")
    number = row.get("number")
    if type(number) is not int or number < 1:
        raise ValueError("GitHub metadata read failed")
    head = (row.get("head") or {}).get("sha") if isinstance(row.get("head"), dict) else None
    if not isinstance(head, str) or not SHA.fullmatch(head):
        raise ValueError("GitHub metadata read failed")
    timestamp(row.get("created_at"))
    state = "merged" if row.get("merged_at") else row.get("state")
    if state not in {"open", "closed", "merged"}:
        raise ValueError("GitHub metadata read failed")
    ref_name = (row.get("head") or {}).get("ref") if isinstance(row.get("head"), dict) else ""
    if not isinstance(ref_name, str) or not BRANCH.fullmatch(ref_name or "x"):
        ref_name = ""
    return {
        "repo": repo,
        "number": number,
        "state": state,
        "created_at": row["created_at"],
        "proposed_head": head,
        "author": _login((row.get("user") or {}).get("login") if isinstance(row.get("user"), dict) else ""),
        "assignees": _logins(row.get("assignees"), required=False) if "assignees" in row else [],
        "review_requests": _logins(row.get("requested_reviewers"), required=False) if "requested_reviewers" in row else [],
        "head_ref": ref_name if isinstance(ref_name, str) and (not ref_name or BRANCH.fullmatch(ref_name)) else "",
        "draft": bool(row.get("draft")),
        "glance": parse_at_a_glance(row.get("body") if isinstance(row.get("body"), str) else "",
                                    row.get("title") if isinstance(row.get("title"), str) else ""),
        "labels": allowlisted_labels(row.get("labels")),
    }


def _pages(read, path, max_pages=MAX_PAGES):
    rows = []
    page = 1
    joiner = "" if path.endswith("?") or path.endswith("&") else ("&" if "?" in path else "?")
    while True:
        if page > max_pages:
            raise ValueError("incomplete pagination")
        try:
            batch = read("%s%sper_page=%d&page=%d" % (path, joiner, PER_PAGE, page))
        except (OSError, TimeoutError, ValueError):
            raise ValueError("GitHub metadata read failed") from None
        if not isinstance(batch, list):
            raise ValueError("GitHub metadata read failed")
        rows.extend(batch)
        if len(batch) < PER_PAGE:
            return rows
        page += 1


def list_open(read, repos=REPOS, max_pages=MAX_PAGES):
    """Every open PR in each repository. A short page ends the walk; a failure does not."""
    found = []
    for repo in repos:
        if repo not in PROJECTS:
            raise ValueError("GitHub metadata read failed")
        seen = {}
        page = 1
        while True:
            if page > max_pages:
                raise ValueError("incomplete pagination")
            path = "repos/%s/pulls?state=open&sort=created&direction=asc&per_page=%d&page=%d" % (repo, PER_PAGE, page)
            try:
                batch = read(path)
            except (OSError, TimeoutError, ValueError):
                raise ValueError("GitHub metadata read failed") from None
            if not isinstance(batch, list):
                raise ValueError("GitHub metadata read failed")
            for row in batch:
                item = scrub_pull(repo, row)
                if item["state"] != "open":
                    raise ValueError("PR moved during collection")
                number = item["number"]
                if number in seen:
                    raise ValueError("incomplete pagination")
                seen[number] = item
            if len(batch) < PER_PAGE:
                break
            page += 1
        try:
            again = read("repos/%s/pulls?state=open&sort=created&direction=asc&per_page=%d&page=1" % (repo, PER_PAGE))
        except (OSError, TimeoutError, ValueError):
            raise ValueError("GitHub metadata read failed") from None
        if not isinstance(again, list):
            raise ValueError("GitHub metadata read failed")
        for row in again:
            item = scrub_pull(repo, row)
            prior = seen.get(item["number"])
            if prior is None or prior["proposed_head"] != item["proposed_head"]:
                raise ValueError("PR moved during collection")
        found.extend(seen[number] for number in sorted(seen))
    return found


def _scrub_reviews(rows):
    reviews = []
    for row in rows:
        if not isinstance(row, dict):
            raise ValueError("GitHub metadata read failed")
        commit_id = row.get("commit_id") or ""
        if commit_id and not SHA.fullmatch(commit_id):
            raise ValueError("GitHub metadata read failed")
        state = row.get("state")
        if state not in {"APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED", "PENDING"}:
            continue
        submitted = row.get("submitted_at")
        if submitted:
            timestamp(submitted)
        reviews.append({
            "state": state,
            "commit_id": commit_id,
            "submitted_at": submitted or "",
            "login": _login((row.get("user") or {}).get("login") if isinstance(row.get("user"), dict) else ""),
        })
    reviews.sort(key=lambda review: (review["submitted_at"], review["commit_id"], review["state"], review["login"]))
    return reviews


def _scrub_events(rows):
    """Closed and reopened events only. A missing id makes the interval unknown."""
    events = []
    incomplete = False
    for row in rows:
        if not isinstance(row, dict):
            raise ValueError("GitHub metadata read failed")
        kind = row.get("event")
        if kind not in {"closed", "reopened"}:
            continue
        when = row.get("created_at")
        identifier = row.get("id")
        if not when or type(identifier) is not int:
            incomplete = True
            continue
        timestamp(when)
        events.append({"id": identifier, "event": kind, "created_at": when})
    if incomplete:
        return None
    unique = {}
    for event in events:
        prior = unique.get(event["id"])
        if prior and prior != event:
            return None
        unique[event["id"]] = event
    return [unique[key] for key in sorted(unique)]


def attach_activity(records, read):
    for record in records:
        repo, number = record["repo"], record["number"]
        record["reviews"] = _scrub_reviews(_pages(read, "repos/%s/pulls/%d/reviews?" % (repo, number)))
        record["events"] = _scrub_events(_pages(read, "repos/%s/issues/%d/events?" % (repo, number)))
    return records


def attach_checks(records, policy, read):
    """Reuse the exact-head collector. No policy means checks were not collected."""
    if not policy:
        for record in records:
            record["checks"] = None
            record["required_checks"] = []
        return records
    grouped = {}
    for record in records:
        grouped.setdefault(record["repo"], []).append(record)
    for repo, rows in grouped.items():
        names = policy.get(repo)
        if not names:
            for record in rows:
                record["checks"] = None
                record["required_checks"] = []
            continue
        previous = {"schema_version": 1, "items": [{
            "id": "%s#%d" % (repo, record["number"]),
            "source": "https://github.com/%s/pull/%d" % (repo, record["number"]),
        } for record in rows]}
        try:
            result = collect(previous, {repo: names}, read)
        except (OSError, TimeoutError, ValueError, KeyError, TypeError):
            raise ValueError("GitHub metadata read failed") from None
        by_id = {item["id"]: item for item in result["items"]}
        for record in rows:
            item = by_id["%s#%d" % (repo, record["number"])]
            record["checks"] = item["checks"]
            record["required_checks"] = item["required_checks"]
            record["proposed_head"] = item["head_sha"]
            record["state"] = item["state"] if item["state"] in {"open", "closed", "merged"} else record["state"]
    return records


def _age(start, as_of, basis):
    seconds = int((as_of - start).total_seconds())
    if seconds < 0:
        raise InvalidEvidence("as-of precedes the interval start")
    hours = seconds // 3600
    return {"measured": True, "basis": basis, "hours": hours, "days": hours // 24, "rounding": "floor"}


def _unknown(reason):
    return {"measured": False, "basis": "current_open_interval", "hours": None, "days": None,
            "rounding": None, "reason": reason}


def intervals(created_at, events, as_of, state):
    """Creation age is measured from created_at. The current open interval is measured only from events."""
    created = instant(created_at)
    moment = instant(as_of)
    creation = _age(created, moment, "since_creation")
    if not isinstance(events, list):
        return creation, _unknown("missing_history")
    unique = {}
    for event in events:
        identifier = event.get("id")
        if type(identifier) is not int or not event.get("created_at") or event.get("event") not in {"closed", "reopened"}:
            return creation, _unknown("missing_history")
        current = {"id": identifier, "event": event["event"], "created_at": event["created_at"]}
        if identifier in unique and unique[identifier] != current:
            return creation, _unknown("missing_history")
        unique[identifier] = current
    ordered = []
    for event in unique.values():
        when = instant(event["created_at"])
        if when <= moment:
            ordered.append((event["created_at"], event["id"], event["event"]))
    ordered.sort()
    open_since = created_at
    is_open = True
    saw_close = False
    for when, _identifier, kind in ordered:
        if kind == "closed":
            is_open = False
            saw_close = True
        elif kind == "reopened":
            is_open = True
            open_since = when
    if state != "open":
        return creation, _unknown("not_open")
    if not is_open:
        return creation, _unknown("history_conflict")
    if not saw_close:
        current = _age(created, moment, "since_creation")
        current["same_as_creation_age"] = True
        return creation, current
    current = _age(instant(open_since), moment, "since_reopen")
    current["same_as_creation_age"] = False
    return creation, current


def stage_of(record):
    """Stage from the current head only. A merged PR is not a delivery receipt."""
    state = record.get("state")
    if state == "merged":
        return "merged_undelivered"
    if state == "closed":
        return "closed_unmerged"
    head = record.get("proposed_head")
    checks = [check for check in (record.get("checks") or []) if check.get("head_sha") == head]
    reviews = record.get("reviews") or []
    current = [review for review in reviews if review.get("commit_id") == head and review.get("state") != "DISMISSED"]
    other = [review for review in reviews if review.get("commit_id") and review.get("commit_id") != head]
    failed = any(check.get("status") == "completed" and check.get("conclusion") in FAIL_CONCLUSIONS for check in checks)
    if failed:
        return "checks_blocked"
    required = record.get("required_checks") or []
    green = bool(required) and all(
        any(check.get("name") == name and check.get("status") == "completed" and check.get("conclusion") == "success"
            for check in checks)
        for name in required)
    if any(review.get("state") == "CHANGES_REQUESTED" for review in current):
        return "review"
    if green:
        return "checks_recorded"
    if any(check.get("status") != "completed" for check in checks):
        return "checks_pending"
    if current:
        return "review"
    if other:
        return "review_stale"
    return "open"


def _opaque(value):
    if not isinstance(value, str) or not OPAQUE.fullmatch(value):
        raise InvalidEvidence("evidence reference is not an opaque id")
    return value


def _index_acks(acknowledgments):
    found = {}
    for row in acknowledgments or []:
        if not isinstance(row, dict):
            raise InvalidEvidence("invalid acknowledgment")
        role = row.get("role")
        if role not in ACK_ROLES:
            raise InvalidEvidence("invalid acknowledgment role")
        repo, number = row.get("repo"), row.get("number")
        if repo not in PROJECTS or type(number) is not int:
            raise InvalidEvidence("invalid acknowledgment")
        actor = row.get("actor")
        source = row.get("source")
        if source is not None and (not isinstance(source, str) or not OPAQUE.fullmatch(source)):
            raise InvalidEvidence("evidence reference is not an opaque id")
        agreed = row.get("acknowledged") is True and isinstance(source, str) and bool(OPAQUE.fullmatch(source))
        shared = not isinstance(actor, str) or not ACTOR.fullmatch(actor) or actor in SHARED_LOGINS
        state = "unknown" if shared else "acknowledged" if agreed else "unverified"
        slot = found.setdefault((repo, number, role), [])
        slot.append({"actor": actor if isinstance(actor, str) and ACTOR.fullmatch(actor) and actor not in SHARED_LOGINS else "",
                     "state": state, "source": source if agreed and not shared else ""})
    resolved = {}
    for key, rows in found.items():
        accepted = [row for row in rows if row["state"] == "acknowledged"]
        if len(accepted) == 1:
            resolved[key] = accepted[0]
        elif len(accepted) > 1:
            resolved[key] = {"actor": "", "state": "ambiguous", "source": ""}
        else:
            resolved[key] = {"actor": "", "state": rows[0]["state"], "source": ""}
    return resolved


def _index_by_id(rows, fields):
    found = {}
    for row in rows or []:
        if not isinstance(row, dict):
            raise InvalidEvidence("invalid coordination record")
        identifier = row.get("id")
        if not isinstance(identifier, str) or identifier.count("#") != 1:
            raise InvalidEvidence("invalid coordination record")
        found.setdefault(identifier, []).append({key: row.get(key) for key in fields})
    return found


def _assessment(record, rows):
    priority, priority_state = None, "unassessed"
    types, type_state = [], "unassessed"
    topic_state = "unassessed"
    salesforce = False
    for row in rows:
        evidence = row.get("evidence")
        evidenced = isinstance(evidence, str) and bool(OPAQUE.fullmatch(evidence))
        if row.get("priority") in PRIORITIES and evidenced and row.get("priority_state") == "assessed":
            priority, priority_state = row["priority"], "assessed"
        elif row.get("priority") in PRIORITIES and priority_state != "assessed":
            priority_state = "unverified"
        raw_types = row.get("types") if isinstance(row.get("types"), list) else []
        clean = [name for name in raw_types if name in TYPES]
        if clean and evidenced and row.get("type_state") == "assessed":
            types, type_state = sorted(set(clean)), "assessed"
        elif clean and type_state != "assessed":
            types, type_state = sorted(set(clean)), "unverified"
        if row.get("topic") == "salesforce" and not salesforce:
            if evidenced and row.get("topic_state") == "assessed":
                salesforce, topic_state = True, "assessed"
            elif topic_state != "assessed":
                topic_state = row.get("topic_state") if row.get("topic_state") in {"suspected", "unverified"} else "unverified"
    # A security type does not assign a priority.
    if "security" in types and priority_state != "assessed":
        priority = None
    return {
        "priority": priority,
        "priority_state": priority_state,
        "types": types,
        "type_state": type_state,
        "salesforce": salesforce,
        "topic_state": topic_state,
    }


def _links(record_id, dependencies):
    blocks, blocked_by = [], []
    for row in dependencies or []:
        if not isinstance(row, dict):
            continue
        state = row.get("state")
        evidence = row.get("evidence")
        if state not in {"assessed", "suspected", "unverified"}:
            continue
        if not isinstance(evidence, str) or not OPAQUE.fullmatch(evidence):
            continue
        pair = {"id": "", "state": state, "evidence": evidence}
        if row.get("direction") == "blocks" and row.get("from_id") == record_id:
            pair["id"] = row.get("to_id")
            if isinstance(pair["id"], str):
                blocks.append(pair)
        elif row.get("direction") == "blocks" and row.get("to_id") == record_id:
            pair["id"] = row.get("from_id")
            if isinstance(pair["id"], str):
                blocked_by.append(pair)
        elif row.get("direction") == "blocked_by" and row.get("from_id") == record_id:
            pair["id"] = row.get("to_id")
            if isinstance(pair["id"], str):
                blocked_by.append(pair)
    blocks.sort(key=lambda item: (item["id"], item["state"], item["evidence"]))
    blocked_by.sort(key=lambda item: (item["id"], item["state"], item["evidence"]))
    return blocks, blocked_by


def _deployed(record, rows):
    """An explicit runtime observation is an identity comparison, not acceptance."""
    proposed = record["proposed_head"]
    for row in rows:
        sha = row.get("sha")
        evidence = row.get("evidence")
        if not isinstance(sha, str) or not SHA.fullmatch(sha):
            continue
        if not isinstance(evidence, str) or not OPAQUE.fullmatch(evidence):
            continue
        state = "matches_proposed" if sha == proposed else "differs"
        return {"deployed_head": sha, "deployed_state": state, "runtime_accepted": False, "evidence": evidence}
    return {"deployed_head": None, "deployed_state": "unknown", "runtime_accepted": False, "evidence": ""}


def _role(acks, repo, number, role, requested=False):
    chosen = acks.get((repo, number, role))
    if chosen:
        return chosen["actor"], chosen["state"], chosen["source"]
    if requested and role == "reviewer":
        return "", "requested", ""
    return "", "unacknowledged", ""


def _days_open(creation, current):
    if current.get("measured") and isinstance(current.get("days"), int):
        return str(current["days"])
    return UNASSESSED


def assemble_glance(record, closure_actor, closure_state, stage, creation, current):
    """Display fields. Every one is a non-empty string. Missing stays unassessed."""
    parsed = record.get("glance") if isinstance(record.get("glance"), dict) else {}
    labels = record.get("labels") if isinstance(record.get("labels"), list) else []
    normalized = [name.strip().lower() for name in labels if isinstance(name, str) and name.strip()]
    priority = parsed.get("priority") if parsed.get("priority") in GLANCE_PRIORITIES else ""
    if not priority:
        ranks = [LABEL_RANK[name] for name in normalized if name in LABEL_RANK]
        priority = min(ranks, key=lambda rank: ("P0", "P1", "P2").index(rank)) if ranks else UNASSESSED
    status = STATUS_LINE.get(stage, UNASSESSED)
    if "blocked" in normalized and status in {"Open", "In review"}:
        status = "Blocked"
    driver = OWNER_NAMES.get(closure_actor or "") if closure_state == "acknowledged" and closure_actor else ""
    return {
        "priority": _shown(priority),
        "blocks": _shown(parsed.get("blocks")),
        "blocked_by": _shown(parsed.get("blocked_by")),
        "owner": _shown(parsed.get("owner")),
        "closure_driver": _shown(driver),
        "status": _shown(status),
        "days_open": _shown(_days_open(creation, current)),
    }


def project_record(record, as_of, acknowledgments, assessments, dependencies, deployed):
    repo, number = record["repo"], record["number"]
    identifier = "%s#%d" % (repo, number)
    creation, current = intervals(record["created_at"], record.get("events"), as_of, record["state"])
    assessed = _assessment(record, assessments.get(identifier, []))
    queue = ["claude"] if assessed["salesforce"] else list(QUEUES[repo])
    closure_actor, closure_state, closure_source = _role(acknowledgments, repo, number, "closure_driver")
    impl_actor, impl_state, impl_source = _role(acknowledgments, repo, number, "implementation_owner")
    review_actor, review_state, review_source = _role(
        acknowledgments, repo, number, "reviewer", requested=bool(record.get("review_requests")))
    blocks, blocked_by = _links(identifier, dependencies)
    deployment = _deployed(record, deployed.get(identifier, []))
    source = "https://github.com/%s/pull/%d" % (repo, number)
    if not REF.fullmatch(source):
        raise InvalidEvidence("invalid pull request reference")
    stage = stage_of(record)
    glance = assemble_glance(record, closure_actor, closure_state, stage, creation, current)
    return {
        "id": identifier,
        "repo": repo,
        "number": number,
        "project": PROJECTS[repo],
        "ref": source,
        "proposed_head": record["proposed_head"],
        "deployed_head": deployment["deployed_head"],
        "deployed_state": deployment["deployed_state"],
        "runtime_accepted": False,
        "state": record["state"],
        "stage": stage,
        "queue_owners": queue,
        "queue_basis": "salesforce_topic" if assessed["salesforce"] else "repo_default",
        "topic_state": assessed["topic_state"],
        "closure_driver": closure_actor or None,
        "closure_driver_state": closure_state,
        "closure_source": closure_source,
        "implementation_owner": impl_actor or None,
        "implementation_owner_state": impl_state,
        "implementation_source": impl_source,
        "reviewer": review_actor or None,
        "reviewer_state": review_state,
        "reviewer_source": review_source,
        "author": record.get("author") or "",
        "assignees": list(record.get("assignees") or []),
        "review_requests": list(record.get("review_requests") or []),
        "head_ref": record.get("head_ref") or "",
        "priority": assessed["priority"],
        "priority_state": assessed["priority_state"],
        "types": assessed["types"],
        "type_state": assessed["type_state"],
        "as_of": as_of,
        "created_at": record["created_at"],
        "creation_age": creation,
        "current_open": current,
        "blocks": blocks,
        "blocked_by": blocked_by,
        "disposition": "unassessed",
        "glance": glance,
    }


def _assert_metadata(value):
    if isinstance(value, dict):
        banned = BANNED_FIELDS.intersection(value)
        if banned:
            raise InvalidEvidence("private field refused")
        for item in value.values():
            _assert_metadata(item)
    elif isinstance(value, list):
        for item in value:
            _assert_metadata(item)
    elif isinstance(value, str):
        if any(ord(char) < 32 for char in value):
            raise InvalidEvidence("private field refused")


def build_generation(records, as_of, acknowledgments=None, assessments=None, dependencies=None, deployed=None):
    instant(as_of)
    acks = _index_acks(acknowledgments)
    assessed = _index_by_id(assessments, ("priority", "priority_state", "types", "type_state", "topic", "topic_state", "evidence"))
    delivered = _index_by_id(deployed, ("sha", "evidence", "observed_at"))
    items = [project_record(record, as_of, acks, assessed, dependencies, delivered) for record in records]
    items.sort(key=lambda item: (item["repo"], item["number"]))
    _assert_metadata({"items": items})
    by_repo = {}
    for repo in REPOS:
        rows = [item for item in items if item["repo"] == repo]
        stages = {}
        for item in rows:
            stages[item["stage"]] = stages.get(item["stage"], 0) + 1
        by_repo[repo] = {
            "project": PROJECTS[repo],
            "queue_owners": list(QUEUES[repo]),
            "count": len(rows),
            "stages": stages,
            "ids": [item["id"] for item in rows],
        }
    by_project = {}
    for repo, rollup in by_repo.items():
        project = rollup["project"]
        slot = by_project.setdefault(project, {"queue_owners": rollup["queue_owners"], "count": 0, "repos": []})
        slot["count"] += rollup["count"]
        slot["repos"].append(repo)
    counts = {repo: by_repo[repo]["count"] for repo in REPOS}
    body = {
        "schema_version": 1,
        "kind": "pr_board",
        "as_of": as_of,
        "complete": True,
        "counts": counts,
        "inventory_stated": dict(STATED_INVENTORY),
        "inventory_delta": {repo: counts[repo] - STATED_INVENTORY[repo] for repo in REPOS},
        "by_repo": by_repo,
        "by_project": by_project,
        "items": items,
    }
    raw = json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    body["id"] = hashlib.sha256(raw.encode("utf-8")).hexdigest()
    return body


def _compact(item):
    def bit(value):
        return "1" if value else "0"

    def num(interval, key):
        value = interval.get(key)
        return "" if value is None else str(value)

    creation, current = item["creation_age"], item["current_open"]
    return {
        "as_of": item["as_of"],
        "author": item["author"],
        "c_basis": creation["basis"],
        "c_days": num(creation, "days"),
        "c_hours": num(creation, "hours"),
        "c_measured": bit(creation["measured"]),
        "cd": item["closure_driver"] or "",
        "cd_state": item["closure_driver_state"],
        "deployed": item["deployed_head"] or "",
        "deployed_state": item["deployed_state"],
        "head": item["proposed_head"],
        "id": item["id"],
        "impl": item["implementation_owner"] or "",
        "impl_state": item["implementation_owner_state"],
        "n": str(item["number"]),
        "o_basis": current["basis"],
        "o_days": num(current, "days"),
        "o_hours": num(current, "hours"),
        "o_measured": bit(current["measured"]),
        "priority": item["priority"] or "",
        "priority_state": item["priority_state"],
        "project": item["project"],
        "qo": ",".join(item["queue_owners"]),
        "repo": item["repo"],
        "rev": item["reviewer"] or "",
        "rev_state": item["reviewer_state"],
        "stage": item["stage"],
        "type_state": item["type_state"],
        "types": ",".join(item["types"]),
        "g_priority": item["glance"]["priority"],
        "g_blocks": item["glance"]["blocks"],
        "g_blocked": item["glance"]["blocked_by"],
        "g_owner": item["glance"]["owner"],
        "g_cd": item["glance"]["closure_driver"],
        "g_status": item["glance"]["status"],
        "g_days": item["glance"]["days_open"],
    }


def _mapping(fields):
    # Longer than the governed preview, so a preview read cannot equal a full read.
    fields = dict(fields, witness="readback-" + ("0" * 220))
    if len(fields) > MAX_PUT_FIELDS:
        raise InvalidEvidence("governed hash exceeds 50 fields")
    if any(not isinstance(value, str) for value in fields.values()):
        raise InvalidEvidence("governed hash values must be strings")
    encoded = json.dumps(fields, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    if len(encoded.encode("utf-8")) > MAX_VALUE_BYTES:
        raise InvalidEvidence("governed value exceeds 2048 bytes")
    return fields


def redis_documents(generation):
    """Immutable hash mappings. Each one fits hput's 50 fields and 2048 bytes."""
    if not generation.get("complete") or not re.fullmatch(r"[0-9a-f]{64}", str(generation.get("id") or "")):
        raise InvalidEvidence("incomplete generation")
    prefix = NAMESPACE + "g:" + generation["id"][:16]
    rows = [_compact(item) for item in generation["items"]]
    shards = []
    bucket = []

    def seal(buf, seq):
        payload = json.dumps(buf, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
        return _mapping({
            "generation": generation["id"],
            "rows": payload,
            "seq": str(seq),
            "sha256": hashlib.sha256(payload.encode("utf-8")).hexdigest(),
        })

    for row in rows:
        trial = bucket + [row]
        try:
            seal(trial, len(shards))
        except InvalidEvidence:
            if not bucket:
                raise InvalidEvidence("one pull request exceeds the governed value cap") from None
            shards.append(seal(bucket, len(shards)))
            bucket = [row]
            seal(bucket, len(shards))
        else:
            bucket = trial
    if bucket:
        shards.append(seal(bucket, len(shards)))
    documents = []
    for seq, mapping in enumerate(shards):
        documents.append((prefix + ":i:" + str(seq), mapping))
    for repo, rollup in generation["by_repo"].items():
        slug = repo.split("/", 1)[1]
        payload = json.dumps({
            "count": rollup["count"],
            "project": rollup["project"],
            "queue_owners": rollup["queue_owners"],
            "stages": rollup["stages"],
        }, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
        documents.append((prefix + ":repo:" + slug, _mapping({
            "generation": generation["id"],
            "repo": repo,
            "rollup": payload,
            "sha256": hashlib.sha256(payload.encode("utf-8")).hexdigest(),
        })))
    meta_payload = json.dumps({
        "as_of": generation["as_of"],
        "counts": generation["counts"],
        "inventory_delta": generation["inventory_delta"],
    }, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    documents.append((prefix + ":meta", _mapping({
        "advisory_head": "0",
        "as_of": generation["as_of"],
        "complete": "1",
        "generation": generation["id"],
        "meta": meta_payload,
        "principal": "cursor",
        "sha256": hashlib.sha256(meta_payload.encode("utf-8")).hexdigest(),
    })))
    for key, _mapping_value in documents:
        if not key.startswith(NAMESPACE) or key.startswith("proj:milestones:"):
            raise InvalidEvidence("PR board key is outside proj:pr-board:")
    return documents


def _previewed(expected, got):
    if not isinstance(got, dict):
        return False
    for key, value in expected.items():
        seen = got.get(key)
        if isinstance(value, str) and isinstance(seen, str) and seen != value and seen == value[:PREVIEW_CHARS] + "...":
            return True
    return False


def write_generation(generation, put, read_full):
    """Write every shard, read the full values back, then move the advisory head.

    put(key, mapping) follows redis_gov hput's result shape. read_full must
    return the stored strings. A governed preview is not acceptance. The head
    key is advisory and is not a compare-and-swap.
    """
    documents = redis_documents(generation)
    head = read_full(HEAD_KEY)
    previous = head.get("generation") if isinstance(head, dict) else None

    def stale(reason):
        return {"status": "stale", "reason": reason, "items": None, "previous_head": previous,
                "wrote_head": False, "generation_id": generation["id"]}

    try:
        existing = [(key, read_full(key)) for key, _mapping_value in documents]
    except TimeoutError:
        return stale("timeout")
    if all(got == mapping for (_key, got), (_key, mapping) in zip(existing, documents)):
        if isinstance(head, dict) and head.get("generation") == generation["id"] and head.get("advisory") == "1":
            return {"status": "replay", "reason": "generation_present", "items": generation["items"],
                    "previous_head": previous, "wrote_head": False, "generation_id": generation["id"],
                    "read_back": "full"}
    for key, got in existing:
        expected = dict(documents)[key]
        if got not in (None, {}) and got != expected:
            return stale("immutable_conflict")
    for key, mapping in documents:
        if dict(existing)[key] == mapping:
            continue
        try:
            result = put(key, mapping)
        except TimeoutError:
            return stale("timeout")
        if not isinstance(result, dict) or not result.get("ok") or result.get("partial"):
            reason = "audit_failed" if isinstance(result, dict) and result.get("partial") else "partial_write"
            return stale(reason)
    try:
        for key, mapping in documents:
            got = read_full(key)
            if _previewed(mapping, got):
                return stale("preview_readback")
            if got != mapping:
                return stale("readback_mismatch")
    except TimeoutError:
        return stale("timeout")
    head_mapping = _mapping({"advisory": "1", "complete": "1", "generation": generation["id"]})
    try:
        result = put(HEAD_KEY, head_mapping)
    except TimeoutError:
        return stale("timeout")
    if not isinstance(result, dict) or not result.get("ok") or result.get("partial"):
        return stale("head_unmoved")
    confirmed = read_full(HEAD_KEY)
    if confirmed != head_mapping:
        return stale("preview_readback" if _previewed(head_mapping, confirmed) else "readback_mismatch")
    return {"status": "complete", "reason": "read_back", "items": generation["items"],
            "previous_head": previous, "wrote_head": True, "generation_id": generation["id"],
            "advisory_head": True, "read_back": "full"}


def governed_put(execute, conn, acl, principal="cursor", via="pr-board"):
    """A put() closure that calls redis_gov.execute's hput signature and nothing else."""
    if principal == FORBIDDEN_PRINCIPAL:
        raise InvalidEvidence("milestones-sync cannot write the PR board")

    def put(key, mapping):
        if principal == FORBIDDEN_PRINCIPAL:
            raise InvalidEvidence("milestones-sync cannot write the PR board")
        if not str(key).startswith(NAMESPACE):
            raise InvalidEvidence("PR board key is outside proj:pr-board:")
        payload = json.dumps(mapping, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
        if len(payload.encode("utf-8")) > MAX_VALUE_BYTES or len(mapping) > MAX_PUT_FIELDS:
            raise InvalidEvidence("governed value exceeds the existing hput cap")
        raw = base64.b64encode(payload.encode("utf-8")).decode("ascii")
        return execute(conn, acl, principal, via, "hput", key, "", raw, "b64", 10, None)

    return put


def display_rows(generation):
    """One public row per pull request. P0 first, then the ones open the longest."""
    rows = []
    for item in generation.get("items") or []:
        glance = item.get("glance") or {}
        short = "%s#%s" % (item["repo"].split("/", 1)[1], item["number"])
        row = {
            "pr": short,
            "priority": _shown(glance.get("priority")),
            "blocks": _shown(glance.get("blocks")),
            "blocked_by": _shown(glance.get("blocked_by")),
            "owner": _shown(glance.get("owner")),
            "closure_driver": _shown(glance.get("closure_driver")),
            "status": _shown(glance.get("status")),
            "days_open": _shown(glance.get("days_open")),
        }
        if any(not value or value != value.strip() for value in row.values()):
            raise InvalidEvidence("a glance field was blank")
        rows.append(row)
    rank = {"P0": 0, "P1": 1, "P2": 2, UNASSESSED: 3}

    def key(row):
        days = int(row["days_open"]) if row["days_open"].isdigit() else -1
        return (rank.get(row["priority"], 3), -days, row["pr"])

    rows.sort(key=key)
    return rows


def public_snapshot(generation, enabled=False):
    """The Ops table document. Enabled only when the collector flag is on."""
    rows = display_rows(generation) if enabled else []
    return {"enabled": bool(enabled), "as_of": generation.get("as_of") if enabled else "", "rows": rows}


def stale_result(reason, previous_head=None):
    return {"status": "stale", "reason": reason, "items": None, "previous_head": previous_head,
            "wrote_head": False, "wrote": False}


def run(as_of=None, read=None, policy=None, acknowledgments=None, assessments=None, dependencies=None,
        deployed=None, repos=REPOS, put=None, read_full=None, enabled_flag=False, env=None, max_pages=MAX_PAGES):
    if not enabled(enabled_flag, env):
        return {"status": "disabled", "reason": "flag_off", "items": None, "wrote": False, "wrote_head": False}
    if not as_of:
        raise InvalidEvidence("an explicit as-of time is required")
    try:
        records = attach_checks(attach_activity(list_open(read, repos, max_pages=max_pages), read), policy, read)
        generation = build_generation(records, as_of, acknowledgments, assessments, dependencies, deployed)
    except (InvalidEvidence, ValueError, KeyError, TypeError):
        return stale_result("source_failure")
    if put is None or read_full is None:
        return {"status": "projected_not_written", "reason": "writer_not_attached", "items": generation["items"],
                "generation": generation, "wrote": False, "wrote_head": False}
    try:
        receipt = write_generation(generation, put, read_full)
    except TimeoutError:
        return stale_result("timeout")
    except (InvalidEvidence, ValueError, TypeError):
        return stale_result("source_failure")
    receipt["wrote"] = receipt.get("status") in {"complete", "replay"}
    receipt["generation"] = generation if receipt["wrote"] else None
    if not receipt["wrote"]:
        receipt["items"] = None
    return receipt


def _load(path):
    if path is None:
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def main(argv=None, read=None, put=None, read_full=None, env=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--enable", action="store_true", help="Required. The flag defaults off.")
    parser.add_argument("--as-of", help="Explicit UTC timestamp, YYYY-MM-DDTHH:MM:SSZ")
    parser.add_argument("--policy", type=argparse.FileType("r", encoding="utf-8"))
    parser.add_argument("--acknowledgments", type=argparse.FileType("r", encoding="utf-8"))
    parser.add_argument("--assessments", type=argparse.FileType("r", encoding="utf-8"))
    parser.add_argument("--dependencies", type=argparse.FileType("r", encoding="utf-8"))
    parser.add_argument("--deployed", type=argparse.FileType("r", encoding="utf-8"))
    parser.add_argument("--out", help="Local metadata JSON. Not written when the flag is off or collection fails.")
    parser.add_argument("--public-out", help="Ops table JSON. Written only when the flag is on and collection succeeds.")
    args = parser.parse_args(argv)
    env = os.environ if env is None else env
    if not enabled(args.enable, env):
        print("PR board disabled; flag defaults off. No GitHub read and no Redis write.")
        return 0
    if not args.as_of:
        print("PR board needs an explicit --as-of time.", file=sys.stderr)
        return 2

    def read_json(handle):
        if handle is None:
            return None
        return json.load(handle)

    try:
        instant(args.as_of)
        if read is None:
            from ops_delivery_collect import api as read  # noqa: PLC0415
        receipt = run(args.as_of, read, read_json(args.policy), read_json(args.acknowledgments),
                      read_json(args.assessments), read_json(args.dependencies), read_json(args.deployed),
                      put=put, read_full=read_full, enabled_flag=True, env=env)
    except (InvalidEvidence, OSError, ValueError, json.JSONDecodeError):
        print("PR board collection failed; last good generation retained.", file=sys.stderr)
        return 1
    if receipt["status"] == "disabled":
        print("PR board disabled; flag defaults off. No GitHub read and no Redis write.")
        return 0
    if receipt["status"] == "stale":
        print("PR board collection failed; last good generation retained.", file=sys.stderr)
        return 1
    def write_json(path, value):
        text = json.dumps(value, sort_keys=True, indent=2) + "\n"
        temporary = path + ".tmp"
        with open(temporary, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(text)
        os.replace(temporary, path)

    if args.out and receipt.get("generation"):
        write_json(args.out, receipt["generation"])
    if args.public_out and receipt.get("generation"):
        write_json(args.public_out, public_snapshot(receipt["generation"], enabled=True))
    if receipt["status"] == "projected_not_written":
        print("PR board projected locally. No Redis write; the governed writer was not attached.")
        return 0
    print("PR board generation %s %s" % (receipt["generation_id"], receipt["status"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
