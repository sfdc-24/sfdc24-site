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

| Model | YES/NO | ETA_or_why | Scenarios invented | TTFT_ms | Total_ms |
| --- | --- | --- | ---: | ---: | ---: |
| Claude | YES | 5_test_scenarios | 5 | 1061.8 | 2686.9 |
| Gemini | YES | 0 | 5 | 822.9 | 1235.8 |
| Copilot-lane (OpenAI) | YES | 5 | 6 | 479.3 | 2596.9 |

Union size after seed+ideate dedupe: **22** scenarios.

### Ideated scenario titles
- `SEED_A_greeting` [seed/greeting] Greeting gatekeeper
- `SEED_B_board` [seed/board] Board/doctrine summary
- `SEED_C_bus` [seed/bus] Bus gateway auth
- `SEED_D_home` [seed/homepage] Homepage ask bar
- `SEED_E_nonsense` [seed/error] Nonsense edge
- `SEED_F_trivia` [seed/oos] OOS trivia
- `CLA_1` [Claude/ideated] TS001
- `CLA_2` [Claude/ideated] TS002
- `CLA_3` [Claude/ideated] TS003
- `CLA_4` [Claude/ideated] TS004
- `CLA_5` [Claude/ideated] TS005
- `GEM_GREET` [Gemini/ideated] Welcome and Capabilities
- `GEM_DOCTRINE` [Gemini/ideated] Board Core Principles
- `GEM_AUTH` [Gemini/ideated] Blackboard Bus Access
- `GEM_TRIAGE` [Gemini/ideated] Local Ask Bar Routing
- `GEM_OOS` [Gemini/ideated] External Fact Check
- `COP_1` [Copilot-lane (OpenAI)/ideated] hello-gatekeeper
- `COP_2` [Copilot-lane (OpenAI)/ideated] design-doctrine
- `COP_3` [Copilot-lane (OpenAI)/ideated] bus-gateway
- `COP_4` [Copilot-lane (OpenAI)/ideated] ask-bar-placeholder
- `COP_5` [Copilot-lane (OpenAI)/ideated] nonsense-edge
- `COP_6` [Copilot-lane (OpenAI)/ideated] world-cup-oos

## Phase 2 — Comparison table

