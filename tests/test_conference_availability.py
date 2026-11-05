"""The public pages agree on who can join a conference.

The live room is open to the owner. Guest access is not a door on these
pages. The invitation rule stays on the owner surfaces, and the public next
step stays the one contact that was already there.
"""
from __future__ import annotations

import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]

PAGES = (
    "index.html",
    "conference/index.html",
    "conferences/index.html",
    "experience/index.html",
    "projects/index.html",
)

# Claims that contradicted each other, or that address every visitor as a joiner.
GONE = (
    "not open yet",
    "You talk",
    "You speak",
    "as you talk",
    "marked You",
    "guests join",
    "Join the conference",
)

GATEWAY = "https://conference-gateway-yzet4vuplq-uc.a.run.app"
CLOSED = "guest access is not open"
INVITATION = "by invitation only, once the owner approves"


def _read(rel: str) -> str:
    return (REPO / rel).read_text(encoding="utf-8")


def _main(html: str) -> str:
    return html.split("<main", 1)[1].split("</main>", 1)[0]


class ConferenceAvailabilityCopy(unittest.TestCase):
    def test_every_surface_closes_guest_access_and_drops_the_old_claims(self):
        for rel in PAGES:
            html = _read(rel)
            self.assertIn(CLOSED, html, rel)
            self.assertTrue(
                "owner only" in html or "only the owner" in html,
                rel,
            )
            for phrase in GONE:
                self.assertNotIn(phrase, html, f"{rel} still says {phrase!r}")

    def test_homepage_qualifies_the_line_and_keeps_one_public_step(self):
        html = _read("index.html")
        main = _main(html)
        self.assertIn("The line is owner only", main)
        self.assertIn("The owner talks, the team answers", main)
        self.assertIn("microphone marked Owner", main)
        self.assertEqual(main.count("Write to the studio"), 1)
        self.assertEqual(main.count('href="mailto:abdus@sfdc24.com"'), 1)
        self.assertNotIn('href="/conferences/"', main)
        self.assertNotIn(GATEWAY, html)
        self.assertNotIn(">Join the room<", main)

    def test_owner_room_stays_a_sign_in_and_not_a_public_door(self):
        html = _read("conference/index.html")
        main = _main(html)
        self.assertIn("Google sign-in, owner only", main)
        self.assertIn(">Join the room</button>", main)
        self.assertIn('data-src="https://room.sfdc24.com/"', main)
        self.assertIn("not the join door", main)
        self.assertIn(INVITATION, main)
        self.assertIn("that invitation is not open", main)
        self.assertNotIn("mailto:", main)
        self.assertEqual(html.count(">Join the room</button>"), 1)

    def test_public_conferences_page_has_one_contact_and_no_join(self):
        html = _read("conferences/index.html")
        main = _main(html)
        self.assertIn("open to the owner only", main)
        self.assertIn("To talk about the work, write to the studio.", main)
        self.assertEqual(main.count('href="mailto:abdus@sfdc24.com"'), 1)
        self.assertEqual(main.count("<a "), 1)
        for banned in (
            'id="conference-start"',
            'id="conference-join"',
            ">Join the room<",
            ">Join</a>",
            GATEWAY,
            "room.sfdc24.com",
        ):
            self.assertNotIn(banned, html)

    def test_experience_keeps_one_owner_link_and_a_closed_invitation(self):
        html = _read("experience/index.html")
        self.assertEqual(html.count(GATEWAY), 1)
        self.assertEqual(html.count("Join the voice room (owner sign-in)"), 1)
        self.assertIn("admits only the owner for now", html)
        self.assertIn("Guest invitations are not open", html)
        self.assertIn(INVITATION, html)
        self.assertIn("as the owner talks", html)
        self.assertNotIn("mailto:", _main(html))

    def test_projects_does_not_call_conferences_running(self):
        html = _read("projects/index.html")
        start = html.index("<h3>Conferences:")
        article = html[html.rindex("<article", 0, start):html.index("</article>", start)]
        self.assertIn(">Owner only</p>", article)
        self.assertNotIn("Running", article)
        self.assertNotIn('class="tag live"', article)
        self.assertIn(CLOSED, article)
        self.assertIn(INVITATION, article)
        self.assertNotIn("mailto:", article)
        main = _main(html)
        self.assertEqual(main.count('href="mailto:abdus@sfdc24.com"'), 1)

    def test_hero_drawings_mark_the_microphone_as_the_owner(self):
        for rel in ("assets/studio-hero.svg", "assets/studio-hero-portrait.svg"):
            svg = _read(rel)
            self.assertIn(">Owner</text>", svg)
            self.assertNotIn(">You</text>", svg)
            self.assertIn("marked Owner", svg)


if __name__ == "__main__":
    unittest.main()
