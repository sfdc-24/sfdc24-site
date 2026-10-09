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
An older commit can become the current head after a branch reset. Explicitly
generated prior-head CI is invalidated even when the new head's event anchor is
older; historical time/intervals stay unchanged and the row explains that retained
time is not new activity. Newer manual blockers and production receipts remain
protected. A reset-to-older-head regression prevents inherited green results.

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

## PR board projection (off by default)

`tools/ops_pr_board.py` walks every open pull request in conference, Blackboard,
and sfdc24-site and can store a metadata-only generation under the existing
`proj:` grant at `proj:pr-board:v1:`. It is not part of this workflow. The flag
defaults off (`--enable` or `OPS_PR_BOARD=1`); otherwise it does not read GitHub
and does not write Redis. It does not change the 100-item public schema, the
site-scoped token, `redis_acl.json`, or the milestones-sync principal. Titles,
bodies, and review text stay in GitHub.

Each item carries a glance record for a reader who is not an engineer: priority
(`P0`, `P1`, or `P2`), a plain-English blocks line, blocked by, owner, closure
driver, status, and days open. A missing field is the word `unassessed`.
Priority, blocks, blocked by, and owner are read from an `At a glance` block
at the top of the pull request description (plain lines or the blockquote
form), then from the labels `P0`, `P1`, `P2`, and `blocked`. Closure driver, status, and days open come from the
projection (an acknowledged closure driver, the stage, and the measured open
interval). The Ops page renders one row per pull request, `P0` first and then
the longest measured open interval. `PR_BOARD_ENABLED` in
`assets/ops-pr-board.js` defaults off, so the public page shows an off note
and does not fetch the projection. `data/pr-board-public.json` stays
`enabled: false` with no rows. A private title is never a row; a blocks line
is shown only when it is a short non-sensitive sentence.

Rollback: stop passing `--enable`, leave `PR_BOARD_ENABLED` false, and do not
merge. Leave any `proj:pr-board:v1:` generation to the existing 30-day `proj:`
TTL. Do not add a delete grant and do not give this workflow a conference
token.
