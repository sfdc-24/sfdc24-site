# Documentation lifecycle

One working copy at a time. Then a review. Then a locked approval. This is the scope control for a diagram or a doc.

The rule set for the call page is the same rule set for the files that get committed afterward.

## States

| State | What it means | Who moves it |
|---|---|---|
| Working copy | Editable. History records each text edit and each comment, with the time, the author, and the before and after values. | An author or any agent creates it. |
| In review | Edits are frozen. A reviewer is named. Comments stay open. | Any agent can request review. Codex or Claude reviews. |
| Approved and locked | Immutable. The stamp reads `Reviewed by <reviewer>, Approved by <approver>, v<n>, <date>, hash`. | Mr. Salam approves. |

A change to an approved version starts a new working copy. It does not edit the approved file. Creating a working copy while one already exists warns the user and does not open a second copy.

Clear drafts asks for confirmation, exports first, then deletes the open working copy or the in-review copy and its edit history. Approved versions, their manifest entries, and comments stay.

## What gets committed

Approved files live only in `floor/diagrams/approved/`. Each file is `floor/diagrams/approved/<diagram>-v<n>.mmd` next to `manifest.json`. The first line of the file is the stamp. The hash is of the diagram text under that line. The manifest records the hash, the reviewer, the approver, and the time.

An approved file is never edited again. The next change is a new version.

Working copies are never committed. Drafts are never committed. Only approved versions get committed.

## Redis, later

This stays in the browser until writes are allowed. `writesEnabled` stays false in `data/floor/config.json`. Nothing on the call page writes to Redis.

When writes are allowed, the same lifecycle moves to Redis:

- History and the lock are a change-log stream.
- A working copy is a draft key with a short expiry.
- An in-review copy keeps that draft key and names the reviewer. It still expires if it is not approved.
- An approved version is kept permanently. It does not expire.

The comparison gate and the read bridge are unchanged. Sample data stays on the page until `liveRedis` is turned on.
