#!/usr/bin/env python3
"""Metadata-only PR board generations for the governed Redis projection.

Walks every open pull request in conference, Blackboard, and sfdc24-site,
with full page walks past 100. Rolls each one up by repository and project
with queue owner, closure driver, stage, and hours/days open as of an
explicit timestamp. Each item also carries a glance record for the Ops
table: priority (P0, P1, or P2), what it blocks, what blocks it, owner,
closure driver, status, and days open. Unassessed fields say unassessed.
Turnaround is time to first review, from that review to merge or close, and
total open-to-close. Those use review and close/reopen events only. Missing
history is unknown. A daily median for the last seven days is kept per
repository and per agent. Each open pull request also carries one owner,
its project, a milestone when that name is safe to show, status, age,
the blocker line, and a GO-on-exact-head flag. The flag records an
approval on the current head. It does not merge anything.
Writes immutable generations through a redis_gov-compatible
hput under the existing proj: grant (proj:pr-board:v1:). Repository names
are encoded inside that prefix. A pr: key is not used. Does not edit
redis_acl.json, does not use the milestones-sync principal, and does not
touch the public Ops feed or its site-scoped token.
One enabled run is one sweep of the three repositories. This process does
not schedule itself. A 2 to 4 hour sweep cannot meet a 1 hour new-PR SLA.

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
from pathlib import Path
import statistics
import sys
import unicodedata
from datetime import timedelta
from ops_delivery import SECRET, InvalidEvidence, instant
from ops_delivery_collect import SHA, collect, timestamp
from redis_gov import backend_receipt_accepts, complete_receipt

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
MAX_RECONSTRUCTED_BYTES = 1048576
# The verifier reads at most this many documents in one batch. This cap does not rise.
MAX_AUDIT_BATCH = 128
# One manifest byte bound, shared with Blackboard haudit. Caps do not rise.
MAX_MANIFEST_BYTES = 65536
# Conference fixture shape: one item shard and one action shard per pull request,
# plus 3 repo, 3 turn, 1 meta, and 1 closed document. The largest generation
# whose paged haudit manifest fits in 65536 bytes is 233 pull requests,
# 474 documents (paged inventory 65400 bytes, flat {"keys"} manifest 64089).
# 234 pull requests is 476 documents and 65671 paged bytes. The retired
# 512-document count is a 69238-byte flat manifest. Head and manifest pages
# are not counted. Over the byte bound is refused before put.
MAX_GENERATION_DOCUMENTS = 474
MANIFEST_PAGE_SIZE = 8
MAX_MANIFEST_PAGES = (MAX_GENERATION_DOCUMENTS + MANIFEST_PAGE_SIZE - 1) // MANIFEST_PAGE_SIZE
VERIFY_FLAG = "REDIS_GOV_VERIFY"
VERIFY_ON = frozenset({"1", "true", "on", "yes"})
# Blackboard scripts/redis_gov.py, vendored at ea85bffb45904d93bbaa2056ae29d73a5e3c50a9.
# complete_receipt is line 361. backend_receipt_accepts is line 394.
# Plus is outside the key grammar. repo_key uses owner:name because a colon is allowed
# and a GitHub owner or name does not contain one.
KEY_GRAMMAR = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$")
FIELD_GRAMMAR = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$")
VERIFIER_SHA = "ea85bffb45904d93bbaa2056ae29d73a5e3c50a9"
PRIVATE_VIA = frozenset({"pr-board"})
NAMESPACE = "proj:pr-board:v1:"
HEAD_KEY = NAMESPACE + "head"
# The public Ops page may show prose only for the public site repository.
# Conference and Blackboard relationship text stays in the private generation.
PUBLIC_AUDIENCE = frozenset({"sfdc-24/sfdc24-site"})
PRIVATE_AGGREGATE_REPOS = frozenset({"conference", "Blackboard"})
AGGREGATE_ENV = "OPS_PR_BOARD_PRIVATE_AGGREGATES"
PUBLIC_FIELDS = (
    "pr", "priority", "blocks", "blocked_by", "owner", "closure_driver",
    "status", "days_open", "milestone", "project", "go_on_head",
)
PUBLIC_PROSE = ("blocks", "blocked_by", "owner", "closure_driver", "milestone")
ADVISORY_ACTIONS = ("MERGE", "FIX", "DEFER", "CLOSE")
# CR-20261011-001 asks Aya to sweep every 2 hours, and at least every 4.
# This collector adds no scheduler, so 4 hours is the cadence it can support.
SWEEP_CADENCE_HOURS = 4
FORBIDDEN_PRINCIPAL = "milestones-sync"
FAIL_CONCLUSIONS = {
    "failure", "cancelled", "timed_out", "action_required", "stale", "startup_failure",
}
TYPES = {
    "ux:joining", "ux:interaction", "ux:loading", "ux:artifact", "ux:audio",
    "security", "redis", "salesforce", "infrastructure",
}
PRIORITIES = {"CRITICAL", "HIGH", "MEDIUM", "LOW"}
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
UNKNOWN_TIME = "unknown"
TURN_METRICS = ("first_review", "review_to_close", "open_to_close")
TURN_LABELS = {
    "first_review": "First review",
    "review_to_close": "Review to close",
    "open_to_close": "Open to close",
}
AGENT_ORDER = ("Claude", "Aya", "Jenny", "Cody", "Greg")
REVIEW_STATES = {"APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED"}
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


def verify_enabled(env=None):
    """True only when REDIS_GOV_VERIFY is explicitly on. Unset is off."""
    source = os.environ if env is None else env
    return str(source.get(VERIFY_FLAG, "")).strip().lower() in VERIFY_ON


def private_aggregates_enabled(flag=False, env=None):
    """Conference and Blackboard daily medians stay off the public snapshot until authorized."""
    if flag is True:
        return True
    source = os.environ if env is None else env
    return str(source.get(AGGREGATE_ENV, "")).strip().lower() in {"1", "true", "yes", "on"}


def private_prefix(generation_id):
    """Redis prefix for one private generation. Public JSON is not this key."""
    if not re.fullmatch(r"[0-9a-f]{64}", str(generation_id or "")):
        raise InvalidEvidence("incomplete generation")
    return NAMESPACE + "g:" + generation_id[:16] + ":"


def is_public_path(path):
    """True for the Ops public file or any path under a public directory."""
    text = str(path or "").replace("\\", "/")
    name = text.rsplit("/", 1)[-1].lower()
    folded = "/" + text.lower().strip("/") + "/"
    return name == "pr-board-public.json" or "/public/" in folded


def is_public_tree(path):
    """True for a private output path inside the published site tree, including data/."""
    text = str(path or "").replace("\\", "/").strip()
    folded = text.lower()
    if folded in {"data", "./data"} or folded.startswith("data/") or folded.startswith("./data/"):
        return True
    try:
        candidate = Path(text).expanduser()
        if not candidate.is_absolute():
            candidate = Path.cwd() / candidate
        resolved = candidate.resolve()
        data_root = (Path(__file__).resolve().parents[1] / "data").resolve()
        if resolved == data_root or data_root in resolved.parents:
            return True
    except OSError:
        return True
    return False


def is_private_generation(document):
    """True when the document is the private generation rather than the Ops snapshot."""
    if not isinstance(document, dict):
        return False
    if any(key in document for key in ("items", "closed_history", "action_audience")):
        return True
    text = json.dumps(document, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return "next_action" in text or "recommendations_execute" in text


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


def _milestone(row, title):
    """A milestone name safe to show. A private name stays off the board."""
    milestone = row.get("milestone") if isinstance(row, dict) else None
    if not isinstance(milestone, dict):
        return ""
    phrase = public_phrase(milestone.get("title") or "", title)
    return "" if phrase == UNASSESSED else phrase


def _sha_or_blank(value):
    """A commit id, or blank. A branch head is not a historical close head."""
    if isinstance(value, str) and SHA.fullmatch(value):
        return value
    return ""


def repo_key(repo):
    """Encode owner:name. The governed key grammar allows a colon and rejects plus.

    This is the encoding both #296 and #383 test. A GitHub owner and repository
    name do not contain a colon, so the first colon is the split. The grammar
    is Blackboard redis_gov ``_KEY`` at the pinned verifier SHA.
    """
    if repo not in PROJECTS or repo.count("/") != 1:
        raise InvalidEvidence("PR board key is outside the governed key grammar")
    owner, name = repo.split("/", 1)
    if not owner or not name or any(mark in owner + name for mark in ("+", ":", "/")):
        raise InvalidEvidence("PR board key is outside the governed key grammar")
    encoded = owner + ":" + name
    if not KEY_GRAMMAR.fullmatch(encoded):
        raise InvalidEvidence("PR board key is outside the governed key grammar")
    return encoded


def _assert_governed_key(key):
    if not isinstance(key, str) or not KEY_GRAMMAR.fullmatch(key):
        raise InvalidEvidence("PR board key is outside the governed key grammar")
    if not key.startswith(NAMESPACE) or key.startswith("pr:") or "/" in key or "+" in key:
        raise InvalidEvidence("PR board key is outside proj:pr-board:v1:")


def _assert_governed_fields(mapping):
    if not isinstance(mapping, dict):
        raise InvalidEvidence("PR board field is outside the governed field grammar")
    for name in mapping:
        if not isinstance(name, str) or not FIELD_GRAMMAR.fullmatch(name):
            raise InvalidEvidence("PR board field is outside the governed field grammar")


def _tri_state(row, key):
    """True, False, or unknown. A missing value is unknown, not permission to proceed."""
    if not isinstance(row, dict) or key not in row or row.get(key) is None:
        return "unknown"
    if row.get(key) is True:
        return True
    if row.get(key) is False:
        return False
    return "unknown"


def _waiting_events(value):
    if not isinstance(value, list):
        return "unknown"
    rows = []
    for row in value:
        if not isinstance(row, dict) or type(row.get("id")) is not int:
            return "unknown"
        if row.get("event") not in {"waiting", "review_requested"}:
            return "unknown"
        when = row.get("created_at")
        try:
            instant(when)
        except (InvalidEvidence, TypeError):
            return "unknown"
        rows.append({"id": row["id"], "event": row["event"], "created_at": when})
    return rows


def _access_field(value):
    if not isinstance(value, dict):
        return {"state": "unknown", "observed_at": "", "evidence": ""}
    state = value.get("state") if value.get("state") in {"allowed", "denied", "unknown"} else "unknown"
    when = value.get("observed_at") if isinstance(value.get("observed_at"), str) else ""
    evidence = _opaque_or_blank(value.get("evidence"))
    if state in {"allowed", "denied"}:
        try:
            instant(when)
        except InvalidEvidence:
            state, when, evidence = "unknown", "", ""
        if not evidence:
            state, when, evidence = "unknown", "", ""
    else:
        when, evidence = "", ""
    return {"state": state, "observed_at": when, "evidence": evidence}


def _task_field(value):
    if not isinstance(value, dict):
        return "unknown"
    number = value.get("number")
    work_id = value.get("work_id")
    return {
        "state": value.get("state") if value.get("state") in {"assessed", "suspected", "unverified"} else "unknown",
        "kind": value.get("kind") if value.get("kind") in {"issue", "pr"} else "unknown",
        "number": number if type(number) is int and number > 0 else "unknown",
        "repo": value.get("repo") if value.get("repo") in PROJECTS else "unknown",
        "evidence": _opaque_or_blank(value.get("evidence")) or "unknown",
        "work_id": work_id if _has_evidence(work_id) and bool(OPAQUE.fullmatch(work_id)) else "unknown",
    }


def _closure_case_field(value):
    if not isinstance(value, dict):
        return "unknown"
    rationale = value.get("rationale") if value.get("rationale") in {"duplicate", "obsolete"} else "unknown"
    return {
        "duplication": value.get("duplication") is True,
        "obsolete": value.get("obsolete") is True,
        "rationale": rationale,
        "replacement": _opaque_or_blank(value.get("replacement")) or "unknown",
        "obligations_preserved": value.get("obligations_preserved") is True,
        "evidence": _opaque_or_blank(value.get("evidence")) or "unknown",
    }


def _fix_url_field(value):
    if isinstance(value, str) and re.fullmatch(
            r"https://github\.com/sfdc-24/(?:conference|Blackboard|sfdc24-site)/pull/[1-9][0-9]*/files", value):
        return value
    return "unknown"


def scrub_pull(repo, row):
    """Copy the allowlisted PR metadata. Titles and bodies never leave.

    Readiness inputs are kept or set to unknown. A missing draft, mergeable
    flag, access observation, or closure actor is not treated as permission.
    """
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
        "draft": _tri_state(row, "draft"),
        "mergeable": _tri_state(row, "mergeable"),
        "glance": parse_at_a_glance(row.get("body") if isinstance(row.get("body"), str) else "",
                                    row.get("title") if isinstance(row.get("title"), str) else ""),
        "labels": allowlisted_labels(row.get("labels")),
        "milestone": _milestone(row, row.get("title") if isinstance(row.get("title"), str) else ""),
        "merged_commit": _sha_or_blank(row.get("merge_commit_sha")),
        "head_at_close": _sha_or_blank(row.get("closed_head_sha")),
        "waiting_events": _waiting_events(row.get("waiting_events")) if "waiting_events" in row else "unknown",
        "access": _access_field(row.get("access")) if "access" in row else {"state": "unknown", "observed_at": "", "evidence": ""},
        "task": _task_field(row.get("task")) if "task" in row else "unknown",
        "fix_url": _fix_url_field(row.get("fix_url")) if "fix_url" in row else "unknown",
        "fix_evidence": _opaque_or_blank(row.get("fix_evidence")) or "unknown" if "fix_evidence" in row else "unknown",
        "closure_case": _closure_case_field(row.get("closure_case")) if "closure_case" in row else "unknown",
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


def _identity(rows):
    return tuple(sorted(
        (row["repo"], row["number"], row["proposed_head"], row["state"]) for row in rows
    ))


def _walk_open(read, repos, max_pages):
    """Every open PR. A short page ends a repository. The caller compares a second walk."""
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
        found.extend(seen[number] for number in sorted(seen))
    return found


def list_open(read, repos=REPOS, max_pages=MAX_PAGES):
    """Walk every page twice and keep the list only when number, head, and state match."""
    first = _walk_open(read, repos, max_pages)
    second = _walk_open(read, repos, max_pages)
    if _identity(first) != _identity(second):
        raise ValueError("PR moved during collection")
    return first


def confirm_collected(read, records, repos=REPOS, max_pages=MAX_PAGES):
    """After reviews and events are read, the open set must still match."""
    again = _walk_open(read, repos, max_pages)
    if _identity(again) != _identity(records):
        raise ValueError("PR moved during collection")


def list_closed(read, as_of, repos=REPOS, max_pages=MAX_PAGES):
    """Closed pull requests whose latest close falls in the seven days before as_of.

    closed_at only decides whether a row is in the window. The measured
    durations still come from review and issue events. An unfinished page walk
    is a failure, same as the open walk.
    """
    moment = instant(as_of)
    earliest = moment - timedelta(days=7)
    found = []
    for repo in repos:
        if repo not in PROJECTS:
            raise ValueError("GitHub metadata read failed")
        seen = {}
        page = 1
        while True:
            if page > max_pages:
                raise ValueError("incomplete pagination")
            path = "repos/%s/pulls?state=closed&sort=updated&direction=desc&per_page=%d&page=%d" % (
                repo, PER_PAGE, page)
            try:
                batch = read(path)
            except (OSError, TimeoutError, ValueError):
                raise ValueError("GitHub metadata read failed") from None
            if not isinstance(batch, list):
                raise ValueError("GitHub metadata read failed")
            for row in batch:
                if not isinstance(row, dict):
                    raise ValueError("GitHub metadata read failed")
                closed_at = row.get("closed_at")
                if isinstance(closed_at, str) and closed_at:
                    try:
                        closed_when = instant(closed_at)
                    except InvalidEvidence:
                        raise ValueError("GitHub metadata read failed") from None
                    if closed_when < earliest or closed_when > moment:
                        continue
                elif closed_at not in (None, ""):
                    raise ValueError("GitHub metadata read failed")
                item = scrub_pull(repo, row)
                if item["state"] not in {"closed", "merged"}:
                    raise ValueError("PR moved during collection")
                if item["number"] in seen:
                    raise ValueError("incomplete pagination")
                seen[item["number"]] = item
            if _page_is_older_than(batch, earliest):
                break
            if len(batch) < PER_PAGE:
                break
            page += 1
        found.extend(seen[number] for number in sorted(seen))
    return found


def list_closed_history(read, repos=REPOS, max_pages=MAX_PAGES):
    """Every closed pull request, newest update first. No date window and no silent cap.

    A short page ends a repository. Asking for a page past max_pages fails the
    walk instead of returning a shorter history. The caller compares a second
    walk, then checks the set again after activity is attached.
    """
    first = _walk_closed_history(read, repos, max_pages)
    second = _walk_closed_history(read, repos, max_pages)
    if _identity(first) != _identity(second):
        raise ValueError("PR moved during collection")
    return first


def confirm_history(read, records, repos=REPOS, max_pages=MAX_PAGES):
    """After close and reopen events are read, the closed set must still match."""
    again = _walk_closed_history(read, repos, max_pages)
    if _identity(again) != _identity(records):
        raise ValueError("PR moved during collection")


def _walk_closed_history(read, repos, max_pages):
    found = []
    for repo in repos:
        if repo not in PROJECTS:
            raise ValueError("GitHub metadata read failed")
        seen = {}
        page = 1
        while True:
            if page > max_pages:
                raise ValueError("incomplete pagination")
            path = "repos/%s/pulls?state=closed&sort=updated&direction=desc&per_page=%d&page=%d" % (
                repo, PER_PAGE, page)
            try:
                batch = read(path)
            except (OSError, TimeoutError, ValueError):
                raise ValueError("GitHub metadata read failed") from None
            if not isinstance(batch, list):
                raise ValueError("GitHub metadata read failed")
            for row in batch:
                item = scrub_pull(repo, row)
                if item["state"] not in {"closed", "merged"}:
                    raise ValueError("PR moved during collection")
                if item["number"] in seen:
                    raise ValueError("incomplete pagination")
                seen[item["number"]] = item
            if len(batch) < PER_PAGE:
                break
            page += 1
        found.extend(seen[number] for number in sorted(seen))
    return found


def _page_is_older_than(batch, earliest):
    """True when every row was last updated before the window.

    Sort is by updated time, newest first. updated_at is only this walk
    bound. Membership still uses closed_at. A single old closed_at does
    not stop the walk, because a later row on an updated-desc page can
    still have closed inside the window.
    """
    if not batch:
        return False
    for row in batch:
        updated = row.get("updated_at") if isinstance(row, dict) else None
        if not isinstance(updated, str) or not updated:
            return False
        try:
            when = instant(updated)
        except InvalidEvidence:
            return False
        if when >= earliest:
            return False
    return True


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
        review = {
            "state": state,
            "commit_id": commit_id,
            "submitted_at": submitted or "",
            "login": _login((row.get("user") or {}).get("login") if isinstance(row.get("user"), dict) else ""),
        }
        if type(row.get("id")) is int:
            review["id"] = row["id"]
        reviews.append(review)
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
        actor = row.get("actor")
        login = actor.get("login") if isinstance(actor, dict) else actor
        actor_name = _login(login) if isinstance(login, str) else ""
        events.append({
            "id": identifier,
            "event": kind,
            "created_at": when,
            "actor": actor_name or "unknown",
        })
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
        agreed = row.get("acknowledged") is True and _has_evidence(source) and bool(OPAQUE.fullmatch(source))
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
    priority, priority_state, priority_evidence = None, "unassessed", ""
    types, type_state = [], "unassessed"
    topic_state = "unassessed"
    salesforce = False
    for row in rows:
        evidence = row.get("evidence")
        evidenced = _has_evidence(evidence) and bool(OPAQUE.fullmatch(evidence))
        if row.get("priority") in PRIORITIES and evidenced and row.get("priority_state") == "assessed":
            priority, priority_state, priority_evidence = row["priority"], "assessed", evidence
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
        "priority_evidence": priority_evidence,
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
        if not _has_evidence(evidence) or not OPAQUE.fullmatch(evidence):
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
    """The latest dated observation wins. Order of the input rows does not."""
    proposed = record["proposed_head"]
    valid = []
    for row in rows:
        sha = row.get("sha")
        evidence = row.get("evidence")
        if not isinstance(sha, str) or not SHA.fullmatch(sha):
            continue
        if not _has_evidence(evidence) or not OPAQUE.fullmatch(evidence):
            continue
        observed = row.get("observed_at")
        when = None
        if isinstance(observed, str) and observed:
            try:
                when = instant(observed)
            except InvalidEvidence:
                return {"deployed_head": None, "deployed_state": "unknown", "runtime_accepted": False, "evidence": ""}
        elif observed not in (None, ""):
            return {"deployed_head": None, "deployed_state": "unknown", "runtime_accepted": False, "evidence": ""}
        valid.append((when, observed or "", sha, evidence))
    if not valid:
        return {"deployed_head": None, "deployed_state": "unknown", "runtime_accepted": False, "evidence": ""}
    dated = [item for item in valid if item[0] is not None]
    if dated and len(dated) != len(valid):
        return {"deployed_head": None, "deployed_state": "unknown", "runtime_accepted": False, "evidence": ""}
    if not dated:
        if len(valid) != 1:
            return {"deployed_head": None, "deployed_state": "unknown", "runtime_accepted": False, "evidence": ""}
        _when, _stamp, sha, evidence = valid[0]
    else:
        latest = max(item[0] for item in dated)
        winners = [item for item in dated if item[0] == latest]
        shas = {item[2] for item in winners}
        if len(shas) != 1:
            return {"deployed_head": None, "deployed_state": "unknown", "runtime_accepted": False, "evidence": ""}
        winners.sort(key=lambda item: item[3])
        _when, _stamp, sha, evidence = winners[0]
    state = "matches_proposed" if sha == proposed else "differs"
    return {"deployed_head": sha, "deployed_state": state, "runtime_accepted": False, "evidence": evidence}


def _role(acks, repo, number, role, requested=False):
    chosen = acks.get((repo, number, role))
    if chosen:
        return chosen["actor"], chosen["state"], chosen["source"]
    if requested and role == "reviewer":
        return "", "requested", ""
    return "", "unacknowledged", ""


def _days_open(current):
    if current.get("measured") and isinstance(current.get("days"), int):
        return str(current["days"])
    return UNASSESSED


def go_on_exact_head(record):
    """Yes only for an approval on the current head. A missing review list is unassessed."""
    reviews = record.get("reviews")
    if not isinstance(reviews, list):
        return UNASSESSED
    head = record.get("proposed_head")
    approvals = []
    blocking = []
    for review in reviews:
        if not isinstance(review, dict) or review.get("commit_id") != head:
            continue
        submitted = review.get("submitted_at") or ""
        if not submitted:
            continue
        if review.get("state") == "APPROVED":
            approvals.append(submitted)
        elif review.get("state") in {"CHANGES_REQUESTED", "DISMISSED"}:
            blocking.append(submitted)
    if not approvals:
        return "no"
    if blocking and max(blocking) > max(approvals):
        return "no"
    return "yes"


def assemble_glance(record, closure_actor, closure_state, stage, current):
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
        "days_open": _shown(_days_open(current)),
    }


def _persona(login):
    if not isinstance(login, str):
        return ""
    return OWNER_NAMES.get(login.strip().lower()) or ""


def _hour_label(hours):
    if hours is None:
        return UNKNOWN_TIME
    number = float(hours)
    if number.is_integer():
        return "%d h" % int(number)
    return "%.1f h" % number


def _blank_turnaround(author=""):
    return {
        "first_review": UNKNOWN_TIME,
        "review_to_close": UNKNOWN_TIME,
        "open_to_close": UNKNOWN_TIME,
        "first_review_hours": None,
        "review_to_close_hours": None,
        "open_to_close_hours": None,
        "first_review_at": "",
        "closed_at": "",
        "author_name": author if author in AGENT_ORDER else "",
        "reviewer_name": "",
    }


def _cycles(created_at, events, as_of):
    """Open cycles from close and reopen events. None when that history is missing."""
    if not isinstance(created_at, str) or not isinstance(events, list):
        return None
    try:
        moment = instant(as_of)
        opened = instant(created_at)
    except InvalidEvidence:
        return None
    if opened > moment:
        return None
    unique = {}
    for event in events:
        if not isinstance(event, dict):
            return None
        identifier = event.get("id")
        kind = event.get("event")
        when = event.get("created_at")
        if type(identifier) is not int or kind not in {"closed", "reopened"} or not isinstance(when, str):
            return None
        try:
            stamp = instant(when)
        except InvalidEvidence:
            return None
        current = {"id": identifier, "event": kind, "created_at": when}
        if identifier in unique and unique[identifier] != current:
            return None
        unique[identifier] = current
    ordered = []
    for event in unique.values():
        if instant(event["created_at"]) <= moment:
            ordered.append((event["created_at"], event["id"], event["event"]))
    ordered.sort()
    cycles = []
    start = created_at
    is_open = True
    for when, _identifier, kind in ordered:
        if kind == "closed":
            if not is_open:
                return None
            cycles.append({"open": start, "close": when})
            is_open = False
        else:
            if is_open:
                return None
            start = when
            is_open = True
    if is_open:
        cycles.append({"open": start, "close": None})
    return cycles


def _review_times(record, as_of):
    """Submitted reviews at or before as_of. None when the review list was not collected."""
    reviews = record.get("reviews")
    if not isinstance(reviews, list):
        return None
    try:
        moment = instant(as_of)
    except InvalidEvidence:
        return None
    found = []
    for review in reviews:
        if not isinstance(review, dict):
            return None
        if review.get("state") not in REVIEW_STATES:
            continue
        submitted = review.get("submitted_at") or ""
        if not isinstance(submitted, str) or not submitted:
            continue
        try:
            stamp = instant(submitted)
        except InvalidEvidence:
            return None
        if stamp <= moment:
            found.append((submitted, _login(review.get("login") or "")))
    found.sort()
    return found


def _seconds_between(start, end):
    seconds = int((instant(end) - instant(start)).total_seconds())
    if seconds < 0:
        return None
    return seconds


def turnaround_of(record, as_of):
    """First review, review to close, and open to close. Missing history is unknown.

    A reopen starts a new open interval. Time spent closed is not part of
    open-to-close. updated_at is not a timestamp here.
    """
    result = _blank_turnaround(_persona(record.get("author")))
    cycles = _cycles(record.get("created_at"), record.get("events"), as_of)
    if not cycles:
        return result
    state = record.get("state")
    if state == "open":
        if cycles[-1].get("close"):
            return result
        current = cycles[-1]
        completed = []
    elif state in {"closed", "merged"}:
        if not cycles[-1].get("close"):
            return result
        current = cycles[-1]
        completed = cycles
    else:
        return result
    reviews = _review_times(record, as_of)
    open_at = current["open"]
    close_at = current.get("close") or ""
    window_end = close_at or as_of
    chosen = None
    if reviews is not None:
        for submitted, login in reviews:
            if instant(submitted) < instant(open_at) or instant(submitted) > instant(window_end):
                continue
            chosen = (submitted, login)
            break
    if chosen:
        seconds = _seconds_between(open_at, chosen[0])
        if seconds is not None:
            result["first_review_hours"] = seconds // 3600
            result["first_review"] = _hour_label(result["first_review_hours"])
            result["first_review_at"] = chosen[0]
            persona = _persona(chosen[1])
            result["reviewer_name"] = persona if persona in AGENT_ORDER else ""
    if completed:
        total = 0
        for cycle in completed:
            seconds = _seconds_between(cycle["open"], cycle["close"])
            if seconds is None:
                total = None
                break
            total += seconds
        if total is not None:
            result["open_to_close_hours"] = total // 3600
            result["open_to_close"] = _hour_label(result["open_to_close_hours"])
            result["closed_at"] = completed[-1]["close"]
        if chosen and close_at:
            seconds = _seconds_between(chosen[0], close_at)
            if seconds is not None:
                result["review_to_close_hours"] = seconds // 3600
                result["review_to_close"] = _hour_label(result["review_to_close_hours"])
                result["closed_at"] = close_at
    for key in TURN_METRICS:
        if not isinstance(result[key], str) or not result[key].strip():
            result[key] = UNKNOWN_TIME
    return result


def trend_days(as_of):
    end = instant(as_of).date()
    return [(end - timedelta(days=6 - index)).isoformat() for index in range(7)]


def _median_label(samples):
    if not samples:
        return UNKNOWN_TIME
    return _hour_label(statistics.median(samples))


def daily_medians(items, as_of):
    """Median hours for each of the last seven UTC days, per repo and per agent."""
    days = trend_days(as_of)
    day_set = set(days)
    repos = [repo.split("/", 1)[1] for repo in REPOS]
    buckets = {}
    for metric in TURN_METRICS:
        buckets[metric] = {}
        for day in days:
            buckets[metric][day] = {
                "repos": {name: [] for name in repos},
                "author": {name: [] for name in AGENT_ORDER},
                "reviewer": {name: [] for name in AGENT_ORDER},
            }
    for item in items:
        turn = item.get("turnaround") if isinstance(item.get("turnaround"), dict) else {}
        repo = str(item.get("repo") or "").split("/", 1)[-1]
        author = turn.get("author_name") or ""
        reviewer = turn.get("reviewer_name") or ""
        placements = (
            ("first_review", turn.get("first_review_hours"), (turn.get("first_review_at") or "")[:10]),
            ("review_to_close", turn.get("review_to_close_hours"), (turn.get("closed_at") or "")[:10]),
            ("open_to_close", turn.get("open_to_close_hours"), (turn.get("closed_at") or "")[:10]),
        )
        for metric, hours, day in placements:
            if not isinstance(hours, int) or day not in day_set:
                continue
            slot = buckets[metric][day]
            if repo in slot["repos"]:
                slot["repos"][repo].append(hours)
            if author in slot["author"]:
                slot["author"][author].append(hours)
            if reviewer in slot["reviewer"]:
                slot["reviewer"][reviewer].append(hours)
    metrics = {}
    for metric in TURN_METRICS:
        metrics[metric] = {"repos": {}, "author": {}, "reviewer": {}}
        for name in repos:
            metrics[metric]["repos"][name] = [
                _median_label(buckets[metric][day]["repos"][name]) for day in days]
        for name in AGENT_ORDER:
            metrics[metric]["author"][name] = [
                _median_label(buckets[metric][day]["author"][name]) for day in days]
            metrics[metric]["reviewer"][name] = [
                _median_label(buckets[metric][day]["reviewer"][name]) for day in days]
    return {"days": days, "metrics": metrics}


def _event_rows(events):
    """Close and reopen events. A missing id or actor stays unknown. Authors are not actors."""
    if not isinstance(events, list):
        return "unknown"
    rows = []
    for event in events:
        if not isinstance(event, dict) or type(event.get("id")) is not int:
            return "unknown"
        if event.get("event") not in {"closed", "reopened"}:
            return "unknown"
        actor = event.get("actor")
        if not isinstance(actor, str) or not ACTOR.fullmatch(actor) or actor in SHARED_LOGINS:
            actor = "unknown"
        rows.append({
            "id": event["id"],
            "event": event["event"],
            "at": event.get("created_at") or "",
            "actor": actor,
        })
    return rows


def _waiting(record, as_of):
    """Waiting time starts at an evidenced waiting event. updated_at is never that start."""
    rows = record.get("waiting_events")
    if not isinstance(rows, list) or not rows:
        return {"measured": False, "hours": None, "label": UNKNOWN_TIME, "basis": "no_waiting_event"}
    starts = []
    for row in rows:
        if not isinstance(row, dict) or type(row.get("id")) is not int:
            return {"measured": False, "hours": None, "label": UNKNOWN_TIME, "basis": "missing_history"}
        if row.get("event") not in {"waiting", "review_requested"}:
            continue
        when = row.get("created_at")
        if not isinstance(when, str):
            return {"measured": False, "hours": None, "label": UNKNOWN_TIME, "basis": "missing_history"}
        try:
            instant(when)
        except InvalidEvidence:
            return {"measured": False, "hours": None, "label": UNKNOWN_TIME, "basis": "missing_history"}
        starts.append(when)
    if not starts:
        return {"measured": False, "hours": None, "label": UNKNOWN_TIME, "basis": "no_waiting_event"}
    try:
        age = _age(instant(min(starts)), instant(as_of), "waiting_event")
    except InvalidEvidence:
        return {"measured": False, "hours": None, "label": UNKNOWN_TIME, "basis": "missing_history"}
    return {"measured": True, "hours": age["hours"], "days": age["days"], "label": _hour_label(age["hours"]),
            "basis": "waiting_event"}


def _review_observation(record):
    """Exact head, observation time, and conflict. Equal timestamps with two states conflict."""
    reviews = record.get("reviews")
    head = record.get("proposed_head") or ""
    if not isinstance(reviews, list):
        return {"head": head, "observed_at": "", "state": "unknown", "conflict": "unknown"}
    on_head = []
    for review in reviews:
        if not isinstance(review, dict) or review.get("commit_id") != head:
            continue
        submitted = review.get("submitted_at") or ""
        state = review.get("state")
        if not submitted or state not in REVIEW_STATES or state == "COMMENTED":
            continue
        if state == "PENDING":
            continue
        on_head.append(review)
    if not on_head:
        return {"head": head, "observed_at": "", "state": "none", "conflict": "none"}
    latest = max(review.get("submitted_at") or "" for review in on_head)
    states = sorted({review.get("state") for review in on_head if review.get("submitted_at") == latest})
    if len(states) > 1:
        return {"head": head, "observed_at": latest, "state": "conflict", "conflict": "conflict"}
    return {"head": head, "observed_at": latest, "state": states[0], "conflict": "none"}


def _checks_observation(record, as_of):
    checks = record.get("checks")
    head = record.get("proposed_head") or ""
    if not isinstance(checks, list):
        return {"head": head, "observed_at": "", "state": "unknown"}
    required = record.get("required_checks") if isinstance(record.get("required_checks"), list) else []
    on_head = [check for check in checks if isinstance(check, dict) and check.get("head_sha") == head]
    failed = any(check.get("status") == "completed" and check.get("conclusion") in FAIL_CONCLUSIONS for check in on_head)
    if failed:
        return {"head": head, "observed_at": as_of, "state": "failed"}
    if required and all(
            any(check.get("name") == name and check.get("status") == "completed" and check.get("conclusion") == "success"
                for check in on_head)
            for name in required):
        return {"head": head, "observed_at": as_of, "state": "passed"}
    if any(check.get("status") != "completed" for check in on_head):
        return {"head": head, "observed_at": as_of, "state": "pending"}
    return {"head": head, "observed_at": as_of if on_head else "", "state": "unknown"}


def _access_observation(record):
    """Permission is unknown unless an observation says so. mergeable and assignees are not permission."""
    head = record.get("proposed_head") or ""
    observed = record.get("access")
    if not isinstance(observed, dict):
        return {"head": head, "observed_at": "", "state": "unknown"}
    state = observed.get("state")
    when = observed.get("observed_at")
    evidence = observed.get("evidence")
    if state not in {"allowed", "denied", "unknown"}:
        return {"head": head, "observed_at": "", "state": "unknown"}
    if not isinstance(when, str) or not _has_evidence(evidence) or not OPAQUE.fullmatch(evidence):
        return {"head": head, "observed_at": "", "state": "unknown"}
    try:
        instant(when)
    except InvalidEvidence:
        return {"head": head, "observed_at": "", "state": "unknown"}
    return {"head": head, "observed_at": when, "state": state}


def _has_evidence(value):
    """False for None, empty, and the sentinels unknown and unassessed."""
    if not isinstance(value, str):
        return False
    text = value.strip()
    return bool(text) and text.lower() not in {"unknown", "unassessed"}


def _opaque_or_blank(value):
    if not _has_evidence(value):
        return ""
    return value if OPAQUE.fullmatch(value) else ""


def _action_links(record):
    """Allowlisted links. A review link is the review anchor. A work id alone is not a task link."""
    repo, number = record["repo"], record["number"]
    pull = "https://github.com/%s/pull/%d" % (repo, number)
    review_link = UNASSESSED
    reviews = record.get("reviews") if isinstance(record.get("reviews"), list) else []
    for review in reviews:
        if not isinstance(review, dict) or review.get("commit_id") != record.get("proposed_head"):
            continue
        if type(review.get("id")) is int:
            review_link = "%s#pullrequestreview-%d" % (pull, review["id"])
            break
    fix = UNASSESSED
    fix_url = record.get("fix_url")
    if (_has_evidence(fix_url) and _has_evidence(record.get("fix_evidence"))
            and _opaque_or_blank(record.get("fix_evidence"))
            and re.fullmatch(r"https://github\.com/sfdc-24/(?:conference|Blackboard|sfdc24-site)/pull/[1-9][0-9]*/files", fix_url)):
        fix = fix_url
    work = UNASSESSED
    task_state = UNASSESSED
    task = record.get("task") if isinstance(record.get("task"), dict) else {}
    kind = task.get("kind")
    task_number = task.get("number")
    task_repo = task.get("repo") if task.get("repo") in PROJECTS else repo
    evidence = _opaque_or_blank(task.get("evidence")) if _has_evidence(task.get("evidence")) else ""
    work_id = task.get("work_id")
    if not _has_evidence(work_id):
        work_id = ""
    contradictory = isinstance(work_id, str) and work_id and (
        not isinstance(task_number, int) or str(task_number) not in work_id)
    if (task.get("state") == "assessed" and _has_evidence(evidence) and _has_evidence(kind)
            and kind in {"issue", "pr"} and type(task_number) is int and not contradictory):
        if kind == "issue":
            work = "https://github.com/%s/issues/%d" % (task_repo, task_number)
        else:
            work = "https://github.com/%s/pull/%d" % (task_repo, task_number)
        task_state = "assessed"
    elif task:
        task_state = "unresolved" if contradictory or work_id else UNASSESSED
    return {
        "pr": pull,
        "files": pull + "/files",
        "review": review_link,
        "fix": fix,
        "checks": pull + "/checks",
        "work": work,
        "task_state": task_state,
        "task_evidence": evidence or UNASSESSED,
    }


def _merge_gate(item, record, review, checks, access, dependencies_collected):
    """Every gate must be explicitly satisfied. Unknown or false is not MERGE."""
    if record.get("draft") is not False:
        return "draft"
    if record.get("mergeable") is not True:
        return "mergeable"
    if not isinstance(access, dict) or access.get("state") != "allowed":
        return "access"
    if record.get("state") != "open":
        return "state"
    if item.get("go_on_exact_head") != "yes":
        return "go"
    if review.get("conflict") != "none" or review.get("state") != "APPROVED":
        return "review"
    if checks.get("state") != "passed" or not _has_evidence(checks.get("state")):
        return "checks"
    if not _has_evidence(item.get("milestone")):
        return "milestone"
    if item.get("implementation_owner_state") != "acknowledged" or not _has_evidence(item.get("implementation_source")):
        return "owner"
    if not dependencies_collected:
        return "dependencies"
    if any(edge.get("state") == "assessed" for edge in item.get("blocked_by") or []):
        return "blocked"
    reviewer_ok = item.get("reviewer_state") == "acknowledged" or record.get("reviewer_policy") == "not_required"
    if record.get("reviewer_policy") == "required" and item.get("reviewer_state") != "acknowledged":
        reviewer_ok = False
    if not reviewer_ok:
        return "reviewer"
    return ""


def _advisory(item, record, review, checks, access, dependencies_collected):
    """MERGE, FIX, DEFER, or CLOSE. The word does not merge, push, or close anything."""
    case = record.get("closure_case") if isinstance(record.get("closure_case"), dict) else {}
    duplicated = case.get("duplication") is True or case.get("obsolete") is True
    replacement = _opaque_or_blank(case.get("replacement")) if _has_evidence(case.get("replacement")) else ""
    evidence = _opaque_or_blank(case.get("evidence")) if _has_evidence(case.get("evidence")) else ""
    rationale = case.get("rationale") if case.get("rationale") in {"duplicate", "obsolete"} and _has_evidence(case.get("rationale")) else ""
    if (duplicated and _has_evidence(replacement) and _has_evidence(evidence)
            and case.get("obligations_preserved") is True and rationale):
        return "CLOSE", "duplication_or_obsolescence"
    if review["conflict"] == "conflict" or review["state"] == "conflict":
        return "DEFER", "review_conflict"
    fix_review = review.get("state") == "CHANGES_REQUESTED" and _has_evidence(review.get("state"))
    fix_checks = checks.get("state") == "failed" and _has_evidence(checks.get("state"))
    if fix_review or fix_checks:
        return "FIX", "changes_or_checks"
    blocked = _merge_gate(item, record, review, checks, access, dependencies_collected)
    if not blocked:
        return "MERGE", "approval_checks_owner_milestone"
    if blocked == "checks" and item.get("go_on_exact_head") == "yes":
        return "DEFER", "checks_unknown" if checks.get("state") == "unknown" else "merge_evidence_incomplete"
    return "DEFER", blocked


def _action_row(record, item, dependencies_collected):
    review = _review_observation(record)
    checks = _checks_observation(record, item["as_of"])
    access = _access_observation(record)
    waiting = _waiting(record, item["as_of"])
    links = _action_links(record)
    action, basis = _advisory(item, record, review, checks, access, dependencies_collected)
    creation = item["creation_age"]
    if creation.get("measured") and isinstance(creation.get("hours"), int):
        age_hours, age_days = str(creation["hours"]), str(creation["days"])
    else:
        age_hours, age_days = UNKNOWN_TIME, UNKNOWN_TIME
    assessed = item.get("priority") if item.get("priority_state") == "assessed" and item.get("priority") in PRIORITIES else ""
    if dependencies_collected:
        if any(edge.get("state") == "assessed" for edge in item.get("blocked_by") or []):
            dependency_state = "blocked"
        elif item.get("blocked_by"):
            dependency_state = "unverified"
        else:
            dependency_state = "clear"
    else:
        dependency_state = "unknown"
    owner_actor = item.get("implementation_owner") if item.get("implementation_owner_state") == "acknowledged" else ""
    return {
        "id": item["id"],
        "repo": item["repo"],
        "number": item["number"],
        "display_priority": item["glance"]["priority"],
        "assessed_priority": assessed or UNASSESSED,
        "priority_evidence": item.get("priority_evidence") or UNASSESSED,
        "owner": OWNER_NAMES.get(owner_actor or "", UNASSESSED) if owner_actor else UNASSESSED,
        "owner_state": item.get("implementation_owner_state") or UNASSESSED,
        "owner_source": item.get("implementation_source") or UNASSESSED,
        "reviewer": item.get("reviewer") or UNASSESSED,
        "reviewer_state": item.get("reviewer_state") or UNASSESSED,
        "reviewer_source": item.get("reviewer_source") or UNASSESSED,
        "closure_source": item.get("closure_source") or UNASSESSED,
        "next_action": action,
        "recommendation_basis": basis,
        "recommendations_execute": False,
        "age_hours": age_hours,
        "age_days": age_days,
        "waiting": waiting["label"],
        "waiting_basis": waiting["basis"],
        "blocks": item["glance"]["blocks"],
        "blocked_by": item["glance"]["blocked_by"],
        "block_edges": list(item.get("blocks") or []),
        "blocked_edges": list(item.get("blocked_by") or []),
        "head": item["proposed_head"],
        "review_observed_at": review["observed_at"],
        "review_state": review["state"],
        "checks_observed_at": checks["observed_at"],
        "checks_state": checks["state"],
        "conflict_state": review["conflict"],
        "dependency_state": dependency_state,
        "dependency_observed_at": item["as_of"] if dependencies_collected else "",
        "access_state": access["state"],
        "access_observed_at": access["observed_at"],
        "links": links,
        "closure_events": _event_rows(record.get("events")),
    }


def _history_row(record):
    state = record.get("state")
    disposition = "merged" if state == "merged" else "closed_unmerged" if state == "closed" else "unknown"
    merged_commit = record.get("merged_commit") if _sha_or_blank(record.get("merged_commit")) else UNKNOWN_TIME
    if merged_commit != UNKNOWN_TIME:
        merged_commit = record["merged_commit"]
    else:
        merged_commit = "unknown"
    head_at_close = record["head_at_close"] if _sha_or_blank(record.get("head_at_close")) else "unknown"
    case = record.get("closure_case") if isinstance(record.get("closure_case"), dict) else {}
    rationale = case.get("rationale") if case.get("rationale") in {"duplicate", "obsolete"} and _has_evidence(case.get("evidence")) and _opaque_or_blank(case.get("evidence")) else "unknown"
    replacement = case.get("replacement") if _has_evidence(case.get("replacement")) and _opaque_or_blank(case.get("replacement")) else "unknown"
    return {
        "repo": record["repo"],
        "number": record["number"],
        "id": "%s#%d" % (record["repo"], record["number"]),
        "disposition": disposition,
        "events": _event_rows(record.get("events")),
        "merged_commit": merged_commit if disposition == "merged" else "unknown",
        "head_at_close": head_at_close,
        "closure_rationale": rationale,
        "replacement": replacement,
    }


def _sample_30(rows, as_of):
    """A 30-day turnaround sample. It is not the seven-day median and not the full history."""
    moment = instant(as_of)
    earliest = moment - timedelta(days=30)
    count = 0
    for row in rows:
        events = row.get("events")
        if not isinstance(events, list):
            continue
        for event in events:
            if event.get("event") != "closed":
                continue
            try:
                when = instant(event.get("at") or "")
            except InvalidEvidence:
                continue
            if earliest <= when <= moment:
                count += 1
                break
    return {"window_days": 30, "count": count, "label": "30-day sample"}


def _closed_history(items, history_records, as_of):
    open_count = len(items)
    if history_records is None:
        return {
            "coverage": "not_collected",
            "freshness": as_of,
            "rows": [],
            "open": open_count,
            "merged": None,
            "closed_unmerged": None,
            "truncated": False,
            "turnaround_sample_30d": {"window_days": 30, "count": None, "label": "30-day sample"},
        }
    rows = [_history_row(record) for record in history_records]
    rows.sort(key=lambda row: (row["repo"], row["number"]))
    merged = sum(1 for row in rows if row["disposition"] == "merged")
    unmerged = sum(1 for row in rows if row["disposition"] == "closed_unmerged")
    return {
        "coverage": "complete",
        "freshness": as_of,
        "rows": rows,
        "open": open_count,
        "merged": merged,
        "closed_unmerged": unmerged,
        "truncated": False,
        "turnaround_sample_30d": _sample_30(rows, as_of),
    }


def project_record(record, as_of, acknowledgments, assessments, dependencies, deployed, dependencies_collected=False):
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
    glance = assemble_glance(record, closure_actor, closure_state, stage, current)
    go_flag = go_on_exact_head(record)
    turnaround = turnaround_of(record, as_of)
    item = {
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
        "owner": glance["owner"],
        "milestone": _shown(record.get("milestone")),
        "go_on_exact_head": go_flag if go_flag in {"yes", "no", UNASSESSED} else UNASSESSED,
        "glance": glance,
        "turnaround": turnaround,
        "priority_evidence": assessed.get("priority_evidence") or "",
    }
    item["action"] = _action_row(record, item, dependencies_collected)
    return item


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


def build_generation(records, as_of, acknowledgments=None, assessments=None, dependencies=None, deployed=None,
                     closed_records=None, history_records=None):
    instant(as_of)
    acks = _index_acks(acknowledgments)
    assessed = _index_by_id(assessments, ("priority", "priority_state", "types", "type_state", "topic", "topic_state", "evidence"))
    delivered = _index_by_id(deployed, ("sha", "evidence", "observed_at"))
    collected = dependencies is not None
    items = [project_record(record, as_of, acks, assessed, dependencies, delivered, collected) for record in records]
    items.sort(key=lambda item: (item["repo"], item["number"]))
    closed_items = [project_record(record, as_of, acks, assessed, dependencies, delivered, collected)
                    for record in (closed_records or [])]
    closed_items.sort(key=lambda item: (item["repo"], item["number"]))
    _assert_metadata({"items": items, "closed": closed_items})
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
        "turnaround_trend": daily_medians(items + closed_items, as_of),
        "public_turnaround_trend": daily_medians(
            [item for item in items + closed_items if item.get("repo") in PUBLIC_AUDIENCE], as_of),
        "closed_turnaround": [{
            "id": item["id"],
            "first_review": item["turnaround"]["first_review"],
            "review_to_close": item["turnaround"]["review_to_close"],
            "open_to_close": item["turnaround"]["open_to_close"],
        } for item in closed_items],
        "closed_history": _closed_history(items, history_records, as_of),
        "action_audience": "private",
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
        "go_head": item["go_on_exact_head"],
        "milestone": item["milestone"],
        "t_first": item["turnaround"]["first_review"],
        "t_review": item["turnaround"]["review_to_close"],
        "t_open": item["turnaround"]["open_to_close"],
    }


def _assert_put_bound(mapping):
    """Refuse a hash over 50 fields or 2048 UTF-8 bytes before it is written."""
    if not isinstance(mapping, dict) or not mapping:
        raise InvalidEvidence("governed value exceeds 2048 bytes")
    if len(mapping) > MAX_PUT_FIELDS:
        raise InvalidEvidence("governed hash exceeds 50 fields")
    if any(not isinstance(name, str) or not isinstance(value, str) for name, value in mapping.items()):
        raise InvalidEvidence("governed hash values must be strings")
    encoded = json.dumps(mapping, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    if len(encoded.encode("utf-8")) > MAX_VALUE_BYTES:
        raise InvalidEvidence("governed value exceeds 2048 bytes")


def _mapping(fields):
    # Longer than the governed preview, so a preview read cannot equal a full read.
    fields = dict(fields, witness="readback-" + ("0" * 220))
    _assert_put_bound(fields)
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
        payload = json.dumps({
            "count": rollup["count"],
            "project": rollup["project"],
            "queue_owners": rollup["queue_owners"],
            "stages": rollup["stages"],
        }, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
        documents.append((prefix + ":repo:" + repo_key(repo), _mapping({
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
        "advisory": "0",
        "as_of": generation["as_of"],
        "complete": "1",
        "generation": generation["id"],
        "meta": meta_payload,
        "principal": "cursor",
        "sha256": hashlib.sha256(meta_payload.encode("utf-8")).hexdigest(),
    })))
    trend = generation.get("turnaround_trend") or {}
    for metric in TURN_METRICS:
        payload = json.dumps({
            "days": trend.get("days") or [],
            "metric": metric,
            "values": (trend.get("metrics") or {}).get(metric) or {},
        }, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
        documents.append((prefix + ":turn:" + metric, _mapping({
            "generation": generation["id"],
            "metric": metric,
            "sha256": hashlib.sha256(payload.encode("utf-8")).hexdigest(),
            "trend": payload,
        })))
    documents.extend(_detail_documents(prefix, generation, "action", _action_payload(generation)))
    documents.extend(_detail_documents(prefix, generation, "closed", _closed_payload(generation)))
    item_shards = sum(1 for key, _mapping_value in documents if ":i:" in key)
    action_shards = sum(1 for key, _mapping_value in documents if ":action:" in key)
    closed_shards = sum(1 for key, _mapping_value in documents if ":closed:" in key)
    checked = []
    for key, mapping in documents:
        if key.endswith(":meta"):
            mapping = _mapping(dict(
                mapping,
                item_shards=str(item_shards),
                action_shards=str(action_shards),
                closed_shards=str(closed_shards),
                schema_version="1",
            ))
        checked.append((key, mapping))
    documents = checked
    for key, _mapping_value in documents:
        if (not key.startswith(NAMESPACE) or key.startswith("proj:milestones:")
                or key.startswith("pr:") or "/" in key):
            raise InvalidEvidence("PR board key is outside proj:pr-board:v1:")
    return documents


def _action_payload(generation):
    rows = []
    for item in generation.get("items") or []:
        action = item.get("action")
        if isinstance(action, dict):
            rows.append(action)
    return {"audience": "private", "schema_version": 1, "rows": rows}


def _closed_payload(generation):
    history = generation.get("closed_history") if isinstance(generation.get("closed_history"), dict) else {}
    return {
        "audience": "private",
        "schema_version": 1,
        "coverage": history.get("coverage") or "not_collected",
        "freshness": history.get("freshness") or "",
        "open": history.get("open"),
        "merged": history.get("merged"),
        "closed_unmerged": history.get("closed_unmerged"),
        "truncated": False,
        "turnaround_sample_30d": history.get("turnaround_sample_30d") or {},
        "rows": list(history.get("rows") or []),
    }


def _detail_documents(prefix, generation, kind, payload):
    """Bounded private chunks. Content is validated before it is stored. Nothing is truncated."""
    _assert_metadata(payload)
    raw = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    if len(raw.encode("utf-8")) > MAX_RECONSTRUCTED_BYTES:
        raise InvalidEvidence("reconstructed generation exceeds the bound")
    rows = payload.get("rows") if isinstance(payload.get("rows"), list) else []
    envelope = {key: value for key, value in payload.items() if key != "rows"}

    def pack(buf):
        piece = dict(envelope, rows=buf)
        encoded = json.dumps(piece, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
        return _mapping({
            "audience": "private",
            "generation": generation["id"],
            "kind": kind,
            "rows": encoded,
            "schema_version": "1",
            "seq": "0",
            "sha256": hashlib.sha256(encoded.encode("utf-8")).hexdigest(),
        })

    shards = []
    bucket = []
    for row in rows:
        trial = bucket + [row]
        try:
            pack(trial)
        except InvalidEvidence:
            if not bucket:
                raise InvalidEvidence("one %s row exceeds the governed value cap" % kind) from None
            shards.append(bucket)
            bucket = [row]
            pack(bucket)
        else:
            bucket = trial
    if bucket or not shards:
        shards.append(bucket)
    documents = []
    for seq, buf in enumerate(shards):
        mapping = pack(buf)
        mapping["seq"] = str(seq)
        documents.append((prefix + ":" + kind + ":" + str(seq), mapping))
    return documents


def _previewed(expected, got):
    if not isinstance(got, dict):
        return False
    for key, value in expected.items():
        seen = got.get(key)
        if isinstance(value, str) and isinstance(seen, str) and seen != value and seen == value[:PREVIEW_CHARS] + "...":
            return True
    return False


def write_generation(generation, put, read_full, extra_documents=None, manifest_binding=None):
    """Write every shard, read the full values back, then move the advisory head.

    put(key, mapping) follows redis_gov hput's result shape. read_full must
    return the stored strings. A governed preview is not acceptance. The head
    key is advisory and is not a compare-and-swap. A public route is refused
    before any put.
    """
    if getattr(put, "accepts_private", True) is False:
        raise InvalidEvidence("private generation cannot use a public route")
    documents = list(redis_documents(generation))
    _assert_manifest_bound(documents)
    documents.extend(extra_documents or [])
    documents_by_key = dict(documents)
    head = read_full(HEAD_KEY)
    previous = head.get("generation") if isinstance(head, dict) else None

    def stale(reason, wrote_head=False, head_retained=True, head_write=None):
        result = {"status": "stale", "reason": reason, "items": None, "previous_head": previous,
                  "wrote_head": wrote_head, "generation_id": generation["id"],
                  "head_retained": head_retained}
        if head_write is not None:
            result["head_write"] = head_write
        return result

    try:
        existing_by_key = {key: read_full(key) for key in documents_by_key}
    except TimeoutError:
        return stale("timeout")
    named = (isinstance(head, dict) and head.get("generation") == generation["id"]
             and head.get("advisory") == "1")
    root_ok = True
    if manifest_binding:
        root_ok = (isinstance(head, dict)
                   and head.get("manifest_root") == manifest_binding.get("manifest_root")
                   and head.get("page_count") == manifest_binding.get("page_count")
                   and head.get("listed") == manifest_binding.get("listed"))
    if all(existing_by_key[key] == mapping for key, mapping in documents_by_key.items()):
        if named and root_ok:
            return {"status": "replay", "reason": "generation_present", "items": generation["items"],
                    "previous_head": previous, "wrote_head": False, "generation_id": generation["id"],
                    "read_back": "full"}
    # A generation is never rewritten after its head names that generation id.
    if named:
        return stale("immutable_generation")
    for key, mapping in documents_by_key.items():
        got = existing_by_key[key]
        if got not in (None, {}) and got != mapping:
            return stale("immutable_conflict")
    head_fields = {"advisory": "1", "complete": "1", "generation": generation["id"]}
    if manifest_binding:
        head_fields.update(manifest_binding)
    head_mapping = _mapping(head_fields)
    _assert_governed_key(HEAD_KEY)
    _assert_governed_fields(head_mapping)
    for key, mapping in documents_by_key.items():
        _assert_governed_key(key)
        _assert_governed_fields(mapping)
        _assert_put_bound(mapping)
    _assert_put_bound(head_mapping)
    for key, mapping in documents_by_key.items():
        try:
            result = put(key, mapping)
        except TimeoutError:
            return stale("timeout")
        if not isinstance(result, dict) or not result.get("ok") or result.get("partial"):
            reason = "audit_failed" if isinstance(result, dict) and result.get("partial") else "partial_write"
            return stale(reason)
    try:
        for key, mapping in documents_by_key.items():
            got = read_full(key)
            if _previewed(mapping, got):
                return stale("preview_readback")
            if got != mapping:
                return stale("readback_mismatch")
    except TimeoutError:
        return stale("timeout")
    try:
        result = put(HEAD_KEY, head_mapping)
    except TimeoutError:
        return stale("head_audit_uncertain", head_retained=False)
    if not isinstance(result, dict) or not result.get("ok") or result.get("partial"):
        try:
            confirmed = read_full(HEAD_KEY)
        except TimeoutError:
            return stale("head_audit_uncertain", head_retained=False)
        if confirmed == head_mapping:
            return stale("head_audit_uncertain", wrote_head=True, head_retained=False)
        if confirmed == head:
            return stale("head_unmoved")
        return stale("head_audit_uncertain", head_retained=False)
    head_state = {"attempted": True, "written": True, "confirmed": False, "audited": False}
    try:
        confirmed = read_full(HEAD_KEY)
    except TimeoutError:
        return stale("head_readback_timeout", wrote_head=None, head_retained="unknown",
                     head_write=head_state)
    if confirmed != head_mapping:
        retained = True if confirmed == head else "unknown"
        landed = False if confirmed == head else None
        return stale("preview_readback" if _previewed(head_mapping, confirmed) else "head_readback_mismatch",
                     wrote_head=landed, head_retained=retained, head_write=head_state)
    head_state = {"attempted": True, "written": True, "confirmed": True, "audited": True}
    return {"status": "complete", "reason": "read_back", "items": generation["items"],
            "previous_head": previous, "wrote_head": True, "generation_id": generation["id"],
            "advisory_head": True, "read_back": "full", "head_write": head_state,
            "head_retained": False}


def canonical_text(mapping):
    """NFC compact JSON of one hash. The digest is the SHA-256 of these UTF-8 bytes.

    Field names and values are strict text. Two names that collapse to one NFC
    name are refused. This is the same byte string as the verifier's canonical
    form: sorted keys, compact separators, and no ASCII escaping.
    """
    if not isinstance(mapping, dict) or not mapping:
        raise InvalidEvidence("audit hash is not complete")
    normalized = {}
    for name, value in mapping.items():
        if not isinstance(name, str) or not isinstance(value, str):
            raise InvalidEvidence("audit hash is not complete")
        folded_name = unicodedata.normalize("NFC", name)
        if folded_name in normalized:
            raise InvalidEvidence("audit hash is not complete")
        normalized[folded_name] = unicodedata.normalize("NFC", value)
    return json.dumps(normalized, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def canonical_hash_digest(mapping):
    """SHA-256 and byte length of one whole hash, including sha256 and witness."""
    raw = canonical_text(mapping).encode("utf-8")
    return hashlib.sha256(raw).hexdigest(), len(raw)


def inventory_manifest(specs):
    """Paged haudit manifest. Its UTF-8 length is the 65536-byte bound.

    ``{"pages":[{"index":n,"keys":{name:{"len":n,"sha256":hex}}}]}`` with
    sorted object keys, compact separators, and pages of 8 in key order.
    This is the inventory blob. The flat ``{"keys"}`` body is measured too.
    """
    names = sorted(specs)
    pages = []
    for index, start in enumerate(range(0, len(names), MANIFEST_PAGE_SIZE)):
        chunk = names[start:start + MANIFEST_PAGE_SIZE]
        pages.append({
            "index": index,
            "keys": {name: {"len": int(specs[name]["len"]), "sha256": specs[name]["sha256"]}
                     for name in chunk},
        })
    return json.dumps({"pages": pages}, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=False).encode("utf-8")


def manifest_lengths(documents):
    """Flat manifest bytes, then paged inventory bytes."""
    specs = _specs(_listed_entries(documents))
    return len(manifest_body(specs)), len(inventory_manifest(specs))


def _assert_manifest_bound(documents):
    """Refuse before any Redis read when a measured manifest exceeds 65536 bytes.

    65536 bytes is inside the cap. 65537 is refused. The check is the byte
    length of the keys form and the pages form, not a 512-document count.
    """
    flat_n, paged_n = manifest_lengths(documents)
    if flat_n > MAX_MANIFEST_BYTES or paged_n > MAX_MANIFEST_BYTES:
        raise InvalidEvidence("manifest exceeds the 65536 byte bound")
    if len(documents) > MAX_GENERATION_DOCUMENTS:
        raise InvalidEvidence("generation exceeds the generation ceiling")


def manifest_body(specs):
    """Canonical UTF-8 of {"keys": {name: {"len": n, "sha256": hex}}}.

    len sorts before sha256. The head key is not a member. This is the manifest
    digest's preimage.
    """
    keys = {name: {"len": int(specs[name]["len"]), "sha256": specs[name]["sha256"]}
            for name in specs}
    return json.dumps({"keys": keys}, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=False).encode("utf-8")


def report_body(specs):
    """One line per generation document, excluding the head: key, sha256, len.

    Lines are sorted by key and separated by newlines. There is no status
    column. The writer and the verifier hash these same bytes.
    """
    lines = ["%s\t%s\t%d" % (name, specs[name]["sha256"], int(specs[name]["len"]))
             for name in sorted(specs)]
    return "\n".join(lines).encode("utf-8")


def _audit_report(lines):
    specs = {}
    for row in lines:
        specs[row[0]] = {"sha256": row[1], "len": int(row[2])}
    raw = report_body(specs)
    return hashlib.sha256(raw).hexdigest(), len(raw)


def _listed_entries(documents):
    entries = []
    for key, mapping in documents:
        digest, length = canonical_hash_digest(mapping)
        entries.append((key, digest, length))
    entries.sort(key=lambda row: row[0])
    return entries


def _specs(entries):
    return {key: {"sha256": digest, "len": length} for key, digest, length in entries}


def page_entries_text(chunk):
    """Compact JSON array for one manifest page. Object keys sort as key, len, sha256."""
    return json.dumps(
        [{"key": key, "len": length, "sha256": sha} for key, sha, length in chunk],
        sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def manifest_root_body(page_digests, listed):
    """UTF-8 preimage of the manifest root.

    ``{"listed": <int>, "page_count": <int>, "pages": ["<64 hex>", ...]}``
    with sorted object keys and compact separators. ``pages`` stays in index
    order 0..N-1 and is not sorted again. ``page_count`` is the length of
    that array. The generation id and the head are not members. The head
    stores the SHA-256 of this text, plus decimal ``listed`` and
    ``page_count``. The preimage itself is not one Redis hash: a 41-page
    root is larger than the 2048-byte hput cap, and that cap does not rise.
    """
    digests = list(page_digests)
    body = {"listed": int(listed), "page_count": len(digests), "pages": digests}
    return json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def paged_root(entries, page_size):
    """Page digests and the root over them. entries are (key, sha256, len)."""
    if not isinstance(page_size, int) or isinstance(page_size, bool) or page_size < 1:
        raise InvalidEvidence("manifest page size is not fixed")
    if len(entries) > MAX_GENERATION_DOCUMENTS:
        raise InvalidEvidence("generation exceeds the generation ceiling")
    pages = []
    ordered = list(entries)
    page_count = max(1, (len(ordered) + page_size - 1) // page_size) if ordered else 1
    for seq in range(page_count):
        chunk = ordered[seq * page_size:(seq + 1) * page_size]
        text = page_entries_text(chunk)
        raw = text.encode("utf-8")
        pages.append({"text": text, "sha256": hashlib.sha256(raw).hexdigest(), "len": len(raw)})
    root_raw = manifest_root_body([page["sha256"] for page in pages], len(ordered))
    return {
        "pages": pages,
        "page_count": len(pages),
        "listed": len(ordered),
        "root_text": root_raw.decode("utf-8"),
        "root_sha256": hashlib.sha256(root_raw).hexdigest(),
        "root_len": len(root_raw),
    }


def _union_listed(page_rows):
    """Indexes 0..N-1, no missing page, no key on two pages."""
    seen = set()
    listed = []
    for seq, rows in enumerate(page_rows):
        if rows is None:
            raise InvalidEvidence("manifest page gap")
        if not isinstance(rows, list):
            raise InvalidEvidence("manifest page gap")
        if seq < len(page_rows) - 1 and len(rows) != MANIFEST_PAGE_SIZE:
            raise InvalidEvidence("manifest page gap")
        for row in rows:
            if not isinstance(row, dict) or set(row) != {"key", "len", "sha256"}:
                raise InvalidEvidence("manifest page gap")
            key = row["key"]
            if not isinstance(key, str) or key in seen or key == HEAD_KEY or ":manifest:" in key:
                raise InvalidEvidence("manifest key repeated")
            seen.add(key)
            listed.append((key, row["sha256"], row["len"]))
    return listed


def manifest_pages(generation_id, documents):
    """Private fixed-size pages for one generation. Pages are an index, not listed documents.

    The workload is paged: MANIFEST_PAGE_SIZE entries per page, indexes 0..N-1,
    at most MAX_GENERATION_DOCUMENTS documents. The last page may be short. A
    generation over that cap is refused. This is not a one-page cap.
    """
    if len(documents) > MAX_GENERATION_DOCUMENTS:
        raise InvalidEvidence("generation exceeds the generation ceiling")
    entries = _listed_entries(documents)
    digest = hashlib.sha256(manifest_body(_specs(entries))).hexdigest()
    rooted = paged_root(entries, MANIFEST_PAGE_SIZE)
    page_count = rooted["page_count"]
    if page_count > MAX_MANIFEST_PAGES:
        raise InvalidEvidence("generation exceeds the generation ceiling")
    prefix = private_prefix(generation_id)
    pages = []
    for seq, page in enumerate(rooted["pages"]):
        pages.append((prefix + "manifest:" + str(seq), _mapping({
            "audience": "private",
            "entries": page["text"],
            "generation": generation_id,
            "manifest_sha256": digest,
            "page": str(seq),
            "pages": str(page_count),
            "sha256": page["sha256"],
        })))
    binding = {
        "manifest_root": rooted["root_sha256"],
        "page_count": str(page_count),
        "listed": str(len(entries)),
    }
    return pages, binding


def _receipt_result(generation_id="", partial=True, scope="generation", page_ok=False, ok=False,
                    report="", manifest="", root="", listed=0, page_count=0, read_back="unknown",
                    reason="readback_unknown"):
    """Counts and digests only. The local receipt does not publish.

    page_ok means every page read in this receipt verified. A full receipt
    has page_ok and ok. One page has page_ok and not ok.
    """
    ident = generation_id if isinstance(generation_id, str) and re.fullmatch(r"[0-9a-f]{64}", generation_id) else ""
    verified_pages = bool(page_ok) and not partial
    full_ok = verified_pages and scope == "generation" and bool(ok)
    if full_ok:
        shown = "full"
    elif verified_pages and scope == "page":
        shown = "page"
    else:
        shown = "unknown"
    return {
        "ok": full_ok,
        "page_ok": verified_pages,
        "partial": bool(partial),
        "scope": "page" if scope == "page" else "generation",
        "generation": ident,
        "report_digest": report if isinstance(report, str) else "",
        "report_sha256": report if isinstance(report, str) else "",
        "manifest_digest": manifest if isinstance(manifest, str) else "",
        "root_digest": root if isinstance(root, str) else "",
        "listed": int(listed),
        "page_count": int(page_count),
        "read_back": shown,
        "public_publish": False,
        "reason": "match" if full_ok else reason,
    }


def _receipt_failed(generation_id="", partial=True):
    return _receipt_result(generation_id, partial=partial)


def _load_manifest_page(page, generation_id, manifest_sha, seq, page_count, expect_text):
    if not isinstance(page, dict) or page.get("audience") != "private":
        return None
    if page.get("generation") != generation_id or page.get("manifest_sha256") != manifest_sha:
        return None
    if page.get("page") != str(seq) or page.get("pages") != str(page_count):
        return None
    raw_entries = page.get("entries")
    if not isinstance(raw_entries, str) or raw_entries != expect_text:
        return None
    if hashlib.sha256(raw_entries.encode("utf-8")).hexdigest() != page.get("sha256"):
        return None
    parsed = json.loads(raw_entries)
    if not isinstance(parsed, list) or len(parsed) > MANIFEST_PAGE_SIZE:
        return None
    return parsed


def writer_receipt(generation, read_full, list_keys=None, page=None):
    """Receipt for one private generation. Counts and digests only.

    This is the watched verifier port of Blackboard ``haudit`` at
    ``VERIFIER_SHA``. The shared cross-check vector proves the digest bytes.
    The head is read first. Its generation id, manifest root, listed count,
    and page count must match before any page or document is read. The head
    is read again after every manifest page, including page 0, after every
    batch of at most ``MAX_AUDIT_BATCH`` documents, and once more at the end.
    A head change at any of those points is not ok. page_ok means every page
    read in this receipt verified. One page returns page_ok and ok false.
    A full receipt returns page_ok and ok. Full ok requires pages 0..N-1,
    no gaps, no repeated key, and that final head revalidation. This local
    receipt does not publish and does not mark ACTION ready. There is no
    keyspace scan.
    """
    if list_keys is not None:
        raise InvalidEvidence("receipt does not scan keys")
    generation_id = ""
    try:
        if not isinstance(generation, dict):
            return _receipt_failed()
        generation_id = str(generation.get("id") or "")
        if not re.fullmatch(r"[0-9a-f]{64}", generation_id):
            return _receipt_failed()
        if page is not None and (isinstance(page, bool) or not isinstance(page, int) or page < 0):
            return _receipt_failed(generation_id)
        head = read_full(HEAD_KEY)
        if not isinstance(head, dict) or head.get("generation") != generation_id or head.get("advisory") != "1":
            return _receipt_failed(generation_id)
        documents = list(redis_documents(generation))
        if len(documents) > MAX_GENERATION_DOCUMENTS:
            return _receipt_failed(generation_id)
        expected = _listed_entries(documents)
        specs = _specs(expected)
        manifest_raw = manifest_body(specs)
        manifest_sha = hashlib.sha256(manifest_raw).hexdigest()
        rooted = paged_root(expected, MANIFEST_PAGE_SIZE)
        if (head.get("manifest_root") != rooted["root_sha256"]
                or head.get("page_count") != str(rooted["page_count"])
                or head.get("listed") != str(rooted["listed"])):
            return _receipt_failed(generation_id, partial=True)
        if rooted["page_count"] > MAX_MANIFEST_PAGES:
            return _receipt_failed(generation_id)
        prefix = private_prefix(generation_id)

        def same_head():
            again = read_full(HEAD_KEY)
            return again == head

        if page is not None:
            if page >= rooted["page_count"]:
                return _receipt_failed(generation_id)
            got = read_full(prefix + "manifest:" + str(page))
            parsed = _load_manifest_page(
                got, generation_id, manifest_sha, page, rooted["page_count"], rooted["pages"][page]["text"])
            if parsed is None or not same_head():
                return _receipt_result(
                    generation_id, partial=True, scope="page", page_ok=False,
                    manifest=manifest_sha, root=rooted["root_sha256"],
                    listed=rooted["listed"], page_count=rooted["page_count"])
            return _receipt_result(
                generation_id, partial=False, scope="page", page_ok=True, ok=False,
                manifest=manifest_sha, root=rooted["root_sha256"],
                listed=rooted["listed"], page_count=rooted["page_count"], reason="page")
        parsed_pages = []
        for seq in range(rooted["page_count"]):
            got = read_full(prefix + "manifest:" + str(seq))
            if not same_head():
                return _receipt_failed(generation_id)
            parsed = _load_manifest_page(
                got, generation_id, manifest_sha, seq, rooted["page_count"], rooted["pages"][seq]["text"])
            if parsed is None:
                return _receipt_failed(generation_id)
            parsed_pages.append(parsed)
        listed = _union_listed(parsed_pages)
        if listed != expected:
            return _receipt_failed(generation_id)
        by_key = dict(documents)
        lines = []
        ok = True
        for start in range(0, len(listed), MAX_AUDIT_BATCH):
            for key, digest, length in listed[start:start + MAX_AUDIT_BATCH]:
                mapping = by_key[key]
                got = read_full(key)
                if not isinstance(got, dict) or not got:
                    lines.append((key, digest, length, "missing"))
                    ok = False
                    continue
                if _previewed(mapping, got) or got != mapping:
                    lines.append((key, digest, length, "changed"))
                    ok = False
                    continue
                got_sha, got_len = canonical_hash_digest(got)
                if (got_sha, got_len) != (digest, length):
                    lines.append((key, got_sha, got_len, "changed"))
                    ok = False
                    continue
                lines.append((key, got_sha, got_len, "match"))
            if not same_head():
                return _receipt_failed(generation_id)
        if not same_head():
            return _receipt_failed(generation_id)
        report_sha, _report_len = _audit_report(lines)
        if not ok:
            return _receipt_result(
                generation_id, partial=False, ok=False, page_ok=True, report=report_sha,
                manifest=manifest_sha, root=rooted["root_sha256"],
                listed=len(listed), page_count=rooted["page_count"])
        return _receipt_result(
            generation_id, partial=False, ok=True, page_ok=True, report=report_sha,
            manifest=manifest_sha, root=rooted["root_sha256"],
            listed=len(listed), page_count=rooted["page_count"], read_back="full")
    except (TimeoutError, OSError, ValueError, TypeError, InvalidEvidence, UnicodeError, json.JSONDecodeError):
        return _receipt_failed(generation_id)


def audit_private_readback(generation, read_full, list_keys=None):
    """Writer receipt. list_keys is refused: a receipt does not scan the keyspace."""
    return writer_receipt(generation, read_full, list_keys=list_keys)


def shared_contract_vector():
    """Cross-check vector. Generation id is 64 zeros and is not a digest byte.

    Documents are the two hashes themselves. The report has no head line and
    no status column. The root uses the production page size of 8, so both
    documents share page 0. ``two_page`` is the same documents with page size
    1: page 0 is ``a``, page 1 is ``b``.
    """
    documents = {"a": {"x": "1"}, "b": {"y": "\u00e9"}}
    canonical = {}
    entries = []
    for key in sorted(documents):
        text = canonical_text(documents[key])
        raw = text.encode("utf-8")
        digest = hashlib.sha256(raw).hexdigest()
        canonical[key] = {"text": text, "sha256": digest, "len": len(raw)}
        entries.append((key, digest, len(raw)))
    specs = _specs(entries)
    manifest_raw = manifest_body(specs)
    report_raw = report_body(specs)
    rooted = paged_root(entries, MANIFEST_PAGE_SIZE)
    two_page = paged_root(entries, 1)
    return {
        "generation_id": "0" * 64,
        "paging": "paged",
        "page_size": MANIFEST_PAGE_SIZE,
        "canonical": canonical,
        "manifest_text": manifest_raw.decode("utf-8"),
        "manifest_sha256": hashlib.sha256(manifest_raw).hexdigest(),
        "manifest_len": len(manifest_raw),
        "report_text": report_raw.decode("utf-8"),
        "report_sha256": hashlib.sha256(report_raw).hexdigest(),
        "report_len": len(report_raw),
        "root_text": rooted["root_text"],
        "root_sha256": rooted["root_sha256"],
        "root_len": rooted["root_len"],
        "page_count": rooted["page_count"],
        "pages": rooted["pages"],
        "two_page": two_page,
    }


def write_private_generation(generation, put, read_full):
    """Write full rows, ACTION, closed history, and the paged manifest under the private prefix.

    The public JSON file is not a destination. A public route is refused
    before any put. A key outside the generation prefix, or a key that says
    public, is refused before put. A generation over the absolute ceiling is
    refused before any read or put.
    """
    if getattr(put, "accepts_private", True) is False:
        raise InvalidEvidence("private generation cannot use a public route")
    documents = list(redis_documents(generation))
    _assert_manifest_bound(documents)
    prefix = private_prefix(generation["id"])
    saw_action = False
    saw_closed = False
    for key, mapping in documents:
        if not str(key).startswith(prefix) or "public" in str(key):
            raise InvalidEvidence("private generation left the private Redis key")
        if ":action:" in str(key):
            saw_action = True
            if not isinstance(mapping, dict) or mapping.get("audience") != "private":
                raise InvalidEvidence("private generation left the private Redis key")
        if ":closed:" in str(key):
            saw_closed = True
            if not isinstance(mapping, dict) or mapping.get("audience") != "private":
                raise InvalidEvidence("private generation left the private Redis key")
    if not saw_action or not saw_closed:
        raise InvalidEvidence("private generation is incomplete")
    pages, binding = manifest_pages(generation["id"], documents)
    for key, mapping in pages:
        if not str(key).startswith(prefix) or "public" in str(key) or mapping.get("audience") != "private":
            raise InvalidEvidence("private generation left the private Redis key")
        _assert_put_bound(mapping)
    if binding.get("manifest_root") is None or len(pages) != int(binding["page_count"]):
        raise InvalidEvidence("manifest root is not bound")
    receipt = write_generation(generation, put, read_full, extra_documents=pages, manifest_binding=binding)
    receipt["private_key"] = prefix
    receipt["public_written"] = False
    return receipt


def write_public_file(path, document):
    """Write an Ops snapshot. A private generation never lands on this path."""
    if is_private_generation(document):
        raise InvalidEvidence("private generation cannot be written to a public path")
    text = json.dumps(document, sort_keys=True, indent=2, ensure_ascii=False) + "\n"
    if "next_action" in text or "closed_history" in text or "recommendations_execute" in text:
        raise InvalidEvidence("private generation cannot be written to a public path")
    if "proj:pr-board:" in text or ":manifest:" in text:
        raise InvalidEvidence("public summary names a private key")
    temporary = str(path) + ".tmp"
    with open(temporary, "w", encoding="utf-8", newline="\n") as handle:
        handle.write(text)
    os.replace(temporary, path)


def governed_put(execute, conn, acl, principal="cursor", via="pr-board"):
    """A put() closure that calls redis_gov.execute's hput signature and nothing else."""
    if principal == FORBIDDEN_PRINCIPAL:
        raise InvalidEvidence("milestones-sync cannot write the PR board")

    def put(key, mapping):
        if principal == FORBIDDEN_PRINCIPAL:
            raise InvalidEvidence("milestones-sync cannot write the PR board")
        if not str(key).startswith(NAMESPACE) or str(key).startswith("pr:") or "/" in str(key):
            raise InvalidEvidence("PR board key is outside proj:pr-board:v1:")
        if via == "public-sheet" and _private_action(key, mapping):
            raise InvalidEvidence("private ACTION cannot use the public sheet")
        payload = json.dumps(mapping, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
        if len(payload.encode("utf-8")) > MAX_VALUE_BYTES or len(mapping) > MAX_PUT_FIELDS:
            raise InvalidEvidence("governed value exceeds the existing hput cap")
        raw = base64.b64encode(payload.encode("utf-8")).decode("ascii")
        return execute(conn, acl, principal, via, "hput", key, "", raw, "b64", 10, None)

    put.accepts_private = via in PRIVATE_VIA
    put.via = via
    return put


def _private_action(key, mapping):
    """True when this hput is private ACTION, a manifest, or a receipt.

    The public sheet must refuse it before base64. A receipt carries counts
    and digests only, and it still stays off that route.
    """
    text = str(key)
    if ":action:" in text or ":closed:" in text or ":manifest:" in text or ":receipt" in text:
        return True
    if not isinstance(mapping, dict):
        return False
    if mapping.get("audience") == "private":
        return True
    if "recommendations_execute" in mapping or "next_action" in mapping:
        return True
    if any(name in mapping for name in ("manifest_root", "manifest_sha256", "report_digest", "root_digest", "entries")):
        return True
    return False


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
            "milestone": _shown(item.get("milestone")),
            "project": _shown(item.get("project")),
            "go_on_head": {"yes": "Yes", "no": "No"}.get(item.get("go_on_exact_head"), UNASSESSED),
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


def turnaround_rows(generation, public=False):
    """Per-PR turnaround in the same order as the glance table. Missing is unknown.

    The public snapshot omits conference and Blackboard rows. A private pull
    request number is not published beside its review time.
    """
    by_pr = {}
    audience = {}
    for item in generation.get("items") or []:
        short = "%s#%s" % (item["repo"].split("/", 1)[1], item["number"])
        audience[short] = item.get("repo")
        turn = item.get("turnaround") if isinstance(item.get("turnaround"), dict) else {}
        row = {
            "pr": short,
            "first_review": turn.get("first_review") or UNKNOWN_TIME,
            "review_to_close": turn.get("review_to_close") or UNKNOWN_TIME,
            "open_to_close": turn.get("open_to_close") or UNKNOWN_TIME,
        }
        if any(not isinstance(value, str) or not value.strip() for value in row.values()):
            raise InvalidEvidence("a turnaround field was blank")
        by_pr[short] = row
    rows = [by_pr[row["pr"]] for row in display_rows(generation)]
    if public:
        rows = [row for row in rows if audience.get(row["pr"]) in PUBLIC_AUDIENCE]
    return rows


def _public_rows(generation):
    """Per-PR public rows exist only for sfdc-24/sfdc24-site.

    Conference and Blackboard rows are omitted. A redacted stub would still
    publish the private pull request id, priority, project, age, and status.
    """
    by_pr = {}
    for item in generation.get("items") or []:
        short = "%s#%s" % (item["repo"].split("/", 1)[1], item["number"])
        by_pr[short] = item
    rows = []
    for row in display_rows(generation):
        item = by_pr[row["pr"]]
        if item["repo"] not in PUBLIC_AUDIENCE:
            continue
        rows.append({field: row[field] for field in PUBLIC_FIELDS})
    return rows


def _public_trend(trend, include_private):
    """Public daily medians. Private repositories are omitted unless authorized."""
    days = list((trend or {}).get("days") or [])
    source = (trend or {}).get("metrics") if isinstance((trend or {}).get("metrics"), dict) else {}
    metrics = {}
    for metric, body in source.items():
        if not isinstance(body, dict):
            continue
        repos = body.get("repos") if isinstance(body.get("repos"), dict) else {}
        if not include_private:
            repos = {name: series for name, series in repos.items() if name not in PRIVATE_AGGREGATE_REPOS}
        metrics[metric] = {
            "repos": repos,
            "author": body.get("author") if isinstance(body.get("author"), dict) else {},
            "reviewer": body.get("reviewer") if isinstance(body.get("reviewer"), dict) else {},
        }
    return days, metrics


def public_snapshot(generation, enabled=False, private_aggregates=False):
    """The Ops table document. Enabled only when the collector flag is on.

    Per-PR rows and per-PR turnaround rows are limited to sfdc-24/sfdc24-site.
    Conference and Blackboard pull requests are omitted, not rewritten as
    unassessed stubs. Their daily medians are omitted too, unless
    private_aggregates is true. ACTION rows and closed history are not part
    of this document.
    """
    if not enabled:
        return {"as_of": "", "enabled": False, "rows": [],
                "turnaround": {"days": [], "metrics": {}, "rows": []}}
    if private_aggregates:
        trend = generation.get("turnaround_trend") or {}
    else:
        trend = generation.get("public_turnaround_trend")
        if not isinstance(trend, dict):
            public_items = [item for item in (generation.get("items") or [])
                            if item.get("repo") in PUBLIC_AUDIENCE]
            trend = daily_medians(public_items, generation.get("as_of") or "")
    days, metrics = _public_trend(trend, private_aggregates)
    document = {
        "as_of": generation.get("as_of") or "",
        "enabled": True,
        "rows": _public_rows(generation),
        "turnaround": {
            "days": days,
            "metrics": metrics,
            "rows": turnaround_rows(generation, public=True),
        },
    }
    text = json.dumps(document, sort_keys=True, ensure_ascii=False)
    if "proj:pr-board:" in text or ":manifest:" in text:
        raise InvalidEvidence("public summary names a private key")
    return document


def advise_action(rows):
    """Advice copied from ACTION rows. The copy cannot execute."""
    advice = []
    allowed = {"MERGE", "FIX", "DEFER", "CLOSE"}
    for row in rows or []:
        if not isinstance(row, dict):
            continue
        action = row.get("next_action")
        basis = row.get("recommendation_basis")
        advice.append({
            "id": row.get("id") if isinstance(row.get("id"), str) else "",
            "next_action": action if action in allowed else "DEFER",
            "recommendation_basis": basis if isinstance(basis, str) else "",
            "recommendations_execute": False,
        })
    return {
        "audience": "private",
        "mode": "advise",
        "executes": False,
        "merges": False,
        "closes": False,
        "comments": False,
        "rows": advice,
    }


def _advice_unknown():
    return {
        "audience": "private", "mode": "advise", "executes": False, "merges": False,
        "closes": False, "comments": False, "read_back": "unknown", "rows": [],
    }


def _current_binding(generation):
    """Id, manifest root, listed count, and page count of this generation."""
    documents = list(redis_documents(generation))
    rooted = paged_root(_listed_entries(documents), MANIFEST_PAGE_SIZE)
    return {
        "generation": generation.get("id"),
        "manifest_root": rooted["root_sha256"],
        "listed": rooted["listed"],
        "page_count": rooted["page_count"],
    }


def _same_count(got, expected):
    return type(got) is int and type(expected) is int and got == expected


def _receipt_binds_current(generation, receipt):
    """True when a complete backend receipt names this generation.

    generation id, manifest_root, listed, and page_count each have to equal
    the current generation. A self-consistent receipt for a different
    generation, and a receipt with one of those fields changed, are false.
    """
    if not backend_receipt_accepts(receipt):
        return False
    if not isinstance(generation, dict):
        return False
    try:
        current = _current_binding(generation)
    except (InvalidEvidence, ValueError, TypeError, UnicodeError, json.JSONDecodeError):
        return False
    if receipt.get("generation") != current["generation"]:
        return False
    if receipt.get("manifest_root") != current["manifest_root"]:
        return False
    if not _same_count(receipt.get("listed"), current["listed"]):
        return False
    if not _same_count(receipt.get("page_count"), current["page_count"]):
        return False
    return True


def consume_action(generation, read_full=None, effects=None, backend_receipt=None, env=None):
    """Advise from ACTION rows only after the receipt binds this generation.

    backend_receipt_accepts is required, and the receipt's generation id,
    manifest root, listed count, and page count must equal this generation.
    None, a flag-off refusal, a stale receipt, and a mutated count are not
    accepted. The local writer_receipt does not mark ACTION ready. effects
    is accepted so a caller cannot sneak in a merge, close, or comment hook:
    this function never calls it. Only manifest-listed ACTION keys are read,
    and only after the receipt binds.
    """
    if effects is not None:
        effects = None
    if env is not None:
        env = env
    if not isinstance(generation, dict) or read_full is None:
        return _advice_unknown()
    if not _receipt_binds_current(generation, backend_receipt):
        return _advice_unknown()
    try:
        documents = [(key, mapping) for key, mapping in redis_documents(generation) if ":action:" in key]
        if not documents:
            return _advice_unknown()
        collected = []
        for key, mapping in documents:
            got = read_full(key)
            if not isinstance(got, dict) or _previewed(mapping, got) or got != mapping:
                return _advice_unknown()
            raw_rows = got.get("rows")
            if not isinstance(raw_rows, str) or hashlib.sha256(raw_rows.encode("utf-8")).hexdigest() != got.get("sha256"):
                return _advice_unknown()
            payload = json.loads(raw_rows)
            if payload.get("audience") != "private":
                return _advice_unknown()
            collected.extend(payload.get("rows") or [])
        if collected != (_action_payload(generation).get("rows") or []):
            return _advice_unknown()
    except (TimeoutError, OSError, ValueError, TypeError, InvalidEvidence, UnicodeError, json.JSONDecodeError):
        return _advice_unknown()
    result = advise_action(collected)
    result["read_back"] = "full"
    return result


def action_snapshot(generation):
    """Private ACTION view. Recommendations are advisory and do not execute."""
    history = generation.get("closed_history") if isinstance(generation.get("closed_history"), dict) else {}
    rows = [item["action"] for item in generation.get("items") or [] if isinstance(item.get("action"), dict)]
    return {
        "audience": "private",
        "delivery": "local_only",
        "recommendations_execute": False,
        "schema_version": 1,
        "as_of": generation.get("as_of") or "",
        "rows": rows,
        "open": history.get("open", len(rows)),
        "merged": history.get("merged"),
        "closed_unmerged": history.get("closed_unmerged"),
        "freshness": history.get("freshness") or generation.get("as_of") or "",
        "coverage": history.get("coverage") or "not_collected",
    }


def local_projection(generation):
    """A file on disk is not a Redis read-back."""
    return {"delivery": "local_only", "redis_read_back": False, "generation_id": generation.get("id")}


def assemble_generation(documents):
    """Validate one complete generation. redis_read_back is true only after that check."""
    failed = {"redis_read_back": False, "delivery": "incomplete", "complete": False}

    def reject(reason):
        return dict(failed, reason=reason)

    pairs = list(documents.items()) if isinstance(documents, dict) else list(documents or [])
    by_key = {key: mapping for key, mapping in pairs}
    metas = [(key, mapping) for key, mapping in pairs if str(key).endswith(":meta")]
    if len(metas) != 1 or not isinstance(metas[0][1], dict):
        return reject("meta")
    key, meta = metas[0]
    payload = meta.get("meta")
    if not isinstance(payload, str) or hashlib.sha256(payload.encode("utf-8")).hexdigest() != meta.get("sha256"):
        return reject("meta_hash")
    if meta.get("schema_version") != "1" or meta.get("generation") != json.loads(payload).get("generation", meta.get("generation")):
        if meta.get("schema_version") != "1":
            return reject("schema")
    prefix = key[:-len(":meta")]
    total = 0
    for field, marker in (("item_shards", ":i:"), ("action_shards", ":action:"), ("closed_shards", ":closed:")):
        try:
            expected = int(meta.get(field))
        except (TypeError, ValueError):
            return reject("inventory")
        for seq in range(expected):
            mapping = by_key.get(prefix + marker + str(seq))
            if not isinstance(mapping, dict) or mapping.get("seq") != str(seq):
                return reject("missing_shard")
            rows = mapping.get("rows")
            if not isinstance(rows, str) or hashlib.sha256(rows.encode("utf-8")).hexdigest() != mapping.get("sha256"):
                return reject("shard_hash")
            total += len(rows.encode("utf-8"))
            if total > MAX_RECONSTRUCTED_BYTES:
                return reject("bound")
            try:
                json.loads(rows)
            except json.JSONDecodeError:
                return reject("shard_json")
            if marker != ":i:" and mapping.get("audience") != "private":
                return reject("audience")
    return {
        "redis_read_back": True,
        "generation": meta.get("generation"),
        "schema_version": 1,
        "delivery": "redis",
        "complete": True,
        "reason": "validated",
    }


def _enrichment_index(sources):
    if sources is None:
        return {}
    if not isinstance(sources, list):
        raise InvalidEvidence("invalid enrichment")
    index = {}
    for row in sources:
        if not isinstance(row, dict):
            raise InvalidEvidence("invalid enrichment")
        repo, number = row.get("repo"), row.get("number")
        if repo not in PROJECTS or type(number) is not int or number < 1:
            raise InvalidEvidence("invalid enrichment")
        if (repo, number) in index:
            raise InvalidEvidence("invalid enrichment")
        index[(repo, number)] = row
    return index


def _apply_enrichment_row(record, source):
    """Copy evidenced milestone, closure, task, and fix fields. Sentinels stay absent."""
    if "milestone" in source and _has_evidence(source.get("milestone")):
        phrase = public_phrase(source.get("milestone"), "")
        if _has_evidence(phrase) and phrase != UNASSESSED:
            record["milestone"] = phrase
    if "closure" in source:
        closure = source.get("closure")
        record["closure_case"] = _closure_case_field(closure) if isinstance(closure, dict) else "unknown"
    if "task" in source:
        task = source.get("task")
        record["task"] = _task_field(task) if isinstance(task, dict) else "unknown"
    if "fix_url" in source:
        record["fix_url"] = _fix_url_field(source.get("fix_url")) if _has_evidence(source.get("fix_url")) else "unknown"
    if "fix_evidence" in source:
        record["fix_evidence"] = _opaque_or_blank(source.get("fix_evidence")) or "unknown"


def apply_enrichment(records, sources):
    """The enrichment file is the source for those fields. It does not invent them."""
    index = _enrichment_index(sources)
    for record in records or []:
        source = index.get((record.get("repo"), record.get("number")))
        if source:
            _apply_enrichment_row(record, source)
    return records


def enrichment_acknowledgments(sources):
    """Owner and closure-driver evidence. A sentinel source does not acknowledge anyone."""
    found = []
    for key, row in _enrichment_index(sources).items():
        repo, number = key
        for role, actor_key, source_key in (
            ("implementation_owner", "owner_actor", "owner_source"),
            ("closure_driver", "closure_actor", "closure_source"),
        ):
            evidence = row.get(source_key)
            actor = row.get(actor_key)
            if not _has_evidence(evidence):
                continue
            if not isinstance(actor, str) or not ACTOR.fullmatch(actor) or actor in SHARED_LOGINS:
                continue
            found.append({
                "repo": repo, "number": number, "role": role, "actor": actor,
                "acknowledged": True, "source": evidence,
            })
    return found


def stale_result(reason, previous_head=None):
    return {"status": "stale", "reason": reason, "items": None, "previous_head": previous_head,
            "wrote_head": False, "wrote": False}


def run(as_of=None, read=None, policy=None, acknowledgments=None, assessments=None, dependencies=None,
        deployed=None, repos=REPOS, put=None, read_full=None, enabled_flag=False, env=None, max_pages=MAX_PAGES,
        enrichment=None, backend_receipt=None):
    if not enabled(enabled_flag, env):
        return {"status": "disabled", "reason": "flag_off", "items": None, "wrote": False, "wrote_head": False}
    if not as_of:
        raise InvalidEvidence("an explicit as-of time is required")
    try:
        records = attach_checks(attach_activity(list_open(read, repos, max_pages=max_pages), read), policy, read)
        confirm_collected(read, records, repos, max_pages)
        closed = attach_activity(list_closed(read, as_of, repos, max_pages=max_pages), read)
        history = attach_activity(list_closed_history(read, repos, max_pages=max_pages), read)
        confirm_history(read, history, repos, max_pages)
        apply_enrichment(records, enrichment)
        apply_enrichment(closed, enrichment)
        apply_enrichment(history, enrichment)
        sourced = enrichment_acknowledgments(enrichment)
        if sourced:
            acknowledgments = list(acknowledgments or []) + sourced
        generation = build_generation(records, as_of, acknowledgments, assessments, dependencies, deployed,
                                      closed_records=closed, history_records=history)
    except (InvalidEvidence, ValueError, KeyError, TypeError):
        return stale_result("source_failure")
    if put is None or read_full is None:
        return {"status": "projected_not_written", "reason": "writer_not_attached", "items": generation["items"],
                "generation": generation, "wrote": False, "wrote_head": False, "public_publish": False,
                "read_back": "unknown", "public_written": False}
    try:
        receipt = write_private_generation(generation, put, read_full)
    except TimeoutError:
        return stale_result("timeout")
    except (InvalidEvidence, ValueError, TypeError):
        return stale_result("source_failure")
    if receipt.get("status") in {"complete", "replay"}:
        audit = writer_receipt(generation, read_full)
        receipt["report_sha256"] = audit.get("report_sha256", "")
        receipt["report_digest"] = audit.get("report_digest", "")
        receipt["manifest_digest"] = audit.get("manifest_digest", "")
        receipt["root_digest"] = audit.get("root_digest", "")
        receipt["listed"] = audit.get("listed", 0)
        receipt["page_count"] = audit.get("page_count", 0)
        receipt["partial"] = bool(audit.get("partial"))
        receipt["page_ok"] = bool(audit.get("page_ok"))
        receipt["ok"] = False
        receipt["scope"] = audit.get("scope") or "generation"
        receipt.pop("keys", None)
        local_full = (audit.get("ok") is True and audit.get("page_ok") is True
                      and audit.get("partial") is False and audit.get("scope") == "generation"
                      and audit.get("read_back") == "full")
        if not local_full:
            receipt["status"] = "stale"
            receipt["reason"] = "readback_unknown"
            receipt["read_back"] = "unknown"
            receipt["public_publish"] = False
            receipt["items"] = None
        elif _receipt_binds_current(generation, backend_receipt):
            receipt["ok"] = True
            receipt["public_publish"] = True
            receipt["read_back"] = "full"
        else:
            receipt["public_publish"] = False
            receipt["read_back"] = "unknown"
    else:
        receipt["public_publish"] = False
        if receipt.get("read_back") != "full":
            receipt["read_back"] = "unknown"
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
    parser.add_argument("--enrichment", type=argparse.FileType("r", encoding="utf-8"),
                        help="Milestone, owner, closure, task, and fix evidence. Missing stays unknown.")
    parser.add_argument("--out", help="Local metadata JSON. Not written when the flag is off or collection fails.")
    parser.add_argument("--public-out", help="Ops table JSON. Written only when the flag is on and collection succeeds.")
    parser.add_argument("--public-private-aggregates", action="store_true",
                        help="Publish conference and Blackboard daily medians. Defaults off.")
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
                      put=put, read_full=read_full, enabled_flag=True, env=env,
                      enrichment=read_json(args.enrichment))
    except (InvalidEvidence, OSError, ValueError, json.JSONDecodeError):
        print("PR board collection failed; last good generation retained.", file=sys.stderr)
        return 1
    if receipt["status"] == "disabled":
        print("PR board disabled; flag defaults off. No GitHub read and no Redis write.")
        return 0
    if receipt["status"] == "stale":
        retained = receipt.get("head_retained")
        if retained is False or retained == "unknown":
            print("PR board head write was not audited. The previous generation is not confirmed.", file=sys.stderr)
        else:
            print("PR board collection failed; last good generation retained.", file=sys.stderr)
        return 1
    def write_json(path, value):
        text = json.dumps(value, sort_keys=True, indent=2) + "\n"
        temporary = path + ".tmp"
        with open(temporary, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(text)
        os.replace(temporary, path)

    try:
        if args.out and (is_public_path(args.out) or is_public_tree(args.out)):
            raise InvalidEvidence("private generation cannot be written to a public path")
        if args.out and receipt.get("generation"):
            local = dict(receipt["generation"])
            local["delivery"] = "local_only"
            local["redis_read_back"] = False
            write_json(args.out, local)
        if args.public_out and receipt.get("generation") and receipt.get("public_publish") is True:
            write_public_file(args.public_out, public_snapshot(
                receipt["generation"], enabled=True,
                private_aggregates=private_aggregates_enabled(args.public_private_aggregates, env)))
    except InvalidEvidence:
        print("PR board collection failed; last good generation retained.", file=sys.stderr)
        return 1
    if receipt["status"] == "projected_not_written":
        print("PR board projected locally. No Redis write; the governed writer was not attached.")
        return 0
    print("PR board generation %s %s" % (receipt["generation_id"], receipt["status"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
