# Call notes

Notes from the conference diagrams. The call page keeps them in the browser. Export writes a file. Nothing is sent to a server, and nothing is written to Redis.

After the call, commit the export here:

- `docs/call-notes/call-notes-2026-10-07.md`
- `docs/call-notes/call-notes-2026-10-07.json`

The markdown file is grouped by diagram and by node. It includes the change history. The JSON file is what Import merges. Open `docs/conference-call.html` on each machine, import the other JSON files, export once, and commit that combined pair.

Spoken comments are pasted transcript excerpts. Written comments are the notes typed during the discussion. A diagram edit shows up in the export as a diff against the committed Mermaid text.

## Permanent lock

Each diagram has History and Approve this version.

History records every diagram-text edit and every comment add or remove, with the time, the author, and the before and after values. Approve this version records the approver (Mr. Salam unless another name is chosen), the time, and a short content hash, then freezes that diagram. The panel shows `Locked — approved v<n> by <name> at <time>`. Comments stay open. The next text change has to be an explicit Start new draft from v<n>, which opens v<n+1> as a draft. Earlier approved versions stay viewable.

Export also writes:

- `manifest.json` with the hash, the approver, and the time
- `approved/<diagram>-v<n>.mmd` for each approved version

After the call, commit those files under `floor/diagrams/approved/` together with `manifest.json`. The download name is `approved/<diagram>-v<n>.mmd`. The path in the manifest is `floor/diagrams/approved/<diagram>-v<n>.mmd`. A browser may save the download as `approved_<diagram>-v<n>.mmd`. Rename it to `<diagram>-v<n>.mmd` before committing it.

Each approved file is never edited again. A change becomes a new version. Files in `floor/diagrams/approved/` are immutable. See `floor/diagrams/approved/README.md`.

Only approved versions get committed. Drafts are never committed.

Clear drafts asks for confirmation, exports first, then removes unapproved draft versions and their edit history from the browser. Approved versions, their manifest entries, and comments stay.

Later, this history and this lock move into Redis as a change-log stream (the version-control proposal) once writes are allowed. Drafts get a short expiry. Approved versions are kept permanently. Until that approval, `writesEnabled` stays false in `data/floor/config.json`. This page does not write to Redis.

Do not put a passcode, a token, a credential, or a Redis address in the notes.
