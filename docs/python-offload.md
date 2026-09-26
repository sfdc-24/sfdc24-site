# Python offload map

Cheap scripts for repetitive deploy loops. **Models only for judgment.**

Visitor-facing copy (Method, History, chrome): **24 hour clock** and live **SFDC + time** — not “AI Fitness”, and do not repeat SFDC24. Internal script names (`sfdc24-site`, `www.sfdc24.com` in CLI defaults) are fine.

Mandate (Mr Salam): identify repeated activities per deployment → build them into Python → check for a few cycles that the script runs per the rules / guiding principles → measure. **Only then** stop spending model tokens on that loop.

## Cycle

**Detect → Script → Validate N cycles → Measure → Retire model path.**

| Step | Meaning | Done when |
|---|---|---|
| **Detect** | Same work shows up on more than one deploy (ETA log, git history dump, Pages curl, wait-for-200) | The loop can be named in one line |
| **Script** | A stdlib Python tool under `tools/` (this repo) or `scripts/` (Blackboard) | `python3 tools/… --help` runs; no model import |
| **Validate N cycles** | Run it for a few deploys against doctrine (honesty, no live-org theater, estimate-lessons schema) | N≥3 green runs, or `--validate` / unittest / smoke exit 0 |
| **Measure** | Record TTFB, wall-clock, or estimate vs actual (`data/speed-test-log.jsonl`, `data/estimate-lessons.jsonl`) | A number exists; not a vibe |
| **Retire model path** | Models stop performing the loop. They still judge: is the 200 honest, what is the next ETA, should we roll back | The next agent run *calls the script* instead of re-deriving |

Do not spend tokens re-deriving a JSONL line, re-listing git history, or curling Pages by hand. Run the script; read the exit code; then decide. If the script has not survived N cycles + a measurement, it is still a draft — keep the model in the loop.

## Site repo (`sfdc-24/sfdc24-site`)

| Repetitive task | Script | Still needs a model |
|---|---|---|
| Log ETA outcome (`beat` / `on_time` / `delayed` / `failed`) | `tools/log_eta_lesson.py` | Write `why` + reusable `course_correct`; cite it on the next ETA |
| Validate `data/estimate-lessons.jsonl` | `tools/log_eta_lesson.py --validate` | Nothing if it exits 0 |
| Rebuild `/history/` feed from git since 2026-09-04 | `tools/build_history_timeline.py` | Which commits to narrate / hide |
| Confirm homepage-scoped edit inventory | `tools/build_site_manifest.py` | Whether a new visitor-facing claim is allowed |
| Mechanical homepage edit (find/replace, CSS var, static section, triage *answer* copy) | `tools/site_edit_router.py` | Routing / CREW / DoL / new pages / first-person or ORG_NOUN claims — router prints a Claude hand-off |
| HTTP smoke www.sfdc24.com + `next-deploy.js` + `/history/` + `cabinet.js` + `/method/` | `tools/site_smoke.py` | Whether a 200 is *honest* (copy, live-org claims). `--require-markers` checks Method skate + honest-boundary |
| After merge: wait until a path/hash is 200 on Pages | `tools/pages_wait.py` | Whether to roll back |
| Staging tree (banner, noindex, URL rewrite) | `tools/prepare_staging_site.py` | What to promote |
| Prototype publish / removal | `tools/prototype_publisher.py` | Source review, honesty, go/no-go |
| Choice-design pilot (ask copy / palette / Release density) | `tools/choice_design.py`, `data/choice-design-pilot.json` — deterministic design; Method probe at `/method/#choice-design` is an on-page demo, not a fitted experiment. Catalog status stays `pilot-not-deployed` | Which attributes belong in a real visitor pilot and when evidence is sufficient |
| Ops engine snap for `/ops/` | `tools/board_ops_snap.py` writes `data/board-ops-snap.json`. The page polls that static file. The scheduled workflow commits to branch `board-ops-snap`, never `main`. No bus call. | Whether a baked failure is real, and when a sanitized export should replace the quiet roster |
| Palette inference (Cobalt / Google Blue / Trust Navy) | not yet — default Cobalt; no randomizer until a reviewed pilot and n≥20+CI | Which palette wins engagement |

Existing router + manifest are **already** the cheap path. This PR does not rewrite them. Escalate kinds stay in `tools/site_edit_router.py`.

## Overnight / CI

Unit tests run on every PR (`.github/workflows/python-offload.yml`, job `python-offload / test`). That job is **not** in ruleset 23679990.

Live `site-smoke` is **optional**. It is not a required check. Overnight (or after merge) call it yourself:

```bash
python3 tools/pages_wait.py --path /assets/next-deploy.js --timeout 180
python3 tools/site_smoke.py
python3 tools/log_eta_lesson.py --validate
python3 tools/build_history_timeline.py --check
```

To regenerate the History feed after merges:

```bash
python3 tools/build_history_timeline.py
# commit data/history-timeline.json if the event list changed
```

The workflow also has an optional `python-offload / site-smoke` job (`continue-on-error: true`) so a Pages blip does not block the PR.

## Blackboard counterparts (`sfdc-24/Blackboard`)

Those scripts stay in Blackboard. Do not copy them here. When the loop is board/bus/GAS/Zoom/WhatsApp, use the Blackboard file and only come back to this repo for the public site.

| Repetitive task | Blackboard script | Still needs a model |
|---|---|---|
| Append / read a board row | `scripts/append.py`, `scripts/show_row.py`, `scripts/tail_full.py` | What to write; whether a RESULT is honest |
| Board say / summary / wake | `scripts/board_say.py`, `scripts/board_summary.py`, `scripts/board_waker.py` | Tone, priority, who to ping |
| Bus client / health | `scripts/bus.py`, `scripts/bus.ps1`, `scripts/bus_health.sh` | How to recover a failed write |
| Env / baseline / identity | `scripts/env_check.py`, `scripts/baseline_verify.py`, `scripts/gas_build_identity.py` | Whether drift is a ship-stopper |
| GAS version / staging / canary | `scripts/gas_get_version.py`, `scripts/gas_version_assert.py`, `scripts/gas_staging_target.py`, `scripts/gas_tts_canary.py` | Promote vs roll back |
| Prompt / quote / inference receipts | `scripts/prompt_log.py`, `scripts/quote.py`, `scripts/inference_report.py` | Interpretation |
| Fleet watch | `scripts/fleet_watch.ps1`, `tools/gen_fleet_watch.py` | Who is stuck and what to cut |
| WhatsApp / Zoom helpers | `scripts/wa_*.ps1`, `scripts/wa_send.py`, `scripts/hear_in_zoom.ps1`, `scripts/say_in_zoom.ps1` | What to say on the call |
| X-Ray score | `scripts/xray_score.py` | Whether the score matches the claim |

## Rule of thumb

If the work is **append, poll, hash, curl, git-log, find-replace**, run Python. If the work is **should we, is this honest, what is the next ETA**, use a model — and then log the ETA with `log_eta_lesson.py`.
