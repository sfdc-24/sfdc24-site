# Release milestones

The homepage header reads `data/release-milestones.json` when the page loads.
It shows the first milestone whose `status` is not `passed`: the short `label`,
and a countdown when `at` is an ISO-8601 time. No `at` means the label only.
When the clock reaches `at`, the line says **Releasing now**. The clock does
not mark the milestone passed.

## Pass evidence

A milestone passes only when a machine signal exists. Time running out is not
evidence.

Convention: an annotated tag, or a GitHub release whose tag is

`milestone/<id>-passed`

on `sfdc-24/conference` or `sfdc-24/sfdc24-site`. Example: `milestone/V3-passed`.

`scripts/refresh_site_data.py` reads those tags. On a match it sets `status`
to `passed`, `passed_at` from the annotated tagger date, and `evidence` to the
public tag URL. Lightweight tags are ignored. A repository that cannot be
read is left untouched; a failed read is not treated as "no tag".

`sfdc-24/conference` is private. The site workflow's `GITHUB_TOKEN` cannot
read it. A pass tag that exists only there stays unseen until a token with
read access is available. Do not add that secret in the workflow. Public
`sfdc-24/sfdc24-site` tags are visible with the built-in token.

## Enabling the hourly refresh

`.github/workflows/site-data-refresh.yml` is registered on a schedule and on
`workflow_dispatch`, and the job does not run until the repository variable
`ENABLE_SITE_DATA_REFRESH` is the string `true`. Set that variable to enable
it. The job runs the refresh script and commits only when the generated data
changed. The commit message ends with `[skip ci]`.

## Privacy

The header publishes the label and the milestone time only. It does not
publish `source`, pull request numbers, branch names, or owner tasks.
Fleet-pack files under `data/fleet-pack/` are stripped before any page can
read them: `source` on `milestones.json` is removed, and `totals.json` loses
`board_rows_by_phase` and per-agent board-row counts.
