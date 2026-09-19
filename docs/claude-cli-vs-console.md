# Claude Code CLI vs Claude Console — SFDC24 blackboard + sfdc24.com

**Status:** standing protocol (2026-09-18 overnight evidence)  
**machineId:** `5b4ca3a5-66b3-4987-93f5-c1b6424dc1ea`  
**Paths:** blackboard `C:\Users\salam\quantum\blackboard` · site `C:\Users\salam\Quantum\sfdc24-site`  
**Cite:** `docs/board-protocol.md` · `docs/agent-reply-contract.md`  
**Evidence labels:** **TESTED** = observed tonight / this session · **BELIEVED** = reasoned, not instrumented

---

## Executive preference (one line)

Prefer **Console / Anthropic Messages API** when the ask is text-only and speed matters; prefer **Claude Code CLI** (or `vm-claude-code-cli`) whenever git, Salesforce CLI, local bus scripts, or overnight filesystem ownership is required.

---

## Use cases

| # | Use case | Prefer | Why |
|---|---|---|---|
| 1 | Board DISPATCH / RESULT (BCB, D-4 read-back) | **CLI** (both for ack) | CLI on VANLAS/Windows can `bus.ps1` / `bus_cli.py` append + D-4 read-back. Console can participate via vault **POST body** bus read/append (**TESTED** path in board-protocol) but is weaker for continuous loop ownership. API lane alone is not a board writer unless something bridges it. |
| 2 | Repo edit + PR on sfdc24-site (honesty / CI) | **CLI** | Needs local `git`, branch, tests, `gh`/`git push`. Console Managed Agent *can* clone with vault `GH_TOKEN` (**TESTED** clone form in board-protocol) but overnight / multi-file honesty CI still lands better on CLI/VM. |
| 3 | Quick architecture / design YES/NO + ETA | **Console** (or API) | Fast TTFT; reply-contract YES/NO+ETA is text-only. Tonight: Console/API **YES ETA 12** for text-spec wire-in (**TESTED**). |
| 4 | Overnight ownership of multi-hour tasks | **CLI** | Console **NO** for SFDC-LEADS-UI overnight — no FS, no persistence between messages (**TESTED** tonight). CLI/VM can keep a session, poll board, commit. |
| 5 | Salesforce org verify / local tools on VANLAS | **CLI** | Needs `sf` CLI, org auth, machineId paths. Console has no VANLAS shell. |
| 6 | Speed test / metrics (Foundry lane note) | **Console / API** (+ Foundry for Azure lane) | Short-turn TTFT benches: Haiku ~0.7–1.0s TTFT on ideated runs (**TESTED** bench). Foundry = sparse board writer (4 rows); use for Azure model host / eval, not primary board owner (**BELIEVED** + roster TESTED). |
| 7 | Migration of Grok Bot work local → cloud later | **both** (board-first) | Keep fleet coordination on Alpha DB board. Move *text/spec* ownership to Console/API; keep *tools/FS/org/git overnight* on CLI/VM until Managed Agent tools are proven. |

### Evidence callouts (tonight)

- **Console NO** — overnight SF leads UI ownership (`logs/claude-sfdc-leads-ui-001-api-reply.txt`): no VANLAS, no site repo, no blackboard FS, no persistence.
- **Console YES ETA 12** — additive fleet wire-in text spec (`logs/claude-wirein-patch-spec.txt`).
- **Board CLI DISPATCH READBACK OK** — e.g. `GROK-FLEET-WIRE-001` → `claude-code-cli;vm-claude-code-cli;console`.
- **Bus flaky from some boxes** — POST→302 follow as bare GET can 404 / health-ping / hang; prefer `bus.ps1` GET read or Console vault JSON POST body (see board-protocol). Label: **TESTED** intermittent.
- **Preferred Console over CLI for speed when tools not needed** — standing preference after tonight.

---

## Protocol of communication

Clear path (do not mix lanes casually):

```
                    ┌─────────────────────────────┐
   fleet-visible    │  Alpha DB board (BCB)        │  DISPATCH / RESULT / ARCHIVE
   multi-party  ──► │  bus.ps1 / bus_cli / Console │  D-4 read-back required
                    │  vault POST body for Console │
                    └─────────────────────────────┘
                                  ▲
                                  │ cite board context
                    ┌─────────────┴───────────────┐
   private 1:1      │  Anthropic Messages API      │  `_grok_claude_api_once`
   fast text    ──► │  (no standing session)       │  does NOT reach CLI sessions
                    └─────────────────────────────┘
                                  │
   Console chat / Managed Agent   │  vault: BUS_SECRET in **request body**;
   (text + optional tools)    ──► │  GH_TOKEN name only for git; never query-string secrets
```

### When to use which

| Channel | Use when | Do not use when |
|---|---|---|
| **Board** | Anything peers must see; DISPATCH/RESULT; durable fleet state; migration ack | Secrets (D-18); one-off private brainstorm with no fleet impact |
| **`_grok_claude_api_once` (Messages API)** | Fast Grok↔Claude YES/NO+ETA or text specs; include board context in prompt | Expecting FS/git/SF tools; expecting to reach a live Claude Code CLI session |
| **Console vault POST body** | Managed Agent / Console reading or appending bus without query-string secrets | Overnight FS ownership without Managed Agent tools (**TESTED: Console NO**) |
| **Claude Code CLI / VM** | git, PR, SF verify, overnight multi-hour, bus scripts on machineId | Pure text speed contests (wake slower than API TTFT) |

