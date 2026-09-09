# Homepage A/B test — problem-led vs capability-led

## The question

The homepage has always opened by naming the visitor's problem: *"Salesforce
operations for orgs nobody wants to touch."* It is good writing, and it asks the
visitor to arrive already admitting something is wrong.

The alternative opens with capability and lets curiosity produce the question:
*"I make heavy Salesforce orgs light again"*, followed by the credentials that
make it credible, and four questions worth asking.

**Hypothesis.** Leading with capability produces more conversations, and
conversations that start with a real question rather than a complaint.

Both are live in `index.html`. Neither is a placeholder.

| | Variant A (control) | Variant B (challenger) |
|---|---|---|
| Headline | Salesforce operations for orgs nobody wants to touch | I make heavy Salesforce orgs light again |
| Deck | Tell it what's broken | Certified since 2013 · Six Sigma Black Belt · puts a number on it |
| Chat heading | Tell it what's broken | Ask it something hard |
| Findings section | You've met this org before | What I usually find |
| Stance | the visitor confesses | the visitor gets curious |

Everything below the first two sections is identical in both. The test is about
the opening stance, not the whole page.

## How a visitor is assigned

In `index.html`, before first paint, so nothing flickers:

1. `?v=a` or `?v=b` in the URL pins that variant and remembers it.
2. Otherwise the remembered variant from a previous visit is reused.
3. Otherwise a coin flip, remembered from then on.

Sticky per browser: the same person always sees the same page. Someone sent a
pinned link stays pinned even if they come back later without the parameter.

## How results are measured — no tracker, no new backend

The conversation id already sent with every chat message is prefixed with the
variant:

```
hb1a2b3c4d5   →  homepage, variant B
ha9z8y7x6w5   →  homepage, variant A
```

Conversations are already saved and already read by a human. So every transcript
now says which page produced it, and the thing we actually care about — did they
ask, and what did they ask — *is* the measurement. Nothing new to build, nothing
new to consent to, and no analytics vendor added to a page that currently has
none.

`/voice/` keeps its own `v…` prefix, so voice conversations stay
distinguishable from homepage ones.

## What counts

Per variant, over the same window:

| Measure | Where it comes from | Why it matters |
|---|---|---|
| Conversations started | count of distinct ids by prefix | the primary number |
| Questions per conversation | turns in the transcript | did curiosity hold |
| First message is a question, not a complaint | reading the first turn | tests the hypothesis directly |
| Reached email or the intake form | transcript / intake `lead_source` | the outcome that pays |
| Suggested question used vs typed their own | first turn matches a chip | is the seeding doing the work |

Read the transcripts. With invited testers the numbers are far too small for
significance, and pretending otherwise would be the mistake — the transcripts are
qualitative evidence, and that is the honest use of them.

## Running it with invited testers

**Send each tester a pinned link.** Split the roster so that people who know
Salesforce well and people who don't are spread across both variants — a page
that only reads well to admins is a finding.

```
https://www.sfdc24.com/?v=a
https://www.sfdc24.com/?v=b
```

Keep the roster where the transcripts are read, not in this repo:

| Tester | Knows Salesforce | Device | Variant | Sent | Feedback in |
|---|---|---|---|---|---|
| _(fill in)_ | yes / no | phone / laptop | a / b | | |

Aim for at least three testers on a phone per variant. The phone path is where
the old page was weakest and is the one most likely to still surprise us.

**Do not tell a tester which variant they have, or that there is a test.** Ask
them to use the site as if they had found it, then answer the questions below.

### Test cases

Each tester, in order. 1–4 are the ones that can fail outright.

1. **Open the link on a phone.** Anything cut off, overlapping, or requiring
   sideways scrolling? Is the text readable without zooming?
2. **Ask the assistant a question** — a suggested one or your own. Did an answer
   come back? How long did it feel?
3. **Tap "Talk instead" and speak a question.** Did the browser ask permission?
   Did it hear you? Did your words appear? *(Firefox has no speech recognition at
   all; the button correctly does not appear there. On iPhone use Safari.)*
4. **Open the same link on a laptop.** Same three checks.
5. **Follow "Talk out loud" to `/voice/`.** Does it listen and speak back?
6. **Submit the intake form** at `/intake/` with real-looking details.
7. **Visit a junk URL** such as `/nope`. Styled 404, not a bare GitHub page?

### The four questions to ask afterwards

Ask these in this order, and write down the words they use.

1. In one sentence, what does this person do?
2. Would you trust them with your org? What made you say that?
3. What did you want to ask, and did anything stop you?
4. What would you have expected to see that wasn't there?

Question 1 is the real test of the headline. If a tester on variant B cannot
answer it, the capability-led opening has failed at its own job, whatever the
conversation count says.

## Deciding

Pick the winner from the transcripts and question 1, not from the counts. Then
delete the losing variant from `index.html` rather than leaving both in place —
a permanent A/B is a maintenance cost with no owner, which is precisely the
fourth pattern this site warns clients about.

If the result is ambiguous, keep the control. The challenger has to earn the
change.
