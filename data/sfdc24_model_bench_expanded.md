# SFDC24 expanded model bench

- Generated: 2026-09-18 21:24:36 EDT
- Doctrine: every call expects first line `YES|<ETA_MINUTES>` or `NO|<why>`; ETAs recorded below.
- Models: Claude=`claude-haiku-4-5-20251001`; Gemini=`gemini-flash-lite-latest`; Copilot-lane=`gpt-4o-mini` (OpenAI proxy, NOT GitHub Copilot Chat)
- Env ANTHROPIC_MODEL was claude-opus-5; overnight preferred cheaper Haiku.
- max_tokens: ideate=350, run=400
- Live: live triage greeting="Hi. What can we help you with?" contains_SFDC24=NO
- Paths: `/tmp/sfdc24_model_bench_expanded.md` ; `/tmp/sfdc24_model_bench_expanded.csv` (Linux /tmp; Windows Temp not reachable from this runner)

## Metrics compliance (REQUIRED)

- **compliance_rate**: **0.9855** (68/69 exchanges incl. ideation)
- **estimate_accuracy**: **0.6** (15/25 YES rows with parseable ETA)
- Accuracy rule: ETA<=1 & actual<=1 min => accurate; else within 2x relative OR <=1 min abs error.
- Metrics JSONL: `/tmp/agent-reply-metrics.jsonl` + `sfdc24-site-repo/data/agent-reply-metrics.jsonl`

| Model | Avg TTFT_ms | Avg Total_ms | Pass | compliance_rate | estimate_accuracy |
| --- | ---: | ---: | ---: | ---: | ---: |
| Claude | 733.3 | 2528.7 | 19/22 | 0.9545 (21/22) | 1.0 (5/5) |
| Copilot-lane (OpenAI) | 522.0 | 1080.5 | 20/22 | 1.0 (22/22) | 0.2 (1/5) |
| Gemini | 912.9 | 1204.4 | 20/22 | 1.0 (22/22) | 0.6667 (8/12) |

## Phase 1 — Independent ideation (ETAs)

See full table in repo file. Union size after seed+ideate dedupe: **22** scenarios.

## Phase 3 — Live-page performance tunings (ranked by impact)

1. **Ask-bar local-first (HIGH):** Keep triage synchronous; expand local rules; local path <50ms.
2. **Cabinet / view preload (HIGH):** Prefetch cabinet chunks on idle.
3. **wakeFleet deferral (MED-HIGH):** Defer until after local triage miss.
4. **Mic button lazy (MED):** Construct SpeechRecognition on first tap only.
5. **Streaming TTFT UX (MED):** Gate timer + first-token skeleton.
6. **YES|NO gate in client (LOW-MED):** Client parser for YES|NO + ETA.

Full Phase 2 comparison table retained in this file on disk / PR.
