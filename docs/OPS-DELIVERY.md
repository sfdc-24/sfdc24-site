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

Repository names are stored as `owner:name` inside `proj:pr-board:v1:`
(for example `sfdc-24:conference`). A plus sign is outside the Blackboard
`redis_gov` key grammar at `9921626098766617e9a0cda739a5d78b593eaf84`
(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$`). A colon is allowed, and a GitHub
owner or name does not contain one, so the first colon is the split. The
same encoding is what #383 tests. Keys do not use a `pr:` prefix and do
not contain a slash. One enabled run is one sweep of the three
repositories. Nothing in this tool starts a timer. The cadence it can
support is the owner's minimum, every 4 hours (every 2 hours while pull
requests are moving). A 1 hour new-PR SLA cannot hold on that sweep.

Each item carries a glance record for a reader who is not an engineer: priority
(`P0`, `P1`, or `P2`), a plain-English blocks line, blocked by, one owner,
closure driver, status, days open, milestone, project, and a GO-on-exact-head
flag (`Yes`, `No`, or `unassessed`). A missing field is the word `unassessed`.
The GO flag is an approval whose commit is the current head. It does not merge.
Priority, blocks, blocked by, and owner are read from an `At a glance` block
at the top of the pull request description (plain lines or the blockquote
form), then from the labels `P0`, `P1`, `P2`, and `blocked`. Closure driver, status, and days open come from the
projection (an acknowledged closure driver, the stage, and the measured open
interval). The Ops page renders one row per pull request, `P0` first and then
the longest measured open interval. Turnaround — time to first review,
from that review to close, and total open-to-close — is on each open pull
request and as a seven-day daily median per repository and per agent, next
to the scorecard. Those times use review, close, and reopen events only.
Missing history is `unknown`. `PR_BOARD_ENABLED` in
`assets/ops-pr-board.js` defaults off, so the public page shows an off note
and does not fetch the projection. `data/pr-board-public.json` stays
`enabled: false` with no rows. A private title is never a row. Per-PR
glance rows and per-PR turnaround rows are published only for
`sfdc-24/sfdc24-site`. Conference and Blackboard rows are omitted. A
redacted stub would still publish the private pull request id, priority,
project, age, and status. Conference and Blackboard daily medians wait for
an owner ruling. `OPS_PR_BOARD_PRIVATE_AGGREGATES` and
`--public-private-aggregates` default off, and the public snapshot omits
those repository series until one of them is turned on. With the flag off,
author and reviewer medians are computed from `sfdc-24/sfdc24-site` only.
A generation id is 64 hex characters and is not rewritten after
`proj:pr-board:v1:head` names it. The writer stores a private paged manifest
(`manifest:0` onward, 8 entries per page) listing each generation document's
key, SHA-256, and UTF-8 byte length. The report digest covers those documents
and excludes the head and the manifest pages. The absolute generation ceiling
is 512 listed documents. The 159-pull-request board is 326 documents and is
written: 41 manifest pages, the last one short. The verifier reads at most
128 documents between head revalidations. A generation over 512 is refused
before any put. Public JSON is written only after an ok receipt. A projected
run with no writer does not publish one. ACTION advice also waits for that
receipt. An unlisted key is ignored and is not scanned for.
The manifest workload is paged, not a one-page cap: 8 entries on each page,
indexes `0..N-1`, and at most 512 listed documents. The head binds the
manifest root digest, the total listed count, and `page_count`. The root
preimage is `{"listed": <int>, "page_count": <int>, "pages": ["<page digest>", ...]}`
with sorted keys and compact separators. Each page digest is the SHA-256 of
that page's entries array. The 41-page preimage is larger than 2048 bytes, so
it is not stored as one Redis hash; both sides recompute it from the page
digests. The head is read at the start and again after every manifest page,
including page 0, after every batch of at most 128 documents, and once at the
end. A head change is not ok, does not publish, and leaves ACTION unknown.
The page union is exactly `0..N-1`, with no gaps and no overlap. A check of
one page is page-ok only. A receipt carries counts and digests, not key names,
and it is not sent through the public Sheet. A public route, including
`via=public-sheet`, rejects the private generation before any put. `--out`
refuses a path under the public site tree, including `data/`. Every hash is
refused above 2048 UTF-8 bytes or 50 fields before `put`.
The page drops any other per-PR row before it fills a cell. MERGE is
advisory and every readiness gate fails closed: unknown or false is not MERGE.
`unknown`, `unassessed`, None, and an empty value are absent evidence.
CLOSE, MERGE, and FIX do not rest on them, and a task or fix link is not
built from them.

The private ACTION view is a separate projection for the shared queue. It
records owner and handoff evidence, a `CRITICAL`/`HIGH`/`MEDIUM`/`LOW`
priority, waiting time, blocks and blocked-by, and an advisory
`MERGE`/`FIX`/`DEFER`/`CLOSE` recommendation. That recommendation does not
merge or close anything. Closed history is a separate document: merged and
closed-without-merge, close and reopen events, and no silent cap. A local
JSON file is `local_only`. A consumer sets `redis_read_back` only after it
validates one complete generation. Private ACTION and closed-history
documents are not sent through the public Sheet `hput`.

Rollback of this addendum: revert to `45916666ce7558105aff2537bc15a8fb33322cb0`
with the flags off. Production is unchanged because this collector is not in
the public workflow. Leave any `proj:pr-board:v1:` generation to the existing
30-day `proj:` TTL. Do not add a delete grant and do not give this workflow a
conference token.
