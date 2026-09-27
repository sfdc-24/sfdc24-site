# /ops/ In progress ↔ Backlog funnel (release train) (CONF-LINE-OPS-FUNNEL-20260926)

## Why /ops/ looked empty
The Active queue was a baked/hand snapshot stuck on Voice-fix theater. Not bus-driven.

## Truth tonight (sample snap + next-release on this branch)

### In progress (release train)
1. Conference Line LiveKit spike on the shared room contract.
2. SA Wed Applicant Portal build for the Wednesday demo.
3. Org AI inventory across client orgs and enablement lanes.

### Backlog (parked / resumable — NOT deleted)
Codex architecture PDF "Next promotions, in order" (2026-09-26 p2) — sequenced first:

| # | Item | Effort | Est. | Gate notes |
|---|---|---|---|---|
| 1 | PR-272 repaired on a fresh exact head, independent acceptance, then a newly verified image; each requires Codex GO | HIGH | ~1–2 days fleet | Controller arbiter repair before any promote |
| 2 | Deploy, traffic and the owner rehearsal (targeted G1 close) — gated separately after item 1 | MEDIUM | ~0.5–1 day after PR-272 GO | G1 continuous-audio / live-prototype evidence |
| 3 | Complete G2 and the PR-260 gate, then PR-261 | HIGH | ~2–4 days | G2 provider reliability; G3 workspaces; G4 stacked on G3 |
| 4 | Repair and review PR-269; CX1 charter-only operator canary with PDF and price effects off; CX2 unpriced then fully priced quote canaries after owner commercial gates; traffic is a separate GO; then ADR G5–G9 | HIGH | ~1–2 weeks gated | CX1/CX2 then G5–G9 |

Parked (prior demotions — still resumable):
1. Voice fix for the heard question, parked until the next release window. (demoted from Active)
2. Ops page with architecture of CI/CD, agents and bus, backlog queue and release view. Managed by Python post-release.
3. Homepage visitor talk becomes a queued prototype for a later release.

### Promotion ledger — ADR pass conditions (Codex PDF p2)
Source: SFDC24 + Blackboard future governed minibus architecture, 26 Sep 2026. Do not invent parallel strategy.

| Component | Pass condition | Gate |
|---|---|---|
| Control plane motherboard | Kill switch reaches connected nodes within the 60 s design target | G9 enrollment |
| OpenAI Realtime | Ten minutes, five turns, two barge-ins, no reconnect or transcript-only substitution | G1 |
| OpenAI TTS | Spoken once through the browser audio arbiter in that session | G1 |
| Web / mobile | No cross-tenant read or reuse; revocation enforced at every boundary | G3 |
| WhatsApp | One inbound message, one authorized work item, one delivered status with destination receipt | G8 |
| Zoom RTMS + Ubuntu presenter | A consented real meeting: media, speak, present, reconnect, tear down | G8 |
| One browser audio arbiter | Two barge-ins inside the ten-minute continuous-audio session | G1 |
| Studio Controller turn and task arbiter | End-to-end deadlines, cancellation, fallback, circuit state, stale-turn fences, bounded bodies, receipts, fault tests | G2 |
| Session, event + CAS ledger | Final artifact reproduced from the event ledger; one publication and one receipt after a crash | G1, G4 |
| Concurrent bounded work | A stale, late, malformed or over-budget Gemini result cannot change the artifact | G5 |
| Single artifact committer | At least three visible typed revisions in one session | G1 |
| Durable outbox + capability gateways | A confirmed sandbox operation dispatches once, is read back, survives restart, has a tested rollback | G7 |
| Charter + quote PDF (PR-269) | Repair and review; CX1 with PDF and price effects off; CX2 after owner commercial gates | CX1, CX2 |
| Converspan minibus | ADR G9 in full, including G2 and its own enrollment | G9, non-waivable |
| Nav / steelworkson.ca minibus | PR-260 exact-head acceptance, PR-261, then its own G9 enrollment | G3, G4, G9 |
| Additional client minibuses | Each its own G9 enrollment; Converspan soak is evidence, not approval | G9 |
| Salesforce commercial engine | Lead count matches a separate org read with org binding; then sandbox mutations | G6, G7 |

## Demote / resume control
- Active = `open_work.next: true` or `lane: "cooking"` (internal lane key)
- Demote → Backlog = same work `id`, set `lane: "backlog"`, clear `next` (preserves row for resume)
- Resume / promote = set Active (`lane: "cooking"` + `next: true`) in sanitized `BOARD_OPS_EXPORT`
- Python `tools/board_ops_snap.py` bakes every ~5m to branch `board-ops-snap`; page polls 60–120s

## Fleet roles
| Agent | Role |
|---|---|
| Claude | MCP gatekeeper + governance/controller/host |
| Codex | Dev lead |
| Cursor | Coding/dev |
| Copilot | Git review |
| Gemini | Coordinator/admin + GCP/VM/infra |
| Grok | Strategy lead / PM |
| Meta | WhatsApp for Business notify |

## Release plan (PM) — Gantt milestones (anchor Sun Sep 27 2026 ET)

| Milestone | Window (ET) | Effort | Maps to Codex sequence |
|---|---|---|---|
| 🔧 M1 PR-272 Codex GO + verified image | Sep 27–28 | HIGH · 1–2d | Item 1 |
| 🚀 M2 Deploy/traffic + owner G1 rehearsal | Sep 29 | MED · 0.5–1d after M1 | Item 2 |
| 🧱 M3 G2 complete + PR-260 then PR-261 | Sep 30–Oct 3 | HIGH · 2–4d | Item 3 |
| 📄 M4 PR-269 repair + CX1 | Oct 4–7 | HIGH | Item 4 / CX1 |
| ✅ M5 CX2 + traffic GO | Oct 8–10 | HIGH · gated | Item 4 / CX2 |
| 🎯 M6 ADR G5–G9 path; Converspan G9 held until foundation | Oct 11–17+ | HIGH · 1–2w gated | Item 4 / G5–G9 |

Live chart: `/ops` **Release plan (PM)** at page top — Staging → Prod after CI green + exact-head GO.
