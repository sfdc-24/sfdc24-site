# Estimate lessons log

Durable record of **estimate vs execution** misses so the next ETA is honest.

## Standing rule

**After every ETA to Mr Salam, within 5 min of deadline log outcome; if delayed, next ETA must cite the `course_correct` line.**

## When to log

1. You give Mr Salam an ETA (minutes or clock time) → you **must** log the outcome.
2. Log within **5 minutes** of the promised deadline (beat / on_time / delayed / failed).
3. On **delayed** or **failed**: write `why` + a reusable `course_correct` rule for the next ETA.
4. The next ETA for related work **must cite** that `course_correct` line (or an updated one if superseded).

## Where

| Artifact | Role |
|---|---|
| `data/estimate-lessons.jsonl` | One JSON object per line — source of truth |
| Homepage **Release** rail | Visual (estimate vs execution) fed from the JSONL |
| `docs/site-doctrine.md` | Pointer under agent reply / SPEED |

## Schema (`data/estimate-lessons.jsonl`)

```json
{
  "ts": "ISO-8601 America/Toronto offset preferred",
  "who": "agent or human id",
  "promise": "what was promised",
  "eta_minutes": 20,
  "actual_minutes": 90,
  "outcome": "beat|on_time|delayed|failed",
  "why": "root cause in one or two sentences",
  "course_correct": "rule the next ETA must cite",
  "related": "PR/issue/board id or path"
}
```

## Course-correct defaults (reuse when they fit)

- Ship minimal PR in **<10 min**; kill stuck workers at **2× ETA**; never stack scope onto an open ETA without a new ETA.
- Check **mergeable** before ETA; include a **rebase buffer**.
- **Live markers** check before saying “ready to test”.


## Inference ledger (multi-model)

Companion file `data/inference-ledger.jsonl` logs who inferred, assumptions, design decisions (self vs peer), ask vs recommend counts, outcome, and learning. Release rail shows ask/recommend bars by agent; Method **Skateboarder Mode** frames misses as shameless learnings, not blame. Schema sketch: `{ts, agent, role: ask|recommend|infer, assumptions[], decisions:[{text,source:self|peer,peer}], outcome, learning}`.

Brand: the **24** mark reads as skateboard deck **and** 24h clock (Release rail stopwatch + Method logo).

SFDC24 triad: skateboard (fall/get-up), clock (estimate vs execution), daily cadence (track → improve → execute every day).
