# Call notes

Notes from the conference diagrams. The call page keeps them in the browser. Export writes a file. Nothing is sent to a server, and nothing is written to Redis.

After the call, commit the export here:

- `docs/call-notes/call-notes-2026-10-07.md`
- `docs/call-notes/call-notes-2026-10-07.json`

The markdown file is grouped by diagram and by node. The JSON file is what Import merges. Open `docs/conference-call.html` on each machine, import the other JSON files, export once, and commit that combined pair.

Spoken comments are pasted transcript excerpts. Written comments are the notes typed during the discussion. A diagram edit shows up in the export as a diff against the committed Mermaid text.

Do not put a passcode, a token, a credential, or a Redis address in the notes.
