# Fleet view (`/xp/`)

Owner-only picture of the agents, their instances, and the work moving between them. The page is `noindex` and is not linked from the nav. It reads a snapshot; it does not open a socket to Redis.

## Run it locally

```bash
python3 -m http.server 8765
```

Open `http://127.0.0.1:8765/xp/?preview=owner`.

`preview=owner` is accepted only on localhost. It is labeled **Local preview** and is not a gate. Any other host shows **Owner only** until an identity is wired.

## Two sources

| Source | When |
|---|---|
| Live | `GET /data/xp-live.json` returns a snapshot |
| Unavailable | The public snapshot is deliberately withheld |
| Fixture | local preview, the test host, or `?source=fixture` |

The current public `data/xp-live.json` is `{"public_status":"withheld","keys":{}}`. It contains no Redis keyspace data. Do not republish the internal read output until a separately reviewed public projection is defined; `tests/public_xp_snapshot.cjs` rejects changes to this safe fallback.

The badge says **Fixture**, **Live**, **Unavailable**, **Stale** (live snapshot older than 300 seconds), or **Missing**. **Missing** means neither snapshot could be read. **Unavailable** means the public snapshot is withheld. A snapshot that loads with no agents stays **Fixture** or **Live**; it does not say Missing. A stale live snapshot also says **stale snapshot**. A number that is not in the snapshot is **unknown**. A region with nothing stored — supervisor, agents, milestones, tasks, the feed, or the hourly trend — says **not yet reported**.

`data/xp-fixture.json` is the same shape, stored on one line so the page stays small. The internal read path lives outside this repository and does not publish here automatically. The public file remains withheld until a safe projection is approved.

Snapshot shape:

```json
{ "read_at": "2026-10-19T02:30:00Z", "keys": { "fleet:alive:pi1-cli": "1792376960" } }
```

`read_at` is the clock for heartbeats and for the 24 hour window. Ages are not compared to the wall clock except to mark a live snapshot stale.

## Key names

All names live in `KEYS` inside `assets/xp-adapter.js`. Change them there.

| View | Key the fleet writes today | Not used |
|---|---|---|
| Instance | `v1:agent:<id>` hash | |
| Alias | `v1:agent:canon` | |
| Heartbeat | `fleet:alive:<id>` epoch seconds, stale after 300s | `hb:`, `fleet:heartbeat:` |
| Handoff | `fleet:inbox:<id>` stream `{id, by, text, at}` | `mbox:` |
| Task accept | `fleet:worker:accept:<task>` = `<instance>:<epoch>[:<lease>]` | `fleet:task:` |
| Task done | `fleet:worker:done:<task>` JSON `{by, state, note, evidence}` | `pr:` |
| Milestone | `proj:milestones:v1:<stream>` hash | |
| Board row | `v1:bus:row:<row_id>` hash | |
| Chair | `v1:conf:<room>:state` | `conf:` is a different namespace |
| Supervisor events | `fleet:supervisor:pi1-cli:events` | |
| Supervisor log | `fleet:supervisor:events` | secondary; `ts` and `agent` |
| Supervisor counters | `fleet:supervisor:pi1-cli` hash | not `stalls`, `waits`, `duplicates`, `checks`, `watching` |

A waiting flag is an accept whose lease has expired and that has no done record. A stalled flag is a heartbeat older than 300 seconds. A missing heartbeat is **unknown**, not stalled.

## Work rows

Each task tile is followed by one overview line: Work, Agent, Blocker, Waiting for, and Next. Tap the tile for Lane, Work, Agent, Status, Blocker, Waiting for, Lease, Evidence, Stale, Next, and Note.

A task is listed when it has `fleet:worker:accept:<task>` or `fleet:worker:done:<task>`. Inbox messages, board rows, and heartbeats are never turned into tasks. The fields come from the existing done JSON: `lane`, `work`, `blocker`, `waiting_for`, `next`, plus `by`, `state`, `note`. No new key, stream, or writer is added. A missing field, or a done value that is not a JSON object (an array, say), shows **unknown**. Nothing is filled in from the task id, the board, or the fixture.

**Waiting for** is the named dependency from `waiting_for`. **Lease** is separate: `closed` once a done record exists, `lapsed` when the accept lease ran out before a done record, `held` while it runs, `settled` for the legacy scalar done marker `1`, `unknown` when there is no lease or clock. The card says **Lapsed** for a lapsed lease.

The legacy done value `1` (string or number) only says the task was settled. It is not a lapsed or outstanding lease and it is not a success: Status stays **unknown** (no `accepted`), Evidence and Stale stay **unknown** (no completion time), no output is counted, and Agent is only what an accept record reports, never inferred from the marker.

