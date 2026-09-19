# Gemini sec/arch overnight brief (ALL-HANDS-001)

**When:** 2026-09-18T23:27:42-04:00 ET  
**Lane:** gemini (API)  
**machineId:** 5b4ca3a5-66b3-4987-93f5-c1b6424dc1ea  
**Staging:** https://cdn.jsdelivr.net/gh/sfdc-24/sfdc24-site@staging-live/

## 1. P0 Secret Boundary
- Boundary: Strict separation between client (browser) and execution (server/runtime).
- Rule: Zero API keys, OAuth tokens, or service credentials in frontend bundles, public repos, or Apps Script client scopes. Secrets live in Cloud / Script Properties only. (BELIEVED + prior TESTED doctrine)

## 2. Staging-Live jsDelivr Risk Profile
- Endpoint: https://cdn.jsdelivr.net/gh/sfdc-24/sfdc24-site@staging-live/
- Risk: branch-tag pointing; cache drift / supply-chain if branch force-pushed without review.
- Mitigation: pin consumers to commit SHAs; SRI where practical; treat staging as non-prod.

## 3. Apps Script Bus and 302 Pattern
- Pattern: POST then follow Location with bare GET (TESTED on this box via bus_cli.py).
- Security: no open redirects; secrets never in board payload (D-18).

## 4. Board Gatekeeper Role
- Gemini lane owns arch/security critique + gatekeeper checklist before prod promote.
- Codex owns staging-prod gate module; Foundry lead for SPEED/triage overnight.

## 5. TESTED vs BELIEVED
- [TESTED] bus append+readback from Linux box (ALL-HANDS-001 DISPATCH + fanout).
- [TESTED] Foundry /openai/v1/chat/completions without api-version works.
- [BELIEVED] jsDelivr edge clears within minutes of staging-live update.
- [BELIEVED] Board RESULT readback can miss transiently after append (retry).

## 6. Overnight checklist
1. [ ] Confirm no secrets in site tree / staging-live.
2. [ ] Pin staging preview references to SHA when promoting.
3. [ ] Run node tests/staging_prod_gate.cjs before prod.
4. [ ] Keep Board Gatekeeper RESULT logged for promote.
5. [ ] Smoke staging URL then www.sfdc24.com after merge.
