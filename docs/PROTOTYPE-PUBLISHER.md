# Path-first prototype publisher

## Decision and boundary

For the September 10 proof of concept, prototypes belong below the existing
GitHub Pages hostname:

```text
https://www.sfdc24.com/p/<opaque-work-id>/
```

This is a publishing mechanism, not a registration or DNS mechanism. A
NameSilo `dnsAddRecord` call only adds a DNS resource record. GitHub Pages also
requires the custom hostname to be configured on a Pages site, DNS can take
time to propagate, and certificate readiness is separate. The current site is
already one Pages site published from `main` at the repository root and bound
to `www.sfdc24.com`, so a path adds no registrar, hostname, or certificate
state.

An unlisted path with `noindex` is public. It is not authentication and must not
contain secrets, Blackboard rows, private customer data, or privileged links.

## Desired-state contract

`tools/prototype_publisher.py` accepts a canonical lowercase UUIDv4 work ID and
the caller's expected content digest. It publishes one static source directory
to `p/<work-id>/`.

The content digest is deterministic over each relative path and its exact
bytes. The publisher records that digest, the work ID, the public route, every
artifact file hash, and an aggregate artifact digest in
`p/<work-id>/prototype.json`. It also injects the work ID and content digest
into the page as publisher-owned meta tags, so the public page can be tied back
to the desired state without relying on a filename or deployment claim.

The source bundle must:

- contain a UTF-8 `index.html` at its root;
- contain only regular files and directories, never symlinks;
- use normalized relative paths;
- exclude repository-control and credential-prone files such as `.git`, `.env`,
  private keys, and certificate bundles;
- reserve the basename `prototype.json`, case-insensitively, at every directory
  level and leave all `blackboard-*` meta names to the publisher;
- give every HTML document exactly one explicit, closed `head` before `body`;
- use at most one robots and one viewport meta tag inside that head;
- never repeat a `name` or `content` attribute within a meta tag;
- use `noindex` in that robots meta tag when present; and
- use `width=device-width` in that viewport meta tag when present.

If robots or viewport metadata is absent, the publisher adds safe defaults to
every `.html` and `.htm` document in the bundle. The rest of each page must
still be designed and checked at a narrow mobile
viewport; a viewport tag cannot make a fixed-width design responsive.
Robots or viewport metadata in `body` or a template fails closed rather than
creating contradictory crawler or mobile behavior. Head-like text in comments
or scripts is ignored structurally and cannot redirect where publisher
metadata is inserted.

## Local lifecycle

Run from the repository root. These PowerShell examples keep the opaque ID and
the exact digest explicit:

```powershell
$idResult = python tools/prototype_publisher.py new-id | ConvertFrom-Json
$workId = $idResult.work_id

$digestResult = python tools/prototype_publisher.py digest --source C:\path\to\prototype | ConvertFrom-Json
$contentDigest = $digestResult.content_digest

python tools/prototype_publisher.py publish `
  --site-root . `
  --source C:\path\to\prototype `
  --work-id $workId `
  --content-digest $contentDigest

python tools/prototype_publisher.py verify `
  --site-root . `
  --work-id $workId `
  --content-digest $contentDigest
```

The first publish returns `created`. Repeating the exact work ID and digest
returns `unchanged` without rewriting bytes. Reusing the work ID for different
content returns `content_conflict` and changes nothing. Separate work IDs use
separate directories and may be prepared concurrently.

Removal is limited to a publisher-owned directory and requires its recorded
digest:

```powershell
python tools/prototype_publisher.py remove `
  --site-root . `
  --work-id $workId `
  --content-digest $contentDigest
```

A wrong digest, missing state, or artifact drift fails closed. Removal first
creates a per-work-ID journal, atomically moves the target into a deterministic
tombstone, and verifies that moved directory before deleting it. If deletion
fails while the tombstone is intact, the publisher best-effort restores the
original route and returns `removal_delete_failed_restored`. If restoration
cannot complete, the journal and tombstone remain discoverable, publishing and
verification are blocked, and retry resumes the quarantined deletion when its
recorded bytes remain intact. A target collision preserves both states and
returns `removal_recovery_collision`; it never returns `absent`.

