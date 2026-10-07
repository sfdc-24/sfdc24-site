# Redis floor

Discussion views for the conference line, plus a sample work board. The Blackboard Google Sheet stays the system of record. This folder does not read Redis from the browser and does not grant access.

These pages are new. They do not edit the Process page or the Ops refresh. When "Make Process a findable delivery board" and "Ops refreshes itself from merged pull requests" land, link across. Do not merge those files into this set.

## Call diagrams

Plain-language captions, current versus future, the decision, and a validation placeholder for Codex:

`docs/conference-diagrams-brief.md`

Editable diagram text:

- `floor/diagrams/call-access.mmd`
- `floor/diagrams/call-agents.mmd`
- `floor/diagrams/call-future.mmd`
- `floor/diagrams/call-architecture.mmd`

Rendered pictures sit beside those files (`.svg` and `.png`). Open `docs/conference-call.html` locally. It shows the pictures without a server. Edit a box on that page and press Redraw, then copy the text back into the `.mmd` file.

Re-render committed pictures after an edit:

```bash
python3 tools/render_call_diagrams.py
```

## What is sample, and what is real

| Surface | Source |
|---|---|
| Conference handoff list | Labeled sample in `data/floor/sample.json` |
| Access, agents, future, and architecture diagrams | The `.mmd` text. Not a live key count |
| Process lanes | Checked-in delivery snapshot. Not Redis |
| Key tables | Schema only |

`liveRedis` is false. No live Redis number is shown.

## The flag

One line in `data/floor/config.json`:

```json
"liveRedis": false
```

Leave it false until the comparison gate is clear and the read bridge below exists. `writesEnabled` stays false until a write path is approved. Acknowledge, assign, and comment update this screen only.

## Read API contract

No such HTTP endpoint exists yet. Cloud Run jobs can reach `redis-central` inside the private VPC. They are jobs, not a webpage API. A bridge service was approved and is not deployed.

`GET {readApi}` when the flag is on. The browser sends no Redis credential.

```json
{
  "source": "redis",
  "gate": "clear",
  "observed_at": "2026-10-07T23:00:00Z",
  "threads": [
    {
      "id": "string",
      "title": "string",
      "project": "Conference line",
      "from": "Grok",
      "to": "Claude",
      "state": "requested",
      "assignee": "",
      "result": "",
      "comments": [{"text": "Landed", "at": ""}]
    }
  ]
}
```

Allowed `state` values: `requested`, `acknowledged`, `result`, `escalated`.

The response must not include a secret, an address, a token, or raw sheet cells. `key_counts` is optional and only when `gate` is `clear`. Any other `gate` is ignored and the page keeps the sample.

CORS, if the page calls it from the public site: allow `https://www.sfdc24.com` only.

Writes, not called until `writesEnabled` is true:

- `POST {writeApi}/acknowledge` body `{ "id": "..." }`
- `POST {writeApi}/assign` body `{ "id": "...", "assignee": "Cursor" }`
- `POST {writeApi}/comment` body `{ "id": "...", "text": "Landed" }`
- `POST {writeApi}/escalate` body `{ "id": "..." }`

## Go live, after the gate clears

1. Codex records the comparison gate as clear. Until that happens, do not flip the flag.
2. Deploy the read-only HTTPS bridge on the Blackboard side, on Cloud Run, in `us-central1`, with the existing private-VPC path. No new IAM and no secret from this repository.
3. Implement the GET contract above.
4. Set `readApi` to that HTTPS URL.
5. Change `liveRedis` from `false` to `true`. That is the switch. Ship through the normal Pages path.
6. Leave `writesEnabled` false until acknowledge, assign, and comment through the bridge are approved separately.
7. Keep the sheet readers. Redis does not replace the sheet.

## Design source

Penpot is not running here. There is no Docker and no Penpot service. `tools/floor_design.py` writes SVG frames in the site colors under `design/floor/`. Those frames are not a Penpot file and not a Penpot export.
