# Approved diagram versions

Files in this directory are immutable. The rule set is `docs/documentation-lifecycle.md`. Working copies are never committed here.

An approved diagram is committed once, as `floor/diagrams/approved/<diagram>-v<n>.mmd`, next to `manifest.json`. The manifest records the content hash, the approver, and the time. That file is never edited again. A later change is a new version, `v<n+1>`, from an explicit new draft on the call page.

Export on the conference page writes `approved/<diagram>-v<n>.mmd` and `manifest.json`. Place the diagram files in this directory and commit the manifest beside them. Do not rewrite a file that is already here.

History and the lock stay in the browser for now. Later they move into Redis as a change-log stream, once writes are allowed. `writesEnabled` stays false until that approval.
