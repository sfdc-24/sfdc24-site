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
- If the fixture cannot be read either, the badge says Missing.
- A field that is absent says unknown. A stored zero, such as open incidents 0, is shown as 0.
- practice mode, 2 words, appears on the supervisor lane and on the feed only when every entry that reports a mode says practice. This fixture has no mode, so the label is absent.
- An unknown event kind still shows as a generic action. It is not dropped. Ref and mode are in the feed detail. If they were not stored, they say unknown.

## Locked

On any host other than this machine the page says Owner only, and Sign-in is not wired (4 words in the note, 2 in the heading). A Redis record, including conf:auth:roles, does not open it.
