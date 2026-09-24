# Studio contract: one conversation, one evolving prototype

The shared contract for item 6 (live prototyping on sfdc24.com). The page
(`/studio/`), the cloud controller and every worker build against THIS, so the
three can be built by different agents at the same time and still meet.

Source of the design: Codex's review
(`CODEX-SITE-ITEM6-ARCH-REVIEW-20260924T0212Z`, detail in Blackboard
`.codex/item6-architecture-review-20260924T0210Z.md`), Gemini's component
review (`GEMINI-WAKE-CCC-GEMINI-ARCH-COMPONENTS-20260924T0225`), and Mr Salam's
rule: conversation and construction are ONE loop - Ask, Point, Change, Confirm.

## Stage A only

This contract covers stage A of that review: controller, event schema,
renderer and lifecycle, driven by a **scripted synthetic session**. No
microphone, no voice provider, no model call. Real voice is stage B and waits
on Mr Salam's explicit approval of the voice provider and its data and spend
envelope. Nothing here may call a provider.

## The pieces

| file | what it is |
|---|---|
| `events.schema.json` | every event the controller may send the page, and every command the page may send back |
| `fixtures/scripted-session.json` | one complete synthetic session: a homepage wireframe, one question asked and answered, a change, a confirmation, a correction that supersedes it, and one stale event that must be ignored |
| `../../tests/studio.spec.cjs` | the acceptance test. `/studio/?script=fixture` must pass it with no network |

## How the page accepts events

Added after Codex's review of the first page (PR 139, REQUEST_CHANGES at
`2950d7d`): four ways a stream could corrupt the prototype. Every rule below is
checked BEFORE the event touches any state - the sequence cursor and the op_id
dedupe included - so a refused event never consumes anything.

1. **Shape.** The envelope matches `$defs.envelope` and the payload matches its
   type's schema in `$defs.payloads`. Otherwise refuse.
2. **Session.** `session_id` must be this page's session. A foreign session's
   event is refused whatever its seq; commands keep going to this session.
3. **Generation.** Lower than current: refuse. Higher: a new generation starts
   (the controller restarted or the stream reconnected). Its first event must be
   an `artifact.snapshot` at seq 1; the page adopts the snapshot, the new
   generation and seq, and drops anything queued from the old generation.
4. **Order.** Within a generation, events apply in seq order. A gap is held for
   at most 2 seconds; an `artifact.snapshot` whose version is newer than the
   current one REPAIRS a gap - it applies immediately, the cursor jumps to its
   seq, and queued events at or below its version are dropped.
5. **Revision.** `task_revision` below the current revision: refuse.
6. **Patch base.** An `artifact.patch` applies only to `artifact_version - 1`.
   A patch whose version is not newer is refused; one that skips ahead is held
   (and repaired by a snapshot, rule 4).
7. **Fencing.** `confirm`, `progress`, `focus.set` and the highlights they drive
   apply only when their `artifact_version` equals the current version.

