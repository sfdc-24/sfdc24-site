# Coordination read (Ops, Process, Method)

The published delivery snapshot answers. Redis is off. These pages do not open a socket to Memorystore and do not carry an AUTH string.

Blackboard’s Redis dual-run scaffold (“redis: the dual-run scaffold, off by default and unable to answer”) is the governance side: old path authoritative, shadow read, write-through, off by a settings file. Apps Script cannot reach a private Memorystore address. Only a VPC service such as Cloud Run can. This site is the read model that service can serve later.

## What is live

| Surface | What it shows | Source today |
|---|---|---|
| Ops | Compact coordination strip under the conference action items. Counts, named roles, dark controls. Project counts stay folded. | `GET /data/ops-delivery.json` |
| Process | Project delivery board: each project, what is in progress, what has landed. Peer-wait register below stays the static seed. | Same snapshot, plus the existing seed HTML |
| Method | How that read works, with the same counts. Not a second board. | Same snapshot |

Landed means `stage=production` and `status=verified`. Anything else is in progress, including a production row that is still pending. A merge is not landed. Blockers are snapshot rows with `status=blocked`. The peer-wait register on Process is a separate static seed and is not copied into Redis.

Roles on the strip are named jobs, not presence: Claude governs Redis, Grok is strategic lead and execution C2, Codex verifies, Gemini owns next-phase architecture, Cursor supports exact-head review.

## What is stubbed

`data/coord-redis.json` ships with `dual_run: "off"` and `api: ""`. While that is true the browser fetches only the flag file and the delivery snapshot.

When `dual_run` is `shadow` or `live` **and** `api` is exactly `/api/coord`, two controls light up:

- “Read the Redis shadow” does `GET /api/coord` and compares project and blocker **counts**. The site list stays on screen. A body with `authoritative: true` is ignored.
- “Mark a blocker seen” does `POST /api/coord/controls` only after a blocker is chosen. The body is `{schema, action, id, source}` and has no secret.

`redis_answers` in the flag is ignored. The site adapter never lets Redis replace the snapshot.

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
