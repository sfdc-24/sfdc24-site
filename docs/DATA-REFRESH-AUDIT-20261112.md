# Data refresh audit, 12 Nov 2026

TASK ID: C69. Window: 1 Sep 2026 through 12 Nov 2026.
The site is public. Refreshed figures are aggregates. A missing source is unavailable.

## Estimate

- by: cursor
- relayer: grok
- task: TASK ID: C69
- started: 2026-11-12T05:51:00Z
- est_minutes: 180, then 240 after the header, milestone, and privacy rulings
- est_done: 2026-11-12T09:51:00Z (04:51 America/Toronto)

## What was readable

- sfdc-24/sfdc24-site: public. Pull-request totals and workflow totals.
- sfdc-24/Blackboard: public. Pull-request totals.
- sfdc-24/conference: not readable with this token. Its counts stay unavailable.
- No milestone pass tag was required to invent a date. V3 keeps the supplied time.

## Unavailable

- Conference pull-request and workflow totals.
- Chair test and break-it counts after 6 Nov 2026 (they live in the conference repository).
- Estimate-versus-actual ratios and review verdicts (no fleet pack, and verdicts are not published).
- Visitor totals, the live fleet picture, and per-task board rows.
- v6 tracker rows, until a file is present. The reducer keeps counts only.

## Fleet and tracker

- sfdc-24/conference tags unavailable
- fleet pack absent
- history timeline regenerated

## Public data files and the fields they expose

