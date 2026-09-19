# Staging → production gate

Fail-closed gate before promoting a staging preview to production (`main` / www.sfdc24.com).

## Staging URL

```text
https://cdn.jsdelivr.net/gh/sfdc-24/sfdc24-site@staging-live/
```

Purge after publish:

```text
https://purge.jsdelivr.net/gh/sfdc-24/sfdc24-site@staging-live/index.html
```

## Promote recipe (staging publish only)

```bash
git push -f origin HEAD:staging
```

That triggers `staging-deploy` → updates `staging-live`. It does **not** merge to `main` or change Pages for www.sfdc24.com.

## Run the gate locally

From the repo root (Node 18+; Node 22 in CI):

```bash
node tests/staging_prod_gate.cjs
```

File checks only (no live fetch):

```bash
SKIP_NETWORK=1 node tests/staging_prod_gate.cjs
```

Optional env: `STAGING_URL`, `PROD_URL`, `STAGING_TTFB_MAX_MS`, `PROD_TTFB_MAX_MS`.

## What it checks (all labeled; fail closed)

1. **Required check names** — workflow job names for the six branch-protection contexts are present under `.github/workflows/`.
2. **Speed smoke** — fetch staging + prod; TTFB under labeled ms thresholds (default staging 5000 / prod 3000).
3. **Local-first markers** — `assets/local-first-boot.js` + homepage references.
4. **No SFDC24 greeting spam** — triage greeting answer stays brand-free / short.
5. **Honesty surfaces** — no present-tense invented live-org claim phrases; staging-live must keep STAGING banner + noindex.

## CI

Workflow: `.github/workflows/staging-prod-gate.yml`  
Check context: `staging-prod-gate / test`  
Triggers: `workflow_dispatch`, push to `staging`, pull requests.

Board id: `CODEX-STAGE-GATE-001`. Grok speed-tests this gate module's own wall-clock runtime; Foundry owns broader Daily SPEED TEST design.
