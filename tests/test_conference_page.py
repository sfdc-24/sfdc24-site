"""Public /conference page: join honesty, no secrets, fleet role copy."""
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[1]
PAGE = ROOT / "conference" / "index.html"
JS = ROOT / "assets" / "conference-join.js"


class ConferencePageTest(unittest.TestCase):
    def setUp(self):
        self.html = PAGE.read_text(encoding="utf-8")
        self.js = JS.read_text(encoding="utf-8")
        self.main = self.html.split("<main", 1)[1].split("</main>", 1)[0]

    def test_conference_page_exists(self):
        self.assertTrue(PAGE.is_file())
        self.assertTrue(JS.is_file())

    def test_no_okf_word_on_public_conference_page(self):
        blob = self.html + self.js
        self.assertNotIn("OKF", blob)
        self.assertNotIn("okf", blob.lower())

    def test_no_secret_markers(self):
        blob = self.html + self.js
        for needle in ("API_KEY", "SECRET", "LIVEKIT_API", "BEGIN PRIVATE", "BEGIN RSA"):
            self.assertNotIn(needle, blob)

    def test_no_people_names_in_the_conference_copy(self):
        for needle in ("Yasmine", "Hajar", "Salam", "Abdus"):
            self.assertNotIn(needle, self.main)
            self.assertNotIn(needle, self.js)

    def test_honest_when_token_missing_and_no_fake_invite(self):
        self.assertIn("No join token on this link.", self.html)
        self.assertIn("does not mint one", self.html)
        self.assertIn("does not send an invite", self.html)
        self.assertNotIn("You're invited", self.html)
        self.assertNotIn("calendar invite", self.html.lower())
        self.assertNotRegex(self.html, r"https://[^\"']*zoom\.us")

    def test_join_is_owner_sign_in_without_a_token_query(self):
        hrefs = re.findall(r'href="(https://conference-gateway[^"]*)"', self.html)
        self.assertEqual(hrefs, ["https://conference-gateway-96522051727.us-central1.run.app/"])
        self.assertNotIn("?token=", self.html)
        self.assertNotIn("?t=", self.html)
        self.assertIn("Sign in to join", self.html)

    def test_recording_is_off_and_owner_opt_in_only(self):
        self.assertIn('id="record"', self.html)
        self.assertIn("disabled", self.html)
        self.assertIn("Recording: off.", self.html)
        self.assertIn("This page does not record.", self.html)
        self.assertIn("Owner opt-in stays on the signed-in gateway.", self.html)
        self.assertIn('data-feedback="heard"', self.html)
        self.assertNotIn("MediaRecorder", self.html + self.js)
        self.assertNotIn("getUserMedia", self.html + self.js)

    def test_feedback_stays_in_the_tab(self):
        blob = self.html + self.js
        self.assertNotIn("sendBeacon", blob)
        self.assertNotIn("/conference/feedback", blob)
        self.assertNotIn("Receipt not confirmed.", blob)
        self.assertIn("does not add a log", self.html)
        self.assertIn("already keeps the room log", self.html)
        self.assertIn("already issues the room token", self.html)
        self.assertIn('id="beacon-status"', self.html)

    def test_role_copy_matches_fleet_rulings(self):
        roles = {
            "Grok": "Strategy",
            "Claude": "Implementation &amp; release. Handoffs, not the live floor.",
            "Codex": "PM &amp; test lead. Preferred facilitation.",
            "Gemini": "Adversarial reasoning",
            "Copilot Agents": "PR review &amp; living docs",
            "Cursor": "Independent exact-head review",
        }
        for name, role in roles.items():
            self.assertIn(f"<b>{name}</b> {role}", self.main)
        for retired in ("delivery lead", "Heavy PM", "MCP gatekeeper", "Dev lead", "live chair"):
            self.assertNotIn(retired, self.main)

    def test_page_stays_unlisted(self):
        self.assertIn('content="noindex"', self.html)

    def test_page_names_the_offer(self):
        self.assertIn("Assessment, automation, and AI enablement.", self.main)


if __name__ == "__main__":
    unittest.main()
