#!/usr/bin/env python3
"""Find merged pull requests that are not already on the Ops delivery list.

The bake used to re-check only rows already in the snapshot, so finished work
never appeared unless someone typed it in. This reads merged pull requests from
the two public repositories and returns full delivery rows for the ones the
list does not already name.

Titles are the pull request titles, in plain language. A title that is only a
number, names a person, or carries a secret, a Redis figure, or a credential
is left out. Bodies, comments, and the private conference repository are not
read. A merge is staging evidence, not a production receipt.
"""
from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from urllib.parse import quote

from ops_agent_metrics import BANNED, agent_of
from ops_delivery import SECRET

ALLOWED = ("sfdc-24/sfdc24-site", "sfdc-24/Blackboard")
LOOKBACK_DAYS = 21
MAX_NEW = 30
EXTRA_BANNED = ("redis", "password", "secret", "credential", "api key", "private key")
EVIDENCE = (
    "Pull request merged. Staging and production are not verified from the merge alone. "
    "The dated bar is the pull request window, not working time."
)
NEXT = "Provide deployed identity, then receiver-side verification and human acceptance."
ASSIGNMENT = "Merged pull request; not a deployment receipt"
PROJECTS = {"sfdc-24/sfdc24-site": "SFDC24", "sfdc-24/Blackboard": "Blackboard"}


def plain_title(title):
    """A public sentence, or None when the title must not be shown."""
    if not isinstance(title, str):
        return None
    text = re.sub(r"\s+", " ", title).strip()
    if not text or len(text) > 180 or not re.search(r"[A-Za-z]", text):
        return None
    if re.fullmatch(r"#?\d+", text):
        return None
    if any(ord(char) < 32 for char in text) or SECRET.search(text):
        return None
    lowered = text.lower()
    if any(word in lowered for word in BANNED + EXTRA_BANNED):
        return None
    return text


def parse_stamp(value):
    if not isinstance(value, str) or not value.endswith("Z"):
        raise ValueError("invalid source timestamp")
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)
    parsed = parsed.replace(microsecond=0)
    return parsed.strftime("%Y-%m-%dT%H:%M:%SZ")


def item_id(repo, number):
    slug = repo.split("/", 1)[1].lower()
    return "merged-%s-%s" % (slug, number)


def search_path(repo, day):
    query = "repo:%s is:pr is:merged merged:>=%s" % (repo, day)
    return "search/issues?q=" + quote(query, safe="") + "&sort=updated&order=desc&per_page=50"


def row_from_pull(repo, pull, now):
    number = pull.get("number")
    if not isinstance(number, int) or number < 1:
        raise ValueError("invalid pull request number")
    merged_raw = pull.get("merged_at")
    if not merged_raw:
        return None
    merged = parse_stamp(merged_raw)
    if datetime.strptime(merged, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc) > now + timedelta(seconds=60):
        raise ValueError("future merge time")
    title = plain_title(pull.get("title"))
    if title is None:
        return None
    created_raw = pull.get("created_at")
    periods = []
    if created_raw:
        created = parse_stamp(created_raw)
        if created <= merged:
            periods.append({"stage": "dev", "kind": "actual", "start": created, "end": merged})
    head = pull.get("head") if isinstance(pull.get("head"), dict) else {}
    ref = head.get("ref")
    owner = agent_of(ref) if isinstance(ref, str) else None
    owner = owner or "Unassigned"
    return {
        "id": item_id(repo, number),
        "title": title,
        "project": PROJECTS[repo],
        "owner": owner,
        "assignment": ASSIGNMENT,
        "stage": "staging",
        "status": "pending",
        "observed_at": merged,
        "source": "https://github.com/%s/pull/%s" % (repo, number),
        "evidence": EVIDENCE,
        "next": NEXT,
        "periods": periods,
    }


