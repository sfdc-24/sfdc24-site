"""Public /conference page: no internal wiki jargon, no secrets."""
from __future__ import annotations

import unittest
from pathlib import Path

PAGE = Path(__file__).resolve().parents[1] / "conference" / "index.html"


class ConferencePage(unittest.TestCase):
    def test_conference_page_exists(self):
        self.assertTrue(PAGE.is_file())

    def test_no_okf_word_on_public_conference_page(self):
        text = PAGE.read_text(encoding="utf-8")
        self.assertNotIn("OKF", text)
        self.assertNotIn("okf", text.lower())

    def test_no_secret_markers(self):
        text = PAGE.read_text(encoding="utf-8")
        for needle in ("API_KEY", "SECRET", "LIVEKIT_API", "BEGIN PRIVATE", "LiveKit", "Cloud Run"):
            self.assertNotIn(needle, text)

    def test_brochure_is_not_a_join_door(self):
        text = PAGE.read_text(encoding="utf-8")
        self.assertIn("conference gateway", text)
        self.assertIn("Guests stay closed", text)
        self.assertIn("VERIFY", text)
        self.assertIn("not the join door", text)
        self.assertIn("public join", text)
        self.assertNotIn("Join the conference", text)
        self.assertNotIn("mailto:", text.split("<footer", 1)[0])


if __name__ == "__main__":
    unittest.main()
