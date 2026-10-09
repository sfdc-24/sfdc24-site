"""/experience/: the owner's conference experience page (owner, 2026-10-09 call).

The homepage studio (voice + live canvas) opened on the conference line, with one
owner-labelled link to the voice room. The homepage keeps mounting the studio with
{} so its behaviour does not change.
"""
from __future__ import annotations

import re
import unittest
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlsplit

REPO = Path(__file__).resolve().parents[1]
PAGE = REPO / "experience" / "index.html"
HOME = REPO / "index.html"
VOICE = REPO / "assets" / "voice-conversation.js"
GATEWAY_ORIGIN = "https://conference-gateway-yzet4vuplq-uc.a.run.app"
CONTROLLER = "https://sfdc24-studio-controller-96522051727.us-central1.run.app"


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


def _gateway_links(text: str) -> list[dict]:
    parser = _Links()
    parser.feed(text)
    out = []
    for a in parser.links:
        parts = urlsplit(a["attrs"].get("href") or "")
        if parts.scheme and f"{parts.scheme}://{parts.netloc}" == GATEWAY_ORIGIN:
            out.append(a)
    return out


class ExperiencePage(unittest.TestCase):
    def setUp(self):
        self.text = PAGE.read_text(encoding="utf-8")

    def test_page_exists_with_title(self):
        self.assertTrue(PAGE.is_file())
        self.assertIn("<title>Conference experience</title>", self.text)
        self.assertIn('data-palette="cobalt"', self.text)
        self.assertIn("/assets/chrome.css", self.text)
        self.assertIn("/assets/chrome.js", self.text)

    def test_footer_is_left_to_chrome(self):
        # chrome.js builds the footer at runtime; a static one would be replaced.
        self.assertNotIn("<footer", self.text)

    def test_mounts_the_homepage_studio_on_the_conference_topic(self):
        self.assertIn('/assets/voice-conversation.js', self.text)
        self.assertIn('/assets/prototype-canvas.js', self.text)
        self.assertIn('id="prototype-canvas"', self.text)
        self.assertIn(f'data-controller-url="{CONTROLLER}"', self.text)
        # Not the homepage id: the module auto-mounts #voice-conversation with {}.
        self.assertNotIn('id="voice-conversation"', self.text)
        self.assertRegex(self.text, r"SFDC24Voice\.mount\(root, \{")
        self.assertIn('topic: "conference"', self.text)
        self.assertIn('[["conference", "Work on the conference line"]]', self.text)
        self.assertIn('topicFallback: "other"', self.text)
        self.assertIn('opening: "What are we working on today?"', self.text)
        self.assertIn(">What are we working on today?</h2>", self.text)

    def test_same_controller_as_homepage(self):
        home = HOME.read_text(encoding="utf-8")
        self.assertIn(f'data-controller-url="{CONTROLLER}"', home)

    def test_exactly_one_gateway_link_new_tab_noopener_owner_label(self):
        links = _gateway_links(self.text)
        self.assertEqual(len(links), 1)
        (link,) = links
        self.assertEqual(link["attrs"].get("target"), "_blank")
        rel = (link["attrs"].get("rel") or "").split()
        self.assertIn("noopener", rel)
        self.assertIn("noreferrer", rel)
        self.assertEqual(" ".join(link["text"].split()), "Join the voice room (owner sign-in)")
        self.assertIn("admits only the owner for now", self.text)
        self.assertEqual(self.text.count(GATEWAY_ORIGIN), 1)

    def test_team_names_as_the_conference_page_names_them(self):
        for name in ("Claude", "Greg", "Aya", "Jenny", "Cody"):
            self.assertIn(f"<b>{name}</b>", self.text)
        self.assertIn("<b>Claude</b> — chair", self.text)

    def test_coming_next(self):
        self.assertIn("Coming next", self.text)
        self.assertIn("Guest invitations", self.text)

    def test_no_banned_words_or_secret_markers(self):
        for needle in ("OKF", "LiveKit", "Cloud Run", "API_KEY", "SECRET", "BEGIN PRIVATE",
                       "LIVEKIT_API", "Join the conference"):
            self.assertNotIn(needle, self.text)
        self.assertNotIn("okf", self.text.lower())

    def test_no_first_person_singular_in_page_copy(self):
        prose = re.sub(r"<style[\s\S]*?</style>", " ", self.text)
        prose = re.sub(r"<!--[\s\S]*?-->", " ", prose)
        prose = re.sub(r"/\*[\s\S]*?\*/", " ", prose)
        for rx in (r"\bI\b", r"\bI'", r"\bmy\b", r"\bme\b", r"\bmine\b"):
            self.assertIsNone(re.search(rx, prose), rx)


class HomepageUnchanged(unittest.TestCase):
    def test_homepage_still_auto_mounts_with_empty_opts(self):
        src = VOICE.read_text(encoding="utf-8")
        self.assertIn('var root = document.getElementById("voice-conversation");', src)
        self.assertIn("if (root) mount(root, {});", src)
        home = HOME.read_text(encoding="utf-8")
        self.assertIn('id="voice-conversation"', home)
        self.assertNotIn("SFDC24Voice.mount", home)

    def test_default_topics_unchanged(self):
        src = VOICE.read_text(encoding="utf-8")
        self.assertIn(
            'var TOPICS = [["logo", "Design a logo"], ["website", "Build a website"], ["app", "Develop an app"],\n'
            '                  ["salesforce_admin", "Salesforce admin"], ["salesforce_data", "Salesforce data"], '
            '["other", "Something else"]];', src)
        # The options only ever replace the defaults when a page passes them.
        self.assertIn("if (ownTopics.length) TOPICS = ownTopics;", src)
        self.assertIn('"Homepage conversation"', src)
        self.assertIn('speak(opening || (museOn ? HOST_INTRO : HOST_INTRO_SOLO), 0, "host");', src)
        self.assertIn('(topicFallback ? createWithFallback(operator, create) : post("/v1/session", operator, create))', src)


if __name__ == "__main__":
    unittest.main()
