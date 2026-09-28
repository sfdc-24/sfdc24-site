import hashlib
from pathlib import Path

def blob(text):
    data = text.encode()
    return hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest()

def must(path, old, new):
    file = Path(path)
    text = file.read_text()
    if old not in text:
        raise SystemExit("missing marker in " + path + ": " + old[:120])
    file.write_text(text.replace(old, new, 1))

must("assets/board-ops.part-a.js", 'role:"PM & test lead"', 'role:"Fleet PM"')
must(
    "assets/board-ops.part-a.js",
    '{id:"grok",name:"Grok Bot",role:"Strategy"}',
    '{id:"grok",name:"Grok Bot",role:"Delivery Director"}',
)
must(
    "assets/ops-board-a.css",
    "body.sitefoot.ops .wrap > h1{",
    """.okf-hub{
margin:0 0 8px;background:var(--paper);border:1px solid var(--accent);border-radius:12px;
padding:8px 10px;box-shadow:0 0 0 2px color-mix(in srgb,var(--accent) 12%,transparent)
}
.okf-hub h2,.okf-grid h3{
margin:0 0 4px;font:700 11px/1 var(--ui);letter-spacing:.12em;text-transform:uppercase;color:var(--accent)
}
