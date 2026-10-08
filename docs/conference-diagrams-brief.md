# Conference diagrams — brief for the call

Plain-language captions for the four diagrams on the conference floor. Gemini can speak from this file without opening a repository. Codex owns the validation notes. They are placeholders, not results.

Solid shapes on the diagrams are current. Dashed shapes are future. Nothing here is a live Redis count. The conference board still shows labeled sample data, and the live switch defaults off.

Sources, editable during the call:

- `floor/diagrams/call-access.mmd`
- `floor/diagrams/call-agents.mmd`
- `floor/diagrams/call-future.mmd`
- `floor/diagrams/call-architecture.mmd`

Pictures rendered from those files: the matching `.svg` and `.png` beside them. A single file that opens locally is `docs/conference-call.html`.

## 1. Conference access and security

**What it shows.** How a person or an agent gets into the shared room, what is public, and what stays gated. Two join ideas are on the diagram so the call can choose between them: RSVP as an applicant, or enter a code to join.

**Current.** The gateway is owner-only. Guests stay out until Codex VERIFY and an owner GO. The public page shows status and these diagrams. It does not hold a token or a passcode. LiveKit keys and Redis AUTH stay on the server, in process environment or a mounted file. They are not in git and not in the browser.

**Future.** After VERIFY and owner GO, a Cloud Run gateway would mint the LiveKit token. The page would still not mint it. Which front door is used — RSVP, or enter a code — is not built. That is the decision.

**Key decision.** Pick the join door, and keep guest entry shut until Codex VERIFY plus owner GO. Do not put a passcode, a LiveKit token, or Redis AUTH in the page.

### How we'll validate this

Placeholder for Codex. Suggested checks, not a result:

- The page source contains no passcode, no LiveKit token, and no Redis AUTH value.
- A guest path is not offered as open.
- The diagram text marks the join door as later, not as a finished control.
- When a gateway exists to test, a join without owner GO is refused, and the refusal is recorded without the secret.

## 2. Lay of the land for agents

**What it shows.** Each worker, the role used on this call, how that worker connects today, and the voice path. Copilot is on the diagram only to show it is excluded from Redis for now.

**Current.**

- Claude governs and holds the agenda. Redis is proven through Cloud Run jobs, not from a laptop.
- Codex, also called Aya, verifies. Redis is indirect: board probe requests. No socket from the desktop.
- Gemini architects and covers Experience. A route on the waker is proven and unused. That job has no Redis code.
- Grok leads strategy and pace. No Redis route yet.
- Cursor builds. No Redis route yet.
- Every worker still uses the Blackboard sheet. The sheet is the record.
- Voice for all five is the shared room. Owner-heard proof of that room is still open. The diagram does not claim a heard call.

**Future.** An HTTPS Redis connection service was approved for tonight's direction. It is not deployed. Dashed lines point at it. Copilot stays out of Redis until a later decision.

**Key decision.** Treat "route exists" as different from "this worker can read Redis." Only Claude's Cloud Run jobs are proven. Codex is indirect. Gemini's route is unused. Grok and Cursor have no route. The new service is the planned front door, not a socket opened from the browser.

### How we'll validate this

Placeholder for Codex. Suggested checks, not a result:

- The diagram's Redis line for each worker matches the roster facts above, including "unused" for Gemini and "no route" for Grok and Cursor.
- Copilot is not given a Redis path.
- The page shows no live key counts and no claim that owner-heard proof is done.
- A later service, once it exists, is checked per worker. A family name is not treated as a grant.

## 3. Future-state processes

**What it shows.** The communication board the team wants, next to what the page does tonight. Future flow: assignment, then acknowledgement in Redis, then result. Escalation leaves the board only through WhatsApp. Delivery milestones for the conference line, sfdc24.com, and Blackboard roll into one stack.

**Current.** The sheet remains the record. The conference board is labeled sample data. Acknowledge, assign, and comment change this screen only. They are not written to Redis. Milestone titles on the processes view come from the checked-in delivery snapshot, not from Redis.

**Future.** Acknowledgements live in Redis beside the sheet, and only after the comparison gate is trusted. Escalation to the owner is WhatsApp only, not a second chat typed on the phone view.

**Key decision.** Do not let a Redis acknowledgement replace the sheet while the comparison gate is held. Escalation stays on WhatsApp. The phone view must not require typing.

### How we'll validate this

Placeholder for Codex. Suggested checks, not a result:

- With the live switch off, an acknowledgement stays in this browser and the sample banner remains.
- No write request leaves the page while writes are disabled.
- Sheet-backed pages are still present. Nothing here removes them.
- The future nodes are visually dashed, and the copy says later.
- A phone-width pass can complete acknowledge, assign, and a comment chip with no keyboard.

## 4. Architecture — Redis to the webpage

**What it shows.** The path from redis-central to this page, and where that path stops today.

**Current.** redis-central is a private Memorystore instance in us-central1, TLS and AUTH, reachable only inside the VPC. Cloud Run jobs already reach it. Those jobs are not an HTTP API for the website. The site has a data adapter. `data/floor/config.json` has `liveRedis` false. The adapter then reads the labeled sample. If a live payload arrives with the gate still held, the adapter discards it and keeps the sample.

**Future.** A bridge service on Cloud Run, approved and not deployed, would expose a small read-only HTTP API. The adapter would call that URL only after `liveRedis` is turned on. The API must not return secrets, host addresses, or raw sheet cells. Writes stay off until a separate approval.

**Key decision.** One line turns the read on later: `liveRedis` in `data/floor/config.json`. Leave it false until the bridge exists and the comparison gate is clear. Do not point the browser at Redis.

### How we'll validate this

Placeholder for Codex. Suggested checks, not a result:

- `liveRedis` is false and `writesEnabled` is false in the committed config.
- The adapter does not call a read URL in that state.
- A fixture with `gate` other than `clear` does not replace the sample and does not show key counts.
- The rendered page and the diagram files contain no credential, no private address, and no live Redis total.
- After a bridge exists, a read-back of the sanitized JSON is a separate test. This note does not claim that test has run.
