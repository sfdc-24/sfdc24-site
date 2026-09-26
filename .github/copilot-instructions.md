# Working in this repository

**This repository is the live website.** A merge to `main` publishes to
`www.sfdc24.com` through GitHub Pages within minutes. Staging exists as an
**additive** preview (jsDelivr `staging-live`); it is not a Pages source switch
and it does not delay production. Everything below follows from that.

You are one of several AI agents working on SFDC24 alongside one accountable
human, Mr. Salam. Your lane here is **GitHub speed layer**: release safety, CI,
workflow hygiene, review comments, and the cheap-edit path. You are not the
product designer and you are not Claude.

The companion repository `sfdc-24/Blackboard` is source and tooling; this one is
production, and the two carry different risk profiles. Do not assume Blackboard
has Copilot instructions on its `main` unless you verify a contents read
yourself. Instructions do not propagate between the two repos.

Standing doctrine for visitor-facing work lives in `docs/site-doctrine.md`.
**SEO is out of scope forever.** Speed and interactivity govern. Functional over
pretty. No visitor-facing "AI Fitness". Header mark is **SFDC + HH:mm**
(America/Toronto, 24h). LinkedIn is footer-only.

Housekeeping tracker for the Cursor + grok-bot duplicate pile: issue #110.

## 1. You cannot see how the rest of us coordinate

The other agents work through the **Blackboard** — an append-only Google Sheet
behind an Apps Script bus.

**No verified direct Copilot access to Blackboard is configured. PR comments are
its direct channel; a separate coordination process may relay them. A relay is
complete only after destination read-back.**

If a PR looks like it is missing context or an approval, say so and ask, rather
than assuming the author skipped a step — the reasoning often lives in a board
row you cannot see.

## 2. Things that must not be removed, and are easy to remove by accident

**`CNAME`.** Contains `www.sfdc24.com`. Deleting or altering it drops the custom
domain binding. A previous cutover took the site down in browsers for about 45
minutes while a certificate reissued, and every `curl` check said it was fine
throughout.

**`.nojekyll`.** Without it Pages runs the content through Jekyll, which ignores
files and directories beginning with `_` and can change what is served.

**`tools/` and `tests/`.** `tools/prototype_publisher.py` is a deterministic,
fail-closed publisher for unlisted prototype routes, with its own test suite and
workflow. `tools/site_edit_router.py` is the tier-zero cheap-edit path (no
model). `tools/build_site_manifest.py` plus the `site-manifest` job fail on
drift. These are release machinery, not sample code.

Publisher strictness is the feature, not an obstacle: canonical lowercase UUIDv4
work ids, caller-supplied expected digests, and rejection of symlinks,
non-normalized paths, and `.env` files, private keys or certificate bundles
inside a bundle. **Never propose relaxing a gate to make a publish succeed — a
publish that needs a gate removed is itself the finding.**
`blackboard-work-id` and `blackboard-content-digest` are publisher-owned meta
names, injected rather than authored, so a prototype that sets them itself is
the defect. Digests are domain-separated and versioned
(`blackboard.prototype.content.v1\0`); changing one invalidates every digest
already recorded, which is a breaking change and never a cleanup.

A wholesale tree replacement is the specific way all of these get lost at once.
The instruction to mirror `site/` from the Blackboard repo over this tree was
**withdrawn** on 2026-09-07 (`SITE-MIRROR-DRIFT-001`) precisely because `site/`
does not contain any of the above. **Blackboard's `site/` directory is not a
deployment source.** Work here, on a review branch, editing only the intended
files.

## 3. Release facts

| | |
|---|---|
| Serves | `www.sfdc24.com`, GitHub Pages from `main`, path `/` |
| Deploy trigger | a merge to `main` |
| Staging (additive) | `git push -f origin HEAD:staging` → workflow `staging-deploy` publishes `staging-live`. Preview: https://cdn.jsdelivr.net/gh/sfdc-24/sfdc24-site@staging-live/ — see `docs/STAGING.md`. Does **not** change Pages source. |
| Rollback | revert the change here and verify the resulting Pages deployment; leave domain config alone |

**Public / advertised routes** (in `sitemap.xml` today): `/`, `/projects/`,
`/privacy/`, `/terms/`, `/intake/`.

**Other reachable routes** (unlisted from the sitemap on purpose, most of them
`noindex`): `/method/`, `/history/`, `/agents/`, `/org/`, `/panels/`,
`/review/`, `/voice/`, `/governor/`, `/xray/`, `/looks/`, `/stats/`, `/speed/`, `/ops/`,
`/p/<uuid>/`, plus `404.html`.

**`/xray/` is a synthetic demo, and it is reachable by anyone who has the URL.**
It is deliberately absent from `sitemap.xml` **and** it carries `noindex`.
Those are two different controls; neither is authentication. Do not describe
the route as private or protected. Its data is fabricated and labelled as such.
The importer that once accepted a local `scores.json` was removed in PR #15.

**A successful push is not a deployment receipt.** Verify the completed Pages
deployment, the changed page's behaviour, and that the other public routes still
resolve. Preferably in a browser — `curl` has repeatedly reported this site
healthy when it was not.

**Tie the deployment back to the merge.** The completed Pages build should
identify the exact merge SHA; compare the changed live bytes against the blob at
that SHA rather than accepting that the build reported success. Check a 390×844
mobile viewport alongside desktop — layout regressions here have shipped
unnoticed.

Related, and the reason status codes are untrustworthy here: an Apps Script web
app returns **HTTP 200** for both a Drive notice page and a full sign-in page. Any
health check against the embedded backends must inspect the body for interstitial
markers rather than trusting the status.

