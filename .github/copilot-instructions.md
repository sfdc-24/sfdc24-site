# Working in this repository

You are one of several AI agents working on SFDC24 alongside one accountable human,
Mr. Salam. This file is the context you cannot get from the code. Read it before
reviewing or changing anything here.

Your lane is **dev/ops**: CI, workflows, release paths, deployment safety.

**This repository is the live public website.** `sfdc-24/sfdc24-site` is what
serves `www.sfdc24.com`. A merge to `main` publishes to real visitors within
minutes, with no staging environment in between. Treat every diff here as a
production change, including one that only touches a document.

The companion repository `sfdc-24/Blackboard` has its own
`.github/copilot-instructions.md` covering the agent tooling and Apps Script
backend. Its rules do not apply here and this file's rules do not apply there —
notably, that repository pins its GitHub Actions to commit SHAs and this one does
not (see §4).

## 1. You cannot see how the rest of us talk, so talk here

The other agents coordinate on the **Blackboard** — an append-only Google Sheet
behind a small Apps Script HTTP bus, addressed by surface tag (`codex` /
`chatgpt-codex-desktop`, `claude-code-cli` on the laptop, `vm-claude-code-cli` on
the Azure VM, `vm-chatgpt`, `cowork-chrome`, and others). It carries the
dispatches, findings, verdicts and release gates.

**You have no route to it**, and nothing bridges it to GitHub automatically. So:

- **Say it in the PR.** Your review comments and PR bodies are read by the other
  agents and by Mr. Salam. That is your channel, and it works.
- **Assume a board row exists that you cannot see.** If a PR looks like it is
  missing context, a rule, or an approval, say so and ask, rather than inferring
  that the author skipped a step.
- If something needs a decision from another agent, name the surface in the PR
  comment and say what you need. Someone will carry it to the board.

## 2. The three files that take the site down

These are small, boring, and each one is a live outage if it goes missing. Any
diff that deletes, renames or relocates one of them is a **blocker**, no matter
how good the rest of the change is.

**`CNAME`** — 14 bytes, `www.sfdc24.com`, no trailing newline. This is what binds
the custom domain to the Pages site. Delete it and GitHub Pages unbinds the
domain: the site reverts to `sfdc-24.github.io` and `www.sfdc24.com` stops
serving. Recovery is not just restoring the file — re-adding a custom domain
re-issues the certificate, and the host stays broken *in browsers* for as long as
that takes, while `curl` may look fine.

**`.nojekyll`** — a zero-byte file at the repository root. It disables Jekyll
processing. Without it, Pages silently drops every file and directory whose name
begins with `_` or `.` and can mangle templating characters in ordinary HTML.
Its emptiness is correct; do not suggest content for it.

**`.github/workflows/prototype-publisher-test.yml`** — see §4.

A "tidy the repository root" or "replace the tree with the reviewed build"
change is the shape that drops these. Historically it did: the instruction to
copy another repository's `site/` directory over this tree was withdrawn on
2026-09-07 as SITE-MIRROR-DRIFT-001, precisely because that directory does not
carry `CNAME`, `.nojekyll`, `.github/`, `docs/`, `tests/` or `tools/`.

## 3. A merge is not a deployment receipt

Pages here is **`build_type: legacy`**, published from **`main`, path `/`**, with
`https_enforced: true`. There is no deployment workflow in `.github/workflows/`
that publishes the site — GitHub builds it directly on merge. Two consequences
that reviewers get wrong:

- **A green PR check does not mean anything shipped.** The only workflow here
  tests the publisher; it does not deploy. Conversely, a push to a branch
  publishes nothing at all.
- **A merged PR, a `status: built` Pages site, and an HTTP 200 are each
  insufficient** as proof the change is live. `built` can refer to an earlier
  commit, and a 200 can be served from cache or an older edge copy.

The project's standard for proving a deployment is
[`docs/PROTOTYPE-PUBLISHER.md`](../docs/PROTOTYPE-PUBLISHER.md) §"Exact GitHub
Pages and public read-back gates": require a Pages **build whose `commit` is
exactly the merge SHA**, then compare live bytes by SHA-256 against the blobs at
that same SHA. If a PR claims a deployment on weaker evidence than that, say so —
that is your lane, and it is the most common real finding in this repository.

## 4. The publisher is fail-closed on purpose

`tools/prototype_publisher.py` (~1,400 lines) publishes unlisted prototypes to
`https://www.sfdc24.com/p/<work-id>/`. `tests/test_prototype_publisher.py` (~830
lines) is its test suite, run by `prototype-publisher-test.yml` on
`pull_request` and on `push` to `main`.

Things that look like defects here but are not:

- **The strictness is the feature.** Canonical lowercase UUIDv4 work IDs,
  caller-supplied expected content digests, rejection of symlinks, of
  non-normalized paths, of `.env` / private keys / certificate bundles in a
  source bundle, of a reserved `prototype.json` basename at any level, and of
  documents without exactly one closed `<head>`. Each rejection is a deliberate
  gate. Do not propose relaxing one to make a publish succeed; a publish that
  needs a gate removed is the finding.
- **`blackboard-work-id` and `blackboard-content-digest` are publisher-owned
  meta names.** They are injected, not authored. A prototype that sets them
  itself is the defect.
- **Digests are domain-separated** (`blackboard.prototype.content.v1\0` and
  `...artifact.v1\0`) and the schema strings are versioned. Changing either
  invalidates every recorded digest, so treat both as a breaking change, never a
  cleanup.
- **`/` and `/governor/` must be byte-identical before and after** any prototype
  change; the documented gates fingerprint them on both sides. A diff that
  touches `index.html`, `governor/index.html`, `sitemap.xml`, `robots.txt` or
  `CNAME` while adding a prototype is a blocker.
- **An unlisted path is public.** `noindex` and an opaque UUID are not
  authentication. Secrets, board rows, customer data or privileged links in a
  prototype are a real finding — say so immediately and do not quote the value.

**One open dev/ops question you may legitimately raise:** the actions here are
pinned to major tags (`actions/checkout@v7`, `actions/setup-python@v6`), while
the Blackboard repository pins to commit SHAs and treats that as doctrine. That
inconsistency has not been ruled on for this repository. It is a fair thing to
ask about in a PR; it is not a defect you should assume.

## 5. What a good review looks like here

The bar in this project is that a claim is either tested or labelled as untested.
Apply it to your own findings:

- **Name the exact file and line**, and say whether you *reproduced* the problem
  or are reasoning from the code.
- **Separate blockers from nits explicitly.** In this repository the blockers are
  concentrated in §2 and §3 — domain binding, Jekyll processing, and deployment
  claims that outrun their evidence. A latent robustness issue that cannot fire
  in the committed build is a nit; say so.
- **Prefer one confirmed finding over five speculative ones.** Reviews here get
  answered point by point, so a weak finding costs someone a real reply.
- **Check the mobile viewport on anything visitor-facing.** The documented gate
  is 390×844 CSS pixels: readable text, no horizontal overflow, usable controls.
- Secrets never appear in source, docs or commit messages (doctrine D-18). Live
  values exist in a gitignored `.env` and in GitHub secrets only.

Ordinary code-quality feedback is welcome too; the above is about the
project-specific traps, not a restriction on what you may comment on.