The fixture transport stamps seq and versions in delivery order (see the
fixture's `about`), which is how the order a visitor chooses - for example,
changing a decision before submitting a decision form - cannot stall the page.

Test hooks, fixture mode only: `window.__studio.sent` (every command the page
has sent, in order) and `window.__studio.inject(event)` (deliver one raw event
straight to the reducer, no stamping) - so the spec can play hostile streams.

## Controller HTTP API

The page and the controller (Blackboard `cloud/studio-controller`, Codex) meet
here. **This table is the merged controller (Blackboard #204, #206, #210 - main at
e2a9421), read from its source on 2026-09-24** - where an earlier draft of this section
differed, the controller won. The page reads the base URL from
`data-controller-url` on `#studio-app`, and from nowhere else: no query-string
override, so a link cannot point a visitor at someone else's controller. CORS
allows only the listed origins (`https://www.sfdc24.com`) and the headers
`Authorization`, `Content-Type`, `Last-Event-ID`; Origin is policy, not
authentication - the bearer token is. Routes are exact and slashless: a
trailing slash is a `404`, never a redirect (a redirect could carry a bearer to
an `http` URL). Every refusal body is FastAPI's
`{"detail": "<plain text>"}`: branch on the **status code**, never on the text.

A live studio session has two tokens. The **operator token** says who you are
(email code, 8 hours). The **session token** opens one studio session (at most
10 minutes). Both are bearer tokens, held in memory and never put in a URL.

| call | request | success | refusals |
|---|---|---|---|
| sign in: send code | `POST /v1/auth/start` `{email, client_key}` | `200 {challenge_id, expires_in}` - the **same shape whether or not a code was sent**, so the page can never tell who is allowed; always say "If that address is allowed, a code is on its way." | `400` body wrong, `403` origin |
| sign in: check code | `POST /v1/auth/verify` `{challenge_id, email, code, client_key}` | `200 {token, expires_at, scope: "operator"}` | `401` code not accepted (wrong, expired, used, or another browser), `400` |
| start | `POST /v1/session`, `Authorization: Bearer <operator token>`, `{creation_id, title?}` | `200 {session_id, generation, artifact_version, expires_at, max_session_seconds, daily_admission_number, token, events_url}`; the same `creation_id` returns the same session, so a retried start never costs a second admission | `401` operator token missing or expired (sign in again), `429` daily capacity, `503` busy (retry) |
| events | `GET /v1/session/{id}/events`, `Authorization: Bearer <session token>`, optional `Last-Event-ID: <seq>` - **an integer** | `200 text/event-stream`: `id: <seq>`, `event: <type>`, `data: <one event, JSON>`, and `: keep-alive` comments; header `X-Studio-Generation`. **The stream closes by design about every 25 s**: that is not an error - reconnect at once with `Last-Event-ID`, no backoff. A stream that closes with no frame at all is treated as a failure (back off) | refused **before** the stream starts, as JSON: `400` Last-Event-ID not an integer, `401`, `403` token for another session, `404` session gone (end the session), `409` repair busy (retry with backoff) |
| command | `POST /v1/session/{id}/commands`, `Authorization: Bearer <session token>`, body = one command | `200 {command_id, session_id, artifact_version, events, problems}` - the same receipt for a repeated `command_id` | `409` stale `expected_version` or a reused `command_id` with a different body - show "Catching up" and let the stream deliver the truth; `400`/`404` command refused; `401` |
| voice | `POST /v1/session/{id}/voice`, session bearer, `{sdp}` | `200 {sdp, voice_id, ends_at}` (Phase 3, see below) | `503` voice is off in this release (`STUDIO_ENABLE_VOICE=false`), `409` a call already exists for this session, `410` session over, `502` provider refused, `400`/`413` bad SDP, `401` |
| health | `GET /health`, no auth | `200 {ok, worker, state_backend, features: {voice}}` - the page shows Talk only when `features.voice` is true | anything else: hide Talk. **Not `/healthz`**: Cloud Run reserves some paths ending in `z` and answers them itself with a 404 |

`client_key` is a random value the page makes once per sign-in (at least 128
bits from `crypto.getRandomValues`) and keeps in memory with the challenge: a
code only verifies from the browser that asked for it. The operator token may
be kept in `sessionStorage` so a reload does not cost another code; it is
cleared on any `401`.

**Events are read with `fetch()` streaming, not `EventSource`**, because
`EventSource` cannot send an `Authorization` header and a token in a URL ends up
in logs. The page parses the `text/event-stream` framing itself. A clean end of
a `200` stream is the normal 25-second turn: reconnect immediately. A network
error or `5xx` backs off 1 s doubling to 15 s. On reconnect the controller
resumes after `Last-Event-ID`, or - when it cannot - starts a new generation
with an `artifact.snapshot` at seq 1 and re-asks every open question (rule 3
above). A `401` or `404` ends the session with a plain message and never loops.

**Operator.** Superseded: the controller recognises the operator by the email
code above, not by a Google ID token. Operator-only features (live org facts,
later metadata plans) are checked server-side against the operator token.

## Voice (stage B)

Mr Salam decided the voice on 2026-09-24: OpenAI Realtime over WebRTC, 10
minutes a session, 20 sessions a day site-wide, transcript kept, audio never
stored. The key has no GPT-Live model; the model is `gpt-realtime-2.1`
(`gpt-realtime-2.1-mini` as the cheaper fallback). Shapes below are from
OpenAI's docs, read 2026-09-24 (realtime-webrtc, realtime-server-controls,
realtime-transcription, calls/hangup, client_secrets).