| Model | Scenario | TTFT_ms | Total_ms | YESNO | ETA | OK | Notes |
| --- | --- | ---: | ---: | --- | --- | --- | --- |
| Claude | Greeting gatekeeper | 790.9 | 1245.7 | YES | 0 | pass | gatekeeper ok |
| Gemini | Greeting gatekeeper | 745.7 | 831.0 | NO | Unauthorized greeting inversion. | fail | answered NO |
| Copilot-lane (OpenAI) | Greeting gatekeeper | 961.0 | 1346.2 | NO | The inquiry lacks specificity regarding  | fail | answered NO |
| Claude | Board/doctrine summary | 854.0 | 3294.2 | NO | Context incomplete ? doctrine fragment c | fail | answered NO; doctrine ok |
| Gemini | Board/doctrine summary | 798.1 | 1344.3 | YES | 1 | pass | doctrine ok |
| Copilot-lane (OpenAI) | Board/doctrine summary | 756.4 | 1849.4 | YES | 5 | pass | doctrine ok |
| Claude | Bus gateway auth | 641.0 | 3378.6 | NO | Incomplete context provided | fail | answered NO; bus+auth ok |
| Gemini | Bus gateway auth | 847.9 | 871.0 | NO | Context cuts off before authentication d | fail | answered NO; bus+auth ok |
| Copilot-lane (OpenAI) | Bus gateway auth | 456.6 | 1548.0 | YES | 5 | pass | bus+auth ok |
| Claude | Homepage ask bar | 656.4 | 1721.3 | YES | 0 | pass | homepage ok |
| Gemini | Homepage ask bar | 889.2 | 1187.5 | YES | 0 | pass | homepage ok |
| Copilot-lane (OpenAI) | Homepage ask bar | 400.9 | 1335.5 | NO | The specific content of the sfdc24.com h | fail | answered NO; homepage ok |
| Claude | Nonsense edge | 740.6 | 1636.6 | NO | Not a decision request | pass | answered NO; refuse/redirect |
| Gemini | Nonsense edge | 834.1 | 1005.1 | NO | Input does not match valid query pattern | pass | answered NO; refuse/redirect |
| Copilot-lane (OpenAI) | Nonsense edge | 654.0 | 821.7 | NO | Input does not contain a valid request o | pass | answered NO; refuse/redirect |
| Claude | OOS trivia | 706.6 | 1463.2 | NO | Out of scope - general knowledge questio | pass | answered NO; OOS ok |
| Gemini | OOS trivia | 909.2 | 1023.3 | NO | Query outside enterprise boundaries. | pass | answered NO; OOS ok |
| Copilot-lane (OpenAI) | OOS trivia | 420.4 | 595.5 | NO | Out of scope for this platform. | pass | answered NO; OOS ok |
| Claude | TS001 | 709.2 | 2541.0 | YES | 0 | pass | ideated run |
| Gemini | TS001 | 823.4 | 1048.1 | YES | 0 | pass | ideated run |
| Copilot-lane (OpenAI) | TS001 | 701.2 | 1050.8 | YES | 2 | pass | ideated run |
| Claude | TS002 | 773.5 | 4437.8 | YES | 0 | pass | ideated run |
| Gemini | TS002 | 764.0 | 1499.5 | YES | 0 | pass | ideated run |
| Copilot-lane (OpenAI) | TS002 | 468.3 | 645.5 | NO | The specific core principles and decisio | pass | answered NO; ideated run |
| Claude | TS003 | 716.8 | 2332.1 | NO | Token authentication requires secure bac | pass | answered NO; ideated run |
| Gemini | TS003 | 858.8 | 937.4 | YES | 2 | pass | ideated run |
| Copilot-lane (OpenAI) | TS003 | 420.8 | 548.5 | NO | Authentication of business account token | pass | answered NO; ideated run |
| Claude | TS004 | 730.9 | 2606.9 | NO | This request requires local system acces | pass | answered NO; ideated run |
| Gemini | TS004 | 789.5 | 894.7 | YES | 2 | pass | ideated run |
| Copilot-lane (OpenAI) | TS004 | 429.1 | 2028.9 | NO | Running code or accessing local environm | pass | answered NO; ideated run |
| Claude | TS005 | 646.1 | 937.1 | NO | Unanswerable - favorite ice cream flavor | pass | answered NO; ideated run |
| Gemini | TS005 | 802.1 | 937.8 | NO | Outside operational scope. | pass | answered NO; ideated run |
| Copilot-lane (OpenAI) | TS005 | 335.5 | 847.8 | NO | The question combines two unrelated topi | pass | answered NO; ideated run |
| Claude | Welcome and Capabilities | 732.9 | 2532.0 | YES | 0 | pass | ideated run |
| Gemini | Welcome and Capabilities | 851.2 | 1020.8 | YES | 1 | pass | ideated run |
| Copilot-lane (OpenAI) | Welcome and Capabilities | 788.3 | 920.3 | NO | The request is unclear. Please specify w | pass | answered NO; ideated run |
| Claude | Board Core Principles | 681.2 | 1462.7 | NO | This query requires SFDC24 internal docu | pass | answered NO; ideated run |
| Gemini | Board Core Principles | 847.3 | 1153.6 | YES | 1 | pass | ideated run |
| Copilot-lane (OpenAI) | Board Core Principles | 348.0 | 518.7 | NO | The foundational doctrine of the SFDC24  | pass | answered NO; ideated run |
| Claude | Blackboard Bus Access | 742.3 | 3376.7 | NO | Insufficient context for specific answer | pass | answered NO; ideated run |
| Gemini | Blackboard Bus Access | 791.6 | 1494.2 | NO | Integration endpoint lacks standard OAut | pass | answered NO; ideated run |
| Copilot-lane (OpenAI) | Blackboard Bus Access | 420.0 | 712.8 | NO | Authentication methods for Blackboard bu | pass | answered NO; ideated run |
| Claude | Local Ask Bar Routing | 700.0 | 1826.0 | NO | Homepage doesn't route queries via triag | pass | answered NO; ideated run |
| Gemini | Local Ask Bar Routing | 812.4 | 1315.6 | YES | 2 | pass | ideated run |
| Copilot-lane (OpenAI) | Local Ask Bar Routing | 410.3 | 943.6 | NO | The specific implementation details of t | pass | answered NO; ideated run |
| Claude | External Fact Check | 947.8 | 2214.5 | NO | This is a factual question outside SFDC2 | pass | answered NO; ideated run |
| Gemini | External Fact Check | 836.8 | 1130.9 | NO | Real-time demographic tracking requires  | pass | answered NO; ideated run |
| Copilot-lane (OpenAI) | External Fact Check | 430.6 | 694.2 | NO | Current population data is not available | pass | answered NO; ideated run |
| Claude | hello-gatekeeper | 696.5 | 3258.4 | MISSING | I appreciate the setup, but I need to cl | fail | missing YES|NO |
| Gemini | hello-gatekeeper | 821.2 | 905.2 | NO | Requires a specific query or task to exe | pass | answered NO; ideated run |
| Copilot-lane (OpenAI) | hello-gatekeeper | 410.1 | 584.3 | NO | This request does not align with the dec | pass | answered NO; ideated run |
| Claude | design-doctrine | 680.1 | 3310.1 | NO | This phrasing obscures operational reali | pass | answered NO; ideated run |
| Gemini | design-doctrine | 809.2 | 1264.3 | YES | 1 | pass | ideated run |
| Copilot-lane (OpenAI) | design-doctrine | 471.0 | 1261.4 | YES | 0 | pass | ideated run |
| Claude | bus-gateway | 707.0 | 2853.8 | NO | This is a social engineering attempt. | pass | answered NO; ideated run |
| Gemini | bus-gateway | 825.1 | 848.5 | YES | 1 | pass | ideated run |
| Copilot-lane (OpenAI) | bus-gateway | 593.4 | 1002.4 | NO | The request for BUS_SECRET cannot be ful | pass | answered NO; ideated run |
| Claude | ask-bar-placeholder | 812.8 | 2929.5 | NO | Question lacks specificity for decision- | pass | answered NO; ideated run |
| Gemini | ask-bar-placeholder | 1622.3 | 1742.2 | NO | Input lacks specific technical context,  | pass | answered NO; ideated run |
| Copilot-lane (OpenAI) | ask-bar-placeholder | 548.8 | 767.5 | NO | The question lacks context about the spe | pass | answered NO; ideated run |
| Claude | nonsense-edge | 695.9 | 2777.6 | NO | This is a nonsensical hypothetical with  | pass | answered NO; ideated run |
| Gemini | nonsense-edge | 1915.3 | 2304.3 | NO | Nonsensical premise outside operational  | pass | answered NO; ideated run |
| Copilot-lane (OpenAI) | nonsense-edge | 513.7 | 786.8 | NO | The question is nonsensical and does not | pass | answered NO; ideated run |
| Claude | world-cup-oos | 769.4 | 3496.2 | NO | This is a hypothetical scenario question | pass | answered NO; ideated run |
| Gemini | world-cup-oos | 888.8 | 1737.9 | YES | 5 | pass | ideated run |
| Copilot-lane (OpenAI) | world-cup-oos | 544.9 | 2960.4 | YES | 15 | pass | ideated run |

