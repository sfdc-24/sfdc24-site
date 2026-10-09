"""Homepage owner start for the conference: one link, owner-labelled, new tab.

Only the homepage and the owner's /experience/ page may link to the gateway.

The conference gateway sits behind Google sign-in that admits only the owner, so a
link to it on a public page is an owner start, never a guest join. These checks keep
it to exactly one clearly labelled link on the homepage and nowhere else.
"""
from __future__ import annotations

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
    def test_exactly_one_gateway_link_on_homepage(self):
        self.assertEqual(len(_gateway_links(HOME)), 1)

    def test_opens_in_new_tab_with_noopener(self):
        (link,) = _gateway_links(HOME)
        self.assertEqual(link["attrs"].get("target"), "_blank")
        rel = (link["attrs"].get("rel") or "").split()
        self.assertIn("noopener", rel)
        self.assertIn("noreferrer", rel)

    def test_label_says_owner(self):
        (link,) = _gateway_links(HOME)
        label = " ".join(link["text"].split())
        self.assertIn("owner", label.lower())
        self.assertIn("Start the conference", label)

    def test_homepage_says_guests_are_not_admitted(self):
        text = HOME.read_text(encoding="utf-8")
        self.assertIn("Guests are not admitted", text)
        self.assertIn("signs in with Google", text)
        for banned in ("Join the conference", "Cloud Run", "LiveKit", "OKF", "API_KEY", "SECRET"):
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


if __name__ == "__main__":
    unittest.main()
