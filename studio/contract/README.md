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