Evidence is the done record's `at` (or `ts`), else the accept epoch, shown in ET. The epoch and lease must be whole numbers; a blank or non-numeric epoch is **unknown**. Evidence more than 60 seconds after `read_at` is **unknown**, not fresh. The same validated time governs the hourly output: a done time rejected as future is not used as evidence, does not fall back to the accept epoch, and is not counted, and a `v1:bus:row:*` output row more than 60 seconds after `read_at` is not counted either. **Stale** is `yes` when the evidence is more than 3600 seconds (`KEYS.workStaleSec`) older than `read_at`, `no` when it is not, and `unknown` when either time is missing. The card adds **Stale** after the status.

A field, Note included, that contains `//` (a URL with or without a scheme), a credential word (`token`, `secret`, `password`, `bearer`), or a key prefix (`ghp_`, `sk-`) shows **withheld**. An email or phone number shows **unknown**, the same as `scrub` elsewhere.

Agent (`by` from the accept record, or from the done record when there is no accept) must be a string that looks like an agent id: a letter or digit, then up to 63 letters, digits, `_`, `.` or `-`, and it must pass the same withheld check. Anything else (an email, a phone number, a key prefix, an object or number) shows **unknown** on the overview line and in the detail.

A live snapshot with `public_status: "withheld"` is a no-render boundary: its keys are ignored, whatever they hold.

Real rows need a live snapshot. The public `data/xp-live.json` stays withheld, so on sfdc24.com the work rows say **not yet reported** until a reviewed signed-in projection exists. The fixture row is labeled sample text and is never shown on the public host.

Unmet deployment requirements (not met by this frontend change): session or surface identity is not distinguished, because no record carries a session or surface field, so two tasks from the same principal (for example the main CLI and VS Code) show the same Agent. Missing producer contract: pending (assigned, not yet accepted) work has no explicit record key today, so it cannot be listed without guessing from messages. It needs a writer of `fleet:worker:assigned:<task>` (or the same fields on an accept record). The current accept and done writers also do not set `lane`, `work`, `blocker`, `waiting_for`, `next`, or `at`, so live rows show **unknown** until they do.

### Assignment records

`fleet:worker:assigned:<task_id>` (schema `fleet:worker:assigned` v1 amendment 1b, board row 9018, sha256 `58a97d40…2e437c`) is read by `assigned()` in `assets/xp-adapter.js`. Only keys whose suffix matches `^task-[0-9a-f]{16}$` count; other suffixes are ignored. Tasks are the union of accept, done and assigned keys, one card per task id.

The value must be a JSON string of at most 2048 bytes with exactly the 21 schema fields, the schema enums and patterns, the identity safety check, invariants I1 to I9 and I11 to I12, and an `observed_at` no more than 60 seconds after `read_at`. Any miss makes the whole record **unavailable** (the card keeps its frozen accept and done rows and adds Assignment: unavailable). With no `read_at` the record is also unavailable, because the future check cannot run. An absent key adds nothing, so absent and unavailable stay distinct. I10 (conflict is sticky) spans revisions and cannot be checked from one snapshot.

A valid record adds Assignment, Routed to, Delivered to, Accepted by, Assignee and Attribution rows. Routed to, delivered to, accepted by and the effective assignee stay separate. A delivered but unaccepted record shows Accepted by **acceptance not observed** and Assignee **unconfirmed**; it is never filled in from the accept key. Each delivery and acceptance fact carries its own freshness (ET time, **stale** over 3600 s, **unavailable** over 60 s ahead, **time unknown** when null). A stored conflict shows Assignee **none** and **conflict · reconciliation pending (reason)**, and the card adds **Conflict**.

Round 2 display rules (verifier round 1/3, F3 to F8). The stored record is never rewritten; only the display is derived.

- F3: a newer live accept key that contradicts a valid record (A1 to A8) is a live conflict. Agent becomes unresolved (empty), Assignee reads **unresolved; recorded X is historical**, Attribution reads **conflict · reconciliation pending (reason)**, and Blocker / Waiting for / Next read **assignee_conflict / coordinator / reconcile_assignment** instead of the record's completion wait.
- F4: with no done JSON lane, Lane is the validated record lane (`drive-intake`). The overview card adds **Assignment <state>** next to the execution state, which stays its own value.
- F5: a null `blocker` reads **unknown**, never **none**.
- F6: a `claimed_instance` record shows **(claimed instance/session)** with either side **unknown** when null. The claim is unauthenticated and nothing is inferred.
- F7: after settlement (done JSON or the legacy marker `1`) the record's active labels no longer apply; Blocker / Waiting for / Next come from the done value or read **unknown**. Settlement is not success.
- F8: a value that cannot be byte-counted (a lone surrogate, say) is unavailable for that record only; the 2048-byte limit and every other check stay.

