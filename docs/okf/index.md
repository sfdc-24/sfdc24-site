---
type: index
title: sfdc24.com — living OKF
owner: claude-code-cli (publisher and operator)
updated: 2026-10-03T23:59:00Z
---

# sfdc24.com — the living pack

His directive, 2026-10-03 (relayed as `GROK-OKF-LIVE-WRITE-20261003T1426Z`): the conference line,
**sfdc24.com** and Blackboard each get an OKF with one writer and read access for everyone, and a
rule that hands the pen over during a live call. The other two had one. This repository had none,
so this is **the smallest honest version**: what is true about this site, where it is written down
already, and the handover rule that makes it live.

It is deliberately short. A page here earns its place by being something a peer would otherwise get
wrong; everything else stays in the file that already owns it.

| Page | Purpose |
|---|---|
| [The floor](floor.md) | Who may write this pack, and how the pen is handed over during a call |

## What this repository is

- **It is the publisher.** The live site is this repository, `sfdc-24/sfdc24-site`, served by GitHub
  Pages. It is not Blackboard's `site/` folder, which is a different tree that does not publish.
- **A merge to `main` publishes.** There is no separate deploy step and no staging gate in front of
  it: what lands is what a visitor gets, minutes later. A failing suite does not stop Pages, so
  green is not the thing that decides whether the site is right — the served page is.
- **Verify on `www`,** not on the apex and not on a local file. `www` is a **CNAME** and must never
  become an A record.
- **`docs/` is not served.** This pack, and everything else under `docs/`, is for the fleet. Nothing
  in it reaches a visitor.

## What binds anyone writing here

- **`/ops` only moves forward.** Fix forward on current `main`; never land an older version of a
  page. The `ops-forward` workflow is the check, not a habit.
- **Snapshot before a release, and after,** and show the two side by side. His rule of 2026-09-25.
- **When he rejects a phrase, grep the whole repository for it.** Banned copy survives on the pages
  nobody was looking at, and the footer is rebuilt at runtime by `chrome.js`, so a static edit and
  its static test can both pass while the live page still says the old thing.
- **The homepage is the lane** unless he names another page.
- **DNS is his tap.** Not a standing permission, for this domain or any other.

## Where the rest already lives

| It is written in | For |
|---|---|
| [`docs/site-doctrine.md`](../site-doctrine.md) | How the site is built and what it may claim |
| [`docs/OPS-DELIVERY.md`](../OPS-DELIVERY.md) | The `/ops` page's delivery data and its guards |
| [`docs/STAGING.md`](../STAGING.md) | The staging path and what it does not promise |
| [`docs/lessons-log.md`](../lessons-log.md) | What has gone wrong here before |
| Blackboard `docs/EXPRESS.md` | How the fleet works, required reading every session |
| Blackboard `docs/POKA-YOKE.md` | The mechanisms, including L-116 and L-117, which this rule is |

## What this pack does not hold yet

Grok leads strategy and content for this site. If the site's OKF should carry the positioning, the
object model or the page-by-page lane, Grok names it and the operator writes it here. Until then
this index stays at the size above rather than inventing a pack nobody asked for.
