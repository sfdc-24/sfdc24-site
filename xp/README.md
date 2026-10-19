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

The badge says **Fixture**, **Live**, **Stale** (live snapshot older than 300 seconds), or **Missing**. A number that is not in the snapshot is **unknown**. A feed or an hourly trend with nothing to count says **not yet reported**.

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

A waiting flag is an accept whose lease has expired and that has no done record. A stalled flag is a heartbeat older than 300 seconds. A missing heartbeat is **unknown**, not stalled.

## Supervisor feed

`data-xp-id="feed-supervisor"`. Newest first. Each entry has a time in ET, a target, a few words, and an outcome.

The adapter checks keys in this order:

1. `fleet:supervisor:pi1-cli:events` when the key is **present** (even if the list is empty). Point `KEYS.supervisorEvents` at another `fleet:supervisor:*` key to switch. An empty list means nothing yet, and inbox or board rows are not mixed in.
2. Otherwise, both of these:
   - `fleet:inbox:<agent>` entries whose `by` is `pi1-cli`
   - `v1:bus:row:*` hashes whose `source_tag` is `pi1-cli`

There is no `fleet:events` stream in the writers today.

Dedicated stream entry:

```json
{"id":"1710000000000-0","at":"2026-10-19T01:40:00Z","kind":"stall","target":"gemini","action":"Flagged a stale beat","outcome":"flagged"}
```

`kind` is `nudge`, `stall`, `wait`, `duplicate`, `check`, or `escalation`.

Until that stream exists, a board row uses the columns the mirror already stores (`bus_reconcile.py`): `ts`, `source_tag`, `target_surface`, `action_type`, `gist`, `subgist`. `action_type` is the kind, `gist` is the action, `subgist` is the outcome, `target_surface` is the agent. An inbox line can start with `nudge:` (or the other kinds) and a colon; the rest of the line is the action. Anything else is a message, and its outcome is unknown.

The four counters in the supervisor detail are **not** counted from the feed. They are fields on the hash `fleet:supervisor:pi1-cli`:

```json
{"stalls":"","waits":"","duplicates":"","checks":"","watching":"claude,codex"}
```

Absent fields render as **unknown**. `watching` absent renders as **not yet reported**.

## Output per hour

`data-xp-id="metric-output-per-hour"`. A bar is drawn only for an hour that has a timestamped event in the 24 hours before `read_at`. A dot marks an hour where the supervisor feed also has an entry. Tap the chart for the per-agent counts.

Counted records:

- a board row whose `action_type` is `DONE`, `REVIEW`, `COMMIT`, or `ROUND`, using `ts` and `source_tag`
- a done JSON that includes `at` (ISO). The current writer does not send `at`, so those rows stay off the chart until it does

No timestamp, no bar, and no zero. If nothing in the window qualifies, the chart says **not yet reported**.

## Who can open it

`xp/allow.json` lists roles. Today that list is `owner`. Adding a role there widens the hook and does not authenticate anyone.

The hook reads `window.SFDC24_XP_IDENTITY = { "role": "owner" }`. Nothing on the public site sets that. Putting the existing governor sign-in, or an IAP that already exists, in front of `/xp/` and setting that value from the session is the step that makes the gate real. A new identity, a new secret, or a new service is not required for the hook itself and is not added here.

## Speakable ids

`?focus=agent-codex` highlights that node. Ids are stable: `agent-pi1-cli`, `role-supervisor`, `agent-codex`, `inst-pi2-cli`, `ms-site`, `task-pr-52`, `feed-supervisor`, `metric-output-per-hour`. Task ids in Redis stay `task-` plus 16 hex; the short id is the `TASK_XP` map in the adapter.
