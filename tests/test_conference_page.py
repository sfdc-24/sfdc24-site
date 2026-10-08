"""Public /conference page: no internal wiki jargon, no secrets."""
from __future__ import annotations

import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PAGE = ROOT / "conference" / "index.html"
CONFIG = ROOT / "conference" / "access-config.js"
BEHAVIOR = ROOT / "tests" / "conference_access.cjs"
VENDORS = (
    "Claudia", "Grok", "Gemini", "Codex", "Cursor", "Copilot",
    "OpenAI", "Anthropic", "ChatGPT", "Deepgram", "LiveKit", "xAI",
)


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

    def test_request_section_is_hidden_and_honeypot_is_empty(self):
        text = PAGE.read_text(encoding="utf-8")
        start = text.index('<section class="card" id="conference-access"')
        tag = text[start:text.index(">", start) + 1]
        self.assertIn(" hidden", tag)
        self.assertIn('name="fax_number"', text)
        self.assertIn('value=""', text)
        self.assertNotIn("Join the conference", text)
        config = CONFIG.read_text(encoding="utf-8")
        self.assertIn("enabled: false", config)
        self.assertIn("https://access.invalid/api/conference/access/request", config)
        self.assertNotIn("/api/conference/access/request", text)

    def test_public_copy_uses_persona_names_only(self):
        for path in (PAGE, CONFIG, ROOT / "conference" / "access.js"):
            text = path.read_text(encoding="utf-8")
            for name in VENDORS:
                self.assertNotIn(name, text, f"{path.name} names {name}")
        self.assertIn("Claude chairs the line", PAGE.read_text(encoding="utf-8"))

    def test_access_behavior_suite(self):
        proc = subprocess.run(
            ["node", "--test", str(BEHAVIOR)],
            cwd=ROOT,
            capture_output=True,
            text=True,
            check=False,
        )
        if proc.returncode != 0:
            self.fail(proc.stdout + "\n" + proc.stderr)


if __name__ == "__main__":
    unittest.main()
