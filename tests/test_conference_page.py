"""Public /conference page: join honesty, no secrets, fleet role copy."""
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[1]
PAGE = ROOT / "conference" / "index.html"
CREATE = ROOT / "conference" / "create" / "index.html"
JS = ROOT / "assets" / "conference-join.js"
ROOM = ROOT / "assets" / "conference-room.js"
GATE_JS = ROOT / "assets" / "conference-gate.js"
CREATE_JS = ROOT / "assets" / "conference-create.js"
CLIENTS = [
    PAGE,
    CREATE,
    ROOT / "conference" / "room" / "index.html",
    JS,
    ROOM,
    GATE_JS,
    CREATE_JS,
    ROOT / "assets" / "conference-live.js",
]


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
        self.assertIn('id="portal-join" href="https://portal.sfdc24.com/"', self.html)
        self.assertIn("Join by link on this page.", self.html)
        self.assertIn("No sign-in is required.", self.html)
        self.assertIn("Experience Cloud is not required.", self.html)
        self.assertIn("The room is LiveKit, not inside Salesforce.", self.html)
        self.assertIn("One joiner per code.", self.html)
        self.assertIn("Internal testing only.", self.html)
        self.assertIn("Join with code", self.html)
        self.assertNotIn("token=", self.html[self.html.find("portal.sfdc24.com"):self.html.find("portal.sfdc24.com") + 80])

    def test_recording_is_consent_and_stays_off(self):
        record = re.search(r'<input id="record"[^>]*>', self.html).group(0)
        self.assertNotIn("disabled", record)
        self.assertIn("Recording: off.", self.html)
        self.assertIn("Consent is off.", self.html)
        self.assertIn('data-feedback="heard"', self.html)
        blob = self.html + self.js
        self.assertIn("getUserMedia", self.js)
        self.assertIn("new root.MediaRecorder", self.js)
        self.assertIn("navigator.sendBeacon", self.js)
        self.assertIn("echoCancellation", self.js)
        self.assertIn('id="consent-modal"', self.html)
        self.assertNotIn("LIVEKIT_API", blob)

    def test_feedback_beacon_is_sent(self):
        blob = self.html + self.js
        self.assertIn("navigator.sendBeacon", self.js)
        self.assertIn('GATEWAY + "feedback"', self.js)
        self.assertNotIn("/conference/feedback", blob)
        self.assertIn("Beacon sent.", self.html)
        self.assertIn("has not confirmed storage", self.html)
        self.assertNotIn("Receipt confirmed", blob)
        self.assertIn("already issues the room token", self.html)
        self.assertIn('id="beacon-status"', self.html)

    def test_chat_window_is_local(self):
        self.assertIn('id="room-chat"', self.main)
        self.assertIn('id="chat-text"', self.main)
        self.assertIn('aria-live="polite"', self.main)
        self.assertIn("Lines show here.", self.main)
        self.assertIn("SpeechRecognition", self.js)
        self.assertIn("function chatLine", self.js)

    def test_wait_strip_stays_local_and_empty(self):
        self.assertIn('id="wait-play"', self.main)
        self.assertIn('data-wait="tap"', self.main)
        self.assertIn("Clip slot is empty.", self.main)
        self.assertNotIn("<video", self.html.lower())
        self.assertNotIn("<iframe", self.html.lower())
        self.assertNotIn("friends", self.main.lower())

    def test_note_update_is_a_chalk_placeholder(self):
        self.assertIn("youtube.com/watch?v=sMyh4C8SaTM", self.html)
        self.assertIn("@keyframes chalk-write", self.html)
        self.assertIn("prefers-reduced-motion", self.html)
        self.assertIn('classList.add("chalk")', self.js)

    def test_claude_board_is_a_small_strip(self):
        self.assertIn('id="claude-board"', self.main)
        self.assertIn("Claude handoff", self.main)
        for label in ("Key issues", "Discussion notes", "Action items", "Next steps"):
            self.assertIn(f"<b>{label}</b>", self.main)
        self.assertEqual(self.main.count("None on this page."), 4)
        self.assertIn('class="board-rail"', self.main)
        self.assertIn("var(--paper)", self.html)
        self.assertIn("var(--accent)", self.html)
        self.assertNotIn("#1e3a32", self.html)
        self.assertNotIn("mermaid", self.html.lower())
        self.assertNotIn("100vh", self.html)
        self.assertNotIn("min-height:100", self.html)

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

    def test_the_page_names_the_project_and_the_agent(self):
        self.assertIn('data-project="p_3p1vbksold1"', self.html)
        self.assertIn('data-agent="conference-line"', self.html)
        self.assertIn('data-slot="key_issues"', self.html)
        self.assertIn("Delay, and answers cut off.", self.js)
        self.assertIn("Sign in to join.", self.js)

    def test_room_states_and_duplex_are_on_the_page(self):
        for state in ("idle", "heard", "room-open", "agent-in-room"):
            self.assertIn(f'data-state="{state}"', self.html)
        self.assertIn('id="duplex"', self.html)
        self.assertIn('id="agent-speech"', self.html)
        self.assertIn('aria-live="assertive"', self.html)
        self.assertIn('aria-keyshortcuts="m"', self.html)
        self.assertIn('id="floor-diagram"', self.html)
        self.assertIn('id="penpot-slot"', self.html)
        self.assertIn("Four voices, one floor", self.html)
        self.assertIn("48 kHz requested", self.html)
        self.assertIn("700 ms", self.html)
        self.assertIn("800 ms", self.html)
        self.assertIn("Deepgram stays on the agent worker.", self.html)
        room = ROOM.read_text(encoding="utf-8")
        self.assertIn("LiveKit", room)
        self.assertIn("echoCancellation: true", room)
        self.assertIn("sampleRate: SAMPLE_RATE", room)
        self.assertIn("IDLE_MS = 5 * 60 * 1000", room)
        self.assertIn("FILLER_MS = 700", room)
        self.assertIn("function sanitizeMermaid", room)
        self.assertIn("function sanitizeSvg", room)
        self.assertIn("design.penpot.app", room)
        self.assertNotIn("DEEPGRAM", room.upper())

    def test_create_page_is_separate_and_has_no_host_code(self):
        create = CREATE.read_text(encoding="utf-8")
        create_js = CREATE_JS.read_text(encoding="utf-8")
        self.assertIn('content="noindex"', create)
        self.assertIn("Assessment, automation, and AI enablement.", create)
        self.assertIn(">Guest Name", create)
        self.assertIn(">Guest Email", create)
        self.assertIn(">Agent reference name", create)
        self.assertIn('id="agent-reference"', create)
        self.assertIn('placeholder="Dr. Yasmine / Mr. Salam"', create)
        self.assertRegex(create, r'id="agent-reference"[^>]*\brequired\b')
        self.assertIn("How agents address them on the floor.", create)
        self.assertIn(">Conference Objective", create)
        self.assertIn('id="host-code"', create)
        self.assertIn("This page does not keep it.", create)
        self.assertIn("One joiner.", create)
        self.assertIn('href="https://portal.sfdc24.com/"', create)
        self.assertIn("Experience Cloud is not required.", create)
        self.assertIn("The room is LiveKit, not inside Salesforce.", create)
        self.assertIn("No sign-in is required.", create)
        self.assertIn("Nothing is emailed.", create)
        room = (ROOT / "conference" / "room" / "index.html").read_text(encoding="utf-8")
        self.assertIn("Assessment, automation, and AI enablement.", room)
        self.assertIn("Not inside Salesforce.", room)
        self.assertIn("Internal testing only.", room)
        self.assertNotIn("<iframe", room.lower())
        self.assertNotIn("okf", room.lower())
        self.assertIn("Event queued on this gate. Salesforce has not stored it.", create_js)
        self.assertIn("Salesforce accepted the Event.", create_js)
        self.assertIn('id="invite-draft"', create)
        self.assertIn("Invite draft", create)
        self.assertIn("Nothing was sent.", create)
        self.assertIn("Keep draft", create)
        self.assertNotIn("Confirm send", create)
        self.assertIn("Internal testing only.", create)
        self.assertIn("does not email the guest", create)
        self.assertNotIn("send it to that person", create_js)
        self.assertIn("does not create a calendar invite", create)
        self.assertIn("There is no clock time on this draft.", create)
        self.assertIn("function inviteSentence", create_js)
        self.assertNotIn("/v1/invites", create_js)
        self.assertNotIn("mail hook accepted", create_js)
        self.assertNotIn("<iframe", create.lower())
        banned = "Black" + "board" + "Master"
        blob = ""
        for path in CLIENTS:
            text = path.read_text(encoding="utf-8")
            blob += text
            self.assertNotIn(banned, text, path.name)
            self.assertNotIn("blackboard", text.lower(), path.name)
            for needle in ("API_KEY", "SECRET", "LIVEKIT_API", "BEGIN PRIVATE", "BEGIN RSA"):
                self.assertNotIn(needle, text, path.name)
        self.assertNotIn("okf", blob.lower())
        self.assertIn("function joinLink", create_js)


if __name__ == "__main__":
    unittest.main()
