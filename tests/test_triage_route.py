"""Regression for CODEX-REVIEW-001 P0: route() must return the scored winner."""
from __future__ import annotations

import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TRIAGE_PY = ROOT / "assets" / "triage.py"
TRIAGE_JS = ROOT / "assets" / "triage.js"


class TriageRouteTests(unittest.TestCase):
    def test_emit_template_uses_scored_winner_not_hardcoded_grok(self) -> None:
        src = TRIAGE_PY.read_text(encoding="utf-8")
        # The JS emit template must wire routeTo/why to the scored variables.
        self.assertIn("routeTo: best, why: why", src)
        self.assertNotIn(
            'routeTo: "grok", why: "escalate-to-grok"',
            src,
            "route() must not discard the CREW score and hardcode grok",
        )

    def test_committed_js_matches_scored_winner_contract(self) -> None:
        js = TRIAGE_JS.read_text(encoding="utf-8")
        self.assertIn("routeTo: best, why: why", js)
        self.assertNotIn('routeTo: "grok", why: "escalate-to-grok"', js)

    def test_keyword_miss_routes_apex_to_claude_not_always_grok(self) -> None:
        script = r"""
const fs = require("fs");
const vm = require("vm");
const code = fs.readFileSync(process.argv[1], "utf8");
const ctx = { window: {}, console };
vm.createContext(ctx);
vm.runInContext(code, ctx);
const T = ctx.window.__TRIAGE;
T.setCrew(["claude", "codex", "foundry", "gemini", "grok"]);
const apex = T.route("Need Apex and LWC validation rule help");
if (apex.routeTo !== "claude" || apex.why !== "keyword") {
  console.error("FAIL apex", JSON.stringify(apex));
  process.exit(1);
}
const codeAsk = T.route("please patch this typescript bug in the repo");
if (codeAsk.routeTo !== "codex" || codeAsk.why !== "keyword") {
  console.error("FAIL code", JSON.stringify(codeAsk));
  process.exit(1);
}
const a = T.route("zzzz no signal whatever");
const b = T.route("zzzz no signal whatever");
if (a.why !== "round-robin" || b.why !== "round-robin" || a.routeTo === b.routeTo) {
  console.error("FAIL rr", JSON.stringify({ a, b }));
  process.exit(1);
}
if (a.routeTo === "grok" && b.routeTo === "grok") {
  console.error("FAIL still stuck on grok", JSON.stringify({ a, b }));
  process.exit(1);
}
console.log("ok", apex.routeTo, codeAsk.routeTo, a.routeTo, b.routeTo);
"""
        proc = subprocess.run(
            ["node", "-e", script, str(TRIAGE_JS)],
            cwd=ROOT,
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(
            proc.returncode,
            0,
            f"stdout={proc.stdout!r} stderr={proc.stderr!r}",
        )


if __name__ == "__main__":
    unittest.main()
