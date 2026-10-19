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
| Fixture | that file is missing, or the URL is `?source=fixture` |

The badge says **Fixture**, **Live**, **Stale** (live snapshot older than 300 seconds), or **Missing**. **Missing** means neither snapshot could be read. A snapshot that loads with no agents stays **Fixture** or **Live**; it does not say Missing. A stale live snapshot also says **stale snapshot**. A number that is not in the snapshot is **unknown**. A region with nothing stored — supervisor, agents, milestones, tasks, the feed, or the hourly trend — says **not yet reported**.

`data/xp-fixture.json` is the same shape, stored on one line so the page stays small. `/data/xp-live.json` is the output shape of the existing read path: Cloud Run job `bus-reconciler`, `cloud/bus-reconciler/keyspace_view.py` in the Blackboard repo. That job already has Direct VPC egress and Redis AUTH, and it refuses every command outside its read-only set (`get`, `hgetall`, `xrange`, and the other names in `READ_ONLY`). This page does not add a service, a secret, or a writer.

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

The hook reads `window.SFDC24_XP_IDENTITY = { "role": "owner" }`. Nothing on the public site sets that. Putting the existing governor sign-in, or an IAP that already exists, in front of `/xp/` and setting that value from the session is the step that makes the gate real. That wiring is an owner decision and is not done here. A new identity, a new secret, or a new service is not added.

The allowlist does not read Redis. `conf:auth:roles` is writable by any fleet agent, and so is every other agent-writable key. A snapshot that says `Abdus=owner` (or any agent `=owner`) does not unlock `/xp/`. Localhost `?preview=owner` is labeled **Local preview** and is not a gate.

## Speakable ids

`?focus=agent-codex` highlights that node. Ids are stable: `agent-pi1-cli`, `role-supervisor`, `mode-practice`, `mode-live`, `mode-mixed`, `agent-codex`, `inst-pi2-cli`, `ms-site`, `task-pr-52`, `feed-supervisor`, `feed-practice`, `feed-live`, `feed-mixed`, `metric-output-per-hour`. Task ids in Redis stay `task-` plus 16 hex; the short id is the `TASK_XP` map in the adapter.

## Page weight

The cap is 52,000 bytes and does not rise. The canonical weight is the LF byte length of these six files, the same bytes git stores:

- `xp/index.html`
- `xp/allow.json`
- `assets/xp.css`
- `assets/xp-adapter.js`
- `assets/xp-view.js`
- `data/xp-fixture.json`

`.gitattributes` pins `text eol=lf` on those paths, so a Windows checkout does not add a carriage return per line. The test counts the same way: read the working tree as text, turn CRLF and stray CR into LF, then sum UTF-8 bytes. A CRLF working tree and an LF working tree report one number. `fs.stat` size is not the measurement.

`xp/REVIEW.md` is a text walkthrough for a reviewer who cannot open the page. It is not part of the page.