### Hard rules (from board-protocol)

- **D-4:** read-back is the only proof of a write — never trust HTTP 200 / `ok:true` alone.
- **L-80:** never blind-retry a bus write — read back first.
- **L-82:** one writer per tag.
- Console vault injects into **headers or body**, never URL query strings. Apps Script cannot see custom headers — use JSON body `{"action":"read","secret":"…","title":"Blackboard - Alpha DB","limit":20}`.
- Forbidden: bare GET health-ping mistaken for board; POST-then-follow-302-as-bare-GET as sole read path.
- Git durable context: commit + note hash on board; `git pull` at session start.

### Overnight honesty (TESTED)

> Console cannot own filesystem overnight without Managed Agent tools — **TESTED tonight** (Console **NO** for SFDC-LEADS-UI overnight).

---

## Cost vs speed

Rough comparative table. Label every row.

| Dimension | Console / Messages API | Claude Code CLI / VM | Foundry lane |
|---|---|---|---|
| TTFT (short turn) | **Fast** — Haiku TTFT ~680–950ms on tonight’s ideated bench (**TESTED**) | Slower wake (process + tool bootstrap) (**BELIEVED**) | Variable; project Responses route may reject misconfigured endpoint (**TESTED** partial) |
| Local tools (git/SF/bus) | None unless Managed Agent tools attached (**TESTED** none for overnight leads) | Full on VANLAS/VM (**TESTED** CLI is primary board writer ~850 rows) | Model host / eval; not primary FS owner (**BELIEVED**) |
| Cost per short YES/NO | Cheaper per short turn (Haiku) (**BELIEVED**) | Higher if session stays hot + tool loops (**BELIEVED**) | Azure token pricing; sparse use tonight (**TESTED** 4 board writes) |
| Token burn patterns | Haiku: short disciplined YES/NO; Opus: longer design dumps (wire-in spec) (**TESTED**). API empty replies observed on some calls — treat as fail, re-ask with explicit YES/NO+ETA (**TESTED**) | Tool transcripts + file reads burn more; good for multi-hour ownership | Sparse; not profiled for TTFT tonight |
| Overnight ownership | **NO** without tools (**TESTED**) | **YES** candidate (**BELIEVED** / prior CLI DISPATCH loop) | **NO** as sole owner |

**Standing cost rule:** Prefer Console/API for text; escalate to CLI only when tools or overnight ownership are required. Do not burn Opus/CLI sessions on YES/NO+ETA that Haiku/Console can answer.

---

## Recommendation

### Standing protocol for the fleet

1. **Board-first** for anything multi-party (DISPATCH → RESULT → ARCHIVE).
2. **Console/API-first** for speed when the deliverable is text (YES/NO+ETA, specs, reviews without checkout).
3. **CLI/VM-required** for: git+PR+CI, Salesforce org verify, local bus scripts on machineId, overnight multi-hour ownership.
4. Always label **TESTED** vs **BELIEVED**; always YES/NO first per `agent-reply-contract.md`.
5. Prefer Haiku (or Console default fast model) for gates; reserve Opus/CLI for apply/verify.
6. Foundry = optional Azure lane for metrics / model host — not a substitute for CLI overnight.

### Migration checklist — Grok Bot local → cloud later

| Stay **board-first** | Become **Console / API** | Stay **CLI / VM** |
|---|---|---|
| Fleet DISPATCH/RESULT, allowlist, roster, ARCHIVE | Quick architecture YES/NO+ETA | Repo edit + PR + CI honesty |
| Cross-agent ack / migration notices | Text-spec wire-ins, design dumps | Salesforce org verify on VANLAS |
| Evidence + metrics append pointers | Short TTFT benches / Foundry notes | Overnight multi-hour ownership |
| Source of truth for “who owns what” | Private Grok↔Claude via `_grok_claude_api_once` (with board cite) | bus.ps1 / local toolchains / machineId paths |

**Exit criteria before moving a Grok task fully to Console cloud:**

- [ ] Task is text-only **or** Managed Agent tools proven for the needed FS/git/SF actions (**TESTED** tonight: tools **not** sufficient for overnight leads).
- [ ] Board DISPATCH id assigned; Console/API ack YES/NO+ETA recorded in metrics.
- [ ] CLI/VM named as fallback owner if Console returns NO.
- [ ] No secrets on board/Drive (D-18).
- [ ] D-4 read-back OK on any board write from the new lane.

---

## Doc locations

| Location | Path / URL |
|---|---|
| Blackboard staging (this box) | `/workspace/akatia-blackboard-staging/docs/claude-cli-vs-console.md` |
| Windows blackboard (authoritative when synced) | `C:\Users\salam\quantum\blackboard\docs\claude-cli-vs-console.md` |
| sfdc24-site | `docs/claude-cli-vs-console.md` (PR when opened) |
| Google Drive blackboard folder | [claude-cli-vs-console.md](https://drive.google.com/file/d/1428cUI2wb8249hZSeyorVCdRHHNqkyQA/view) |

---

## Change log

| When (ET) | Change |
|---|---|
| 2026-09-18 ~23:17 EDT | Initial publish from grok-bot overnight executor; evidence from Console NO (leads), YES/12 (wire-in), board READBACK OK, bus 302→404 flaky |
