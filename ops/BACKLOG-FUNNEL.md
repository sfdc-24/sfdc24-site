# /ops/ Cooking ↔ Backlog funnel (CONF-LINE-OPS-FUNNEL-20260926)

## Why /ops/ looked empty
Cooking was a baked/hand snapshot stuck on Voice-fix theater. Not bus-driven.

## Truth tonight (sample snap + next-release on this branch)

### Cooking now (active priority funnel)
1. Stella launch, Release 1. Target Tue 24 Nov 2026, 2:40 PM EST.
2. Demo-closure gate.

### Backlog (parked / resumable — NOT deleted)
1. Light owner page after the Demo-closure gate.
2. Penpot design board. Target, not built.
3. One isolated container per call. Target, before any customer-org work.

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
