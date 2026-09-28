.okf-rule{margin:0 0 4px;font:600 13px/1.35 var(--ui);color:var(--ink)}
.okf-arch{margin:0 0 8px;max-width:88ch;font:400 12px/1.35 var(--ui);color:var(--mute)}
.okf-links{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 8px}
.okf-links a{
display:inline-flex;align-items:center;background:var(--accent);color:var(--paper);
border-radius:999px;padding:4px 8px;font:700 11px/1 var(--ui);text-decoration:none
}
.okf-links a[aria-current="true"]{box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 35%,transparent)}
.okf-grid{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:6px}
.okf-grid article{
background:var(--soft);border:1px solid var(--rule);border-radius:8px;padding:6px 8px;min-width:0
}
.okf-grid p,.okf-grid li{margin:0;font:400 12px/1.3 var(--ui);color:var(--ink);overflow-wrap:anywhere}
.okf-grid ul{margin:0;padding:0;list-style:none}
.okf-grid li+li{margin-top:3px}
.okf-grid a{color:var(--accent);font-weight:600}
.okf-grid [data-okf].is-okf{border-color:var(--accent);box-shadow:0 0 0 2px color-mix(in srgb,var(--accent) 18%,transparent)}
@media (max-width:900px){.okf-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media (max-width:520px){.okf-grid{grid-template-columns:minmax(0,1fr)}}
body.sitefoot.ops .wrap > h1{""",
)
must("tests/board_ops.cjs", "assert.match(view.engine, /Strategy/);", "assert.match(view.engine, /Delivery Director/);")
must(
    "tests/board_ops.cjs",
    "assert.match(view.pipeline, /Conference Line LiveKit spike/);\n  assert.match(view.pipeline, /www\\.sfdc24\\.com/);",
    "assert.match(view.pipeline, /Living OKF hub on Ops for packs/);\n  assert.doesNotMatch(view.pipeline, /Conference Line/);\n  assert.match(view.pipeline, /www\\.sfdc24\\.com/);",
)
must(
    "tests/board_ops.cjs",
    "assert.match(view.cooking, /Conference Line LiveKit spike on the shared room contract\\./);",
