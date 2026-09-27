# /ops/ Cooking ↔ Backlog funnel (CONF-LINE-OPS-FUNNEL-20260926)

## Why /ops/ looked empty
Cooking was a baked/hand snapshot stuck on Voice-fix theater. Not bus-driven.

## Truth tonight (sample snap + next-release on this branch)

### Cooking now (active priority funnel)
1. Conference Line LiveKit spike on the shared room contract.
2. SA Wed Applicant Portal build for the Wednesday demo.
3. Org AI inventory across client orgs and enablement lanes.

### Backlog (parked / resumable — NOT deleted)
1. Voice fix for the heard question, parked until the next release window. (demoted from Cooking)
2. Ops page with architecture of CI/CD, agents and bus, backlog queue and release view. Managed by Python post-release.
3. Homepage visitor talk becomes a queued prototype for a later release.

## Demote / resume control
- Cooking = `open_work.next: true` or `lane: "cooking"`
- Demote → Backlog = same work `id`, set `lane: "backlog"`, clear `next` (preserves row for resume)
- Resume / promote = set `lane: "cooking"` + `next: true` in sanitized `BOARD_OPS_EXPORT`
- Python `tools/board_ops_snap.py` bakes every ~5m to branch `board-ops-snap`; page polls 60–120s

## Fleet roles
| Agent | Role |
|---|---|
| Claude | MCP gatekeeper + governance/controller/host |
| Codex | Dev lead |
| Cursor | Coding/dev |
| Copilot | Git review |
| Gemini | Coordinator/admin + GCP/VM/infra |
| Grok | Strategy lead |
| Meta | WhatsApp for Business notify |

## Cursor: finish ship
Push `/workspace/PENDING_OPS_FUNNEL_PUSH_ALL.json` onto this branch (JS/HTML/baker/tests).
Until then www HTML fallback may still show old Voice-fix until HTML lands.