The live `fleet:worker:accept:<task_id>` key is run through the acceptance table A1 to A8 against the record (rule C6). A conflict it finds marks the card **Conflict**; any other accepted result is a separate **Live accept: acceptance observed (live key)** row. The record's assignee and attribution are never rewritten, and `accept.by` is never chosen as the assignee: with a valid record, Agent is the record's effective assignee or **unknown**. Settlement, lease, status and the hourly output counts keep the frozen accept and done rules (output still uses the accept or done actor).

## Supervisor feed

`data-xp-id="feed-supervisor"`. Newest first. Each entry has a time in ET, a target, a few words, and an outcome. Tap an entry for the ref and the mode.

The adapter reads keys in this order:

1. `fleet:supervisor:pi1-cli:events` when that key is **present** (even if the list is empty). Point `KEYS.supervisorEvents` at another key to switch. An empty list means nothing yet. Inbox lines and board rows are not mixed in.
2. Otherwise, both of these:
   - `fleet:inbox:<agent>` entries whose `by` is `pi1-cli`
   - `v1:bus:row:*` hashes whose `source_tag` is `pi1-cli`
3. `fleet:supervisor:events` is always a secondary source when the key is present. `ts` is the time and `agent` is the target. A row already shown is dropped only when it is a true repeat: the same event `id`, or the same time, kind, target, action, and ref. A shared ref is not a repeat. Two actions at one time can cite one ref. Two delivery gaps can cite one ref and name different targets. The older log has no `kind`, so a copy of a dedicated row is kept when the kinds differ.

Dedicated stream entry, the shape pi1-cli writes:

```json
{"id":"pi1-20261019T032702Z-08e825","at":"2026-10-19T03:27:02Z","kind":"delivery_gap","target":"claude-code-cli","action":"DELIVERY_GAP","outcome":"logged (practice)","ref":"GROK-PR-ESCALATE-20261019T0226Z","mode":"practice"}
```

Other entries seen on that stream:

```json
{"id":"pi1-20261019T040001Z-677772","at":"2026-10-19T04:00:01Z","kind":"escalation","target":"wa-outbox","action":"ANDON","outcome":"logged (practice)","ref":"storm","mode":"practice"}
```

```json
{"id":"pi1-20261019T040901Z-899f3c","at":"2026-10-19T04:09:01Z","kind":"check","target":"owner-trigger","action":"OT_UPDATED","outcome":"logged (practice)","ref":"547d7f1700838a7e","mode":"practice"}
```

`kind` may be `delivery_gap`, `nudge`, `stall`, `wait`, `duplicate`, `check`, `escalation`, or `unblock`. Any other kind still renders as a generic action. It is not dropped.

Older stream entry (`fleet:supervisor:events`):

```json
{"ts":"2026-10-19T03:11:00Z","mode":"practice","agent":"pi1-cli","action":"ONLINE","outcome":"supervisor role confirmed","ref":"GROK-PI1-SUPERVISOR-20261019T0243Z"}
```

```json
{"ts":"2026-10-19T03:04:37Z","mode":"practice","agent":"wa-outbox","action":"ANDON","outcome":"logged","ref":"stall-claude-code-cli"}
```

`mode` on an entry is `practice` or `live` when the writer sends it. The lane, the feed, and the detail **Mode** line show one reconciled word. The inputs are the hash field `mode` on `fleet:supervisor:pi1-cli` and every feed entry that reports a mode. An empty string and `unknown` are not reports.

| Reported modes | Label |
|---|---|
| None | **unknown**. No mode chip. The detail says unknown. |
| One word, on the hash, the feed, or both | That word. **practice** shows **practice mode**. **live** shows **live mode**. |
| Two or more different words | **mixed**, shown as **mixed mode**. |

A live hash with a practice feed is mixed. A practice hash with an empty feed is practice (the chip is on the lane and above the empty feed). A feed that contains both practice and live is mixed. A snapshot with no hash mode and no entry modes is unknown. The detail Mode line is this reconciled word. The hash field is one input, not a second label.

A board row, used only when the dedicated stream key is absent, still uses `ts`, `source_tag`, `target_surface`, `action_type`, `gist`, `subgist`. An inbox line can start with `nudge:` (or another kind) and a colon.

