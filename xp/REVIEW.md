# Fleet view, as it appears

For a reviewer who can read this file and cannot open the page. The page does not load this file.

Open `http://127.0.0.1:8765/xp/?preview=owner` on this machine. The live snapshot is not published, so the screen is fixture data. The badge says Fixture and Local preview. Local preview is not a sign-in.

Headings and badges are small capitals. A word count below splits the visible text on spaces. A dot between words is not a word. Times are ET.

## 1280px

The page sits in a centered column on a dark ground. Nothing scrolls sideways. The supervisor is above the agents. Watch lines run from pi1-cli down to each agent. Two handoff curves are drawn: Codex to Claude, and Claude to Cursor.

### Top bar

2 words: SFDC, Fleet.

SFDC goes to the home page. Fleet is a label.

### Badge

3 words: Fixture, Local, preview.

Not tappable.

### Supervisor

3 words: Supervisor, pi1-cli, Pi.

Tap opens the detail. On this fixture every counter is unknown, because the supervisor hash is not in the snapshot:

Role unknown. Mode unknown. As of unknown. Environment Pi. Liveness active. Checks run unknown. Waits unblocked unknown. Delivery gaps unknown. Escalations unknown. Open incidents unknown. Redis pending unknown.

No practice mode label. These rows do not carry a mode. Close, or Escape, dismisses the detail.

### Agents

Six cards, three across. Tap the name for the agent. Tap the chip under it for that instance.

- Claude, 8 words: Claude, Review, the, gate, laptop, Cloud, Run, VM. The chips are the three instances.
- Codex, 2 words: Codex, laptop.
- Gemini, 4 words: Gemini, Stalled, Cloud, Run.
- Grok, 2 words: Grok, box.
- Cursor, 7 words: Cursor, Ship, the, fleet, view, Waiting, Cloud.
- Pi, 3 words: Pi, Unconfirmed, Pi.

Tap Pi's chip: Environment Pi, Presence unconfirmed, Liveness unknown, Redis read false, Last seen unknown.

### Legend

3 words: Watch, Handoff, Step.

Not tappable. Step is the dot used on the output chart.

### Milestones

Heading, 1 word: Milestones.

- Cloud, 2 words: Cloud, 36%.
- Redis, 2 words: Redis, 47%.
- Site, 2 words: Site, unknown.

Tap Site: Percent unknown, Status AMBER, Fleet view prog. 36% and 47% are stored. Site has no percent stored.

### Tasks

Heading, 1 word: Tasks.

- task-pr-52, 3 words: task-pr-52, accepted, Waiting.
- task-gate, 2 words: task-gate, accepted.
- task-done, 2 words: task-done, SUCCEEDED.

Tap task-pr-52: State accepted, Waiting yes, Note unknown, Owner cursor.

### Supervisor feed

Heading, 1 word: Supervisor.

- 8 words: 21:40, ET, Flagged, a, stale, beat, gemini, flagged.
- 8 words: 21:10, ET, Nudge, the, open, task, cursor, sent.
- 8 words: 20:50, ET, look, at, the, box, grok, unknown.
- 7 words: 18:10, ET, Merged, a, duplicate, grok, merged.

Tap the first row: Time 21:40 ET, Target gemini, Kind stall, Outcome flagged, Ref unknown, Mode unknown, Key v1:bus:row:sup-stall.

### Output

Heading, 1 word: Output.

Axis, 5 words: 16:00, ET, 24h, 21:00, ET.

Three bars. A purple dot marks an hour that also has a supervisor row. Hours with only a supervisor row do not grow a zero bar. Tap the chart: claude 1 task, codex 1 review, cursor 1 commit. Those three are stored board rows.

### Footer

58 words, the site disclaimer:

sfdc24.com is an independent community resource for Salesforce customers, consultants and developers, run by Abdus Salam, a certified Salesforce Sales Cloud Consultant, with help from AI agents. It is not affiliated with, endorsed by, or sponsored by Salesforce, Inc., and does not represent or speak for Salesforce. Salesforce, Sales Cloud and related marks are trademarks of Salesforce, Inc.

## 390px

The same words, in the same order. The column is the width of the phone.

- Agents stack in one column: Claude, Codex, Gemini, Grok, Cursor, Pi.
- Milestones, tasks, the feed, and the chart stack. The feed is above the chart.
- The page does not scroll sideways.
- The same controls take a tap. Tab order is unchanged.

## Keyboard

Tab order: SFDC, the supervisor, each agent and then its chips, the milestones, the tasks, the feed rows, the chart.

Arrow keys move across the agent buttons only: supervisor, Claude, Codex, Gemini, Grok, Cursor, Pi, then back to the supervisor. Enter opens the focused control. Escape closes the detail.

## Empty and unknown

