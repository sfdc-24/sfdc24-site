"""Public /conference page: owner join, role rulings, no client names, no secrets."""
import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PAGE = ROOT / "conference" / "index.html"
GATEWAY = ROOT / "conference" / "gateway.json"
SCRIPT = ROOT / "conference" / "conference.js"

WAITING = "Join unavailable — waiting on gateway token"


def page_text():
    return PAGE.read_text(encoding="utf-8")


class ConferencePage(unittest.TestCase):
    def test_conference_page_exists(self):
        self.assertTrue(PAGE.is_file())
        self.assertTrue(SCRIPT.is_file())
        self.assertTrue(GATEWAY.is_file())

    def test_join_waits_on_gateway_token(self):
        html = page_text()
        self.assertIn(WAITING, html)
        self.assertIn('id="join-conference"', html)
        self.assertIn('type="button"', html)
        gate = json.loads(GATEWAY.read_text(encoding="utf-8"))
        self.assertIsNone(gate["tokenUrl"])
        self.assertIsNone(gate["beaconUrl"])
        self.assertFalse(gate["media"])
        script = SCRIPT.read_text(encoding="utf-8")
        self.assertIn(WAITING, script)
        self.assertNotIn("MediaRecorder", script)
        self.assertNotIn("calendar", html.lower())
        self.assertNotIn("invite", html.lower())

    def test_roles_match_owner_ruling(self):
        html = page_text()
        claude = html.split("<li>", 2)[1]
        self.assertIn("Claude", claude)
        self.assertIn("pre-planned", claude)
        self.assertIn("OKF", claude)
        self.assertIn("handoffs", claude)
        self.assertIn("Not duplex", claude)
        rest = html.replace(claude, "", 1)
        self.assertNotIn("OKF", rest)
        self.assertNotIn("okf", rest.lower())
        self.assertIn("Codex", html)
        self.assertIn("best communicator", html)
        self.assertIn("facilitation", html)
        self.assertIn("Gemini", html)
        self.assertIn("adversarial", html)
        self.assertIn("browser-listen", html)
        self.assertIn("Grok", html)
        self.assertIn("delivery lead", html)
        self.assertIn("delegate", html)

    def test_no_client_or_people_names(self):
        html = page_text()
        bare = html.replace("abdus@sfdc24.com", "").replace("https://www.linkedin.com/in/salams", "")
        lowered = bare.lower()
        for needle in ("yasmine", "abdus", "salam", "mr.", "client name"):
            self.assertNotIn(needle, lowered)
        self.assertIn("assessment, automation, and AI enablement", html)

    def test_no_secret_markers(self):
        blob = page_text() + GATEWAY.read_text(encoding="utf-8")
        for needle in ("API_KEY", "SECRET", "LIVEKIT_API", "BEGIN PRIVATE"):
            self.assertNotIn(needle, blob)

    def test_review_mark_is_opt_in_and_off(self):
        html = page_text()
        self.assertIn('id="record-opt-in"', html)
        attrs = html.split('id="record-opt-in"', 1)[1].split(">", 1)[0]
        self.assertNotIn("checked", attrs)
        self.assertIn("Audio is not recorded.", html)
        self.assertIn('content="noindex"', html)


if __name__ == "__main__":
    unittest.main()
