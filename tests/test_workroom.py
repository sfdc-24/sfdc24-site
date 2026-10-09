"""Source-only workroom integration guards; no network and no provider calls.

These prove document wiring, not browser rendering, controller health or audio.
Behavioral checks live in workroom.spec.cjs.
"""
from html.parser import HTMLParser
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[1]
SOURCE = (ROOT / "workroom/index.html").read_text(encoding="utf-8")
CONTROLLER = "https://sfdc24-studio-controller-96522051727.us-central1.run.app"


class Document(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.elements = []

    def handle_starttag(self, tag, attrs):
        self.elements.append((tag, dict(attrs)))

    def matching(self, tag=None, **attrs):
        return [a for t, a in self.elements if (not tag or t == tag)
                and all(a.get(k) == v for k, v in attrs.items())]


class WorkroomSource(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.doc = Document()
        cls.doc.feed(SOURCE)

    def test_mounts_are_unique_and_initially_hidden(self):
        for identity, component in [("voice-conversation", "vc"), ("prototype-canvas", "pc")]:
            with self.subTest(identity=identity):
                nodes = self.doc.matching(id=identity)
                self.assertEqual(len(nodes), 1)
                self.assertIn("hidden", nodes[0])
                self.assertIn(component, nodes[0].get("class", "").split())
        self.assertIn(CONTROLLER, SOURCE)
        self.assertEqual(self.doc.matching(id="voice-conversation")[0].get("data-controller-url"), CONTROLLER)

    def test_real_deferred_components_load_in_dependency_order(self):
        scripts = [a for t, a in self.doc.elements if t == "script"]
        paths = [a.get("src") for a in scripts]
        for filename in ("prototype-canvas.js", "voice-conversation.js"):
            target = "/assets/" + filename
            self.assertEqual(paths.count(target), 1)
            self.assertIn("defer", scripts[paths.index(target)])
        self.assertLess(paths.index("/assets/prototype-canvas.js"), paths.index("/assets/voice-conversation.js"))
        self.assertNotRegex(SOURCE, r"SFDC24Voice\s*\.\s*mount\s*\(")
        self.assertNotRegex(SOURCE, r"SFDC24Canvas\s*\.\s*create\s*\(")

    def test_top_level_page_with_accessible_landmarks(self):
        self.assertEqual(len(self.doc.matching("html", lang="en")), 1)
        self.assertEqual(len(self.doc.matching("main")), 1)
        self.assertEqual(len(self.doc.matching("h1")), 1)
        self.assertEqual(self.doc.matching("iframe"), [])
        viewport = self.doc.matching("meta", name="viewport")
        self.assertEqual(len(viewport), 1)
        self.assertIn("width=device-width", viewport[0]["content"])

    def test_manual_owner_handoff_uses_home_only(self):
        links = self.doc.matching("a", href="/#owner-conference-start")
        self.assertGreaterEqual(len(links), 1)
        self.assertTrue(all(link.get("target", "_self") == "_self" for link in links))
        self.assertNotIn("conference-gateway-yzet4vuplq-uc.a.run.app", SOURCE)
        self.assertRegex(SOURCE.lower(), r"separate[^<.]*session")

    def test_unlisted_page_retains_indexing_exclusion(self):
        robots = self.doc.matching("meta", name="robots")
        self.assertTrue(any("noindex" in entry.get("content", "") for entry in robots))

    def test_no_new_transport_or_engine_implementation(self):
        self.assertNotRegex(SOURCE, r"new\s+(?:RTCPeerConnection|WebSocket|EventSource)\s*\(")
        self.assertNotRegex(SOURCE, r"/v1/(?:session|auth)/")
        self.assertNotRegex(SOURCE, r"api\.(?:openai|anthropic|xai)\.com")
        self.assertNotIn("script=fixture", SOURCE)

    def test_health_fallback_and_reduced_motion_are_present(self):
        self.assertRegex(SOURCE.lower(), r"unavailable|not available|cannot connect|not ready")
        self.assertIn("prefers-reduced-motion", SOURCE)
        self.assertRegex(SOURCE, r"\[hidden\]")
        self.assertRegex(SOURCE, r"@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{\.vc-live-status::before\{animation:none\}\}")

    def test_existing_icons_and_shared_chrome_style_are_referenced(self):
        icons = self.doc.matching("link", rel="icon")
        self.assertIn("/assets/favicon.ico", [entry.get("href") for entry in icons])
        self.assertEqual(len(self.doc.matching("link", href="/assets/chrome.css")), 1)
        self.assertEqual(self.doc.matching("script", src="/assets/chrome.js"), [])

    def test_static_footer_matches_existing_conference_navigation(self):
        existing = (ROOT / "conference/index.html").read_text(encoding="utf-8")
        footer = re.search(r'<footer class="chrome-foot">[\s\S]*?</footer>', existing).group()
        self.assertIn(footer, SOURCE)
        self.assertIn('href="/privacy/"', footer)
        self.assertIn('href="/terms/"', footer)

    def test_intro_names_the_offer_and_examples_avoid_first_person(self):
        lede = re.search(r'<p class="lede">([\s\S]*?)</p>', SOURCE).group(1)
        self.assertIn("business process automation", lede)
        examples = re.search(r'<ul class="prompt-list"[\s\S]*?</ul>', SOURCE).group()
        self.assertNotRegex(examples, r"\b(?:I|my|mine|me|myself)\b")
        self.assertIn("Map a team’s work intake process.", examples)
        self.assertNotIn("the work our team has open", examples)

    def test_standard_brand_uses_existing_pure_clock_renderer(self):
        chrome = (ROOT / "assets/chrome.js").read_text(encoding="utf-8")
        start = chrome.index("  function torontoClock(now) {")
        end = chrome.index("  function micSvg() {")
        self.assertIn(chrome[start:end], SOURCE)
        self.assertIn('class="mark chrome-mark"', SOURCE)
        self.assertIn('data-live-brand="1"', SOURCE)
        self.assertNotIn('The SFDC24 workroom', SOURCE)


if __name__ == "__main__":
    unittest.main()