**Connection: the controller relays the offer, never a key.** OpenAI's
"unified interface" lets the server post the browser's SDP offer:

1. The visitor taps Talk (explicit microphone intent - nothing listens before
   that). The page gets the microphone, builds an `RTCPeerConnection`, adds the
   audio track, opens a data channel named `oai-events`, and POSTs its SDP
   offer to the controller: `POST /v1/session/{id}/voice` with
   `{"sdp": "<offer>"}`.
2. The controller enforces admission first (20 a day, one voice call per
   studio session, the session's remaining minutes), then POSTs the offer to
   `https://api.openai.com/v1/realtime/calls` as multipart (SDP + session JSON)
   with the server's key. It reads the call id from the response's `Location`
   header (`/v1/realtime/calls/rtc_...`) and returns
   `{"sdp": "<answer>", "voice_id", "ends_at"}`.
3. Audio flows browser <-> OpenAI directly. It never passes through our
   servers, so it cannot be stored by them.

**Ending it, server-side.** A call does not end when a client secret expires,
so the page's own 10-minute timer is not enough on its own. The controller
records `call_id` with `ends_at` and calls
`POST /v1/realtime/calls/{call_id}/hangup` when the time is up (checked on every
request it serves, and by a sweep), and on the `stop` command. The page also
closes its peer connection at `ends_at`.

**Session config the controller sets:** `type: "realtime"`,
`model: "gpt-realtime-2.1"`, `audio.input.transcription.model: "gpt-transcribe"`,
turn detection `semantic_vad` with `create_response: false` - the voice never
answers on its own. Instructions: speak only the text you are given, briefly
and warmly; never state facts about Salesforce or the visitor's business; one
question at a time.

**Who says what.** The voice speaks only controller events, so every spoken
word traces to a validated event. On `question.asked`, `progress` and `confirm`
the page sends, on `oai-events`, a `conversation.item.create` (a user message
with `input_text`: "Say this to the visitor, naturally: ...") followed by
`response.create` with `output_modalities: ["audio"]`. A spoken decision form
reads its title and says the options are on screen.

**What the visitor says.** On `conversation.item.input_audio_transcription.completed`
(`item_id`, `transcript`) the page sends the controller an `utterance` command
with the transcript. The Claude worker reads it as an answer to the open
question when it is one (the same `question.answered` a tap produces - rule 6
below) or as new direction otherwise. Deltas may be shown as live captions;
only completed transcripts are sent.

## Rules the renderer must keep (each one is tested)

1. **Typed data only.** The page renders artifacts from typed nodes into DOM
   and SVG. It never inserts model- or controller-supplied HTML, and never runs
   supplied code. Text is text: a label of `<img onerror=...>` renders as those
   characters.
2. **One shared focus.** At any moment: one active question card, one
   highlighted scope in the prototype. Other cards wait in a small queue.
3. **Ask, Point, Change, Confirm.** A `question.asked` makes its card active
   AND highlights its `affected_artifact_ids` in the prototype. An answer
   produces a new `artifact_version`; only the affected nodes change. The
   confirmation names what changed, specifically.
4. **Versions only move forward.** An event whose `task_revision` is older than
   the current one, or whose `artifact_version` is not newer, is ignored - it
   may not render, and may not be announced.
5. **Corrections keep history.** Changing a decision supersedes the old answer
   (status `superseded`) and creates a new revision. Nothing is erased.
6. **Voice and tap are the same answer.** A tapped option and a spoken answer
   both resolve the same `question_id` through the same `answer` command.
7. **Never steal focus.** Updates are announced through one `aria-live="polite"`
   region. The page never moves keyboard focus on its own.
8. **Phone.** At 390 px wide the active card is a bottom sheet that covers at
   most half the viewport; the prototype stays visible while it is open.
9. **Decisions, quickly.** Mr Salam, 2026-09-24, after answering three
   questions in one form: *"I'd like something like this interactive for users
   on sfdc24.com so they can quickly get to their decisions and carry on with AI
   agents working away."* So an option may be marked **Recommended**, shown
   first with a one-sentence reason, but it is never pre-selected: the visitor
   still chooses. A `decision.batch` groups 2 to 4 questions into one short form
   answered together and submitted once, while the agents keep working.
10. **Reduced motion** is honoured: highlights appear without animation when
   `prefers-reduced-motion: reduce`.