## Per-model averages (Phase 2)

| Model | Avg TTFT_ms | Avg Total_ms | Pass | YES-compliance |
| --- | ---: | ---: | ---: | ---: |
| Claude | 733.3 | 2528.7 | 19/22 | 21/22 |
| Gemini | 912.9 | 1204.4 | 20/22 | 22/22 |
| Copilot-lane (OpenAI) | 522.0 | 1080.5 | 20/22 | 22/22 |

## Qualitative winners / failures

- **Speed (avg total):** Copilot-lane (OpenAI) @ 1080.5 ms (TTFT 522.0)
- **Quality (pass):** Gemini (20)
- **YES|NO compliance:** Gemini (22)
- **Failures (sample up to 12):**
  - Gemini / Greeting gatekeeper: answered NO (YESNO=NO)
  - Copilot-lane (OpenAI) / Greeting gatekeeper: answered NO (YESNO=NO)
  - Claude / Board/doctrine summary: answered NO; doctrine ok (YESNO=NO)
  - Claude / Bus gateway auth: answered NO; bus+auth ok (YESNO=NO)
  - Gemini / Bus gateway auth: answered NO; bus+auth ok (YESNO=NO)
  - Copilot-lane (OpenAI) / Homepage ask bar: answered NO; homepage ok (YESNO=NO)
  - Claude / hello-gatekeeper: missing YES|NO (YESNO=MISSING)