The counters in the supervisor detail are **not** counted from the feed. They are the fields pi1-cli writes on the hash `fleet:supervisor:pi1-cli`. Values arrive as strings. Numeric strings are parsed. A missing field, or a value that is not a number, stays **unknown**. Names that no writer uses (`stalls`, `waits`, `duplicates`, `checks`, `watching`) are ignored.

```json
{"at":"2026-10-19T04:09:01Z","role":"supervisor","mode":"practice","checks_run":"6","waits_unblocked":"2","delivery_gaps":"10","escalations":"2","open_incidents":"0","redis_pending":"1"}
```

`open_incidents` of `"0"` is a reported zero. It is not the same as a missing field.

The events key is a Redis list. Each entry is the JSON object pi1-cli writes, or that same object as a string. A missing `fleet:supervisor:pi1-cli` hash leaves every counter **unknown**. A partial hash leaves the absent fields **unknown**. The feed is not a substitute count: a refused counter write (non-string values) must not become a number taken from the events. Numeric strings, including `"0"` and a string with surrounding spaces, are shown. Anything that is not a number stays **unknown**.

## Output per hour

`data-xp-id="metric-output-per-hour"`. A bar is drawn only for an hour that has a timestamped output event in the 24 hours before `read_at`. A dot marks an hour that has a supervisor event, using that event's `at` or `ts`. Tap the chart for the per-agent counts.

Counted records:

- a board row whose `action_type` is `DONE`, `REVIEW`, `COMMIT`, or `ROUND`, using `ts` and `source_tag`
- a done JSON that includes `at` (ISO). The current writer does not send `at`, so those rows stay off the chart until it does

No timestamp, no bar, and no zero bar. An hour with only a supervisor event gets a dot and no bar. If the window has neither output nor a supervisor event, the chart says **not yet reported**. If it has supervisor events and no output, the dots still show and the count says **not yet reported**.

## Who can open it

`xp/allow.json` lists roles. Today that list is `owner`. Adding a role there widens the hook and does not authenticate anyone.

The gate uses the existing site sign-in. `/studio/?live=1` and the homepage conversation store the operator token in `sessionStorage` under `studio.operator`. This page reads that same key. It does not accept a role typed into the page, and it does not read Redis to decide who is allowed.

A stored token opens the view only when both of these are true:

1. Its payload says `scope` `operator` and it has not expired. A pilot token, a visitor token, and a token with no scope stay locked, and those are not sent to the controller.
2. `POST /v1/session` on the existing studio controller, with that bearer and a body of `{}`, returns **400**. That is the controller's existing operator check. The empty body has no `creation_id`, so no studio session is opened. **401** and any other status stay locked.

`xp/allow.json` still has to list `owner`. The check does not add an identity, a secret, or a service.

On `www.sfdc24.com` and `sfdc24.com`, a verified sign-in reads only `/data/xp-live.json`. It does not fall back to the fixture, including when the URL says `?source=fixture`. If that live file is missing, the badge says **Missing**. Local preview and the test host may still use the fixture.

The allowlist does not read Redis. `conf:auth:roles` is writable by any fleet agent, and so is every other agent-writable key. A snapshot that says `Abdus=owner` (or any agent `=owner`) does not unlock `/xp/`. Localhost `?preview=owner` is labeled **Local preview** and is not a gate.

## Speakable ids

`?focus=agent-codex` highlights that node. Ids are stable: `agent-pi1-cli`, `role-supervisor`, `mode-practice`, `mode-live`, `mode-mixed`, `agent-codex`, `inst-pi2-cli`, `ms-site`, `task-pr-52`, `feed-supervisor`, `feed-practice`, `feed-live`, `feed-mixed`, `metric-output-per-hour`. Task ids in Redis stay `task-` plus 16 hex; the short id is the `TASK_XP` map in the adapter.

## Page weight

The sandbox cap is 58,000 bytes. It was 52,000 until the owner approved one raise to 58,000 on 2026-11-01 for the consumer round; it does not rise again without a new owner approval. The canonical weight is the LF byte length of these six files, the same bytes git stores:

- `xp/index.html`
- `xp/allow.json`
- `assets/xp.css`
- `assets/xp-adapter.js`
- `assets/xp-view.js`
- `data/xp-fixture.json`

`.gitattributes` pins `text eol=lf` on those paths, so a Windows checkout does not add a carriage return per line. The test counts the same way: read the working tree as text, turn CRLF and stray CR into LF, then sum UTF-8 bytes. A CRLF working tree and an LF working tree report one number. `fs.stat` size is not the measurement.

`xp/REVIEW.md` is a text walkthrough for a reviewer who cannot open the page. It is not part of the page.
