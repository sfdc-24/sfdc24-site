"""Public /conferences page: a handoff to the Converspan room, nothing else."""
from __future__ import annotations

import unittest
from pathlib import Path

PAGE = Path(__file__).resolve().parents[1] / "conferences" / "index.html"
ROOM = "https://converspan.com/room"
GATEWAY = "conference-gateway-yzet4vuplq-uc.a.run.app"


class ConferencesPage(unittest.TestCase):
    def setUp(self):
        self.text = PAGE.read_text(encoding="utf-8")

    def test_page_exists_and_hands_off_to_the_room(self):
        self.assertTrue(PAGE.is_file())
        self.assertEqual(self.text.count(f'href="{ROOM}"'), 2)
        self.assertIn(">Start</a>", self.text)
        self.assertIn(">Join</a>", self.text)
        self.assertNotIn("?", self.text.split(ROOM, 1)[1][:20])

    def test_no_identity_and_no_calling_ui(self):
        self.assertNotIn("tel:", self.text.lower())
        self.assertNotIn("<input", self.text.lower())
        self.assertNotIn("<form", self.text.lower())
        self.assertNotIn("dial pad", self.text.lower())
        self.assertNotIn("click-to-call", self.text.lower())
        for needle in ("value=\"", "placeholder=\"", "name=\"guest", "company="):
            self.assertNotIn(needle, self.text)
        self.assertIn("does not send a name or a company", self.text)

    def test_consent_is_plain(self):
        self.assertIn("Recording and transcripts need consent before they start.", self.text)
        self.assertIn("PIPEDA", self.text)
        self.assertIn("CRTC", self.text)
        self.assertIn("This page does not record.", self.text)
        self.assertIn("This page has no microphone and does not take a transcript.", self.text)
        self.assertIn('data-chrome-ask="off"', self.text)

    def test_shared_ask_mic_is_opted_out_only_here(self):
        chrome = (PAGE.parents[1] / "assets" / "chrome.js").read_text(encoding="utf-8")
        guard = 'document.body.getAttribute("data-chrome-ask") === "off"'
        self.assertIn(guard, chrome)
        self.assertLess(chrome.index(guard), chrome.index('id="chrome-mic"'))
        self.assertNotIn("SpeechRecognition", self.text)
        self.assertNotIn("chrome-mic", self.text)

    def test_builds_on_the_brochure_and_keeps_secrets_off(self):
        self.assertIn('href="/conference/"', self.text)
        self.assertNotIn(GATEWAY, self.text)
        for needle in ("OKF", "LiveKit", "Cloud Run", "API_KEY", "SECRET", "BEGIN PRIVATE", "LIVEKIT_API"):
            self.assertNotIn(needle, self.text)
        self.assertNotIn("okf", self.text.lower())

    def test_disclaimer_and_offer_stay(self):
        self.assertIn("not affiliated with, endorsed by, or sponsored by Salesforce", self.text)
        self.assertIn("Assessment, automation and AI enablement", self.text)
        self.assertIn('data-palette="cobalt"', self.text)
        self.assertIn("/assets/chrome.js", self.text)

    def test_how_it_works_is_shown_in_three_steps(self):
        self.assertIn('id="conference-how"', self.text)
        self.assertIn('aria-label="How a conference works"', self.text)
        for label in ("Start or join", "Room opens", "Summary after"):
            self.assertIn(f">{label}</span>", self.text)
        self.assertLess(self.text.index("Start or join"), self.text.index(">Start</a>"))
        self.assertIn("IntersectionObserver", self.text)
        self.assertIn("prefers-reduced-motion:reduce", self.text.replace(" ", ""))
        self.assertIn("animation:none", self.text.replace(" ", ""))
        self.assertNotIn("Start and Join both open the Converspan room.", self.text)
        self.assertIn("does not create a session", self.text)


if __name__ == "__main__":
    unittest.main()
