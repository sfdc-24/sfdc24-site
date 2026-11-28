"""/history shows commit subjects publicly: no name trailer, email, internal row id or editorial marker."""
import importlib.util
import json
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("build_history_timeline", ROOT / "tools" / "build_history_timeline.py")
timeline = importlib.util.module_from_spec(spec)
spec.loader.exec_module(timeline)

LEAKS = re.compile(r"(?i:Co-authored-by|@[\w-]+\.|OWNER-WORDING)|\b(?:CODEX|GEMINI|GROK|CLAUDE|CURSOR)-[A-Z0-9]+-")
SEP = chr(0x1F)


class PublicSubjects(unittest.TestCase):
    def test_the_committed_timeline_carries_no_internal_wording(self):
        data = json.loads((ROOT / "data" / "history-timeline.json").read_text(encoding="utf-8"))
        bad = [e["subject"] for e in data["events"] if LEAKS.search(e.get("subject", ""))]
        self.assertEqual([], bad)

    def test_the_scrubber_removes_each_kind(self):
        cases = {
            "Merge branch 'main' into cursor/x Co-authored-by: A Person <a.person@example.com>":
                "Merge branch 'main' into cursor/x",
            "Merge origin/main into the seat (PR 397 was 7 behind; Codex HOLD CODEX-RESULT-PR397-20261107T2204Z)":
                "Merge origin/main into the seat (PR 397 was 7 behind)",
            "Data statement: say what is provable (calls are recorded to our private cloud storage); "
            "drop the editorial OWNER-WORDING markers from public HTML": "Data statement: say what is provable",
            "Plain subject (#12)": "Plain subject (#12)",
        }
        for raw, want in cases.items():
            self.assertEqual(want, timeline.public_subject(raw), raw)

    def test_a_trailer_only_branch_sync_is_dropped(self):
        raw = SEP.join(["abc1234", "2026-11-01T00:00:00Z",
                        "Merge branch 'main' into cursor/x Co-authored-by: A <a@example.com>"])
        self.assertEqual([], timeline.parse_log(raw))


if __name__ == "__main__":
    unittest.main()
