"""Homepage owner start for the conference: one link, owner-labelled, new tab.

Only the homepage and the owner's /experience/ page may link to the gateway.

The conference gateway sits behind Google sign-in that admits only the owner, so a
link to it on a public page is an owner start, never a guest join. These checks keep
it to exactly one clearly labelled link on the homepage and nowhere else.
"""
from __future__ import annotations

import re
import unittest
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlsplit

REPO = Path(__file__).resolve().parents[1]
HOME = REPO / "index.html"
# The owner's conference experience page (owner, 2026-10-09 call) carries the one
# other owner-labelled link; tests/test_experience_page.py holds it to exactly one.
EXPERIENCE = REPO / "experience" / "index.html"
GATEWAY_ORIGIN = "https://conference-gateway-yzet4vuplq-uc.a.run.app"
SKIP_DIRS = {"node_modules", ".git", "test-results", "playwright-report"}


class _Links(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.links: list[dict] = []
        self._open: dict | None = None

    def handle_starttag(self, tag, attrs):
        if tag == "a":
            self._open = {"attrs": dict(attrs), "text": ""}
            self.links.append(self._open)

    def handle_endtag(self, tag):
        if tag == "a":
            self._open = None

    def handle_data(self, data):
        if self._open is not None:
            self._open["text"] += data


def _origin(href: str) -> str:
    parts = urlsplit(href or "")
    return f"{parts.scheme}://{parts.netloc}" if parts.scheme and parts.netloc else ""


def _gateway_links(path: Path) -> list[dict]:
    parser = _Links()
    parser.feed(path.read_text(encoding="utf-8", errors="replace"))
    return [a for a in parser.links if _origin(a["attrs"].get("href", "")) == GATEWAY_ORIGIN]


class HomepageConferenceStart(unittest.TestCase):
    def test_homepage_does_not_link_the_gateway(self):
        # The public homepage is not an owner console. The gateway link stays
        # on /experience/, which is the owner's working page.
        self.assertEqual(_gateway_links(HOME), [])

    def test_homepage_does_not_advertise_the_conference(self):
        text = HOME.read_text(encoding="utf-8")
        for banned in (
            "Start the conference",
            "Join the conference",
            "Guests are not admitted",
            "Cloud Run",
            "LiveKit",
            "OKF",
            "API_KEY",
            "SECRET",
        ):
            self.assertNotIn(banned, text)

    def test_no_other_page_links_to_gateway(self):
        offenders = []
        for page in REPO.rglob("*.html"):
            if SKIP_DIRS.intersection(page.relative_to(REPO).parts):
                continue
            if page.resolve() in (HOME.resolve(), EXPERIENCE.resolve()):
                continue
            if _gateway_links(page) or GATEWAY_ORIGIN in page.read_text(encoding="utf-8", errors="replace"):
                offenders.append(str(page.relative_to(REPO)))
        self.assertEqual(offenders, [])


class HomepageConferenceTeaser(unittest.TestCase):
    """A silent homepage card that points at /conferences/ and does not open a room."""

    def setUp(self):
        self.text = HOME.read_text(encoding="utf-8")
        self.card = self.text.split('id="host-tease"', 1)[1].split('id="voice-conversation"', 1)[0]
        self.footer = self.text.split("<footer", 1)[1].split("</footer>", 1)[0]

    def test_card_sits_under_the_hero_and_links_to_conferences(self):
        self.assertLess(self.text.index('id="quote"'), self.text.index('class="pathfig"'))
        self.assertLess(self.text.index('class="pathfig"'), self.text.index('id="host-tease"'))
        self.assertLess(self.text.index('id="host-tease"'), self.text.index("<!-- /.hero -->"))
        self.assertIn('aria-label="Live conference room"', self.card)
        self.assertIn(">Live conference room</p>", self.card)
        self.assertIn(">Start</a>", self.card)
        self.assertIn('class="aim-draw"', self.card)
        self.assertEqual(self.card.count('class="who"'), 3)
        self.assertEqual(self.card.count('href="/conferences/"'), 1)
        self.assertIn('id="host-tease-go" href="/conferences/"', self.card)
        self.assertNotIn(">Host a live conference</p>", self.card)
        self.assertNotIn(">Converspan</span>", self.card)
        self.assertNotIn("target=", self.card.split("<a ", 1)[1].split(">", 1)[0])
        self.assertNotIn("converspan.com", self.card)
        self.assertNotIn(GATEWAY_ORIGIN, self.card)
        self.assertEqual(self.footer.count('href="/conferences/"'), 1)
        self.assertIn("not affiliated with, endorsed by, or sponsored by Salesforce", self.footer)

    def test_loop_is_local_and_motion_is_transform_and_opacity_only(self):
        self.assertIn("IntersectionObserver", self.card)
        self.assertIn("visibilitychange", self.card)
        self.assertIn("document.hidden", self.card)
        self.assertIn('addEventListener("change"', self.card)
        self.assertIn("prefers-reduced-motion: reduce", self.card)
        for needle in (
            "getUserMedia", "RTCPeerConnection", "AudioContext", "webkitAudioContext",
            "WebSocket", "fetch(", "XMLHttpRequest", "sendBeacon", "EventSource",
            "new AudioContext",
        ):
            self.assertNotIn(needle, self.card)
        frames = re.findall(r"@keyframes (host-[a-z]+)\{((?:[^{}]|\{[^{}]*\})*)\}", self.text)
        self.assertEqual([name for name, _ in frames], ["host-draw", "host-pulse"])
        for name, body in frames:
            props = re.findall(r"(?:^|[{;])\s*([a-z-]+)\s*:", body)
            self.assertTrue(props, name)
            self.assertTrue(set(props) <= {"transform", "opacity"}, (name, props))
        flat = self.text.replace(" ", "").replace("\n", "")
        self.assertIn(".host-tease.is-live.who{animation-play-state:running}", flat)
        self.assertIn("prefers-reduced-motion:no-preference", flat)
        self.assertIn("prefers-reduced-motion:reduce", flat)
        self.assertIn(".host-tease.who{animation:none;transform:none}", flat)
        self.assertIn(".host-tease.who{opacity:1}", flat)


if __name__ == "__main__":
    unittest.main()
