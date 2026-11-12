#!/usr/bin/env python3
"""Build a sanitized public fleet data pack for sfdc24.com (TASK ID: G36).

Reads the private board through the local read-only bus helper and writes
aggregates only. Never writes owner words, guest or client names, emails,
phones, board row ids, case numbers, tokens, or private-service URLs.

Usage:
  python3 build_fleet_pack.py --out data/fleet-pack \\
      [--cache /tmp/fleet-pack-cache/board_rows.json] \\
      [--github-counts /path/to/github_merged_counts.json] \\
      [--start 2026-09-01] [--end 2026-11-12]

The optional github-counts file is a JSON object:
  {"generated_at": "...Z", "timezone_note": "merged: dates are GitHub UTC",
   "totals": {"sfdc-24/conference": 264, ...},
   "weekly": {"2026-W38": {"sfdc-24/conference": 12, ...}, ...}}
If it is omitted, pull-request metrics are left out of the pack.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import statistics
import sys
from collections import Counter, defaultdict
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

ET = ZoneInfo("America/Toronto")
UTC = timezone.utc

# Public names already used on sfdc24.com (ops metrics + seats). Aya and Jenny
# are not used: they were not found on the public pages checked for TASK ID: G36.
AGENT_FROM = {
    "grok": "Grok",
    "grok-bot": "Grok",
    "claude-code-cli": "Claude",
    "vm-claude-code-cli": "Claude",
    "claude-api": "Claude",
    "claude-voice": "Claude",
    "claude": "Claude",
    "vanlas-claude": "Claude",
    "chatgpt-codex-desktop": "Codex",
    "chatgpt-code-desktop": "Codex",
    "aya": "Codex",
    "codex": "Codex",
    "codex-desktop": "Codex",
    "codex-cloud": "Codex",
    "cursor": "Cursor",
    "cody": "Cursor",
    "gemini": "Gemini",
    "gemini-vscode": "Gemini",
    "jev": "Jev",
    "copilot": "Copilot",
}
INTAKE_FROM = {
    "whatsapp",
    "claude-mobile",
    "chat-mobile",
    "owner",
    "wa-outbox",
}
SYSTEM_FROM = {
    "bus-reconciler",
    "pi1-cli",
    "foundry",
    "cowork-chrome",
    "conference-chair",
    "governor-page",
    "vm-cowork",
    "fleet-check",
}

TASK_RE = re.compile(r"TASK ID:\s*([A-Za-z]{1,8}\d+[A-Za-z0-9]*)", re.I)
FIELD_RE = re.compile(r"(?:^|\|)([A-Za-z_][A-Za-z0-9_]*)=([^|]*)")
PHASE_KEEP = re.compile(r"^[A-Z][A-Z0-9_]{0,40}$")

DEFAULT_TOOLS = Path("/workspace/sfdc24-tools")


def ts_of(value):
    try:
        t = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except Exception:
        return None
    if t.tzinfo is None:
        t = t.replace(tzinfo=UTC)
    return t


def parse_fields(text: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for m in FIELD_RE.finditer(text or ""):
        key, val = m.group(1), m.group(2).strip()
        if not val or len(val) > 80 or "\n" in val or "\r" in val:
            continue
        out[key] = val
    return out


def agent_from_raw(raw: str) -> str | None:
    name = (raw or "").strip()
    if not name:
        return None
    low = name.lower()
    if low.startswith("chatgpt-codex-desktop") or low.startswith("codex"):
        return "Codex"
    if low.startswith("claude"):
        return "Claude"
    if low.startswith("gemini"):
        return "Gemini"
    if low.startswith("grok"):
        return "Grok"
    if low.startswith("cursor") or low == "cody":
        return "Cursor"
    return AGENT_FROM.get(name) or AGENT_FROM.get(low)


def bucket_from(raw: str) -> str:
    agent = agent_from_raw(raw)
    if agent:
        return agent
    low = (raw or "").strip().lower()
    if low in INTAKE_FROM or low.startswith("whatsapp"):
        return "intake"
    if low in SYSTEM_FROM or not low:
        return "system"
    return "other"


def work_order_agent(task_id: str, first_from: str) -> str:
    pref = re.match(r"[A-Za-z]+", task_id or "")
    letter = pref.group(0).upper() if pref else ""
    if letter == "C":
        return "Cursor"
    if letter == "G":
        return "Grok"
    return bucket_from(first_from)


def iso_week_id(local_dt: datetime) -> str:
    iso = local_dt.isocalendar()
    return f"{iso.year}-W{iso.week:02d}"


def monday_of_week(year: int, week: int) -> date:
    return date.fromisocalendar(year, week, 1)


def week_range(week_id: str, window_start: date, window_end: date) -> tuple[date, date]:
    year = int(week_id[:4])
    week = int(week_id.split("W")[1])
    mon = monday_of_week(year, week)
    sun = mon + timedelta(days=6)
    return max(mon, window_start), min(sun, window_end)


def iter_weeks(window_start: date, window_end: date) -> list[str]:
    mon = window_start - timedelta(days=window_start.weekday())
    out = []
    while mon <= window_end:
        iso = mon.isocalendar()
        out.append(f"{iso.year}-W{iso.week:02d}")
        mon += timedelta(days=7)
    return out


def to_number(value):
    if value is None:
        return None
    try:
        return float(re.sub(r"[^0-9.+-]", "", str(value).split()[0]) or "nan")
    except Exception:
        return None


def load_board_rows(cache: Path | None, since_utc: datetime, tools: Path):
    if cache and cache.is_file():
        rows = json.loads(cache.read_text(encoding="utf-8"))
        return rows, {"source": "cache", "path": str(cache)}
    sys.path.insert(0, str(tools))
    import bus_cli_full  # type: ignore

    env = bus_cli_full.load_env()
    rows, meta = bus_cli_full.read_rows(
        env, limit=25000, since=since_utc.strftime("%Y-%m-%dT%H:%M:%SZ")
    )
    info = {
        "source": "board_read",
        "rows_returned": len(rows),
        "filtered": meta.get("filtered") if isinstance(meta, dict) else None,
        "total_sheet": meta.get("total") if isinstance(meta, dict) else None,
    }
    return rows, info


def norm_task_key(task: str, row_id: str) -> str:
    text = task or ""
    m = TASK_RE.search(text)
    if m:
        return m.group(1).upper()
    cleaned = re.sub(r"^TASK ID:\s*", "", text, flags=re.I).strip()
    if cleaned:
        return cleaned[:80]
    return (row_id or "").strip()[:80]


def collect(rows, window_start: date, window_end: date):
    start_dt = datetime.combine(window_start, time.min, tzinfo=ET)
    end_dt = datetime.combine(window_end + timedelta(days=1), time.min, tzinfo=ET)

    parsed = []
    for raw in rows:
        if not isinstance(raw, list) or len(raw) < 6:
            continue
        ts = ts_of(raw[1])
        if not ts:
            continue
        local = ts.astimezone(ET)
        if local < start_dt or local >= end_dt:
            continue
        payload = str(raw[5] or "")
        subject = str(raw[8] or "") if len(raw) > 8 else ""
        fields = parse_fields(payload)
        frm = fields.get("from") or (str(raw[2]) if len(raw) > 2 else "")
        phase = (fields.get("phase") or "").upper()
        if not PHASE_KEEP.match(phase):
            phase = "OTHER" if phase else "UNSET"
        msg = (fields.get("msg_type") or "").upper()
        if not PHASE_KEEP.match(msg):
            msg = ""
        cls = (fields.get("class") or "").upper()
        if not PHASE_KEEP.match(cls):
            cls = ""
        waker = fields.get("wakerreply") == "1" or "wakerreply=1" in payload
        blob = payload + " " + subject
        tasks = [t.upper() for t in TASK_RE.findall(blob)]
        parsed.append(
            {
                "ts": ts,
                "local": local,
                "week": iso_week_id(local),
                "from_raw": frm,
                "agent": bucket_from(frm),
                "phase": phase,
                "msg": msg,
                "cls": cls,
                "waker": waker,
                "fields": fields,
                "tasks": tasks,
                "subject_has_task": bool(tasks),
            }
        )

    parsed.sort(key=lambda r: r["ts"])
    first = parsed[0]["local"].date().isoformat() if parsed else None
    last = parsed[-1]["local"].date().isoformat() if parsed else None

    # Unique work orders, first seen.
    work_first: dict[str, dict] = {}
    for row in parsed:
        for task in row["tasks"]:
            if task not in work_first:
                work_first[task] = {
                    "id": task,
                    "week": row["week"],
                    "agent": work_order_agent(task, row["from_raw"]),
                }

    # Estimates
    estimates = []
    dones = []
    for row in parsed:
        fields = row["fields"]
        phase, msg, thread = row["phase"], row["msg"], fields.get("thread_id") or ""
        is_done = msg == "ESTIMATE_DONE" or phase == "ESTIMATE_DONE"
        is_est = (not is_done) and (
            msg == "ESTIMATE"
            or phase == "ESTIMATE"
            or (thread == "TH-ESTIMATES" and "DONE" not in msg)
        )
        rec = {
            "task": fields.get("task") or "",
            "id": fields.get("id") or "",
            "est_minutes": to_number(fields.get("est_minutes")),
            "started": ts_of(fields.get("started")) or row["ts"],
            "est_done": ts_of(fields.get("est_done")),
            "actual": to_number(fields.get("actual_minutes")),
            "ts": row["ts"],
            "week": row["week"],
            "agent": row["agent"],
        }
        if is_est:
            estimates.append(rec)
        if is_done:
            dones.append(rec)

    used = set()
    pairs = []
    for est in estimates:
        if not est["est_minutes"] or est["est_minutes"] <= 0:
            continue
        key = norm_task_key(est["task"], est["id"])
        if not key:
            continue
        cand = None
        for i, done in enumerate(dones):
            if i in used:
                continue
            dkey = norm_task_key(done["task"], done["id"])
            same = dkey == key or (est["id"] and est["id"] in ((done["id"] or "") + (done["task"] or "")))
            if same and done["ts"] >= est["ts"]:
                cand = (i, done)
                break
        if not cand:
            continue
        i, done = cand
        used.add(i)
        actual = done["actual"]
        if actual is None and done["ts"] and est["started"]:
            actual = (done["ts"] - est["started"]).total_seconds() / 60.0
        if actual is None:
            continue
        ratio = actual / est["est_minutes"]
        on_time = actual <= est["est_minutes"]
        pairs.append(
            {
                "week": est["week"],
                "agent": est["agent"],
                "ratio": ratio,
                "on_time": on_time,
            }
        )

    def accuracy(items):
        if not items:
            return None
        ratios = [x["ratio"] for x in items]
        return {
            "paired": len(items),
            "median_ratio": round(statistics.median(ratios), 3),
            "on_time_pct": round(100.0 * sum(1 for x in items if x["on_time"]) / len(items), 1),
        }

    return {
        "parsed": parsed,
        "first": first,
        "last": last,
        "work_first": work_first,
        "pairs": pairs,
        "accuracy_total": accuracy(pairs),
        "accuracy_by_week": {
            week: accuracy([p for p in pairs if p["week"] == week])
            for week in {p["week"] for p in pairs}
        },
        "estimates": len(estimates),
        "estimate_dones": len(dones),
    }


def empty_week_metrics():
    return {
        "work_orders_by_agent": {},
        "work_orders_total": 0,
        "done_rows_including_waker": 0,
        "done_rows_excluding_waker": 0,
        "done_rows_by_agent_excluding_waker": {},
        "estimate_accuracy": None,
        "board_rows_by_agent": {},
        "board_rows_by_phase": {},
        "board_rows_total": 0,
        "conference_test_rows": 0,
        "conference_test_pass": 0,
        "conference_test_fail": 0,
        "conference_test_outcome_unrecorded": 0,
    }


def test_outcome(row) -> str:
    """Return pass, fail, or unrecorded from short structured fields only."""
    fields = row["fields"]
    verdict = (fields.get("verdict") or "").upper()
    status = (fields.get("status") or "").upper()
    tokens = {verdict, status, row["phase"], row["msg"]}
    fail_words = {"FAIL", "FAILED", "NO-GO", "NOGO", "NO_GO"}
    pass_words = {"PASS", "PASSED", "GO", "OK"}
    if tokens & fail_words:
        return "fail"
    if tokens & pass_words:
        return "pass"
    return "unrecorded"


def week_metrics(data, week_id: str) -> dict:
    rows = [r for r in data["parsed"] if r["week"] == week_id]
    out = empty_week_metrics()
    out["board_rows_total"] = len(rows)
    by_agent = Counter(r["agent"] for r in rows)
    by_phase = Counter(r["phase"] for r in rows)
    out["board_rows_by_agent"] = dict(sorted(by_agent.items()))
    out["board_rows_by_phase"] = dict(sorted(by_phase.items(), key=lambda kv: (-kv[1], kv[0])))

    done = [r for r in rows if r["phase"] == "DONE" or r["msg"] == "DONE"]
    done_ex = [r for r in done if not r["waker"]]
    out["done_rows_including_waker"] = len(done)
    out["done_rows_excluding_waker"] = len(done_ex)
    out["done_rows_by_agent_excluding_waker"] = dict(
        sorted(Counter(r["agent"] for r in done_ex).items())
    )

    work = [w for w in data["work_first"].values() if w["week"] == week_id]
    out["work_orders_by_agent"] = dict(sorted(Counter(w["agent"] for w in work).items()))
    out["work_orders_total"] = len(work)
    out["estimate_accuracy"] = data["accuracy_by_week"].get(week_id)

    tests = [r for r in rows if r["cls"] == "TEST"]
    out["conference_test_rows"] = len(tests)
    outcomes = Counter(test_outcome(r) for r in tests)
    out["conference_test_pass"] = outcomes.get("pass", 0)
    out["conference_test_fail"] = outcomes.get("fail", 0)
    out["conference_test_outcome_unrecorded"] = outcomes.get("unrecorded", 0)
    return out


def add_pr_counts(block: dict, prs: dict | None, week_id: str | None):
    if not prs:
        return
    if week_id is None:
        block["prs_merged_by_repo"] = dict(prs.get("totals") or {})
        block["prs_merged_total"] = int(sum((prs.get("totals") or {}).values()))
    else:
        weekly = (prs.get("weekly") or {}).get(week_id) or {}
        block["prs_merged_by_repo"] = dict(weekly)
        block["prs_merged_total"] = int(sum(weekly.values())) if weekly else 0


def build_milestones(data, window_start: date, window_end: date, prs: dict | None) -> list[dict]:
    """Short, neutral dated facts. No quotes, names, or private ids."""
    items = []

    def add(day, text, source):
        if window_start <= date.fromisoformat(day) <= window_end:
            items.append({"date": day, "text": text, "source": source})

    # Board coverage itself is a fact about this pack, not a product claim.
    if data["first"]:
        add(data["first"], "Board records in this pack begin.", "private board timestamp range")
    if data["pairs"]:
        first_est = min(p["week"] for p in data["pairs"])
        year, week = first_est.split("-W")
        mon = monday_of_week(int(year), int(week)).isoformat()
        add(mon, "Estimate and estimate-done pairing is in use on the board.", "TH-ESTIMATES rows")
    # Public already-published site releases (no private titles invented).
    add("2026-10-12", "Public site release sfdc-24/sfdc24-site #313.", "data/releases.json on main")
    add("2026-11-05", "Public site release sfdc-24/sfdc24-site #389.", "data/latest-release.json on main")
    if prs and (prs.get("totals") or {}).get("sfdc-24/conference"):
        # Last week with conference merges, if any, as a volume milestone only.
        weekly = prs.get("weekly") or {}
        conf_weeks = [w for w, d in weekly.items() if d.get("sfdc-24/conference")]
        if conf_weeks:
            last = max(conf_weeks)
            n = weekly[last]["sfdc-24/conference"]
            year, week = last.split("-W")
            mon = monday_of_week(int(year), int(week)).isoformat()
            add(mon, f"Conference repository merged pull requests this week: {n}.", "GitHub merged search")
    # Dedup by date+text, keep chronological, cap length.
    seen = set()
    out = []
    for item in sorted(items, key=lambda x: x["date"]):
        key = (item["date"], item["text"])
        if key in seen:
            continue
        seen.add(key)
        out.append(item)
    return out[:12]


def write_readme(path: Path, meta: dict, computed: list[str], omitted: list[str]):
    lines = [
        "# Fleet data pack",
        "",
        "Sanitized aggregates for sfdc24.com. TASK ID: G36.",
        "This pack covers 1 September 2026 through the generation date, America/Toronto.",
        "It contains counts and ratios only. It does not contain owner words, guest or",
        "client names, emails, phones, board row ids, case numbers, tokens, or URLs of",
        "private services.",
        "",
        "## Generation",
        "",
        f"- generated_at (America/Toronto): {meta['generated_at']}",
        f"- window: {meta['window']['start']} through {meta['window']['end']} inclusive",
        f"- board rows in the readable sheet after 2026-09-01: {meta['board']['rows_in_pack']}",
        f"- first board row in pack: {meta['board']['first_row']}",
        f"- last board row in pack: {meta['board']['last_row']}",
        "",
        "## Sources",
        "",
        "- Private board (Blackboard Alpha DB) via `/workspace/sfdc24-tools/bus_cli_full.py`",
        "  `read_rows(limit=25000, since=2026-09-01T04:00:00Z)`, which is 00:00 America/Toronto",
        "  on 1 September 2026 (that date was in daylight time). The readable sheet's first",
        f"  in-window row is {meta['board']['first_row']}. Earlier weeks are zero on every",
        "  board-derived metric.",
        "- ESTIMATE and ESTIMATE_DONE rows, including `thread_id=TH-ESTIMATES`.",
        "- DONE rows, split into including-waker and excluding-waker (`wakerreply=1`).",
        "- Optional GitHub merged-pull-request counts (connector search, `merged:DATE..DATE`,",
        "  `is:merged`) for sfdc-24/conference, sfdc-24/sfdc24-site, sfdc-24/Blackboard, and",
        "  sfdc-24/converspan. GitHub's `merged:` filter uses UTC; ISO weeks in this pack use",
        "  America/Toronto, so a merge near midnight UTC can fall in the neighbouring week.",
        "- `scorecard_history.csv` and `scorecard_daily.json` were inspected and not used:",
        "  they only cover 7-9 October 2026 and are stale.",
        "- Ledger snapshots under `/workspace/sfdc24-tools/ledger` were inspected read-only",
        "  and not used: they are file-index snapshots with private identifiers, not a clean",
        "  public metric source.",
        "",
        "## Agent names",
        "",
        "Public names already used on sfdc24.com: Grok, Claude, Cursor, Codex, Gemini,",
        "Copilot, and Jev. Seat names Clay, Greg, Jemma, and Cody also appear on the site",
        "but are not used as separate series here (they map to Claude, Grok, Gemini, and",
        "Cursor on the published ops metrics). Aya is not used; it was not found on the",
        "public pages checked for this pack. `from=aya` and Codex desktop senders are",
        "counted under Codex.",
        "",
        "Work orders: a unique `TASK ID: …` token. `C` + digits is Cursor, `G` + digits is",
        "Grok, anything else is attributed from the `from` field of the first row that",
        "mentioned it. The `TASK ID:` label is recent, so early weeks are mostly zero.",
        "",
        "Board-row agents: `from` (payload, else the sheet column), then prefix rules.",
        "Intake channels are labelled `intake`. Automation senders are labelled `system`.",
        "Anything else is `other`. No person names are emitted.",
        "",
        "## Metric methods",
        "",
        "- **work_orders_by_agent**: unique TASK IDs first seen in that week.",
        "- **done_rows_***: `phase=DONE` or `msg_type=DONE`. Waker auto-rows are a large",
        "  share (especially Gemini); both including and excluding totals are published.",
        "- **estimate_accuracy**: pair an ESTIMATE with the next ESTIMATE_DONE that shares",
        "  a task key. Actual minutes come from `actual_minutes`, or else elapsed from",
        "  `started` (else the estimate row time) to the done-row timestamp. Ratio is",
        "  actual / `est_minutes`. On-time means actual is less than or equal to the",
        "  estimate. Median ratio and on-time percent are omitted when no pairs exist.",
        "- **board_rows_by_agent / by_phase**: every in-window board row. Phase is the",
        "  short `phase=` token; malformed long values are `OTHER`.",
        "- **prs_merged_by_repo**: GitHub merged counts, written as `sfdc-24/<repo>` plus a",
        "  count (not a title list). Pull requests are named repo-then-number when one is",
        "  cited (for example sfdc-24/sfdc24-site #389).",
        "- **conference_test_***: rows with `class=TEST`. Pass or fail is recorded only",
        "  when a short structured field (`verdict`, `status`, or phase) is PASS/FAIL/GO/",
        "  NO-GO. Loose keyword matches in free text are ignored.",
        "",
        "## Computed in this run",
        "",
    ]
    lines += [f"- {x}" for x in computed]
    lines += ["", "## Omitted (cannot be computed reliably)", ""]
    lines += [f"- {x}" for x in omitted]
    lines += [
        "",
        "## Rerun",
        "",
        "```",
        "python3 tools/fleet_pack/build_fleet_pack.py --out data/fleet-pack \\",
        "    --github-counts data/fleet-pack/github_merged_counts.json",
        "```",
        "",
        "The script talks to the board with `bus_cli_full.py` (read-only). A `--cache`",
        "file can be passed for a local rerun. Do not commit a board cache; it is private.",
        "",
    ]
    path.write_text("\n".join(lines), encoding="utf-8")


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Build the public fleet data pack")
    parser.add_argument("--out", required=True, help="Output directory, e.g. data/fleet-pack")
    parser.add_argument("--cache", help="Optional local board JSON cache (private, do not commit)")
    parser.add_argument("--github-counts", help="Optional GitHub merged-count snapshot JSON")
    parser.add_argument("--start", default="2026-09-01")
    parser.add_argument("--end", default=None, help="Inclusive end date, default today in Toronto")
    parser.add_argument("--tools", default=str(DEFAULT_TOOLS))
    args = parser.parse_args(argv)

    today = datetime.now(ET).date()
    window_start = date.fromisoformat(args.start)
    window_end = date.fromisoformat(args.end) if args.end else today
    since_utc = datetime.combine(window_start, time.min, tzinfo=ET).astimezone(UTC)

    rows, board_info = load_board_rows(
        Path(args.cache) if args.cache else None, since_utc, Path(args.tools)
    )
    data = collect(rows, window_start, window_end)

    prs = None
    if args.github_counts:
        prs = json.loads(Path(args.github_counts).read_text(encoding="utf-8"))

    generated = datetime.now(ET)
    weeks = iter_weeks(window_start, window_end)
    weekly = []
    for week_id in weeks:
        start, end = week_range(week_id, window_start, window_end)
        block = {
            "week": week_id,
            "start": start.isoformat(),
            "end": end.isoformat(),
        }
        block.update(week_metrics(data, week_id))
        add_pr_counts(block, prs, week_id)
        weekly.append(block)

    # Totals
    totals = empty_week_metrics()
    agent_rows = Counter()
    phase_rows = Counter()
    work_agents = Counter()
    done_agents = Counter()
    for block in weekly:
        totals["board_rows_total"] += block["board_rows_total"]
        totals["done_rows_including_waker"] += block["done_rows_including_waker"]
        totals["done_rows_excluding_waker"] += block["done_rows_excluding_waker"]
        totals["work_orders_total"] += block["work_orders_total"]
        totals["conference_test_rows"] += block["conference_test_rows"]
        totals["conference_test_pass"] += block["conference_test_pass"]
        totals["conference_test_fail"] += block["conference_test_fail"]
        totals["conference_test_outcome_unrecorded"] += block["conference_test_outcome_unrecorded"]
        agent_rows.update(block["board_rows_by_agent"])
        phase_rows.update(block["board_rows_by_phase"])
        work_agents.update(block["work_orders_by_agent"])
        done_agents.update(block["done_rows_by_agent_excluding_waker"])
    totals["board_rows_by_agent"] = dict(sorted(agent_rows.items()))
    totals["board_rows_by_phase"] = dict(sorted(phase_rows.items(), key=lambda kv: (-kv[1], kv[0])))
    totals["work_orders_by_agent"] = dict(sorted(work_agents.items()))
    totals["done_rows_by_agent_excluding_waker"] = dict(sorted(done_agents.items()))
    totals["estimate_accuracy"] = data["accuracy_total"]
    add_pr_counts(totals, prs, None)

    meta = {
        "generated_at": generated.isoformat(),
        "generated_at_utc": generated.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "timezone": "America/Toronto",
        "task": "TASK ID: G36",
        "window": {"start": window_start.isoformat(), "end": window_end.isoformat(), "inclusive": True},
        "board": {
            "first_row": data["first"],
            "last_row": data["last"],
            "rows_in_pack": len(data["parsed"]),
            "read": {k: v for k, v in board_info.items() if k != "path" or not str(v).startswith("/tmp") or True},
        },
        "estimates": {
            "estimate_rows": data["estimates"],
            "estimate_done_rows": data["estimate_dones"],
            "paired": (data["accuracy_total"] or {}).get("paired", 0),
        },
    }
    # Do not publish a private cache path.
    if isinstance(meta["board"]["read"], dict) and meta["board"]["read"].get("source") == "cache":
        meta["board"]["read"] = {"source": "cache"}

    computed = [
        "work_orders_by_agent and work_orders_total (unique TASK ID tokens)",
        "done_rows_including_waker, done_rows_excluding_waker, done_rows_by_agent_excluding_waker",
        "estimate_accuracy (median_ratio, on_time_pct) from paired ESTIMATE / ESTIMATE_DONE rows",
        "board_rows_by_agent and board_rows_by_phase",
        "conference_test_rows from class=TEST, with pass/fail only when a short field records it",
    ]
    omitted = [
        "mutant planted/killed totals: DONE/RESULT text is not consistently structured; numbers were not invented",
        "releases/deploys from the board: keyword matches are too noisy to be a release log",
        "scorecard utilization, error rate, and spend: the local scorecard files only cover 7-9 October 2026",
        "ledger-derived metrics: snapshots hold private file identifiers and were not aggregated",
    ]
    if prs:
        computed.append("prs_merged_by_repo and prs_merged_total from the GitHub merged-count snapshot")
    else:
        omitted.append("prs_merged_by_repo: no --github-counts snapshot was supplied for this run")

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    (out / "generated_at.json").write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
    (out / "weekly.json").write_text(json.dumps({"weeks": weekly}, indent=2) + "\n", encoding="utf-8")
    (out / "totals.json").write_text(json.dumps(totals, indent=2) + "\n", encoding="utf-8")
    milestones = {
        "timezone": "America/Toronto",
        "items": build_milestones(data, window_start, window_end, prs),
    }
    (out / "milestones.json").write_text(json.dumps(milestones, indent=2) + "\n", encoding="utf-8")
    write_readme(out / "README.md", meta, computed, omitted)
    if prs:
        # Re-emit the counts snapshot (already public-safe) so the pack is self-contained.
        snap = {
            "generated_at": prs.get("generated_at") or meta["generated_at_utc"],
            "query_window": prs.get("query_window") or f"{window_start}..{window_end}",
            "note": prs.get("note")
            or "GitHub search is:merged merged:START..END; counts only, no titles.",
            "totals": prs.get("totals") or {},
            "weekly": prs.get("weekly") or {},
        }
        (out / "github_merged_counts.json").write_text(json.dumps(snap, indent=2) + "\n", encoding="utf-8")

    print(
        json.dumps(
            {
                "ok": True,
                "out": str(out),
                "rows": len(data["parsed"]),
                "work_orders": totals["work_orders_total"],
                "paired_estimates": (data["accuracy_total"] or {}).get("paired", 0),
                "files": sorted(p.name for p in out.iterdir() if p.is_file()),
            }
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
