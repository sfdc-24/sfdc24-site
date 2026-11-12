#!/usr/bin/env python3
"""Rebuild public site data for TASK ID: C69.

Counts come from the public GitHub API. Identifiers, branch names, review
verdicts, and fleet-pack source fields are not written. A missing source
stays unavailable. This does not invent a count.

    python3 scripts/refresh_site_data.py
    python3 scripts/refresh_site_data.py --commit
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from tools.privacy_publish import problems, reduce_tracker, strip_published  # noqa: E402

WINDOW_START = "2026-09-01T00:00:00Z"
REPOS = ("sfdc-24/sfdc24-site", "sfdc-24/Blackboard", "sfdc-24/conference")


def _now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).strftime("%Y-%m-%dT%H:%M:%SZ")


def _gh(path: str) -> tuple[int, str]:
    proc = subprocess.run(
        ["gh", "api", path],
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=45,
    )
    return proc.returncode, proc.stdout


def _search_count(query: str) -> int | None:
    code, out = _gh("search/issues?q=" + query.replace(" ", "+") + "&per_page=1")
    if code:
        return None
    try:
        total = json.loads(out).get("total_count")
    except json.JSONDecodeError:
        return None
    return total if isinstance(total, int) else None


def _repo_counts(repo: str) -> dict:
    opened = _search_count(f"repo:{repo} is:pr created:>={WINDOW_START[:10]}")
    merged = _search_count(f"repo:{repo} is:pr is:merged merged:>={WINDOW_START[:10]}")
    if opened is None and merged is None:
        return {"unavailable": True}
    return {"opened": opened, "merged": merged, "unavailable": False}


def _ci_count(repo: str) -> int | None:
    code, out = _gh(f"repos/{repo}/actions/runs?created=>={WINDOW_START}&per_page=1")
    if code:
        return None
    try:
        total = json.loads(out).get("total_count")
    except json.JSONDecodeError:
        return None
    return total if isinstance(total, int) else None


def _tags(repo: str) -> list | None:
    code, out = _gh(f"repos/{repo}/git/matching-refs/tags/milestone")
    if code:
        return None
    try:
        data = json.loads(out)
    except json.JSONDecodeError:
        return None
    return data if isinstance(data, list) else None


def _pass_from_tags(milestones: dict) -> list[str]:
    """Flip status only when an annotated milestone/<id>-passed tag is visible."""
    notes = []
    rows = {row.get("id"): row for row in milestones.get("milestones") or [] if isinstance(row, dict)}
    for repo in ("sfdc-24/sfdc24-site", "sfdc-24/conference"):
        refs = _tags(repo)
        if refs is None:
            notes.append(f"{repo} tags unavailable")
            continue
        for ref in refs:
            name = str(ref.get("ref") or "")
            prefix = "refs/tags/milestone/"
            if not name.startswith(prefix) or not name.endswith("-passed"):
                continue
            ident = name[len(prefix):-len("-passed")]
            row = rows.get(ident)
            obj = ref.get("object") or {}
            if obj.get("type") != "tag" or row is None:
                continue
            code, out = _gh(f"repos/{repo}/git/tags/{obj.get('sha')}")
            if code:
                notes.append(f"{repo} {ident} tag object unavailable")
                continue
            try:
                tag = json.loads(out)
            except json.JSONDecodeError:
                continue
            passed_at = ((tag.get("tagger") or {}).get("date")) or None
            if not isinstance(passed_at, str):
                continue
            row["status"] = "passed"
            row["passed_at"] = passed_at
            row["evidence"] = f"https://github.com/{repo}/releases/tag/milestone/{ident}-passed"
            notes.append(f"{ident} passed from {repo}")
    return notes


def _write(path: Path, payload: dict) -> None:
    text = json.dumps(payload, indent=2, ensure_ascii=False) + "\n"
    found = problems(text)
    if found:
        raise SystemExit(f"refusing to write {path.name}: {', '.join(found)}")
    path.write_text(text, encoding="utf-8")


def _activity() -> dict:
    repos = {}
    for repo in REPOS:
        short = repo.split("/")[1]
        repos[short] = _repo_counts(repo)
    ci = _ci_count("sfdc-24/sfdc24-site")
    return {
        "generated_at": _now(),
        "window": {"start": "2026-09-01", "end": _now()[:10]},
        "coverage": "Totals only. The conference repository is included when readable and marked unavailable otherwise. Identifiers are not stored.",
        "repos": repos,
        "ci_runs": ci,
        "withheld": ["identifiers", "branch names", "review verdicts", "personal rows"],
    }


def _fleet() -> list[str]:
    notes = []
    pack = ROOT / "data" / "fleet-pack"
    if not pack.is_dir():
        return ["fleet pack absent"]
    for name in ("milestones.json", "totals.json", "manifest.json"):
        path = pack / name
        if not path.is_file():
            notes.append(f"{name} absent")
            continue
        try:
            doc = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            notes.append(f"{name} unreadable")
            continue
        _write(path, strip_published(doc))
        notes.append(f"{name} stripped")
    tracker = ROOT / "data" / "v6-tracker.json"
    if tracker.is_file():
        try:
            doc = json.loads(tracker.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            notes.append("v6 tracker unreadable")
        else:
            _write(tracker, reduce_tracker(doc if isinstance(doc, dict) else {}))
            notes.append("v6 tracker reduced to counts")
    else:
        notes.append("v6 tracker absent")
    return notes


def _history() -> str:
    proc = subprocess.run(
        [sys.executable, str(ROOT / "tools" / "build_history_timeline.py")],
        cwd=ROOT, capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    return "history timeline regenerated" if proc.returncode == 0 else "history timeline unchanged"


def _field_list(value, prefix="") -> list[str]:
    if not isinstance(value, dict):
        return [prefix or "(value)"]
    lines = []
    for key, item in value.items():
        here = f"{prefix}.{key}" if prefix else key
        if isinstance(item, dict):
            lines.extend(_field_list(item, here))
        elif isinstance(item, list) and item and isinstance(item[0], dict):
            lines.append(here + "[]")
            lines.extend(_field_list(item[0], here + "[]"))
        else:
            lines.append(here)
    return lines


def _audit(activity: dict, notes: list[str]) -> None:
    lines = [
        "# Data refresh audit, 12 Nov 2026",
        "",
        "TASK ID: C69. Window: 1 Sep 2026 through 12 Nov 2026.",
        "The site is public. Refreshed figures are aggregates. A missing source is unavailable.",
        "",
        "## Estimate",
        "",
        "- by: cursor",
        "- relayer: grok",
        "- task: TASK ID: C69",
        "- started: 2026-11-12T05:51:00Z",
        "- est_minutes: 180, then 240 after the header, milestone, and privacy rulings",
        "- est_done: 2026-11-12T09:51:00Z (04:51 America/Toronto)",
        "",
        "## What was readable",
        "",
        "- sfdc-24/sfdc24-site: public. Pull-request totals and workflow totals.",
        "- sfdc-24/Blackboard: public. Pull-request totals.",
        "- sfdc-24/conference: not readable with this token. Its counts stay unavailable.",
        "- No milestone pass tag was required to invent a date. V3 keeps the supplied time.",
        "",
        "## Unavailable",
        "",
        "- Conference pull-request and workflow totals.",
        "- Chair test and break-it counts after 6 Nov 2026 (they live in the conference repository).",
        "- Estimate-versus-actual ratios and review verdicts (no fleet pack, and verdicts are not published).",
        "- Visitor totals, the live fleet picture, and per-task board rows.",
        "- v6 tracker rows, until a file is present. The reducer keeps counts only.",
        "",
        "## Fleet and tracker",
        "",
    ]
    lines.extend(f"- {note}" for note in notes)
    lines.extend(["", "## Public data files and the fields they expose", ""])
    data = ROOT / "data"
    for path in sorted(data.rglob("*.json")):
        if path.name.endswith(".json") and "fleet-pack" in path.parts:
            continue
        try:
            doc = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            lines.append(f"- `{path.relative_to(ROOT)}`: not valid JSON")
            continue
        fields = ", ".join(_field_list(doc)[:40])
        lines.append(f"- `{path.relative_to(ROOT)}`: {fields}")
    lines.extend([
        "",
        "## Activity totals this run",
        "",
        "```json",
        json.dumps(activity.get("repos"), indent=2),
        "```",
        "",
        f"Site workflow runs in the window: {activity.get('ci_runs')}.",
        "",
    ])
    (ROOT / "docs" / "DATA-REFRESH-AUDIT-20261112.md").write_text("\n".join(lines), encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--commit", action="store_true")
    args = parser.parse_args(argv)
    milestones_path = ROOT / "data" / "release-milestones.json"
    milestones = json.loads(milestones_path.read_text(encoding="utf-8"))
    notes = _pass_from_tags(milestones)
    milestones["updated"] = _now()
    _write(milestones_path, strip_published(milestones))
    activity = _activity()
    _write(ROOT / "data" / "public-activity.json", activity)
    notes.extend(_fleet())
    notes.append(_history())
    _audit(activity, notes)
    if args.commit:
        subprocess.run(["git", "add", "data", "docs/DATA-REFRESH-AUDIT-20261112.md"], cwd=ROOT, check=False)
        diff = subprocess.run(["git", "diff", "--cached", "--quiet"], cwd=ROOT)
        if diff.returncode != 0:
            subprocess.run(
                ["git", "commit", "-m", "TASK ID: C69 Refresh public site data [skip ci]"],
                cwd=ROOT, check=False,
            )
    print("\n".join(notes))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