Removal also takes a non-blocking per-site, per-work-ID operating-system file
lock below a private per-user directory in the machine's temporary directory.
On POSIX, both lock directories and the persistent lock file must be owned by
the effective user and inaccessible to group and other users. On every
platform, publisher-created path components must be real directories and the
lock must be one real, single-link regular file; symlink and Windows reparse
paths fail closed. The descriptor is opened with no-follow semantics where the
operating system exposes them and is matched back to the inspected path before
the publisher writes or locks a byte.

An active concurrent remover gets `removal_in_progress`. The operating system
releases that lock if its owner crashes, so the next retry can recover a
`deleting` journal: it resumes an intact tombstone, restarts from a verified
restored target, or finalizes `removed` when deletion finished before the
journal update. Only a completed removal with no journal or tombstone makes the
following identical retry return `absent`. A damaged tombstone or conflicting
target remains fail-closed for operator inspection; the publisher never guesses
which conflicting bytes to delete.

Because the result is ordinary Git content, every publish or removal still
goes through review; running the tool alone does not change the live site. A
`.prototype-removals` directory must never be committed: its presence means an
operator must resolve or retry an incomplete local removal first.

## Pull-request gates

Before review:

1. Start from current `origin/main` in an isolated worktree.
2. Record SHA-256 fingerprints for `index.html` and
   `governor/index.html`.
3. Run `python -m unittest discover -s tests -p "test_prototype_publisher.py" -v`.
4. Run `verify` for each prototype included in the change.
5. Confirm the generated `prototype.json` has the requested work ID and content
   digest, and that the committed prototype contains no credentials or private
   data.
6. Recompute the homepage and Governor fingerprints and require exact equality
   with step 2.
7. Require review to show that each new prototype is confined to its own
   `p/<work-id>/` directory and that `index.html`, `sitemap.xml`, `robots.txt`,
   `CNAME`, and `governor/index.html` are unchanged.

## Exact GitHub Pages and public read-back gates

Merging and publishing require separate authorization. After an authorized
merge, do not call the deployment complete merely because the PR merged or the
Pages site says `built`.

Use the merge commit as the immutable candidate and require every gate below:

1. `GET /repos/sfdc-24/sfdc24-site/pages` reports `status=built`,
   `build_type=legacy`, `source.branch=main`, `source.path=/`,
   `cname=www.sfdc24.com`, and `https_enforced=true`.
2. `GET /repos/sfdc-24/sfdc24-site/pages/builds` contains a build whose
   `commit` is exactly the merge SHA, whose `status` is `built`, and whose error
   message is null. A later successful build for another SHA does not satisfy
   this gate.
3. Fetch all files with HTTPS, redirects enabled, and cache bypassed. Require
   HTTP 200 for `/p/<work-id>/` and `/p/<work-id>/prototype.json`.
4. Compare the exact live bytes of every prototype artifact with the same file
   at the merge SHA. At minimum, compare SHA-256 for `index.html`, every listed
   file in `prototype.json`, and the state file itself. Text similarity is not
   sufficient.
5. Parse the live page and state file. Require the exact UUID work ID, exact
   `sha256:` content digest, `noindex`, and `width=device-width`; reject missing,
   duplicated, or contradictory metadata.
6. Fetch `/` and `/governor/` with cache bypassed. Require their SHA-256 values
   to equal both their blobs at the merge SHA and the pre-change fingerprints.
7. Confirm the new route is absent from the homepage, `sitemap.xml`, and all
   public navigation. At a 390-by-844 CSS-pixel viewport, require readable text,
   no horizontal overflow, usable controls, and a visible primary action if the
   prototype has one.
8. Repeat the public fetch from a second resolver or network edge if DNS or
   CDN cache state differs. Do not rewrite DNS to make a failed path deployment
   pass.

For rollback, use the digest-guarded `remove` command in a new reviewed commit,
then apply the same exact-SHA Pages build and public read-back gates. A later
subdomain experiment is a separate design: one Pages hostname binding, one
exact CNAME change after that binding, authoritative and recursive DNS
read-back, TLS readiness, preserved DNS record ID, and a tested rollback. It
must not use wildcard DNS.

## Authoritative references

- [GitHub: managing a custom domain for GitHub Pages](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/managing-a-custom-domain-for-your-github-pages-site)
- [GitHub: REST API endpoints for Pages sites and builds](https://docs.github.com/en/rest/pages/pages)
- [NameSilo: `dnsAddRecord` API](https://www.namesilo.com/api-reference/pages?uid=dns%2Fdns-add-record)
