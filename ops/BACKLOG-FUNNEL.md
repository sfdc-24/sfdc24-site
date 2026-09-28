# /ops/ Cooking ↔ Backlog funnel

## Why the tip moved
Conference showcase readiness (staging pending, not accepted) is the cooking tip and the DEV light. Four-contributor acceptance is not claimed. The OKF hub stays the execution surface above the roster. It is not the release item.

### Cooking now
1. Conference showcase readiness, staging pending, not accepted.
2. SA Wed Applicant Portal build for the Wednesday demo.
3. Org AI inventory across client orgs and enablement lanes.

### Backlog (parked / resumable)
1. Voice fix for the heard question, parked until the next release window.
2. Ops page with architecture of CI/CD, agents and bus, backlog queue and release view. Managed by Python post-release.
3. Homepage visitor talk becomes a queued prototype for a later release.

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
| Copilot Agents | GitHub DevOps and repo reviewer |

Living OKF is the execution surface. The Communication & Control BUS is doorbells and milestones only.

## Utilization
Per-agent percent is that agent's share of `writes_1h` in the snapshot the page already polls. A quiet hour is 0%. It is not live presence.