def discover(previous, read=None, now=None, repositories=None, limit=MAX_NEW):
    """Return an OKF-shaped export of new merged rows. Never includes bodies."""
    if read is None:
        from ops_delivery_collect import api as read
    now = now or datetime.now(timezone.utc)
    if now.tzinfo is None:
        raise ValueError("discovery clock must be timezone-aware")
    now = now.astimezone(timezone.utc)
    if not isinstance(previous, dict) or previous.get("schema_version") != 1 or not isinstance(previous.get("items"), list):
        raise ValueError("invalid previous snapshot")
    repos = tuple(repositories) if repositories is not None else ALLOWED
    unknown = [repo for repo in repos if repo not in ALLOWED]
    if unknown:
        raise ValueError("unapproved discovery repository")
    known_sources = {row.get("source") for row in previous["items"]}
    known_ids = {row.get("id") for row in previous["items"]}
    if limit <= 0:
        return {"schema_version": 1, "items": []}
    day = (now - timedelta(days=LOOKBACK_DAYS)).strftime("%Y-%m-%d")
    found = []
    for repo in repos:
        payload = read(search_path(repo, day))
        items = payload.get("items") if isinstance(payload, dict) else None
        if not isinstance(items, list):
            raise ValueError("GitHub metadata read failed")
        if len(items) > 50:
            raise ValueError("discovery page exceeds bounded limit")
        for issue in items:
            if not isinstance(issue, dict) or not isinstance(issue.get("number"), int):
                raise ValueError("GitHub metadata read failed")
            number = issue["number"]
            source = "https://github.com/%s/pull/%s" % (repo, number)
            if source in known_sources or item_id(repo, number) in known_ids:
                continue
            pull = read("repos/%s/pulls/%s" % (repo, number))
            if not isinstance(pull, dict):
                raise ValueError("GitHub metadata read failed")
            if pull.get("number") != number:
                raise ValueError("pull request number mismatch")
            row = row_from_pull(repo, pull, now)
            if row is None:
                continue
            if SECRET.search(row["title"]) or SECRET.search(row["evidence"]):
                continue
            found.append(row)
    found.sort(key=lambda row: (row["observed_at"], row["id"]), reverse=True)
    # Newest merges first. The caller drops older discovered rows so the public
    # cap stays at 100 and a later merge can still appear.
    return {"schema_version": 1, "items": found[:limit]}


def is_discovered(row):
    return str(row.get("id", "")).startswith("merged-")


def is_protected(row):
    return (not is_discovered(row)) or (row.get("stage") == "production" and row.get("status") == "verified")


def prune_discovered(previous, incoming, keep=MAX_NEW, limit=100):
    """Keep every curated row and the newest discovered merges, within the cap.

    Discovered rows use the merged- id prefix. Production receipts stay even
    when they use that prefix. Older discovered rows are removed so the list
    does not freeze once it reaches 100.
    """
    if not isinstance(incoming, list):
        raise ValueError("invalid discovered rows")
    protected = [row for row in previous["items"] if is_protected(row)]
    if len(protected) > limit:
        raise ValueError("curated delivery list exceeds the public cap")
    slots = max(0, min(keep, limit - len(protected)))
    pool = [row for row in previous["items"] if not is_protected(row)] + list(incoming)
    pool.sort(key=lambda row: (row["observed_at"], row["id"]), reverse=True)
    seen = set()
    kept_ids = []
    for row in pool:
        if row["id"] in seen:
            continue
        seen.add(row["id"])
        kept_ids.append(row["id"])
        if len(kept_ids) >= slots:
            break
    kept = set(kept_ids)
    items = [row for row in previous["items"] if is_protected(row) or row["id"] in kept]
    already = {row["id"] for row in items}
    new_rows = [row for row in incoming if row["id"] in kept and row["id"] not in already]
    new_rows.sort(key=lambda row: row["id"])
    pruned = dict(previous)
    pruned["items"] = items
    return pruned, new_rows
