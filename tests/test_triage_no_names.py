"""No local answer names Mr Salam or promises he will reply.

His words, 2026-09-24: "Can you not mention or promise my name in any
response." assets/triage.js is GENERATED from assets/triage.py, so the rule
is checked on the Python source, on a fresh emit, and on the checked-in file:
Codex review of #179 found the first version edited only the emitted file,
and the next regeneration would have brought the old answers back.
"""
import importlib.util
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
_spec = importlib.util.spec_from_file_location("triage_src", ROOT / "assets" / "triage.py")
triage = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(triage)

NAMED = re.compile(r"abdus|salam", re.I)
PROMISE = re.compile(r"reply usually comes back|reaches a person", re.I)


class NoNamesInLocalAnswers(unittest.TestCase):
    def answers(self):
        return [r.get("answer") or "" for r in triage.RULES]

    def test_the_python_rules_name_no_one(self):
        for a in self.answers():
            self.assertIsNone(NAMED.search(a), a)
            self.assertIsNone(PROMISE.search(a), a)

    def test_a_fresh_emit_names_no_one(self):
        emitted = triage.emit(triage.RULES)
        for m in re.finditer(r'"answer":\s*"([^"]*)"', emitted):
            self.assertIsNone(NAMED.search(m.group(1)), m.group(1))
            self.assertIsNone(PROMISE.search(m.group(1)), m.group(1))

    def test_the_checked_in_file_names_no_one(self):
        shipped = (ROOT / "assets" / "triage.js").read_text(encoding="utf-8")
        for m in re.finditer(r'"answer":\s*"([^"]*)"', shipped):
            self.assertIsNone(NAMED.search(m.group(1)), m.group(1))

    def test_contact_questions_are_sent_to_the_request_form(self):
        contact = [a for a in self.answers() if "request form" in a]
        self.assertTrue(contact)
        for a in contact:
            self.assertIn("www.sfdc24.com/intake/", a)


class NoNamesInLoadedFragments(unittest.TestCase):
    """HTML fragments are loaded into pages at runtime, so the page-level
    check in site_positioning.cjs never sees them. /method/'s speed note said
    results go "to Mr. Salam" until 2026-09-24."""

    def test_no_fragment_names_him_in_prose(self):
        for frag in sorted((ROOT / "assets").glob("*.fragment.html")):
            text = frag.read_text(encoding="utf-8")
            prose = re.sub(r"abdus@sfdc24\.com", "", text)
            self.assertIsNone(NAMED.search(prose), frag.name)


if __name__ == "__main__":
    unittest.main()
