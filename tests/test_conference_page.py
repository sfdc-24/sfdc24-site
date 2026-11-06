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
        # 2026-11-04: plain language for guests instead of the internal VERIFY and GO.
        self.assertIn("by invitation only, once the owner approves", text)
        self.assertNotIn("VERIFY", text)
        self.assertIn("not the join door", text)
        self.assertIn("public join", text)
        self.assertNotIn("Join the conference", text)
        self.assertNotIn("mailto:", text.split("<footer", 1)[0])


    def test_roles_name_the_current_team(self):
        text = PAGE.read_text(encoding="utf-8")
        roles = text.split('aria-label="Roles"', 1)[1].split("</section>", 1)[0]
        self.assertIn('data-keep-names="1"', roles)
        for name in ("Claude", "Greg", "Gemini", "Cody", "Jev"):
            self.assertIn(f"<b>{name}</b>", roles)
        for gone in ("Aya", "Jenny", "Cursor", "— builds"):
            self.assertNotIn(gone, roles)

    def test_room_frame_allows_fullscreen_and_camera(self):
        # The console's Full screen button for a shared screen needs fullscreen
        # delegated to the frame; the camera must stay allowed too.
        text = PAGE.read_text(encoding="utf-8")
        frame = text.split('id="conf-room-frame"', 1)[1].split(">", 1)[0]
        allow = frame.split('allow="', 1)[1].split('"', 1)[0]
        features = [part.strip() for part in allow.split(";")]
        self.assertIn("fullscreen", features)
        self.assertIn("camera", features)


if __name__ == "__main__":
    unittest.main()