Not all of these are on the fixture screen.

- No supervisor hash, no supervisor events, and no heartbeat: the lane says not yet reported.
- No agents, no milestones, no tasks, no feed, or no output in the last 24 hours: that region says not yet reported.
- Supervisor events in the last 24 hours and no output events: the chart draws the dots and says not yet reported. It does not draw a zero bar.
- A live snapshot older than 300 seconds: the badge says Live and Stale, and a line says stale snapshot. Stored rows still show.
- If the fixture cannot be read either, or the file is not JSON, the badge says Missing and each region says not yet reported. A snapshot that loads with nothing in it stays Fixture. It does not say Missing. Each empty region says not yet reported.
- An agent whose family is stored and whose instance list is empty shows not yet reported in the card. The detail count is 0. No environment chip is invented.
- A field that is absent says unknown. A stored zero, such as open incidents 0, is shown as 0.
- The mode label is reconciled from the supervisor hash and from feed entries that report a mode. None reported: no chip, and the detail Mode line says unknown. One reported word: that word, as in practice mode or live mode. Two or more: mixed mode. A live hash with a practice feed is mixed. A practice hash with an empty feed is practice mode, and the empty feed still says not yet reported. This fixture reports no mode, so the chip is absent.
- An unknown event kind still shows as a generic action. It is not dropped. `unblock` is a known kind and stays `unblock`. Ref and mode are in the feed detail. If they were not stored, they say unknown.
- Two feed rows that share a ref both stay when the action, the kind, or the target differs. A row is dropped only when the event id matches, or when time, kind, target, action, and ref are all the same.

## Locked

On any host other than this machine the page says Owner only. The note is a Sign in link to the existing Studio sign-in. A Redis record, including conf:auth:roles, does not open it. A role set on the page does not open it either. The existing operator session does, after the studio controller accepts that token.

## Round 3

Reviewed at 36516ad and held. Three changes, and the fixture screen above is otherwise the same.

1. Feed repeats. A shared ref no longer collapses two actions. The reroute and the guidance that both cite GROK-ACK-AYA-0351-0358-20261019T0423Z both stay. Two delivery gaps that cite one ref and name claude-code-cli and grok both stay. A later row is dropped only when its event id matches one already shown, or when time, kind, target, action, and ref are all identical. The older log has no kind, so its ANDON copy of the dedicated escalation is kept.

2. Mode. The chip and the detail Mode line use one reconciled word. Live hash plus a practice feed reads mixed mode. A practice hash and an empty feed read practice mode. A feed that reports both practice and live reads mixed mode. Nothing reported stays unlabeled, and the detail says unknown.

3. Page weight. The cap stays 52,000 bytes. The number is the LF length of the six page files, 51,603 bytes on this round. `.gitattributes` pins `eol=lf` on them. A CRLF checkout is normalized to that same length before the test compares it to the cap.

An empty snapshot that did load no longer wears a Missing badge. Missing stays the label for a snapshot that cannot be read.

## Round 4

Self-review on 97dd725. The fixture screen above is the same. The footer text now uses the legend grey, so the 11px disclaimer sits with the other secondary type.

1. Redis list. Tests feed `fleet:supervisor:pi1-cli:events` as a list of JSON strings, which is how the Redis list is stored, and as one JSON string of that list. Three `delivery_gap` rows stay, one each for claude-code-cli, grok, and aya, including when they share a ref. `unblock` with action REROUTE and `check` with action GUIDANCE that share a ref both stay. `escalation` and `check` stay. A repeated event id is dropped. These rows all carry `mode=practice`, so the chip says practice mode. A canon row for aya does not rename the target.

2. Counters. With no `fleet:supervisor:pi1-cli` hash, the six counters say unknown. Three delivery gaps do not become the number 3. A partial hash of strings shows the fields that arrived, including `"0"` and a numeric string with spaces, and the missing fields stay unknown. A value that is not a number stays unknown. The same strings are read when the hash itself is one JSON string.

3. Empty and bad reads. No live file on this machine, opened with `?preview=owner`, shows the fixture and Local preview. An empty feed, no hourly output, and a missing counters hash say not yet reported or unknown. The chart does not draw a zero bar. An agent with no instances says not yet reported and draws no chip. The detail count is 0. A file that is not JSON says Missing, and each region says not yet reported. A bad live file still falls back to the fixture.

4. Phone and keys. At 390px nothing draws past the screen. Tab order is unchanged. Arrow keys wrap across the agent buttons. Enter opens the focused control. Escape closes the detail, and Tab stays inside it. Every agent, chip, milestone, task, feed row, and the chart opens its detail. `conf:auth:roles` still does not unlock the page.

5. Page weight. The cap stays 52,000 bytes. The LF length of the six page files is 51,915.
