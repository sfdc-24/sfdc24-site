"""Per-agent utilization, error rate and efficiency for /ops, from the repositories themselves.

    python tools/ops_agent_metrics.py [--days 7] [--out data/ops-agent-metrics.json]

It reads GitHub with the `gh` CLI (the caller's own login) and writes one snapshot. Every number
comes from a public record anyone can re-read: pull requests, their commits, and the review
verdicts posted on them. Nothing is estimated, and an agent with no record in the window shows
no numbers, never zeros.

WHO IS WHO: a pull request belongs to the agent whose branch prefix it was opened from
(claude-code-cli/, codex/, cursor/, copilot/, grok/, gemini/). The ownership rule of each repo
(tools/check_ownership.py in the conference repo) holds every branch to its prefix's folders.

THE MEASURES, over the window (the last DAYS days before `observed_at`):
- utilization: the share of the window's hours in which the agent did repository work: opened a
  pull request, pushed a commit to one, or had one merged. An hour counts once.
- error rate: of the review verdicts posted on the agent's pull requests (Cody's and Aya's
  GO / NO-GO), the share that were NO-GO. A NO-GO is a defect found before merge.
- efficiency: the median hours from a pull request opened to merged, over those merged.
- who did what: how many of its pull requests were merged in each repository, and the titles of
  those in public repositories, newest first. The private conference repository contributes counts
  only, never titles. Blackboard (board) is public: its titles may appear when they pass BANNED.
  A public title that names a person or a client, or carries a word the site does not use, is left
  out (BANNED). Jenny and Greg also work on the board outside pull requests: their rows keep a
  note that board/chat/waker activity is not counted in utilization.
"""
from __future__ import annotations

import argparse
import concurrent.futures
import datetime as dt
import json
import re
import statistics
import subprocess
import sys

REPOS = ["sfdc-24/sfdc24-site", "sfdc-24/Blackboard", "sfdc-24/conference"]
AGENTS = [("claude-code-cli/", "Claude"), ("codex/", "Aya"), ("cursor/", "Cody"), ("copilot/", "Paired review"),
          ("grok/", "Greg"), ("gemini/", "Jenny")]
BOARD_ONLY = {"Greg": "Works mostly on the board (strategy and dispatch), not in pull requests.",
              "Jenny": "Works on the board through its waker (reviews and reasoning), not in pull requests."}
WHAT_MAX = 5
# Words a public title may not carry onto the page: people and the site's banned copy.
BANNED = ("salam", "yasmine", "nav ", "client", "motherboard", "mr.", "dr.")


def gh(path: str):
    out = subprocess.run(["gh", "api", path], capture_output=True, text=True, encoding="utf-8", errors="replace")
    if out.returncode:
        raise RuntimeError("gh api %s: %s" % (path, out.stderr.strip()[:200]))
    return json.loads(out.stdout or "null")


def when(stamp):
    return dt.datetime.fromisoformat(stamp.replace("Z", "+00:00")) if stamp else None


def pulls(repo: str, since: dt.datetime) -> list:
    """Pull requests created at or after `since`, newest first (the list is sorted by creation)."""
    found = []
    for page in range(1, 11):
        batch = gh("repos/%s/pulls?state=all&sort=created&direction=desc&per_page=100&page=%d" % (repo, page))
        for pr in batch:
            if when(pr["created_at"]) < since:
                return found
            found.append(pr)
        if len(batch) < 100:
            break
    return found


# The decision a review opens with: the first of these in its text. A GO that goes on to name the
# NO-GO it closed is a GO; "Not GO" is a NO-GO (Cursor on #261, c84a136: reading the head as a bag
# of letters stored 16 opening GOs as NO-GO and 2 "Not GO" as GO).
DECISION = re.compile(r"(?i:\bnot\s+go\b)|\bNO-GO\b|\bGO\b")


def verdict(comment) -> str | None:
    """GO or NO-GO when a comment is Cursor's or Codex's review verdict, else None."""
    body, who = (comment.get("body") or "").strip(), comment["user"]["login"]
    head = body[:200].replace("*", "").replace("`", "")
    if not (who == "cursor[bot]" or head.lstrip().startswith("Codex")):
        return None
    first = DECISION.search(head)
    if first is None:
        return None
    return "GO" if first.group(0) == "GO" else "NO-GO"


def verdicts_of(comments) -> list:
    """The review verdicts on one pull request, in order; the same verdict posted twice in a row
    (the same opening words, back to back) counts once."""
    out, last = [], None
    for c in comments:
        v = verdict(c)
        if v is None:
            continue
        opening = " ".join((c.get("body") or "").split())[:120]
        if opening == last:
            continue
        last = opening
        out.append(v)
    return out