- `data/board-ops-snap.json`: agents[], agents[].id, agents[].last_seen, agents[].open_dispatch, agents[].phase, agents[].status, agents[].task, agents[].writes_1h, bake_every_min, baked_at, branches[], branches[].kind, branches[].merged, branches[].name, ci[], ci[].conclusion, ci[].name, ci[].repo, ci[].ts, ci[].url, edges[], edges[].from, edges[].phase, edges[].to, edges[].ts, envs[], envs[].health, envs[].id, envs[].label, envs[].note, open_work[], open_work[].age_min, open_work[].from, open_work[].id, open_work[].lane, open_work[].next, open_work[].phase, open_work[].title, open_work[].to, refresh_sec
- `data/build-rigor.json`: as_of, source, chair_tests[], chair_tests[].date, chair_tests[].count, chair_break_it_checks[], chair_break_it_checks[].date, chair_break_it_checks[].count, changes_merged.this_week.from, changes_merged.this_week.to, changes_merged.this_week.count, changes_merged.week_before.from, changes_merged.week_before.to, changes_merged.week_before.count, changes_merged.daily[], changes_merged.daily[].date, changes_merged.daily[].count, changes_merged.since.from, changes_merged.since.count
- `data/choice-design-pilot.json`: schema_version, design_id, status, source, profiles_per_choice_set, choice_sets_per_survey, attributes[], attributes[].name, attributes[].levels, analysis_contract.format, analysis_contract.response_indicator, analysis_contract.selected_values, analysis_contract.exactly_one_selected_per_choice_set, analysis_contract.model, privacy.cookies, privacy.persistent_cross_session_id, privacy.allowed_subject_id, visitor_surface.path, visitor_surface.kind, visitor_surface.applies_to_site
- `data/delivery-ledger.json`: updated_at_et, target_release_date, timezone, program, summary.completed, summary.in_progress, summary.scheduled, summary.checkpoints, summary.on_time_rate, entries[], entries[].id, entries[].date, entries[].window_et, entries[].phase, entries[].owner, entries[].summary, entries[].status, entries[].delta, entries[].next48h, metrics.target_date, metrics.days_total, metrics.days_elapsed, metrics.overall_status, metrics.measured_nov09_tasks_closed, metrics.measured_nov09_on_time_pct, metrics.measured_nov09_actual_over_est, metrics.checkpoints[], metrics.checkpoints[].id, metrics.checkpoints[].ledger_ref, metrics.checkpoints[].title, metrics.checkpoints[].target_date, metrics.checkpoints[].target_window, metrics.checkpoints[].status, metrics.checkpoints[].planned_outcome, metrics.checkpoints[].actual_outcome, metrics.checkpoints[].retrospective_trigger, metrics.checkpoints[].adjustment, metrics.retrospectives[], metrics.retrospectives[].id, metrics.retrospectives[].date
- `data/delivery-metrics-measured.json`: generated_utc, method.merged_prs, method.median_open_to_merge_hours, method.tasks_estimated_and_closed, method.on_time_pct, method.median_actual_over_estimate, method.independent_reviews, method.review_pass_pct, method.passing_fault_injection_runs, coverage, weeks[], weeks[].week_of, weeks[].merged_prs, weeks[].median_open_to_merge_hours, weeks[].tasks_estimated_and_closed, weeks[].on_time_pct, weeks[].median_actual_over_estimate, weeks[].independent_reviews, weeks[].review_pass_pct, weeks[].passing_fault_injection_runs
- `data/desk.json`: (value)
- `data/guest-join.json`: serviceUrl
- `data/history-milestones.json`: _, _why, _rule, events[], events[].ts, events[].subject, events[].source
- `data/history-timeline.json`: since, timezone, title, started, count, events[], events[].sha, events[].ts, events[].subject
- `data/latest-release.json`: timezone, latest.repo, latest.pr, latest.title, latest.merged_at, latest.sha, next.contains
- `data/next-release.json`: note, at, start, cooking, later
- `data/ops-agent-metrics.json`: observed_at, window_start, window_days, repos, private_repos, definitions.utilization, definitions.error_rate, definitions.efficiency, definitions.attribution, definitions.scope, agents[], agents[].agent, agents[].pull_requests, agents[].merged, agents[].closed_unmerged, agents[].active_hours, agents[].window_hours, agents[].utilization, agents[].verdicts, agents[].nogo, agents[].error_rate, agents[].median_hours_to_merge, agents[].merged_by_repo.Blackboard, agents[].merged_by_repo.conference, agents[].merged_by_repo.sfdc24-site, agents[].did[], agents[].did[].repo, agents[].did[].number, agents[].did[].title
- `data/ops-delivery-policy.json`: sfdc-24/conference, sfdc-24/sfdc24-site
- `data/ops-delivery.json`: schema_version, observed_at, items[], items[].id, items[].title, items[].project, items[].owner, items[].assignment, items[].next, items[].evidence, items[].stage, items[].status, items[].observed_at, items[].source, items[].periods[], items[].periods[].stage, items[].periods[].kind, items[].periods[].start, items[].periods[].end
- `data/ops-storyboard.json`: baked_at, entries[], entries[].caption, entries[].date, entries[].illustration, entries[].title, grain, source, v
- `data/org.json`: _meta.live, _meta.snapshot, _meta.caveat, _meta.org_host, _meta.org_kind, _meta.generated, _meta.api, _meta.counts.accounts, _meta.counts.contacts, _meta.counts.opportunities, _meta.fields_withheld, _meta.why_withheld, summary.accounts, summary.contacts, summary.opportunities, summary.pipeline_open, summary.closed_won, summary.closed_lost, summary.open_count, summary.won_count, summary.lost_count, summary.largest_open, summary.by_stage.Closed Won.count, summary.by_stage.Closed Won.amount, summary.by_stage.Needs Analysis.count, summary.by_stage.Needs Analysis.amount, summary.by_stage.Negotiation/Review.count, summary.by_stage.Negotiation/Review.amount, summary.by_stage.Proposal/Price Quote.count, summary.by_stage.Proposal/Price Quote.amount, summary.by_stage.Value Proposition.count, summary.by_stage.Value Proposition.amount, summary.by_stage.Perception Analysis.count, summary.by_stage.Perception Analysis.amount, summary.by_stage.Prospecting.count, summary.by_stage.Prospecting.amount, summary.by_stage.Id. Decision Makers.count, summary.by_stage.Id. Decision Makers.amount, summary.by_stage.Qualification.count, summary.by_stage.Qualification.amount
- `data/pr-board-public.json`: as_of, enabled, rows, turnaround.days, turnaround.rows
- `data/present-join.json`: serviceUrl
- `data/proto-canvas.json`: format, read_at, public_status, note, items[], items[].id, items[].set, items[].set_label, items[].type, items[].title, items[].horizon, items[].status, items[].example, items[].by, items[].source, items[].penpot
- `data/proto-org-model.json`: live, snapshot, generated, source, caveat, fields_withheld, relationship_note, objects[], objects[].name, objects[].fields[], objects[].fields[].name, objects[].fields[].type, relationships[], relationships[].from, relationships[].to, relationships[].label
- `data/public-activity.json`: generated_at, window.start, window.end, coverage, repos.sfdc24-site.opened, repos.sfdc24-site.merged, repos.sfdc24-site.unavailable, repos.Blackboard.opened, repos.Blackboard.merged, repos.Blackboard.unavailable, repos.conference.unavailable, ci_runs, withheld
- `data/release-milestones.json`: updated, convention, milestones[], milestones[].id, milestones[].label, milestones[].at, milestones[].status, milestones[].passed_at, milestones[].evidence
- `data/releases.json`: cadence, current.version, current.pr, current.title, current.sha, current.date, next.cadence, next.date, next.summary, next.items, history[], history[].pr, history[].title, history[].label, history[].sha, history[].date
- `data/site-manifest.json`: built, scope, paths.home, paths.chrome_css, paths.chrome_js, paths.triage_py, paths.triage_js, paths.agents, off_scope_examples, css_variables, templates.static_section.kind, templates.static_section.wrap, inventory[], inventory[].id, inventory[].text, inventory[].present, inventory[].offset, inventory[].where, escalation_rules
- `data/visitor-stats.json`: as_of, timezone, label, visitors_to_date, activities, top_asks, note
- `data/xp-fixture.json`: read_at, keys.v1:agent:canon.codex, keys.v1:agent:canon.aya, keys.v1:agent:canon.pi1-cli, keys.v1:agent:canon.pi2-cli, keys.v1:agent:family:claude.name, keys.v1:agent:family:claude.role, keys.v1:agent:family:claude.instances, keys.v1:agent:family:codex.name, keys.v1:agent:family:codex.role, keys.v1:agent:family:codex.instances, keys.v1:agent:family:gemini.name, keys.v1:agent:family:gemini.role, keys.v1:agent:family:gemini.instances, keys.v1:agent:family:grok.name, keys.v1:agent:family:grok.role, keys.v1:agent:family:grok.instances, keys.v1:agent:family:cursor.name, keys.v1:agent:family:cursor.role, keys.v1:agent:family:cursor.instances, keys.v1:agent:family:pi.name, keys.v1:agent:family:pi.role, keys.v1:agent:family:pi.instances, keys.v1:agent:pi1-cli.family, keys.v1:agent:pi1-cli.runtime, keys.v1:agent:pi1-cli.state, keys.v1:agent:pi1-cli.redis_read, keys.v1:agent:claude-code-cli.family, keys.v1:agent:claude-code-cli.runtime, keys.v1:agent:claude-code-cli.state, keys.v1:agent:claude-code-cli.redis_read, keys.v1:agent:claude-code-cli.last_seen, keys.v1:agent:claude-api.family, keys.v1:agent:claude-api.runtime, keys.v1:agent:claude-api.state, keys.v1:agent:claude-api.redis_read, keys.v1:agent:vm-claude-code-cli.family, keys.v1:agent:vm-claude-code-cli.runtime, keys.v1:agent:vm-claude-code-cli.state, keys.v1:agent:vm-claude-code-cli.redis_read
- `data/xp-live.json`: public_status

