# Working in this repository

**This repository is the live website.** A merge to `main` publishes to
`www.sfdc24.com` through GitHub Pages within minutes, with no staging step in
between. Everything below follows from that.

You are one of several AI agents working on SFDC24 alongside one accountable
human, Mr. Salam. Your lane here is **dev/ops**: release safety, CI, and what
reaches visitors.

The companion repository `sfdc-24/Blackboard` is source and tooling; this one is
production, and the two carry different risk profiles. Equivalent instructions
for that repo are **proposed but not merged** — they live in Blackboard PR #38,
open at `bbb6ce76`, and a contents read of Blackboard `main` returns 404. Do not
assume they are in force there. Instructions do not propagate between the two
repos in any case.

## 1. You cannot see how the rest of us coordinate

The other agents work through the **Blackboard** — an append-only Google Sheet
behind an Apps Script bus. You have no route to it, and nothing bridges it to
GitHub. So your review comments and PR bodies are your channel; the other agents
read them. If a PR looks like it is missing context or an approval, say so and
ask, rather than assuming the author skipped a step — the reasoning often lives in
a board row you cannot see.

## 2. Things that must not be removed, and are easy to remove by accident

**`CNAME`.** Contains `www.sfdc24.com`. Deleting or altering it drops the custom
domain binding. A previous cutover took the site down in browsers for about 45
minutes while a certificate reissued, and every `curl` check said it was fine
throughout.

**`.nojekyll`.** Without it Pages runs the content through Jekyll, which ignores
files and directories beginning with `_` and can change what is served.

**`tools/` and `tests/`.** `tools/prototype_publisher.py` is a deterministic,
fail-closed publisher for unlisted prototype routes, with its own test suite and
workflow. It is release machinery, not sample code.

Its strictness is the feature, not an obstacle: canonical lowercase UUIDv4 work
ids, caller-supplied expected digests, and rejection of symlinks, non-normalized
paths, and `.env` files, private keys or certificate bundles inside a bundle.
**Never propose relaxing a gate to make a publish succeed — a publish that needs
a gate removed is itself the finding.** `blackboard-work-id` and
`blackboard-content-digest` are publisher-owned meta names, injected rather than
authored, so a prototype that sets them itself is the defect. Digests are
domain-separated and versioned (`blackboard.prototype.content.v1\0`); changing
one invalidates every digest already recorded, which is a breaking change and
never a cleanup.

A wholesale tree replacement is the specific way all of these get lost at once.
It has been attempted before: the instruction to mirror `site/` from the
Blackboard repo over this tree was **withdrawn** on 2026-09-07
(`SITE-MIRROR-DRIFT-001`) precisely because `site/` does not contain any of the
above. **Blackboard's `site/` directory is not a deployment source.** Work here,
on a review branch, editing only the intended files.

## 3. Release facts

| | |
|---|---|
| Serves | `www.sfdc24.com`, GitHub Pages from `main`, path `/` |
| Deploy trigger | a merge to `main` |
| Rollback | revert the change here and verify the resulting Pages deployment; leave domain config alone |
| Public routes | `/`, `/voice/`, `/governor/`, `/intake/`, `/projects/`, `/privacy/`, `/terms/`, `/xray/`, plus `404.html` |

**`/xray/` is a synthetic demo, and it is reachable by anyone who has the URL.**
It is deliberately absent from `sitemap.xml`. That is not the same as being
unindexable: `robots.txt` allows `/`, and the page carries no `noindex` as of
this writing — site PR #13 adds one. Do not describe the route as private,
protected, or impossible to index. Its data is fabricated and labelled as such on
the page, and it carries no real org identifier; the importer that once accepted
a local `scores.json` was removed in PR #15, so the page renders a build-time
constant and takes no runtime input at all.

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
  deliberate. But sitemap omission and `noindex` are two different controls, an
  unlisted page needs both, and neither one is authentication. `/governor/`,
  `/voice/` and `404.html` carry `noindex`; `/xray/` shipped without one, which
  is how the gap was found. Secrets, board rows, customer data or privileged
  links on an unlisted page are a real finding — say so immediately and do not
  quote the value.
- **`/` and `/governor/` must be byte-identical before and after** any prototype
  change. A diff that touches `index.html`, `governor/index.html`, `sitemap.xml`,
  `robots.txt` or `CNAME` while adding a prototype is a blocker.

## 5. Conventions

The first two are the **forward rule for new or changed workflows**, not a
description of the tree as it stands. Only one of the four workflows on `main`
satisfies both today, so do not report the others as regressions — they are known
exceptions awaiting separate remediation.

- Pin actions to a commit SHA with the version in a trailing comment; do not
  suggest floating them back to tags. Pinned today: `intake-tests.yml` and
  `homepage-recovery-test.yml`. Still on floating major tags
  (`actions/checkout@v7`, `actions/setup-python@v6`):
  `prototype-publisher-test.yml` and `xray-page-test.yml`.
- Workflows set `permissions: contents: read` and `persist-credentials: false`.
  Only `intake-tests.yml` sets `persist-credentials: false` today — including
  `homepage-recovery-test.yml`, which is SHA-pinned but does not set it.
- Tests live under `tests/` and use **either** Node's built-in test runner
  (`intake.cjs`, `homepage_recovery.cjs`) **or** Python `unittest`
  (`test_xray_page.py`, `test_prototype_publisher.py`), whichever suits the area.
  Run them from a path-scoped workflow. Add a new workflow for a new area rather
  than widening an existing job's discovery pattern, so a reviewed job keeps
  running exactly what was reviewed.
- Note which kind of test you are reading. The `test_xray_page.py` suite asserts
  against the page *source text*: it proves a sanitiser is present, not that it
  works. A behavioural test that executes the served script can catch what a
  static one cannot.
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
