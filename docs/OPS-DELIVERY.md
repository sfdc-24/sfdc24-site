# Ops delivery feed

Owner: Codex, separate from Grok's legacy Ops refresh repair. The public Gantt
reads `ops-delivery-snap/data/ops-delivery.json` every 120 seconds while visible.
GitHub Actions requests a bake every 15 minutes; scheduling is not guaranteed.
The checked-in snapshot is first-load fallback, clearly marked as a failed
hosted refresh. Later failures retain the newer in-browser snapshot.

The Python bake validates the last-good branch snapshot and curated main seed,
imports only newer seed receipts/new work IDs, then reads scoped exact-head PR
metadata. It never reads Blackboard, private prompts, comments or transcripts
into the public feed. The collector discards PR bodies and exports only IDs,
heads, source event times and check states. No token reaches the browser.

The hosted token can read the site repo only. Private conference metadata is
not queried in this workflow. Its last reviewed snapshot remains visible with
its real observation age. A separately authorized owner can use the CLI to
project a sanitized conference export into a reviewed main seed; do not grant a
broad PAT merely to make a freshness badge green.

GitHub merge means staging pending, not deployed. Public release requires an
explicit curated receipt with served identity, browser behavior and an actual
production marker. Historical verified receipts are immutable; use a new work
ID for a later release. Recorded PR windows are not agent working time. No
utilization calculation or presence claim is implemented by this feed.

## Source contract (unchanged v1)

`schema_version=1`, UTC `observed_at`, at most 100 items. Each item has `id`,
`project`, `title`, `owner`, `assignment`, `stage`, `status`, `observed_at`,
`source`, `evidence`, `next`, and `periods`. Stages are backlog, dev, staging,
test, production; status is recorded, blocked, pending, verified. Pending is a
next gate, not a successful environment. Assignment is not acknowledgment.

Periods have stage, kind (`actual` or `planned`), start and end. Empty periods
are undated; zero-length periods are point receipts. Actual endpoints cannot
exceed the item's observation. Plans remain outlined; never invent deadlines.
Each item retains its own age. Raw OKF and board data, prompts, transcripts,
client content and credentials do not belong here. Changes to work, ownership
and gates still belong in OKF, not this read-only projection. No second backlog
or Notion workspace is introduced. The accessible table remains usable without
the Ops-only, version/SRI-pinned Chart.js library.

```powershell
python tools/ops_delivery_collect.py --previous data/ops-delivery.json --policy data/ops-delivery-policy.json --out github.json
python tools/ops_delivery.py --previous data/ops-delivery.json --github-export github.json --okf-export sanitized-okf.json --out candidate.json
python tools/ops_delivery.py --validate candidate.json
python -m unittest discover -s tests -p 'test_ops_delivery*.py' -v
node --test tests/ops_gantt.cjs
```

Empty/malformed API responses, moved heads, incomplete pagination or invalid
input fail the bake. Output replacement is atomic. Unchanged evidence creates
no new timestamp and no commit. No actual work interval is stretched to now.
The isolated branch does not trigger Pages. Failure leaves the last good feed;
check the workflow and public stale/failure label rather than bumping a date.

## Poka-yoke: evidence time and omitted checks

Independent review reproduced two source-level false-progress mechanisms:
PR `updated_at` (including comments) could supersede a newer manual blocker
with older CI; GitHub's default latest-check filter could omit a same-head
failed duplicate before projection. Prevention is executable: collector times
come only from creation/head commit/merge/closure/check events; every check
page explicitly requests `filter=all`. Collector-to-projector regressions
cover a comment after a manual hold and a duplicate failed/successful check.
The policy is conservative: a historical same-head failure stays blocked until
an explicitly reviewed supersession policy or destination receipt resolves it.
These are source regression controls, not a claim of hosted runtime closure.

All current-head failures, including optional checks, are intentional visible CI
blockers; required-check policy controls a green verdict, not failure concealment.
Unstarted queued/requested/waiting/pending checks have no measured check-event
time. Their incomplete observation is anchored to the verified head commit and
never interpreted as a queue/start timestamp or fresh activity. Completed checks
without an event time still fail closed. Regression tests cover both paths.

## Release gate

Claude and Cursor review the exact head before merge; all expected checks must
be complete and successful. No response means hold. Preserve Grok's mounts and
panel. Verify filters, refresh and narrow-screen scrolling after Pages, as well
as served-byte identity. Run the focused Python and Node commands above.

After release, manually dispatch `ops-delivery-snap`, require successful run and
read back the branch bytes, then verify the real public browser consumes them
and retains them during failed refresh. A workflow definition is not runtime
proof. Rollback: revert this thin source release; do not change Pages source,
domain, Cloud Run traffic or credentials.
