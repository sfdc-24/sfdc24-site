"""Public /conferences page: a handoff to the Converspan room, nothing else."""
from __future__ import annotations

import struct
import unittest
from pathlib import Path

PAGE = Path(__file__).resolve().parents[1] / "conferences" / "index.html"
OG_FILE = PAGE.parent / "og.png"
ROOM = "https://converspan.com/room"
SHARE = "https://sfdc24.com/conferences/"
OG_IMAGE = "https://sfdc24.com/conferences/og.png"
SHARE_TITLE = "Live conferences in the Converspan room"
GATEWAY = "conference-gateway-yzet4vuplq-uc.a.run.app"
OG_BUDGET = 150 * 1024


def png_size(path: Path) -> tuple[int, int]:
    data = path.read_bytes()
    if data[:8] != b"\x89PNG\r\n\x1a\n" or data[12:16] != b"IHDR":
        raise AssertionError(f"{path.name} is not a PNG")
    return struct.unpack(">II", data[16:24])


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

    def test_room_mock_is_silent_and_static_without_motion(self):
        self.assertIn('id="conference-stage"', self.text)
        self.assertIn('aria-label="Converspan room"', self.text)
        self.assertLess(self.text.index('id="conference-how"'), self.text.index('id="conference-stage"'))
        self.assertLess(self.text.index('id="conference-stage"'), self.text.index('id="conference-start"'))
        self.assertIn(">Objectives</p>", self.text)
        for label in ("Open the brief", "Mark the aim", "Draw the path"):
            self.assertIn(f">{label}</span>", self.text)
        self.assertIn("visibilitychange", self.text)
        self.assertIn("document.hidden", self.text)
        self.assertIn('addEventListener("change"', self.text)
        self.assertIn("animation-play-state:running", self.text.replace(" ", ""))
        self.assertIn("prefers-reduced-motion:no-preference", self.text.replace(" ", ""))
        self.assertNotIn("<audio", self.text.lower())
        self.assertNotIn("<video", self.text.lower())
        self.assertNotIn("getUserMedia", self.text)
        self.assertNotIn("AudioContext", self.text)
        self.assertEqual(self.text.count(f'href="{ROOM}"'), 2)

    def test_sample_recap_is_after_the_room_and_still_without_motion(self):
        self.assertIn('id="conference-recap"', self.text)
        self.assertIn('role="img"', self.text)
        self.assertIn(
            'aria-label="Sample recap. Three objectives done. Next: send the brief, book next, share the map."',
            self.text,
        )
        self.assertIn(">Sample recap</p>", self.text)
        self.assertIn(">Done</span>", self.text)
        for label in ("Send brief", "Book next", "Share map"):
            self.assertIn(f">{label}</li>", self.text)
        self.assertLess(self.text.index('id="conference-stage"'), self.text.index('id="conference-recap"'))
        self.assertLess(self.text.index('id="conference-recap"'), self.text.index('id="conference-start"'))
        recap = self.text.split('id="conference-recap"', 1)[1].split('id="conference-start"', 1)[0]
        self.assertIn('aria-hidden="true"', recap)
        self.assertIn("IntersectionObserver", recap)
        self.assertIn("visibilitychange", recap)
        self.assertIn("document.hidden", recap)
        self.assertIn('addEventListener("change"', recap)
        self.assertNotIn("<audio", recap.lower())
        self.assertNotIn("<video", recap.lower())
        self.assertNotIn("getUserMedia", recap)
        flat = self.text.replace(" ", "").replace("\n", "")
        self.assertIn(".recap.fold{animation:none;opacity:0;transform:scale(.55)}", flat)
        self.assertIn("prefers-reduced-motion:reduce", flat)
        self.assertEqual(self.text.count(f'href="{ROOM}"'), 2)
        self.assertIn('data-chrome-ask="off"', self.text)

    def test_ready_check_is_local_feature_detect(self):
        self.assertIn('id="conference-ready"', self.text)
        self.assertIn(">Ready to join?</h2>", self.text)
        self.assertIn("The Converspan room asks for the mic only after you choose to join.", self.text)
        self.assertIn('src="/conferences/ready.js"', self.text)
        self.assertIn('href="/conferences/ready.css"', self.text)
        self.assertLess(self.text.index('id="conference-join"'), self.text.index('id="conference-ready"'))
        self.assertLess(self.text.index('id="conference-ready"'), self.text.index('class="note"'))
        self.assertIn("This page has no microphone and does not take a transcript.", self.text)
        self.assertNotIn("getUserMedia", self.text)
        self.assertNotIn("AudioContext", self.text)
        self.assertNotIn("RTCPeerConnection", self.text)
        js = (PAGE.parent / "ready.js").read_text(encoding="utf-8")
        css = (PAGE.parent / "ready.css").read_text(encoding="utf-8")
        self.assertNotRegex(js, r"getUserMedia\s*\(")
        self.assertIn("getUserMedia", js)
        self.assertNotIn("new RTCPeerConnection", js)
        self.assertNotIn("new webkitRTCPeerConnection", js)
        self.assertNotIn("new AudioContext", js)
        self.assertNotIn("new webkitAudioContext", js)
        self.assertNotIn("enumerateDevices", js)
        self.assertNotIn("permissions", js)
        for needle in ("fetch(", "WebSocket", "XMLHttpRequest", "sendBeacon", "EventSource", "setTimeout", "setInterval", "requestAnimationFrame"):
            self.assertNotIn(needle, js)
        for needle in ("isSecureContext", "RTCPeerConnection", "AudioContext", "navigator.onLine", "effectiveType", "pagehide", "pageshow", "IntersectionObserver"):
            self.assertIn(needle, js)
        flat = css.replace(" ", "").replace("\n", "")
        self.assertIn("prefers-reduced-motion:reduce", flat)
        self.assertIn("prefers-reduced-motion:no-preference", flat)
        self.assertIn("animation:none", flat)
        self.assertIn("min-height:48px", flat)

    def test_mobile_flow_bar_is_an_in_page_guide(self):
        self.assertIn('href="/conferences/flow.css"', self.text)
        self.assertIn('src="/conferences/flow.js"', self.text)
        self.assertIn('id="conference-flow"', self.text)
        self.assertIn('id="conference-actions"', self.text)
        self.assertIn('href="#conference-actions"', self.text)
        self.assertIn('class="flowbar-go"', self.text)
        self.assertLess(self.text.index('id="conference-actions"'), self.text.index('id="conference-start"'))
        self.assertEqual(self.text.count(f'href="{ROOM}"'), 2)
        js = (PAGE.parent / "flow.js").read_text(encoding="utf-8")
        css = (PAGE.parent / "flow.css").read_text(encoding="utf-8")
        for needle in ("IntersectionObserver", "pagehide", "pageshow", "matchMedia"):
            self.assertIn(needle, js)
        self.assertIn("prefers-reduced-motion", css)
        for needle in (
            "setTimeout", "setInterval", "requestAnimationFrame", "fetch(", "WebSocket",
            "getUserMedia", "RTCPeerConnection", "AudioContext", "converspan.com/room",
        ):
            self.assertNotIn(needle, js)
        self.assertNotIn('addEventListener("scroll"', js)
        self.assertNotIn("addEventListener('scroll'", js)
        flat = css.replace(" ", "").replace("\n", "")
        self.assertIn("env(safe-area-inset-bottom)", flat)
        self.assertIn("prefers-reduced-motion:reduce", flat)
        self.assertIn("prefers-reduced-motion:no-preference", flat)
        self.assertIn("min-height:48px", flat)
        self.assertIn("@media(min-width:721px)", flat)
        self.assertIn("max-width:720px", js.replace(" ", ""))

    def test_faq_is_a_local_accordion(self):
        self.assertIn('id="conference-faq"', self.text)
        self.assertIn('href="/conferences/faq.css"', self.text)
        self.assertIn('src="/conferences/faq.js"', self.text)
        self.assertIn(">Questions</h2>", self.text)
        self.assertLess(self.text.index('class="meta"'), self.text.index('id="conference-faq"'))
        self.assertLess(self.text.index('id="conference-faq"'), self.text.index('class="chrome-foot"'))
        self.assertLess(self.text.index('id="conference-faq"'), self.text.index("not affiliated with, endorsed by, or sponsored by Salesforce"))
        labels = (
            "Where is the room?",
            "Does this page listen?",
            "Who keeps a transcript?",
            "What is left after?",
        )
        for label in labels:
            self.assertIn(f">{label}</span>", self.text)
        self.assertEqual(self.text.count('class="faq-btn"'), 4)
        for answer in (
            "In the Converspan room. Start or Join on this page opens it.",
            "No. This page has no microphone. The Converspan room asks only after you join.",
            "The Converspan room, and only with consent. This page does not record.",
            "A short recap from the Converspan room: send the brief, book next, share the map.",
        ):
            self.assertIn(answer, self.text)
        self.assertNotIn("Start and Join both open the Converspan room.", self.text)
        self.assertEqual(self.text.count(f'href="{ROOM}"'), 2)
        js = (PAGE.parent / "faq.js").read_text(encoding="utf-8")
        css = (PAGE.parent / "faq.css").read_text(encoding="utf-8")
        for needle in (
            "getUserMedia", "RTCPeerConnection", "AudioContext", "WebSocket",
            "fetch(", "XMLHttpRequest", "sendBeacon", "EventSource",
            "setTimeout", "setInterval", "requestAnimationFrame", "converspan.com/room",
        ):
            self.assertNotIn(needle, js)
        flat = css.replace(" ", "").replace("\n", "")
        self.assertIn("prefers-reduced-motion:reduce", flat)
        self.assertIn("prefers-reduced-motion:no-preference", flat)
        self.assertIn("transition:none", flat)
        self.assertIn("animation:none", flat)
        self.assertIn("min-height:48px", flat)
        self.assertIn("grid-template-rows:0fr", flat)
        self.assertIn("grid-template-rows:1fr", flat)

    def test_invite_copies_the_room_link(self):
        self.assertIn('id="conference-invite"', self.text)
        self.assertIn('type="button"', self.text)
        self.assertIn(">Invite a guest</span>", self.text)
        self.assertIn('id="conference-invite-toast"', self.text)
        self.assertIn('aria-live="polite"', self.text)
        self.assertIn('id="conference-invite-link"', self.text)
        self.assertIn('role="textbox"', self.text)
        self.assertIn('aria-readonly="true"', self.text)
        self.assertIn('href="/conferences/invite.css"', self.text)
        self.assertIn('src="/conferences/invite.js"', self.text)
        self.assertLess(self.text.index('id="conference-join"'), self.text.index('id="conference-invite"'))
        self.assertLess(self.text.index('id="conference-invite"'), self.text.index('id="conference-ready"'))
        self.assertLess(self.text.index('id="conference-invite-toast"'), self.text.index('id="conference-ready"'))
        self.assertEqual(self.text.count(f'href="{ROOM}"'), 2)
        self.assertIn(">Start</a>", self.text)
        self.assertIn(">Join</a>", self.text)
        self.assertNotIn("<input", self.text.lower())
        self.assertIn("sfdc24.com is an independent community resource", self.text)
        self.assertIn("not affiliated with, endorsed by, or sponsored by Salesforce", self.text)
        js = (PAGE.parent / "invite.js").read_text(encoding="utf-8")
        css = (PAGE.parent / "invite.css").read_text(encoding="utf-8")
        self.assertEqual(js.count(ROOM), 1)
        self.assertIn("writeText", js)
        self.assertNotIn("readText", js)
        for needle in (
            "getUserMedia", "RTCPeerConnection", "AudioContext", "WebSocket",
            "fetch(", "XMLHttpRequest", "sendBeacon", "EventSource",
            "setTimeout", "setInterval", "requestAnimationFrame", "alert(",
        ):
            self.assertNotIn(needle, js)
        flat = css.replace(" ", "").replace("\n", "")
        self.assertIn("prefers-reduced-motion:reduce", flat)
        self.assertIn("prefers-reduced-motion:no-preference", flat)
        self.assertIn("animation:none", flat)
        self.assertIn("transition:none", flat)
        self.assertIn("min-height:48px", flat)
        self.assertIn("animation:invite-chip2.4seaseboth", flat)
        self.assertIn("10%{opacity:1;transform:none}", flat)
        self.assertIn("90%{opacity:1;transform:none}", flat)
        self.assertIn("100%{opacity:0;transform:translateY(-6px)}", flat)
        self.assertIn("transition:grid-template-rows.24sease", flat)
        self.assertEqual(round(2.4 * 0.10 * 1000), 240)

    def _content(self, token):
        self.assertIn(token, self.text)
        return self.text.split(token, 1)[1].split('"', 1)[0]

    def test_share_card_is_an_absolute_preview(self):
        self.assertIn(f"<title>{SHARE_TITLE}</title>", self.text)
        canonical = self._content('<link rel="canonical" href="')
        self.assertEqual(canonical, SHARE)
        og = {
            "og:type": "website",
            "og:url": SHARE,
            "og:title": SHARE_TITLE,
            "og:description": "Conferences run in the Converspan room. Start or join there. This page has no microphone. Recording and transcripts need consent first.",
            "og:image": OG_IMAGE,
            "og:image:width": "1200",
            "og:image:height": "630",
            "og:image:alt": "Glowing speaker rings and a waveform on a dark field. Live conferences in the Converspan room.",
        }
        for name, expected in og.items():
            self.assertEqual(self._content(f'<meta property="{name}" content="'), expected)
        twitter = {
            "twitter:card": "summary_large_image",
            "twitter:title": SHARE_TITLE,
            "twitter:description": og["og:description"],
            "twitter:image": OG_IMAGE,
        }
        for name, expected in twitter.items():
            self.assertEqual(self._content(f'<meta name="{name}" content="'), expected)
        for url in (canonical, og["og:url"], og["og:image"], twitter["twitter:image"]):
            self.assertTrue(url.startswith("https://"), url)
            self.assertFalse(url.startswith("http://"))
            self.assertFalse(url.startswith("//"))
        self.assertTrue(OG_FILE.is_file())
        self.assertEqual(png_size(OG_FILE), (1200, 630))
        self.assertLess(OG_FILE.stat().st_size, OG_BUDGET)
        self.assertGreater(OG_FILE.stat().st_size, 0)


if __name__ == "__main__":
    unittest.main()
