"""Public /conferences page: a handoff to the Converspan room, nothing else."""
from __future__ import annotations

import html
import re
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
# Page weight on 2026-10-18, before motion gating, at
# cursor/conferences-share-card-6824 @ 383ebb4:
#   conferences/index.html                         34,974
#   page CSS and JS (ready, flow, faq, invite)     30,562
#   conferences/og.png (share card, local file)   113,179
#   baseline                                       178,715
# Ceiling is that baseline plus about 15% headroom.
# 178715 * 1.15 = 205522, rounded up to 206000 (~15.3%).
# Later passes raised this number. The owner put the original ceiling back.
BASELINE_WEIGHT = 178715
PAGE_BUDGET = 206000
# Visible words inside <main> on 2026-10-18, before the less-text pass: 161.
# A third off that count is 107. The shorter page stays at or under that.
BEFORE_BODY_WORDS = 161
BODY_WORD_BUDGET = 107


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
        self.assertIn("No name", self.text)
        self.assertIn("No company", self.text)

    def test_consent_is_plain(self):
        facts = self.text.split('class="facts"', 1)[1].split('id="conference-faq"', 1)[0]
        self.assertIn("Consent", facts)
        self.assertIn("PIPEDA", facts)
        self.assertIn("CRTC", facts)
        self.assertIn("No mic", facts)
        self.assertIn("No transcript", facts)
        self.assertIn("No recording", facts)
        self.assertIn("No session", facts)
        self.assertIn("No name", facts)
        self.assertIn("No company", facts)
        self.assertIn("No dial", facts)
        self.assertIn("Brochure", facts)
        self.assertIn('href="/conference/"', facts)
        self.assertIn(">Conference</a>", facts)
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
        for label in ("Start", "Room", "Summary"):
            self.assertIn(f">{label}</span>", self.text)
        self.assertLess(self.text.index('class="label">Start</span>'), self.text.index('id="conference-start"'))
        self.assertIn("IntersectionObserver", self.text)
        self.assertIn("prefers-reduced-motion:reduce", self.text.replace(" ", ""))
        self.assertIn("animation:none", self.text.replace(" ", ""))
        self.assertNotIn("Start and Join both open the Converspan room.", self.text)
        self.assertIn("No session", self.text)

    def test_host_and_join_are_two_cards(self):
        self.assertIn('class="pick pick-host"', self.text)
        self.assertIn('class="pick pick-join"', self.text)
        self.assertIn(">Host</p>", self.text)
        self.assertIn(">Join</p>", self.text)
        self.assertIn(">Open</p>", self.text)
        self.assertIn(">Enter</p>", self.text)
        self.assertIn('aria-label="Host Open the room. Start"', self.text)
        self.assertIn('aria-label="Join Enter the room. Join"', self.text)
        host = self.text.split('class="pick pick-host"', 1)[1].split('class="pick pick-join"', 1)[0]
        join = self.text.split('class="pick pick-join"', 1)[1].split('id="conference-invite"', 1)[0]
        self.assertIn('id="conference-start"', host)
        self.assertIn(">Start</a>", host)
        self.assertNotIn('id="conference-join"', host)
        self.assertIn('id="conference-join"', join)
        self.assertIn(">Join</a>", join)
        self.assertEqual(self.text.count(f'href="{ROOM}"'), 2)
        flat = self.text.replace(" ", "").replace("\n", "")
        self.assertIn("@media(min-width:361px)", flat)
        self.assertIn(".pick,.pick:hover,.pick:focus-within{animation:none;transition:none;transform:none}", flat)
        self.assertNotIn("@keyframes pick", flat)
        self.assertNotIn("getUserMedia", host + join)

    def test_room_mock_is_silent_and_static_without_motion(self):
        self.assertIn('id="conference-stage"', self.text)
        self.assertIn(
            'aria-label="Converspan room. Objectives: Open the brief, Mark the aim, Draw the path."',
            self.text,
        )
        self.assertIn('role="img"', self.text.split('id="conference-stage"', 1)[1].split(">", 1)[0])
        self.assertLess(self.text.index('id="conference-how"'), self.text.index('id="conference-stage"'))
        self.assertLess(self.text.index('id="conference-stage"'), self.text.index('id="conference-start"'))
        self.assertIn(">Room</p>", self.text)
        for label in ("Brief", "Aim", "Path"):
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
        for label in ("Brief", "Next", "Map"):
            self.assertIn(f">{label}</li>", self.text)
        self.assertLess(self.text.index('id="conference-stage"'), self.text.index('id="conference-recap"'))
        self.assertLess(self.text.index('id="conference-recap"'), self.text.index('id="conference-start"'))
        recap = self.text.split('id="conference-recap"', 1)[1].split('id="conference-start"', 1)[0]
        self.assertIn('aria-hidden="true"', recap)
        motion = self._motion_script()
        self.assertIn("IntersectionObserver", motion)
        self.assertIn("visibilitychange", motion)
        self.assertIn("document.hidden", motion)
        self.assertIn('addEventListener("change"', motion)
        self.assertIn('id==="conference-recap"', motion)
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
        self.assertIn(">Ready</h2>", self.text)
        self.assertIn("Mic after join.", self.text)
        self.assertIn('src="/conferences/ready.js"', self.text)
        self.assertIn('href="/conferences/ready.css"', self.text)
        self.assertLess(self.text.index('id="conference-join"'), self.text.index('id="conference-ready"'))
        self.assertLess(self.text.index('id="conference-ready"'), self.text.index('class="facts"'))
        self.assertIn("No microphone here.", self.text)
        self.assertIn("No transcript", self.text)
        self.assertIn("No recording", self.text)
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
        self.assertLess(self.text.index('id="conference-flow"'), self.text.index("<main"))
        self.assertIn('aria-label="Go to Start"', self.text)
        self.assertIn('role="group" aria-label="Start or join"', self.text)

    def test_faq_is_a_local_accordion(self):
        self.assertIn('id="conference-faq"', self.text)
        self.assertIn('href="/conferences/faq.css"', self.text)
        self.assertIn('src="/conferences/faq.js"', self.text)
        self.assertIn(">Questions</h2>", self.text)
        self.assertLess(self.text.index('class="facts"'), self.text.index('id="conference-faq"'))
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
            "The Converspan room.",
            "No microphone here.",
            "Converspan, with consent.",
            "The sample recap.",
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
        self.assertIn(">Invite</span>", self.text)
        self.assertIn('aria-label="Invite a guest"', self.text)
        self.assertIn('id="conference-invite-toast"', self.text)
        self.assertIn('aria-live="polite"', self.text)
        self.assertIn('id="conference-invite-link"', self.text)
        self.assertIn('role="textbox"', self.text)
        self.assertIn('aria-readonly="true"', self.text)
        self.assertIn('aria-label="Converspan room link"', self.text)
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
        self.assertIn("selectField", js)
        self.assertIn("preventDefault", js)
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

    def _motion_script(self):
        match = re.search(r'<script type="module">(.*?)</script>', self.text, re.S)
        self.assertIsNotNone(match, "motion controller should be one deferred module")
        return match.group(1)

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

    def test_motion_pauses_offscreen_and_falls_back_still(self):
        self.assertIn('list.classList.add("is-still")', self.text)
        self.assertIn("is-held", self.text)
        motion = self._motion_script()
        self.assertIn("visibilitychange", motion)
        self.assertIn("document.hidden", motion)
        self.assertIn("requestAnimationFrame", motion)
        self.assertLess(
            motion.index('typeof IntersectionObserver!="function"'),
            motion.index('list.classList.add("is-still")'),
        )
        self.assertLess(
            motion.index('list.classList.add("is-still")'),
            motion.index('stage.classList.add("is-armed")'),
        )
        self.assertLess(
            motion.index('typeof IntersectionObserver!="function"'),
            motion.index('card.classList.add("is-armed")'),
        )
        self.assertLess(motion.index("requestAnimationFrame"), motion.index('stage.classList.add("is-armed")'))
        for needle in (
            "getUserMedia(", "new RTCPeerConnection", "new webkitRTCPeerConnection",
            "new AudioContext", "new webkitAudioContext", "new WebSocket",
            "fetch(", "sendBeacon(", "XMLHttpRequest",
        ):
            self.assertNotIn(needle, motion)
        flat = self.text.replace(" ", "").replace("\n", "")
        self.assertIn("html.js.stage.is-armed.ring{animation:halo", flat)
        self.assertIn("html.js.recap.is-armed.fold{animation:rec-fold", flat)
        self.assertIn("html.js.how.is-held.is-in.step{animation-play-state:paused}", flat)
        self.assertIn("html.js.how.is-still.step:nth-child(n){animation:none;opacity:1;transform:none}", flat)
        for name in ("ready.js", "flow.js", "faq.js", "invite.js", "lobby.js", "goals.js"):
            js = (PAGE.parent / name).read_text(encoding="utf-8")
            self.assertIn("visibilitychange", js)
            self.assertIn("IntersectionObserver", js)
            for needle in (
                "getUserMedia(", "new RTCPeerConnection", "new webkitRTCPeerConnection",
                "new AudioContext", "new webkitAudioContext", "new WebSocket",
                "fetch(", "sendBeacon(", "XMLHttpRequest",
            ):
                self.assertNotIn(needle, js, name)
        ready = (PAGE.parent / "ready.js").read_text(encoding="utf-8")
        self.assertLess(ready.index("typeof IntersectionObserver"), ready.index('classList.add("is-still")'))
        self.assertIn("is-held", ready)
        css = (PAGE.parent / "ready.css").read_text(encoding="utf-8").replace(" ", "").replace("\n", "")
        self.assertIn("html.js.ready.is-held.ready-chip:nth-child(n){animation-play-state:paused}", css)
        self.assertIn("html.js.ready.is-still.ready-chip:nth-child(n){animation:none;opacity:1;transform:none", css)
        invite = (PAGE.parent / "invite.css").read_text(encoding="utf-8").replace(" ", "").replace("\n", "")
        self.assertIn(".invite-pop.is-held.invite-chip{animation-play-state:paused}", invite)
        self.assertIn(".invite-pop.is-still.is-on.invite-chip{animation:none;opacity:1;transform:none}", invite)
        flow = (PAGE.parent / "flow.css").read_text(encoding="utf-8").replace(" ", "").replace("\n", "")
        self.assertIn(".flowbar.is-held.flowbar-in{animation-play-state:paused}", flow)

    def test_graphics_keep_their_box_and_images_stay_lazy(self):
        main = self.text.split("<footer", 1)[0]
        svgs = re.findall(r"<svg\b[^>]*>", main)
        self.assertGreaterEqual(len(svgs), 8)
        for tag in svgs:
            width = re.search(r'\swidth="(\d+)"', tag)
            height = re.search(r'\sheight="(\d+)"', tag)
            self.assertIsNotNone(width, tag)
            self.assertIsNotNone(height, tag)
            self.assertGreater(int(width.group(1)), 0)
            self.assertGreater(int(height.group(1)), 0)
        self.assertIn('class="web" viewBox="0 0 200 168" aria-hidden="true" width="200" height="168"', main)
        self.assertIn('class="seal" viewBox="0 0 72 64" focusable="false" width="72" height="64"', main)
        for tag in re.findall(r"<img\b[^>]*>", main, flags=re.I):
            self.assertIn('loading="lazy"', tag)
            self.assertRegex(tag, r'\swidth="\d+"')
            self.assertRegex(tag, r'\sheight="\d+"')
            self.assertNotIn('loading="eager"', tag)
        self.assertNotIn('rel="preload"', self.text)
        footer = self.text.split("<footer", 1)[1]
        self.assertIn('<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">', footer)

    def test_focus_rings_and_start_hover_are_explicit(self):
        flat = self.text.replace(" ", "").replace("\n", "")
        self.assertIn("a.go:not(.quiet):hover,a.go:not(.quiet):active{color:#fff}", flat)
        self.assertIn(
            "a.chrome-mark:focus-visible,.chrome-menunava:focus-visible{outline:2pxsolid#8FC7FF;outline-offset:3px}",
            flat,
        )
        self.assertIn("outline-color:Highlight", flat)

    def test_phone_card_qr_opens_the_conferences_page(self):
        url = "https://sfdc24.com/conferences/"
        self.assertIn('id="conference-phone"', self.text)
        self.assertIn(">Phone</span>", self.text)
        self.assertIn(f'href="{url}"', self.text)
        self.assertIn(f'alt="QR code that opens {url}"', self.text)
        self.assertIn('src="/conferences/phone.svg"', self.text)
        self.assertIn('loading="lazy"', self.text.split('class="phone-qr"', 1)[1].split(">", 1)[0])
        self.assertLess(self.text.index('id="conference-join"'), self.text.index('id="conference-phone"'))
        self.assertLess(self.text.index('id="conference-phone"'), self.text.index('id="conference-invite"'))
        self.assertEqual(self.text.count(f'href="{ROOM}"'), 2)
        self.assertIn("not affiliated with, endorsed by, or sponsored by Salesforce", self.text)
        for needle in ("api.qrserver.com", "chart.googleapis.com", "quickchart.io"):
            self.assertNotIn(needle, self.text)
        css = (PAGE.parent / "phone.css").read_text(encoding="utf-8")
        flat = css.replace(" ", "").replace("\n", "")
        self.assertIn("@media(max-width:720px){.phone{display:none}}", flat)
        self.assertIn("prefers-reduced-motion:reduce", flat)
        self.assertIn("prefers-reduced-motion:no-preference", flat)
        self.assertIn("html.js.phone.is-armed.phone-frame{animation:phone-frame", flat)
        self.assertIn("html.js.phone.is-live.phone-frame{animation-play-state:running}", flat)
        self.assertIn(".phone-frame{animation:none;opacity:.72;transform:none}", flat)
        self.assertIn("min-height:48px", flat)
        self.assertIn("min-width:48px", flat)
        frame = flat.split("@keyframesphone-frame{", 1)[1].split("@media", 1)[0]
        self.assertIn("0%,100%{opacity:.38;transform:scale(1)}", frame)
        self.assertIn("50%{opacity:.95;transform:scale(1.015)}", frame)
        self.assertNotIn("box-shadow", frame)
        self.assertNotIn("filter", frame)
        motion = self._motion_script()
        self.assertLess(
            motion.index('typeof IntersectionObserver!="function"'),
            motion.index('phone.classList.add("is-armed")'),
        )
        self.assertIn("visibilitychange", motion)
        self.assertIn("document.hidden", motion)
        self.assertIn('id==="conference-phone"', motion)
        lobby_js = (PAGE.parent / "lobby.js").read_text(encoding="utf-8")
        self.assertLess(
            lobby_js.index('typeof IntersectionObserver !== "function") return;'),
            lobby_js.index('card.classList.add("is-armed")'),
        )
        svg = (PAGE.parent / "phone.svg").read_text(encoding="utf-8")
        self.assertEqual(decode_qr_svg(svg), url)

    def test_sample_lobby_is_a_local_preview(self):
        self.assertIn('id="conference-lobby"', self.text)
        self.assertIn('href="/conferences/lobby.css"', self.text)
        self.assertIn('src="/conferences/lobby.js"', self.text)
        self.assertIn(">Sample lobby</p>", self.text)
        self.assertIn('aria-labelledby="conference-lobby-kicker"', self.text)
        self.assertIn('aria-label="Waiting for your host"', self.text)
        self.assertIn(">Waiting</p>", self.text)
        self.assertIn('id="conference-lobby-status"', self.text)
        self.assertIn('role="status"', self.text)
        self.assertIn('aria-live="polite"', self.text)
        self.assertIn(">0:00</span>", self.text)
        self.assertIn(">Elapsed </span>", self.text)
        for tip in (
            "Your host opens the room.",
            "This preview does not join.",
            "Nothing here is recorded.",
        ):
            self.assertIn(f'aria-label="{tip}"', self.text)
        for tip in ("Host opens", "Preview only", "Not recorded"):
            self.assertIn(f">{tip}</p>", self.text)
        self.assertLess(self.text.index('id="conference-join"'), self.text.index('id="conference-lobby"'))
        self.assertLess(self.text.index('id="conference-lobby"'), self.text.index('id="conference-phone"'))
        self.assertEqual(self.text.count(f'href="{ROOM}"'), 2)
        self.assertIn("not affiliated with, endorsed by, or sponsored by Salesforce", self.text)
        lobby = self.text.split('id="conference-lobby"', 1)[1].split('id="conference-phone"', 1)[0]
        self.assertIn('aria-hidden="true"', lobby)
        self.assertNotIn("<audio", lobby.lower())
        self.assertNotIn("<video", lobby.lower())
        self.assertNotIn("getUserMedia", lobby)
        self.assertNotIn("fetch(", lobby)
        self.assertNotIn(f'href="{ROOM}"', lobby)
        js = (PAGE.parent / "lobby.js").read_text(encoding="utf-8")
        css = (PAGE.parent / "lobby.css").read_text(encoding="utf-8")
        self.assertIn("setInterval", js)
        self.assertIn("visibilitychange", js)
        self.assertIn("document.hidden", js)
        self.assertIn('addEventListener("change"', js)
        self.assertLess(
            js.index('typeof IntersectionObserver !== "function") return;'),
            js.index('card.classList.add("is-armed")'),
        )
        for needle in (
            "getUserMedia", "RTCPeerConnection", "AudioContext", "WebSocket",
            "fetch(", "XMLHttpRequest", "sendBeacon", "EventSource",
            "requestAnimationFrame", "LiveKit", "token", "converspan.com/room",
        ):
            self.assertNotIn(needle, js)
        flat = css.replace(" ", "").replace("\n", "")
        self.assertIn("prefers-reduced-motion:reduce", flat)
        self.assertIn("prefers-reduced-motion:no-preference", flat)
        self.assertIn(".lobby-ring,.lobby-core,.lobby-beat,.lobby-tip{animation:none;transition:none;transform:none}", flat)
        self.assertIn("html.js.lobby.is-armed.lobby-ring{animation:lobby-halo", flat)
        self.assertIn("html.js.lobby.is-live.lobby-ring,", flat)
        self.assertIn("animation-play-state:running", flat)
        self.assertIn("width:48px;height:48px", flat)
        self.assertIn("transition:opacity.4sease,transform.4sease", flat)
        for name in ("lobby-halo", "lobby-core", "lobby-beat"):
            body = flat.split("@keyframes" + name + "{", 1)[1].split("}", 1)[0]
            props = re.findall(r"([a-z-]+):", body)
            self.assertGreater(len(props), 0, name)
            for prop in props:
                self.assertIn(prop, ("transform", "opacity"), name)
        self.assertNotIn("box-shadow", flat.split("@keyframeslobby-halo", 1)[1].split("@media", 1)[0])

    def test_sample_objectives_tracker_is_a_local_preview(self):
        self.assertIn('id="conference-goals"', self.text)
        self.assertIn('href="/conferences/goals.css"', self.text)
        self.assertIn('src="/conferences/goals.js"', self.text)
        self.assertIn(">Sample objectives</span>", self.text)
        self.assertIn('aria-labelledby="conference-goals-kicker"', self.text)
        self.assertIn('id="conference-goals-live" aria-live="polite"></p>', self.text)
        self.assertIn('id="conference-goals-num">4</span> of 4', self.text)
        for label in ("Scope", "Owner", "Next step", "Outcome"):
            self.assertIn(f'{label}<span class="sr">, done</span>', self.text)
        self.assertLess(self.text.index('id="conference-lobby"'), self.text.index('id="conference-goals"'))
        self.assertLess(self.text.index('id="conference-goals"'), self.text.index('id="conference-phone"'))
        self.assertEqual(self.text.count(f'href="{ROOM}"'), 2)
        card = self.text.split('id="conference-goals"', 1)[1].split('id="conference-phone"', 1)[0]
        self.assertNotIn("<audio", card.lower())
        self.assertNotIn("<video", card.lower())
        self.assertNotIn("getUserMedia", card)
        self.assertNotIn("fetch(", card)
        self.assertNotIn(f'href="{ROOM}"', card)
        self.assertNotIn("<a ", card)
        self.assertNotIn("<button", card)
        js = (PAGE.parent / "goals.js").read_text(encoding="utf-8")
        css = (PAGE.parent / "goals.css").read_text(encoding="utf-8")
        self.assertIn("visibilitychange", js)
        self.assertIn("document.hidden", js)
        self.assertIn('addEventListener("change"', js)
        self.assertLess(
            js.index('typeof IntersectionObserver!="function"){still();return}'),
            js.index('el.classList.add("is-armed")'),
        )
        for needle in (
            "getUserMedia", "RTCPeerConnection", "AudioContext", "WebSocket",
            "fetch(", "XMLHttpRequest", "sendBeacon", "EventSource",
            "requestAnimationFrame", "LiveKit", "token", "converspan.com/room",
        ):
            self.assertNotIn(needle, js)
        flat = css.replace(" ", "").replace("\n", "")
        self.assertIn("prefers-reduced-motion:reduce", flat)
        self.assertIn("prefers-reduced-motion:no-preference", flat)
        self.assertIn(".goal::before,.goal::after{animation:none;transition:none}", flat)
        self.assertIn("html.js.goals.is-armed.is-lit::before{animation:gp", flat)
        self.assertIn("html.js.goals.is-live.is-lit::before{animation-play-state:running}", flat)
        self.assertIn("html.js.goals.is-live.goal::after{transition:transform.4s}", flat)
        body = flat.split("@keyframesgp{", 1)[1].split("}", 1)[0]
        props = re.findall(r"([a-z-]+):", body)
        self.assertGreater(len(props), 0)
        for prop in props:
            self.assertIn(prop, ("transform", "opacity"))

    def test_one_phone_bar_and_one_room_path(self):
        self.assertNotIn('id="conference-dock"', self.text)
        self.assertNotIn("Host a conference", self.text)
        self.assertNotIn("Join a conference", self.text)
        self.assertNotIn("dock-host", self.text)
        self.assertNotIn("dock-on", self.text)
        self.assertEqual(self.text.count(f'href="{ROOM}"'), 2)
        self.assertIn('id="conference-start"', self.text)
        self.assertIn('id="conference-join"', self.text)
        self.assertIn("is-quiet", self.text)
        self.assertIn("not affiliated with, endorsed by, or sponsored by Salesforce", self.text)
        css = (PAGE.parent / "flow.css").read_text(encoding="utf-8")
        js = (PAGE.parent / "flow.js").read_text(encoding="utf-8")
        flat = css.replace(" ", "").replace("\n", "")
        self.assertNotIn("conference-dock", flat)
        self.assertNotIn("dock-on", flat)
        self.assertNotIn("--dock-h", flat)
        self.assertIn("env(safe-area-inset-bottom)", flat)
        self.assertIn("prefers-reduced-motion:reduce", flat)
        self.assertIn("prefers-reduced-motion:no-preference", flat)
        self.assertIn("@media(min-width:721px)", flat)
        self.assertIn("#conference-flow{display:none!important}", flat)
        self.assertIn("@media(max-width:720px)", flat)
        self.assertIn("body.flow-on{overflow-anchor:none;padding-bottom:calc(65px+env(safe-area-inset-bottom))}", flat)
        self.assertIn("min-height:48px", flat)
        self.assertIn("outline:2pxsolid#8FC7FF;outline-offset:4px", flat)
        self.assertIn("scroll-margin-bottom:5.5rem", flat)
        self.assertNotIn("conference-dock", js)
        self.assertIn("flow-on", js)
        self.assertIn("IntersectionObserver", js)
        self.assertNotIn('addEventListener("scroll"', js)
        self.assertNotIn("addEventListener('scroll'", js)
        for needle in (
            "fetch(", "WebSocket", "XMLHttpRequest", "sendBeacon", "EventSource",
            "setTimeout", "setInterval", "requestAnimationFrame", "getUserMedia",
        ):
            self.assertNotIn(needle, js)

    def test_room_transition_is_a_short_local_handoff(self):
        self.assertIn('id="conference-enter"', self.text)
        self.assertIn('class="enter" aria-hidden="true"', self.text)
        self.assertLess(self.text.index("</footer>"), self.text.index('id="conference-enter"'))
        self.assertLess(self.text.index('id="conference-enter"'), self.text.index('src="/conferences/enter.js"'))
        main = self.text.split("<main", 1)[1].split("</main>", 1)[0]
        footer = self.text.split("<footer", 1)[1].split("</footer>", 1)[0]
        self.assertNotIn("conference-enter", main)
        self.assertNotIn("conference-enter", footer)
        self.assertIn("not affiliated with, endorsed by, or sponsored by Salesforce", footer)
        noscript = self.text.split("<noscript>", 1)[1].split("</noscript>", 1)[0]
        self.assertNotIn("enter.css", noscript)
        tag = re.search(r'<link rel="stylesheet" href="/conferences/enter.css"[^>]*>', self.text)
        self.assertIsNotNone(tag)
        self.assertIn('media="print"', tag.group(0))
        self.assertIn("this.media='all'", tag.group(0))
        self.assertIn('src="/conferences/enter.js" defer', self.text)
        self.assertEqual(self.text.count(f'href="{ROOM}"'), 2)
        self.assertIn(">Start</a>", self.text)
        self.assertIn(">Join</a>", self.text)
        js = (PAGE.parent / "enter.js").read_text(encoding="utf-8")
        css = (PAGE.parent / "enter.css").read_text(encoding="utf-8")
        self.assertEqual(js.count(ROOM), 1)
        self.assertIn("preventDefault", js)
        self.assertIn("animationend", js)
        self.assertIn("pageshow", js)
        self.assertIn("prefers-reduced-motion: reduce", js)
        self.assertIn("forced-colors: active", js)
        self.assertIn("var CAP = 450;", js)
        self.assertIn("setTimeout(nav, CAP)", js)
        self.assertIn('getAttribute("href") !== ROOM', js)
        self.assertLess(js.index("event.preventDefault()"), js.index("go(link.href)"))
        for needle in (
            "fetch(", "WebSocket", "XMLHttpRequest", "sendBeacon", "EventSource",
            "getUserMedia", "RTCPeerConnection", "AudioContext", "http://",
        ):
            self.assertNotIn(needle, js)
            self.assertNotIn(needle, css)
        self.assertNotIn("https://", css)
        flat = css.replace(" ", "").replace("\n", "")
        self.assertIn("@media(prefers-reduced-motion:no-preference){.enter{--enter-ready:1}", flat)
        self.assertIn("animation:enter-sweep400msease-in-outboth", flat)
        self.assertIn("@media(prefers-reduced-motion:reduce){.enter,.enter.is-on{animation:none;transition:none;visibility:hidden}", flat)
        self.assertIn("@media(forced-colors:active){.enter,.enter.is-on{display:none}", flat)
        self.assertIn("z-index:100", flat)

    def test_page_weight_stays_within_fifteen_percent(self):
        # Fails when /conferences/ (HTML + the page-specific CSS, JS, and
        # local images that HTML references) grows past PAGE_BUDGET.
        # Baseline 178715 bytes. Budget 206000 is about 15% headroom.
        self.assertEqual(PAGE_BUDGET, 206000)
        self.assertEqual(BASELINE_WEIGHT, 178715)
        self.assertGreaterEqual(PAGE_BUDGET, int(BASELINE_WEIGHT * 1.15))
        self.assertLessEqual(PAGE_BUDGET, int(BASELINE_WEIGHT * 1.16))
        total, parts = conferences_weight()
        names = [name for name, _size in parts]
        self.assertIn("conferences/index.html", names)
        self.assertIn("conferences/og.png", names)
        self.assertIn("conferences/ready.js", names)
        self.assertNotIn("assets/chrome.css", names)
        self.assertNotIn("assets/chrome.js", names)
        detail = ", ".join(f"{name}={size}" for name, size in parts)
        self.assertLessEqual(
            total,
            PAGE_BUDGET,
            f"{total} bytes exceeds the {PAGE_BUDGET} byte ceiling ({detail})",
        )
        self.assertGreater(total, 0)

    def test_load_stays_under_the_measured_weight_and_the_lede_cannot_reflow(self):
        # cursor/conferences-show-more-0719 before this pass, same accounting
        # as conferences_weight(): HTML plus linked conferences assets.
        # Keyboard-focus pass was 210275. The one-path pass was 212305.
        # Phone safe-area landed at 213523. The speed pass merged the
        # parser-blocking motion scripts and stopped lobby.css from blocking
        # first paint, which brought the same accounting down to 212559.
        # The less-text pass adds the dark field, gradient buttons, and
        # chip diagrams, and landed at 215348. Recompressing the share card
        # (still 1200 by 630) brings that accounting under the 206000 ceiling.
        landed = 215348
        after = 188202
        self.assertLess(after, landed)
        self.assertLessEqual(after, 206000)
        total, _parts = conferences_weight()
        self.assertEqual(total, after)
        self.assertLessEqual(total, PAGE_BUDGET)
        flat = self.text.replace(" ", "").replace("\n", "")
        self.assertIn("max-width:22rem", flat)
        self.assertNotIn("max-width:36ch", flat)
        self.assertIn("@media(max-width:720px){.phone{display:none}}", flat)
        for name in ("ready.css", "faq.css", "invite.css", "phone.css", "goals.css", "enter.css", "lobby.css"):
            tag = re.search(rf'<link rel="stylesheet" href="/conferences/{name}"[^>]*>', self.text)
            self.assertIsNotNone(tag, name)
            self.assertIn('media="print"', tag.group(0), name)
            self.assertIn("this.media='all'", tag.group(0), name)
        tag = re.search(r'<link rel="stylesheet" href="/conferences/flow.css"[^>]*>', self.text)
        self.assertIsNotNone(tag)
        self.assertNotIn("media=", tag.group(0))
        for name in ("lobby.js", "goals.js", "ready.js", "invite.js", "faq.js", "flow.js", "enter.js"):
            self.assertIn(f'src="/conferences/{name}" defer', self.text)

    def test_visible_body_text_stays_under_budget(self):
        words = visible_body_words(self.text)
        self.assertEqual(BEFORE_BODY_WORDS, 161)
        self.assertEqual(BODY_WORD_BUDGET, 107)
        self.assertLessEqual(BODY_WORD_BUDGET, BEFORE_BODY_WORDS * 2 // 3)
        self.assertLessEqual(
            len(words),
            BODY_WORD_BUDGET,
            "visible body text grew past the trim: " + " ".join(words),
        )


# Format bits already XOR-masked, in segno / ISO order: masks 0–7 for M, L, H, Q.
_FORMAT_INFO = (
    0x5412, 0x5125, 0x5e7c, 0x5b4b, 0x45f9, 0x40ce, 0x4f97, 0x4aa0,
    0x77c4, 0x72f3, 0x7daa, 0x789d, 0x662f, 0x6318, 0x6c41, 0x6976,
    0x1689, 0x13be, 0x1ce7, 0x19d0, 0x0762, 0x0255, 0x0d0c, 0x083b,
    0x355f, 0x3068, 0x3f31, 0x3a06, 0x24b4, 0x2183, 0x2eda, 0x2bed,
)
_FORMAT_LEVEL = ["M"] * 8 + ["L"] * 8 + ["H"] * 8 + ["Q"] * 8
_ALIGNMENT = (
    (6, 18), (6, 22), (6, 26), (6, 30), (6, 34), (6, 22, 38),
)
# Version 1–6, error M: data codewords. Enough to read a short URL.
_DATA_CODEWORDS_M = {1: 16, 2: 28, 3: 44, 4: 64, 5: 86, 6: 108}


def _mask_fns():
    return (
        lambda i, j: (i + j) & 1 == 0,
        lambda i, j: (i & 1) == 0,
        lambda i, j: j % 3 == 0,
        lambda i, j: (i + j) % 3 == 0,
        lambda i, j: ((i // 2) + (j // 3)) & 1 == 0,
        lambda i, j: ((i * j) % 2 + (i * j) % 3) == 0,
        lambda i, j: ((i * j) % 2 + (i * j) % 3) & 1 == 0,
        lambda i, j: (((i + j) & 1) + ((i * j) % 3)) & 1 == 0,
    )


def _reserved(n):
    version = (n - 17) // 4
    res = [[False] * n for _ in range(n)]
    for r0, c0 in ((0, 0), (0, n - 8), (n - 8, 0)):
        for r in range(8):
            for c in range(8):
                res[r0 + r][c0 + c] = True
    for i in range(n):
        res[6][i] = True
        res[i][6] = True
    if version >= 2:
        positions = _ALIGNMENT[version - 2]
        skip = {
            (positions[0], positions[0]),
            (positions[0], positions[-1]),
            (positions[-1], positions[0]),
        }
        for x in positions:
            for y in positions:
                if (x, y) in skip:
                    continue
                for r in range(5):
                    for c in range(5):
                        res[x - 2 + r][y - 2 + c] = True
    for i in range(9):
        res[8][i] = True
        res[i][8] = True
    for i in range(8):
        res[8][n - 1 - i] = True
        res[n - 1 - i][8] = True
    res[n - 8][8] = True
    return res


def _decode_matrix(matrix):
    n = len(matrix)
    version = (n - 17) // 4
    if version not in _DATA_CODEWORDS_M or len(matrix[0]) != n:
        raise AssertionError(f"unsupported QR matrix {n}")
    bits = 0
    for i in range(8):
        bits |= (matrix[8][n - 1 - i] & 1) << i
    for i in range(7):
        bits |= (matrix[n - 1 - i][8] & 1) << (14 - i)
    best = min(range(len(_FORMAT_INFO)), key=lambda idx: (bits ^ _FORMAT_INFO[idx]).bit_count())
    if (bits ^ _FORMAT_INFO[best]).bit_count() > 3:
        raise AssertionError("QR format information does not match")
    if _FORMAT_LEVEL[best] != "M":
        raise AssertionError(f"QR error level is {_FORMAT_LEVEL[best]}")
    mask = _mask_fns()[best % 8]
    reserved = _reserved(n)
    stream = []
    for right in range(n - 1, 0, -2):
        if right <= 6:
            right -= 1
        for vertical in range(n):
            for z in range(2):
                col = right - z
                upwards = (right & 2) == 0
                upwards ^= col < 6
                row = (n - 1 - vertical) if upwards else vertical
                if reserved[row][col]:
                    continue
                stream.append((matrix[row][col] & 1) ^ (1 if mask(row, col) else 0))
    data_bytes = []
    width = _DATA_CODEWORDS_M[version] * 8
    for i in range(0, width, 8):
        value = 0
        for bit in stream[i:i + 8]:
            value = (value << 1) | bit
        data_bytes.append(value)
    mode = 0
    for bit in stream[:4]:
        mode = (mode << 1) | bit
    if mode != 0b0100:
        raise AssertionError(f"QR mode is {mode:04b}")
    count = 0
    for bit in stream[4:12]:
        count = (count << 1) | bit
    raw = []
    start = 12
    for i in range(count):
        value = 0
        for bit in stream[start + i * 8:start + (i + 1) * 8]:
            value = (value << 1) | bit
        raw.append(value)
    return bytes(raw).decode("iso-8859-1")


def decode_qr_svg(text):
    """Decode a quiet-zone SVG of horizontal black runs into its byte payload."""
    view = re.search(r'viewBox="0 0 (\d+) (\d+)"', text)
    if not view or view.group(1) != view.group(2):
        raise AssertionError("QR SVG viewBox is not square")
    size = int(view.group(1))
    path = re.search(r'<path fill="#000" d="([^"]+)"', text)
    if not path:
        raise AssertionError("QR SVG has no black modules")
    grid = [[0] * size for _ in range(size)]
    found = 0
    for x, y, w in re.findall(r"M(\d+) (\d+)h(\d+)v1H\1z", path.group(1)):
        x, y, w = int(x), int(y), int(w)
        found += 1
        for col in range(x, x + w):
            grid[y][col] = 1
    if not found:
        raise AssertionError("QR SVG path did not rasterize")
    rows = [i for i in range(size) if any(grid[i])]
    cols = [j for j in range(size) if any(grid[i][j] for i in range(size))]
    matrix = [row[cols[0]:cols[-1] + 1] for row in grid[rows[0]:rows[-1] + 1]]
    return _decode_matrix(matrix)


def visible_body_words(page_html):
    """Words a visitor can read in <main>, not scripts, icons, or hidden text."""
    main = re.search(r"<main\b[^>]*>(.*)</main>", page_html, re.S)
    if not main:
        raise AssertionError("conferences page has no main")
    body = main.group(1)
    body = re.sub(r"<script\b[^>]*>.*?</script>", " ", body, flags=re.I | re.S)
    body = re.sub(r"<style\b[^>]*>.*?</style>", " ", body, flags=re.I | re.S)
    body = re.sub(r"<svg\b[^>]*>.*?</svg>", " ", body, flags=re.I | re.S)
    body = re.sub(
        r"<(span|p)\b[^>]*class=\"(?:sr|lobby-sr)\"[^>]*>.*?</\1>",
        " ",
        body,
        flags=re.I | re.S,
    )
    body = re.sub(r"<([a-z0-9]+)\b[^>]*\shidden\b[^>]*>.*?</\1>", " ", body, flags=re.I | re.S)
    text = html.unescape(re.sub(r"<[^>]+>", " ", body))
    return re.findall(r"[A-Za-z0-9']+", text)


def conferences_weight():
    """Bytes of /conferences/ HTML plus page-specific CSS, JS, and images."""
    html = PAGE.read_text(encoding="utf-8")
    root = PAGE.parents[1]
    parts = [("conferences/index.html", PAGE.stat().st_size)]
    seen = set()
    for match in re.finditer(r'(?:href|src|content)\s*=\s*"([^"]+)"', html):
        url = match.group(1)
        path = url
        if url.startswith("https://sfdc24.com/"):
            path = url[len("https://sfdc24.com"):]
        elif url.startswith(("http://", "https://", "//")):
            continue
        if not path.startswith("/conferences/"):
            continue
        rel = path.split("?", 1)[0].split("#", 1)[0]
        if rel.endswith("/") or rel in seen:
            continue
        seen.add(rel)
        file = root / rel.lstrip("/")
        if not file.is_file():
            raise AssertionError(f"missing local asset {rel}")
        if file.suffix.lower() not in {".css", ".js", ".png", ".svg", ".jpg", ".jpeg", ".webp", ".gif", ".ico"}:
            continue
        parts.append((rel.lstrip("/"), file.stat().st_size))
    parts.sort(key=lambda item: item[0])
    return sum(size for _name, size in parts), parts


if __name__ == "__main__":
    unittest.main()
