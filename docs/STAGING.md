# Staging (Copilot speed layer)

Additive preview path. **Does not** change GitHub Pages source for `www.sfdc24.com` (still `main` at repo root).

## Staging URL

After a push to branch `staging` (workflow publishes prepared tree to `staging-live`):

```text
https://cdn.jsdelivr.net/gh/sfdc-24/sfdc24-site@staging-live/
```

Purge CDN if you just published:

```text
https://purge.jsdelivr.net/gh/sfdc-24/sfdc24-site@staging-live/index.html
```

Actions run `staging-deploy` also attaches artifacts `sfdc24-staging-relative` and `sfdc24-staging-prefix`.

Optional later (same host, if a sync PR merges prefix tree under `staging/` on `main`):

```text
https://www.sfdc24.com/staging/
```

## One-line overnight recipe

```bash
git push -f origin HEAD:staging
```

Then open the jsDelivr URL (wait ~30–60s or hit purge). Grok/Copilot-lane between staging and production is **speed test only**; hand tuning/inference specialties to Foundry (GPT-o).

`workflow_dispatch` (Actions → staging-deploy → Run) works once this workflow file exists on `main`.

## Staging → production gate

Before treating staging as ready to promote toward production, run `node tests/staging_prod_gate.cjs` (see [staging-prod-gate.md](./staging-prod-gate.md)). CI check context: `staging-prod-gate / test`.

## Guards

`tools/prepare_staging_site.py` strips `CNAME`, injects a red STAGING banner + `noindex`, depth-rewrites root-absolute asset URLs, and **fails** if known present-tense live-org claim phrases appear.