def detail(repo: str, pr: dict) -> dict:
    n = pr["number"]
    commits = gh("repos/%s/pulls/%d/commits?per_page=100" % (repo, n)) or []
    comments = gh("repos/%s/issues/%d/comments?per_page=100" % (repo, n)) or []
    verdicts = verdicts_of(comments)
    return {"repo": repo, "number": n, "title": pr["title"], "branch": pr["head"]["ref"],
            "created": pr["created_at"], "merged": pr.get("merged_at"), "closed": pr.get("closed_at"),
            "commits": [c["commit"]["committer"]["date"] for c in commits],
            "go": verdicts.count("GO"), "nogo": verdicts.count("NO-GO")}


def public_title(title: str) -> bool:
    return not any(word in (title or "").lower() for word in BANNED)


def agent_of(branch: str) -> str | None:
    return next((name for prefix, name in AGENTS if branch.startswith(prefix)), None)


def measure(records: list, start: dt.datetime, end: dt.datetime, private=frozenset()) -> dict:
    hours = int((end - start).total_seconds() // 3600)
    by = {name: [] for _, name in AGENTS}
    for r in records:
        name = agent_of(r["branch"])
        if name:
            by[name].append(r)
    out = []
    for _, name in AGENTS:
        mine = by[name]
        active = set()
        for r in mine:
            for stamp in [r["created"], r["merged"]] + r["commits"]:
                t = when(stamp)
                if t and start <= t <= end:
                    active.add(int((t - start).total_seconds() // 3600))
        merged = [r for r in mine if r["merged"]]
        verdicts = sum(r["go"] + r["nogo"] for r in mine)
        nogo = sum(r["nogo"] for r in mine)
        to_merge = [(when(r["merged"]) - when(r["created"])).total_seconds() / 3600 for r in merged]
        row = {"agent": name, "pull_requests": len(mine), "merged": len(merged),
               "closed_unmerged": sum(1 for r in mine if r["closed"] and not r["merged"]),
               "active_hours": len(active), "window_hours": hours,
               "utilization": round(len(active) / hours, 3) if mine else None,
               "verdicts": verdicts, "nogo": nogo,
               "error_rate": round(nogo / verdicts, 3) if verdicts else None,
               "median_hours_to_merge": round(statistics.median(to_merge), 1) if to_merge else None,
               "merged_by_repo": {repo.split("/")[1]: n for repo in sorted({r["repo"] for r in merged})
                                  for n in [sum(1 for r in merged if r["repo"] == repo)]},
               "did": [{"repo": r["repo"].split("/")[1], "number": r["number"], "title": r["title"][:120]}
                       for r in sorted(merged, key=lambda r: r["merged"], reverse=True)
                       if r["repo"] not in private and public_title(r["title"])][:WHAT_MAX]}
        if name in BOARD_ONLY:
            # Always surface the undercount: board/waker work is outside PR attribution.
            row["note"] = BOARD_ONLY[name]
        out.append(row)
    return out


def main(argv) -> int:
    args = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    args.add_argument("--days", type=int, default=7)
    args.add_argument("--out", default="data/ops-agent-metrics.json")
    opts = args.parse_args(argv[1:])
    end = dt.datetime.now(dt.timezone.utc).replace(microsecond=0)
    start = end - dt.timedelta(days=opts.days)
    private = frozenset(repo for repo in REPOS if gh("repos/%s" % repo).get("private", True))
    listed = [(repo, pr) for repo in REPOS for pr in pulls(repo, start) if agent_of(pr["head"]["ref"])]
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        records = list(pool.map(lambda item: detail(*item), listed))
    snapshot = {
        "observed_at": end.strftime("%Y-%m-%dT%H:%M:%SZ"), "window_start": start.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "window_days": opts.days, "repos": REPOS, "private_repos": sorted(private),
        "definitions": {
            "utilization": "Share of the window's hours with repository work by the agent: a pull request "
                           "opened, a commit pushed to one, or one merged.",
            "error_rate": "Share of the review verdicts on its pull requests (Cody's and Aya's GO / NO-GO) "
                          "that were NO-GO: defects found before merge.",
            "efficiency": "Median hours from a pull request opened to merged (hours, not a percent).",
            "attribution": "A pull request belongs to the agent whose branch prefix it came from.",
            "scope": "Repositories: public sfdc24-site and Blackboard, plus private conference. "
                     "Private conference contributes counts only (no titles). "
                     "Board chat/waker activity is outside these rates."},
        "agents": measure(records, start, end, private)}
    with open(opts.out, "w", encoding="utf-8", newline="\n") as f:
        json.dump(snapshot, f, indent=1, ensure_ascii=False)
        f.write("\n")
    print("%d pull requests by agents, %s to %s -> %s" % (len(records), snapshot["window_start"],
                                                           snapshot["observed_at"], opts.out))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