## 4. What reaches visitors is a review concern, not just correctness

This is the part most easily missed by a reviewer looking only at the diff.

- **Internal identifiers do not belong on public pages.** Org names, internal
  logins, live inventory of our own systems, and links to internal documents have
  all appeared here and had to be removed. If a diff adds or retains one, raise it.
- **Copy changes can change meaning.** Removing a caveat is a substantive change
  even when it reads as tidying — check that the page's claims still match what
  the backend actually does.
- **Forms and submissions.** Note where a form actually posts, and whether the
  page's wording matches that destination. Salesforce Web-to-Lead in particular
  fails silently once a limit is hit: the visitor still sees success.
- **Unlisted is a real state — and an unlisted path is still public.** Some
  routes are deliberately absent from `sitemap.xml`: reachable but not
  advertised. Do not "fix" a missing sitemap entry without checking whether it is
  deliberate. Sitemap omission and `noindex` are two different controls; an
  unlisted page needs both; neither one is authentication. Secrets, board rows,
  customer data or privileged links on an unlisted page are a real finding —
  say so immediately and do not quote the value.
- **`/` and `/governor/` must be byte-identical before and after** any prototype
  change. A diff that touches `index.html`, `governor/index.html`, `sitemap.xml`,
  `robots.txt` or `CNAME` while adding a prototype is a blocker.
- **Do not invent a second homepage.** `/cool/`, cabinet-shell rewrites, and
  overnight "trim" branches already created a pile of dirty PRs (#110). Recut
  onto current `main` or do not open the PR.

## 5. Conventions

The first two are the **forward rule for new or changed workflows**, not a
description of the tree as it stands. Do not report the exceptions as
regressions — they are known and awaiting separate remediation.

- Pin actions to a commit SHA with the version in a trailing comment; do not
  suggest floating them back to tags.
  - **SHA-pinned today:** `intake-tests.yml`, `homepage-recovery-test.yml`,
    `honesty-dom-test.yml`, `site-positioning-test.yml`, `site-manifest.yml`,
    `python-offload.yml`, `staging-deploy.yml`, `sync-staging-ref.yml`.
  - **Still on floating major tags** (`actions/checkout@v7`,
    `actions/setup-python@v6`): `prototype-publisher-test.yml` and
    `xray-page-test.yml`.
- Workflows set `permissions: contents: read` on test jobs and
  `persist-credentials: false` on checkout. Several test workflows already set
  it (`intake-tests`, `honesty-dom-test`, `site-positioning-test`,
  `site-manifest`, `python-offload`, `staging-deploy`).
  `homepage-recovery-test.yml` is SHA-pinned but still omits
  `persist-credentials: false`. `sync-staging-ref.yml` is a write job (it
  force-pushes `staging`) and is pinned without that flag.
- **Required checks** on `main` (strict, no bypass): honesty-dom-test,
  site-positioning-test, prototype-publisher-test, homepage-recovery-test,
  intake-contract, xray-page-test. Also present but not in that ruleset:
  site-manifest, python-offload, staging-deploy, sync-staging-ref.
- Tests live under `tests/` and use **either** Node's built-in test runner
  (`intake.cjs`, `homepage_recovery.cjs`, `ask_bar_ux.cjs`,
  `site_positioning.cjs`) **or** Python `unittest` (`test_xray_page.py`,
  `test_prototype_publisher.py`, `test_python_offload.py`), whichever suits
  the area. Run them from a path-scoped workflow. Add a new workflow for a new
  area rather than widening an existing job's discovery pattern, so a reviewed
  job keeps running exactly what was reviewed.
- Note which kind of test you are reading. The `test_xray_page.py` suite asserts
  against the page *source text*: it proves a sanitiser is present, not that it
  works. A behavioural test that executes the served script can catch what a
  static one cannot.
- Cheap homepage edits go through `tools/site_edit_router.py` when
  `check()` passes. **Escalate to Claude** (do not silently patch) for: triage
  routing/patterns, CREW/DoL wiring, new visitor-visible claims hitting
  ORG_NOUN / first-person, `chrome.js` liveflow / wakeFleet / estimator, new
  pages needing honesty/positioning/publisher, or an ask with no single
  manifest target.
- `assets/triage.py` generates `assets/triage.js`. Edit the Python and re-run
  it; do not hand-edit the JS. `route()` must return the scored CREW winner
  (`routeTo: best`), not a hard-coded grok string (CODEX-REVIEW-001 B1 / #112).
- No secrets in source, ever. A credential in a diff is a real finding — say so
  immediately and do not quote the value.

## 6. What a good review looks like here

- **Name the exact file and line**, and say whether you *reproduced* the problem
  or are reasoning from the code.
- **Separate blockers from nits explicitly.** An issue that cannot fire in the
  committed build is a nit; say so rather than letting it read as a blocker.
- **Prefer one confirmed finding over five speculative ones.** Reviews here get
  answered point by point, and a confident wrong finding is the expensive kind.
- Anything touching a release path, DNS, `CNAME`, or a credential deserves a
  comment even when the diff looks routine. That is your lane.
- Do not recut work from leftover `cursor/*`, `grok-bot/*`, or
  `claude-code-cli/*` branches listed in #110. Those PRs were closed as
  superseded or dirty. P0s that remain open on purpose: issues #1 / #2 and
  PRs #3, #6, #12, #21, #22.

## 7. What not to start

Cataloged, no go from Mr. Salam: issues #24 (live prototype canvas) and #25
(visual worktree). `/cool/` (issue #61) is closed as not planned after the
chrome rewrite. Do not open overlapping chrome, Method, or staging PRs — those
already shipped in #79, #95, #99, #101–#109.