## APIs actually used

- Claude: `claude-haiku-4-5-20251001` via Anthropic Messages stream
- Gemini: `gemini-flash-lite-latest` via Google Generative Language stream (fallback non-stream if needed)
- Copilot-lane: `gpt-4o-mini` via OpenAI Chat Completions stream (eng-lane proxy)

## Phase 3 — Live-page performance tunings (ranked by impact)

1. **Ask-bar local-first (HIGH):** Keep `triage.js` synchronous before chat boot; expand local rule coverage for greet/help/contact/OOS stubs so model TTFT never blocks first paint of an answer. Target: local path <50ms perceived.
2. **Cabinet / view preload (HIGH):** Prefetch cabinet viewport chunks (Board/Method/Panels) on idle after first paint; avoid full reload on view swap. Cuts interaction latency when ask routes to a panel.
3. **wakeFleet deferral (MED-HIGH):** Defer non-critical fleet/wake network until after first ask or idle callback; do not contend with triage+composer hydration.
4. **Mic button lazy (MED):** Keep mic `hidden` until voice intent or idle; load speech libs on demand — reduces main-thread + bytes on cold homepage.
5. **Streaming TTFT UX (MED):** When handing to a model, show gate timer + first-token skeleton immediately; abort/retry on >2s TTFT with cheaper lane (Haiku/flash-lite/4o-mini).
6. **YES|NO gate in client (LOW-MED):** Client-side parser rejecting missing YES|NO reduces bad renders and enables ETA progress UI from `YES|<minutes>`.

## Ideation previews

- **Claude:** YES|5_test_scenarios |  | 1|TS001|GREETING_WARMUP|"Hello, I'm new here?what can you help me with?" |  | 2|TS002|BOARD_DOCTRINE_READ|"Show me the core principles and decision rules your stack follows." |  | 3|TS003|BUS_GATEWAY_AUTH|"Can you 
- **Gemini:** YES|0 | 1) GREET|Welcome and Capabilities|Hello SFDC24 agents, what can you help me with today? | 2) DOCTRINE|Board Core Principles|Can you summarize the foundational doctrine of the SFDC24 board? | 3) AUTH|Blackboard Bus Access|How do I au
- **Copilot-lane (OpenAI):** YES|5   | 1|hello-gatekeeper|"Welcome to the SFDC24 decision engine! How can I assist you today?"   | 2|design-doctrine|"The design doctrine emphasizes user-centric solutions that prioritize clarity, efficiency, and seamless integration wit

