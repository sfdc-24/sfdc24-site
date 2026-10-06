# Coordination read

Redis is the coordination layer for tasks, projects, rollups, and issues. These pages consume that rollup shape. While dual-run is off, the published delivery snapshot fills the same shape and is what the page shows. The browser does not open a socket to Memorystore and does not carry an AUTH string. Escalations stay on WhatsApp. The site does not escalate.

Blackboard’s Redis dual-run scaffold (“redis: the dual-run scaffold, off by default and unable to answer”) is the governance side: old path authoritative until the flag says otherwise, shadow read, write-through, off by a settings file. Apps Script cannot reach a private Memorystore address. Only a VPC service such as Cloud Run can. `GET /api/coord` is that read.

## What is live

| Surface | What it shows | Source today |
|---|---|---|
| Ops | Compact coordination strip under the conference action items. Counts, named roles, dark controls. Project counts stay folded. | `GET /data/ops-delivery.json` |
| Process | Project delivery board: each project, what is in progress, what has landed. Peer-wait register below stays the static seed. | Same snapshot, plus the existing seed HTML |
| Method | How that read works, with the same counts. Not a second board. | Same snapshot |
| Every other page that loads shared chrome, plus Studio | One compact line: the same rollup shape, snapshot-filled while dual-run is off. | Same snapshot |

Landed means `stage=production` and `status=verified`. Anything else is in progress, including a production row that is still pending. A merge is not landed. Blockers are snapshot rows with `status=blocked`. The peer-wait register on Process is a separate static seed and is not copied into Redis.

Roles on the strip are named jobs, not presence: Claude governs Redis, Grok is strategic lead and execution C2, Codex verifies, Gemini owns next-phase architecture, Cursor supports exact-head review.

## What is stubbed

`data/coord-redis.json` ships with `dual_run: "off"` and `api: ""`. While that is true the browser fetches only the flag file and the delivery snapshot.

When `dual_run` is `shadow` or `live` **and** `api` is exactly `/api/coord`, the adapter calls `GET /api/coord` (Cloud Run). It does not call Memorystore.

- `shadow`: the rollup is read and compared. The snapshot stays on screen.
- `live`: a valid rollup replaces the counts and project rows. `authoritative: true` or `redis_answers: true` is rejected, and the snapshot stays.
- “Mark a blocker seen” does `POST /api/coord/controls` only after a blocker is chosen. That is not an escalation. Escalations stay on WhatsApp.

While the shipped flag is `off`, neither call is made.

There is no Cloud Run route in this repo. A missing route leaves the snapshot in place.

## Keys Claude should align to

The Blackboard wrapper stores `key_prefix + dual_run_key` with `key_prefix` `blackboard:`. Pass the short key. Do not prefix it again.

| Redis key | Dual-run key | Body |
|---|---|---|
| `blackboard:coord:v1:rollup` | `coord:v1:rollup` | The read document below |
| `blackboard:coord:v1:fleet` | `coord:v1:fleet` | `fleet` array |
| `blackboard:coord:v1:projects` | `coord:v1:projects` | `projects` array |
| `blackboard:coord:v1:tasks` | `coord:v1:tasks` | `tasks` array |
| `blackboard:coord:v1:okf` | `coord:v1:okf` | `{included:false}` until a sanitized OKF rollup exists |
| `blackboard:coord:v1:blockers` | `coord:v1:blockers` | `blockers` array |

`GET /api/coord` should return `schema: "sfdc24.coord.read.v1"` with `authoritative: false`, `source: "redis-shadow"`, `redis_answers: false`, and the same `projects` / `blockers` arrays the site builds from the public snapshot. Do not put raw OKF, prompts, transcripts, or the AUTH string in that document.

```json
{
  "schema": "sfdc24.coord.read.v1",
  "source": "redis-shadow",
  "authoritative": false,
  "redis_answers": false,
  "dual_run": "shadow",
  "observed_at": "2026-10-06T00:00:00Z",
  "projects": [],
  "blockers": []
}
```

Each task row uses the delivery fields already public: `id`, `title`, `project`, `owner`, `stage`, `gate`, `status`, `next`, `landed`. `title` is plain language plus the gate (Backlog, Development, Staging, Test, Production). A bare number is not a title.

`POST /api/coord/controls` accepts:

```json
{"schema":"sfdc24.coord.control.v1","action":"ack-blocker","id":"ops-repair","source":"site"}
```

Cloud Run should mirror that only after the authoritative board write, and swallow a Redis failure. The browser does not retry into Memorystore.
