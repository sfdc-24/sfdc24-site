# Fleet data pack

Sanitized aggregates for sfdc24.com. TASK ID: G36.
This pack covers 1 September 2026 through the generation date, America/Toronto.
It contains counts and ratios only. It does not contain owner words, guest or
client names, emails, phones, board row ids, case numbers, tokens, or URLs of
private services.

## Generation

- generated_at (America/Toronto): 2026-11-12T01:01:20.125654-05:00
- window: 2026-09-01 through 2026-11-12 inclusive
- board rows in the readable sheet after 2026-09-01: 18782
- first board row in pack: 2026-09-18
- last board row in pack: 2026-11-12

## Sources

- Private board (Blackboard Alpha DB) via `/workspace/sfdc24-tools/bus_cli_full.py`
  `read_rows(limit=25000, since=2026-09-01T04:00:00Z)`, which is 00:00 America/Toronto
  on 1 September 2026 (that date was in daylight time). The readable sheet's first
  in-window row is 2026-09-18. Earlier weeks are zero on every
  board-derived metric.
- ESTIMATE and ESTIMATE_DONE rows, including `thread_id=TH-ESTIMATES`.
- DONE rows, split into including-waker and excluding-waker (`wakerreply=1`).
- Optional GitHub merged-pull-request counts (connector search, `merged:DATE..DATE`,
  `is:merged`) for sfdc-24/conference, sfdc-24/sfdc24-site, sfdc-24/Blackboard, and
  sfdc-24/converspan. GitHub's `merged:` filter uses UTC; ISO weeks in this pack use
  America/Toronto, so a merge near midnight UTC can fall in the neighbouring week.
- `scorecard_history.csv` and `scorecard_daily.json` were inspected and not used:
  they only cover 7-9 October 2026 and are stale.
- Ledger snapshots under `/workspace/sfdc24-tools/ledger` were inspected read-only
  and not used: they are file-index snapshots with private identifiers, not a clean
  public metric source.

## Agent names

Public names already used on sfdc24.com: Grok, Claude, Cursor, Codex, Gemini,
Copilot, and Jev. Seat names Clay, Greg, Jemma, and Cody also appear on the site
but are not used as separate series here (they map to Claude, Grok, Gemini, and
Cursor on the published ops metrics). Aya is not used; it was not found on the
public pages checked for this pack. `from=aya` and Codex desktop senders are
counted under Codex.

Work orders: a unique `TASK ID: …` token. `C` + digits is Cursor, `G` + digits is
Grok, anything else is attributed from the `from` field of the first row that
mentioned it. The `TASK ID:` label is recent, so early weeks are mostly zero.

Board-row agents: `from` (payload, else the sheet column), then prefix rules.
Intake channels are labelled `intake`. Automation senders are labelled `system`.
Anything else is `other`. No person names are emitted.

## Metric methods

- **work_orders_by_agent**: unique TASK IDs first seen in that week.
- **done_rows_***: `phase=DONE` or `msg_type=DONE`. Waker auto-rows are a large
  share (especially Gemini); both including and excluding totals are published.
- **estimate_accuracy**: pair an ESTIMATE with the next ESTIMATE_DONE that shares
  a task key. Actual minutes come from `actual_minutes`, or else elapsed from
  `started` (else the estimate row time) to the done-row timestamp. Ratio is
  actual / `est_minutes`. On-time means actual is less than or equal to the
  estimate. Median ratio and on-time percent are omitted when no pairs exist.
- **board_rows_by_agent / by_phase**: every in-window board row. Phase is the
  short `phase=` token; malformed long values are `OTHER`.
- **prs_merged_by_repo**: GitHub merged counts, written as `sfdc-24/<repo>` plus a
  count (not a title list). Pull requests are named repo-then-number when one is
  cited (for example sfdc-24/sfdc24-site #389).
- **conference_test_***: rows with `class=TEST`. Pass or fail is recorded only
  when a short structured field (`verdict`, `status`, or phase) is PASS/FAIL/GO/
  NO-GO. Loose keyword matches in free text are ignored.

## Computed in this run

- work_orders_by_agent and work_orders_total (unique TASK ID tokens)
- done_rows_including_waker, done_rows_excluding_waker, done_rows_by_agent_excluding_waker
- estimate_accuracy (median_ratio, on_time_pct) from paired ESTIMATE / ESTIMATE_DONE rows
- board_rows_by_agent and board_rows_by_phase
- conference_test_rows from class=TEST, with pass/fail only when a short field records it
- prs_merged_by_repo and prs_merged_total from the GitHub merged-count snapshot

## Omitted (cannot be computed reliably)

- mutant planted/killed totals: DONE/RESULT text is not consistently structured; numbers were not invented
- releases/deploys from the board: keyword matches are too noisy to be a release log
- scorecard utilization, error rate, and spend: the local scorecard files only cover 7-9 October 2026
- ledger-derived metrics: snapshots hold private file identifiers and were not aggregated

## Rerun

```
python3 tools/fleet_pack/build_fleet_pack.py --out data/fleet-pack \
    --github-counts data/fleet-pack/github_merged_counts.json
```

The script talks to the board with `bus_cli_full.py` (read-only). A `--cache`
file can be passed for a local rerun. Do not commit a board cache; it is private.