## V6 task tracker

`data/v6-tracker.json` is the public V6 task tracker. It is meant to be regenerated from the board. `scripts/refresh_site_data.py` has a TODO hook, `_v6_tracker`, that leaves the sanitized file in place because this refresh cannot read the private board. The page counts Done, Built not merged, In progress, Waiting, Rework, and Not started from the rows. The as-of line is `Status at 12:20 am ET, Thu Nov 12 2026`.

The header milestones after V3 are planned times from the road-to-launch table, America/Toronto (`-05:00`): Test 2 on 14 Nov at 3:00 pm, Test 3 on 18 Nov at 3:00 pm, v6.0-rc1 at the start of 22 Nov because that row has a day and no clock, Test 4 on 23 Nov at 3:00 pm, v6.0-gold on 23 Nov at 4:00 pm, the production train on 24 Nov at 7:30 am, and Test 5 on 24 Nov at 5:00 pm. None of these is marked passed. Passing still requires a `milestone/<id>-passed` tag.

| Element | Reads |
|---|---|
| V6 counters, status bars, burndown, assignee table, three tables, release-train timeline | `data/v6-tracker.json` rows. Counters are not stored as a separate source of truth |
| Header countdown after V3 | `data/release-milestones.json` planned rows T2, T3, v6.0-rc1, T4, v6.0-gold, prod-train, T5 |

## Delivery page, what each element reads

Brought in from `grok/site-refresh-data` at `35191419d22266b7e9a37037c815af9e6c701ab1` (TASK ID: G36). The milestone `source` field is removed before publication. Phase maps and per-agent board-row counts stay in the pack file and are not drawn.

| Element | Reads | If the pack has no figure |
|---|---|---|
| Release trains | `data/releases.json`, `data/release-milestones.json`, `data/build-rigor.json`, `data/fleet-pack/milestones.json` (date and text only) | The homepage files' own as-of dates stay on the cards |
| On time, median actual / estimate | `data/fleet-pack/totals.json` `estimate_accuracy`, and the same fields on each week | `not tracked yet` (weeks before 2 Nov) |
| Actual / estimate by seat | not in the pack | `not tracked yet` on every seat row |
| Work done, work orders | `totals.json` and `weekly.json`, excluding automatic replies for the work-done series | zero when the pack's week is zero, including 1 Sep and 7 Sep |
| Merged pull requests, by week and by repository | `weekly.json` `prs_merged_by_repo` | zero where the pack counted zero |
| Acceleration | previous week's merged count and work-done count, subtracted | `not tracked yet` on the first week |
| Conference tests | `totals.json` conference_test_rows, pass, and unrecorded | the pack's own counts |
| Mutant totals, board release log, scorecard utilization, error rate, spend, ledger-derived metrics | omitted by the pack README | `not tracked yet`. Error rate is not added here; Ops already has that column |
| Reserved executive note | nothing yet | empty on purpose |
| Existing ledger, checkpoint chart, and the 154 / 0.43x run chart | `data/delivery-ledger.json` and `data/delivery-metrics-measured.json` | left as last published, as of 10 Nov 2026 |

Ops fleet totals read `data/fleet-pack/totals.json` and `generated_at.json`. They do not repeat error rate.

## Activity totals this run

```json
{
  "sfdc24-site": {
    "opened": 396,
    "merged": 273,
    "unavailable": false
  },
  "Blackboard": {
    "opened": 476,
    "merged": 355,
    "unavailable": false
  },
  "conference": {
    "unavailable": true
  }
}
```

Site workflow runs in the window: 2500.
