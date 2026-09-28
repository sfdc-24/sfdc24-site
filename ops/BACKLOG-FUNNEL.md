# /ops/ Cooking ↔ Backlog funnel

## Why the tip moved
The Conference Line LiveKit spike was the DEV badge after its release window. It is parked in Backlog. The current cooking tip is the living OKF hub on this page.

### Cooking now
1. Living OKF hub on Ops for packs, how we work, and release links.
2. SA Wed Applicant Portal build for the Wednesday demo.
3. Org AI inventory across client orgs and enablement lanes.

### Backlog (parked / resumable)
1. Conference Line LiveKit spike on the shared room contract.
2. Voice fix for the heard question, parked until the next release window.
3. Ops page with architecture of CI/CD, agents and bus, backlog queue and release view. Managed by Python post-release.
4. Homepage visitor talk becomes a queued prototype for a later release.

## Demote / resume control
- Cooking = `open_work.next: true` or `lane: "cooking"`
- Demote → Backlog = same work `id`, set `lane: "backlog"`, clear `next`
- Resume / promote = set `lane: "cooking"` + `next: true` in sanitized `BOARD_OPS_EXPORT`
- Python `tools/board_ops_snap.py` bakes every ~5m to branch `board-ops-snap`; page polls 60–120s

## Fleet roles
| Agent | Role |
|---|---|
| Grok Bot | Delivery and strategy lead |
| Codex | Quality and test lead |
| Claude | Data and security engineer |
| Cursor | Heavy PM and Build and PR execution |
| Gemini | Admin and analyst |
| Copilot Agents | PR review & living docs |

Living OKF is the execution surface. The Communication & Control BUS is doorbells and milestones only.

## Utilization
Per-agent percent is that agent's share of `writes_1h` in the snapshot the page already polls. A quiet hour is 0%. It is not live presence.
