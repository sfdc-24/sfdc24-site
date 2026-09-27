# Ops delivery projection v1

Owner: Codex (PM and additive Gantt). Grok retains the existing Ops repair lane.

The top `/ops/` panel reads `/data/ops-delivery.json` every 120 seconds while
visible, plus manual Refresh. It is a published snapshot, not agent presence
or a live bus. Its age updates independently every second, including after
fetch failure. At 30 minutes it is marked stale. Failed, invalid or older
responses retain the previous snapshot and display a warning.

## Source contract

`schema_version=1`, UTC `observed_at`, and at most 100 `items`. Each item has:
`id`, `project`, `title`, `owner`, `assignment`, `stage`, `status`,
`observed_at`, `source`, `evidence`, `next`, and `periods`.

- Stages: backlog, dev, staging, test, production. `pending` means the next
  gate, not a successful environment. `status` is recorded, blocked, pending
  or verified. Assignment is not acknowledgment, presence or utilization.
- A period has stage, kind (`actual` or `planned`), start, end. Empty periods
  mean dates unknown or unscheduled. Zero-length periods are point receipts.
- Actual endpoints cannot exceed the item's observed time. Open activity is
  clipped at that observation, never extended automatically to now.
- Plans are outlined and explicitly called plans. Never invent deadlines.
- PR age is not development effort. Label that provenance in evidence.
- Merged source/CI is never automatically promoted to production. Production
  needs a destination receipt; historical receipts must say they are historical.
- Each observation has its own age; republishing the feed does not renew old
  items. Re-reading the same file does not reset its age.
- Export only approved short operational summaries. Never publish raw OKF,
  board payloads, prompts, transcripts, client content or credentials. Link to
  approved GitHub sfdc-24 sources; the browser is read-only and holds no token.

The initial curated snapshot references OKF/GitHub and separately qualified
receipts. It is not a new task ledger: changes to ownership, work and gates
belong in OKF. Future Python automation should project those canonical inputs
and verified deployment receipts into this schema, validate before publication,
and retain the last good snapshot on failure. No scheduler is introduced in v1.
No Notion workspace or duplicate backlog is needed.

## Release gate

Claude and Cursor review the exact head before merge; expected checks must be
complete and successful. No response means hold. Preserve Grok's panel and
mounts. After Pages deploy, compare served assets/data and exercise filters,
refresh, source links and narrow-screen scrolling. Rollback is the prior Pages
commit; the panel adds only its mount, stylesheet, script and data.

Run `node --test tests/ops_gantt.cjs`. The table is the accessible fallback if
Chart.js (version and SRI pinned in HTML) cannot load. Chart code is Ops-only.
