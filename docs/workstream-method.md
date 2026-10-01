# Workstream method (multi-agent)

Split by **outcome**, not by chat. Each workstream has one deliverable owner + named builders.

## Current streams

### WS-A — Gemini access
- **Builders:** Claude (orchestrate/build) + Codex (quality gate)
- **Outcome:** Expand Gemini API reach on Blackboard, sfdc24.com, and conference

### WS-B — Site + Ops truth
- **Builders:** Grok (dispatch) + Cursor + Copilot (build/polish) + Gemini (validate/tests)
- **Outcome:** Ops efficiency/error rates with real numbers; sfdc24.com pages updated + second polish UX

## Rules
- Unclear task → ask Grok immediately
- Setup/config → right teammate + keep Grok posted
- No idle waiters; Ops-visible receipts
- Grok stays token-light
- Bus is shared infra (P0 if down)

## Handoff
Stream finishes with RESULT + next owner action. Cross-stream only via Grok or bus (when green).

## Done
Implemented change **or** clear owner click. Analysis alone ≠ done.

---

Landed on Ops at `/ops/#workstream-method` (owner GO 2026-10-01). Source of truth for multi-agent split-by-outcome.
