# Fleet data pack

Sanitized aggregates for sfdc24.com. TASK ID: G36b.
This pack covers 1 September 2026 through the generation date, America/Toronto.
It contains counts and ratios only. It does not contain owner words, guest or
client names, emails, phones, row ids, case numbers, tokens, or URLs of
private services. It also omits per-phase and per-agent row counts, counts by
message type, and any name outside the fleet agents Claude, Codex, Cursor,
Gemini, and Grok.

## Generation

- generated_at (America/Toronto): 2026-11-12T01:20:50.209821-05:00
- window: 2026-09-01 through 2026-11-12 inclusive

## How it is built

- Delivery work-order and DONE counts, plus estimate accuracy from paired
  ESTIMATE and ESTIMATE_DONE rows.
- DONE totals are published both including and excluding automated waker rows.
- Optional GitHub merged-pull-request counts (connector search, `merged:DATE..DATE`,
  `is:merged`) for sfdc-24/conference, sfdc-24/sfdc24-site, sfdc-24/Blackboard, and
  sfdc-24/converspan. GitHub's `merged:` filter uses UTC; ISO weeks in this pack use
  America/Toronto, so a merge near midnight UTC can fall in the neighbouring week.
- Local scorecard files covering only 7-9 October 2026 were inspected and not used.
- Ledger snapshots were inspected read-only and not used: they hold private
  identifiers, not a clean public metric series.

## Agent names

Public fleet agents in this pack: Claude, Codex, Cursor, Gemini, and Grok.
Work orders: a unique `TASK ID: …` token. `C` + digits is Cursor, `G` + digits is
Grok, anything else is attributed from the first matching fleet agent. Only those
five names appear in by-agent maps. The `TASK ID:` label is recent, so early
weeks are mostly zero.

## Metric methods

- **work_orders_by_agent**: unique TASK IDs first seen in that week, fleet agents only.
- **done_rows_***: DONE rows. Automated waker rows are a large share; both including
  and excluding totals are published. The by-agent excluding map lists fleet agents only.
- **estimate_accuracy**: pair an ESTIMATE with the next ESTIMATE_DONE that shares
  a task key. Actual minutes come from `actual_minutes`, or else elapsed from
  `started` (else the estimate row time) to the done-row timestamp. Ratio is
  actual / `est_minutes`. On-time means actual is less than or equal to the
  estimate. Median ratio and on-time percent are omitted when no pairs exist.
- **prs_merged_by_repo**: GitHub merged counts, written as `sfdc-24/<repo>` plus a
  count (not a title list). Pull requests are named repo-then-number when one is
  cited (for example sfdc-24/sfdc24-site #389).
- **milestones**: dated, short facts. Date and text only.

## Computed in this run

- work_orders_by_agent and work_orders_total (unique TASK ID tokens; fleet agents only in the by-agent map)
- done_rows_including_waker, done_rows_excluding_waker, done_rows_by_agent_excluding_waker (fleet agents only)
- estimate_accuracy (median_ratio, on_time_pct) from paired ESTIMATE / ESTIMATE_DONE rows
- milestones (date and text only)
- prs_merged_by_repo and prs_merged_total from the GitHub merged-count snapshot

## Omitted

- board_rows_by_agent, board_rows_by_phase, and any other per-phase or per-agent row counts: the public pack is delivery aggregates only
- counts by message type or phase, including owner-decision and intake-message categories
- names other than Claude, Codex, Cursor, Gemini, and Grok, and any system or waker buckets
- per-item origin fields, internal thread labels, and internal delivery-record locations
- mutant planted/killed totals: DONE/RESULT text is not consistently structured; numbers were not invented
- releases/deploys from delivery records: keyword matches are too noisy to be a release log
- scorecard utilization, error rate, and spend: the local scorecard files only cover 7-9 October 2026
- ledger-derived metrics: snapshots hold private file identifiers and were not aggregated
- conference test pass/fail counts: not part of the public delivery aggregate

## Rerun

```
python3 tools/fleet_pack/build_fleet_pack.py --out data/fleet-pack \
    --github-counts data/fleet-pack/github_merged_counts.json
```

The script writes aggregates only. A `--cache` file can be passed for a local
rerun. Do not commit a cache; it is not public.
