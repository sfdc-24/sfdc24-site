# Demo script — about three minutes

Prospects watch. They do not join. Speak the lines below. The page is an illustration for this conversation, not a live system.

## Open it on the laptop

The staging link this repository publishes does not open as a page. jsDelivr serves HTML as plain text, with `nosniff`, so Chrome shows the source. Do not put these addresses on screen:

- https://cdn.jsdelivr.net/gh/sfdc-24/sfdc24-site@staging-live/floor/index.html?demo=1
- https://cdn.jsdelivr.net/gh/sfdc-24/sfdc24-site@staging-live/floor-conference/index.html?demo=1

GitHub Pages for this repository is branch `main`, with the production name `www.sfdc24.com`. A preview page needs a different static host that sends `text/html`, serving the prepared `staging-live` tree, on a name that is not `www.sfdc24.com`. That host does not exist yet. Production was not changed.

Until that host exists, serve this branch on the laptop. From a checkout of `cursor/redis-floor-views-222d`:

```bash
python3 -m http.server 8765
```

Then open:

- Floor: http://127.0.0.1:8765/floor/index.html?demo=1
- Conference: http://127.0.0.1:8765/floor-conference/index.html?demo=1

If a red staging strip appears, `?demo=1` is missing. Add it and reload. If the page will not open, play the backup recording in the pull request. Do not debug it live.

## 0:00 — Floor

Open the floor address.

Say: "This is the floor. Assessment, automation, and AI enablement live in one place. What you are seeing is an illustration for this conversation."

Click **Open the conference**. Or click the conference card.

## 0:25 — The room

Say: "Five agents are in the room with us. Claude sets the agenda. Grok keeps the pace. Codex reviews. Gemini shapes what the client sees. Cursor builds. They do not replace the conversation. They keep the work from falling out of it."

## 0:50 — Transcript

Point at the transcript. It adds a line every few seconds.

Say: "What gets said stays with the work. Nobody has to reconstruct the call the next morning."

## 1:15 — Work board

Point at the work board.

Say: "Every task has an owner. A receipt means it came back. You can see what was asked, who has it, and what was delivered. That is the board your team would watch."

## 1:45 — Working copy

Scroll to **Assessment outline**. The badge says Working copy.

Say: "The outline starts as a working copy. It can still change. There is only one working copy, so two people cannot fork the same document by accident."

## 2:05 — In review

Click **Request review**.

Say: "Codex reviews it. The text freezes. Comments can still land. Nothing locks until a person approves."

## 2:25 — Approved and locked

Click **Approve and lock**.

Say: "I approve it. The stamp is the scope: who reviewed, who approved, the version, the date, and a fingerprint. That version does not change. If the client wants a change, it is a new working copy. The locked one stays."

## 2:45 — A new working copy

Click **Start new working copy**.

Say: "Version one stays locked. Version two is the only place the next change can live. That is how the document stays under control."

Stop there. Do not open Processes, Tables, or Chains. Those pages are for the build, not for this conversation.

## If a click does nothing

Reload the conference address. The outline starts again as a working copy. Repeat from Request review.
