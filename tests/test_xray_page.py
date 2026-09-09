"""Acceptance tests for the published /xray/ console.

These encode the conditions the X-Ray page had to meet before it could be served
from this repository, per board award CODEX-XRAY-SYNTHETIC-CANONICAL-GO-20260908T162000Z:

  1. no real SFDC24 org identifier or private inventory literal survives
  2. the sample data is visibly labelled synthetic
  3. no network egress except the one reviewed font origin
  4. nothing uploads: no form, no submit target, no upload API
  5. visitor-supplied JSON cannot inject markup
  6. the change stays inside its own directory

They are static-source assertions on purpose. This repository has no browser in
CI, so these prove the properties that can be proven from the bytes, and the
render/theme-toggle check is done by hand and recorded on the PR.
"""

from __future__ import annotations

import re
from html.parser import HTMLParser
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
PAGE = REPO / "xray" / "index.html"


class _RobotsFinder(HTMLParser):
    """Finds an EFFECTIVE <meta name="robots"> that declines indexing.

    Three things have to be true, and each was learned by having the previous
    version fooled:

      1. It must be a real start tag, not text. A regex over raw source counts a
         COMMENTED-OUT tag -- the first version of this test did, and passed on a
         page with no protection at all.
      2. It must be inside <head>. A robots directive in <body> is ignored by
         search engines, so a page carrying one there is unprotected.
      3. It must not be inside <template>. Template content is inert: it is
         parsed but never applied unless script clones it into the document.

    HTMLParser routes comments to handle_comment rather than handle_starttag,
    which gives (1) for free. (2) and (3) need the context tracked explicitly,
    which is what in_head and template_depth are for. Both were missing until
    chatgpt-codex-desktop demonstrated a template-only tag passing.
    """

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.declines = False
        self._in_head = False
        self._template_depth = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        name = tag.lower()
        if name == "head":
            self._in_head = True
            return
        if name == "template":
            self._template_depth += 1
            return
        if name != "meta" or not self._in_head or self._template_depth:
            return
        a = {k.lower(): (v or "") for k, v in attrs}
        if a.get("name", "").strip().lower() != "robots":
            return
        tokens = {t.strip().lower() for t in a.get("content", "").split(",")}
        if "noindex" in tokens or "none" in tokens:
            self.declines = True

    def handle_endtag(self, tag: str) -> None:
        name = tag.lower()
        if name == "head":
            self._in_head = False
        elif name == "template" and self._template_depth:
            self._template_depth -= 1


def _declines_indexing(html: str) -> bool:
    finder = _RobotsFinder()
    finder.feed(html)
    finder.close()
    return finder.declines


class XrayPageTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.src = PAGE.read_text(encoding="utf-8")

    # -- 1. no real org data -------------------------------------------------

    def test_no_real_org_identifiers(self) -> None:
        """The internal build carried a real Salesforce login. Nothing like it ships."""
        # Deliberately NOT banning the bare string "sfdc24.com": this is SFDC24's
        # own website and the brand names itself in the copy. What must not ship is
        # a real login, a real tenant, or the tool that produced the real figures.
        banned = [
            "abdus",
            "omnistudio",
            "@sfdc24.com",
            "Headless 360",
        ]
        for needle in banned:
            with self.subTest(needle=needle):
                self.assertNotIn(
                    needle.lower(),
                    self.src.lower(),
                    f"{needle!r} is a real-org identifier and must not appear in a public page",
                )

    def test_no_email_address_anywhere(self) -> None:
        """Catch any address shape, not just the one we knew about."""
        found = re.findall(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}", self.src)
        self.assertEqual([], found, f"email-shaped literals must not ship: {found}")

    def test_private_inventory_numbers_are_gone(self) -> None:
        """The real org's counts were 10/9/32/38/46. The synthetic set must differ."""
        live = self._live_object()
        self.assertNotEqual("10", live.get("activeUsers"))
        self.assertNotEqual("9", live.get("staleUsers90"))
        self.assertNotEqual("32", live.get("apexClasses"))
        self.assertNotEqual("38", live.get("permissionSets"))
        self.assertNotEqual("46", live.get("profiles"))

    # -- 2. visibly synthetic ------------------------------------------------

    def test_sample_org_is_labelled_synthetic(self) -> None:
        live = self._live_object()
        self.assertIn("synthetic", live.get("org", "").lower())

    def test_synthetic_label_is_rendered_not_just_commented(self) -> None:
        """A label only counts if the visitor sees it."""
        self.assertIn('class="synthetic-tag"', self.src)
        self.assertIn("SYNTHETIC", self.src)
        self.assertIn(".synthetic-tag{", self.src, "the tag needs a style or it renders bare")

    def test_footer_states_the_data_is_synthetic(self) -> None:
        self.assertIn("synthetic demo data", self.src)

    # -- 3. no network egress beyond the reviewed font origin ----------------

    def test_only_reviewed_external_origins(self) -> None:
        origins = {
            m.group(1).lower()
            for m in re.finditer(r"https?://([^/\s\"'<>)]+)", self.src)
        }
        allowed = {"fonts.googleapis.com", "fonts.gstatic.com"}
        self.assertTrue(
            origins <= allowed,
            f"unreviewed external origin(s): {sorted(origins - allowed)}",
        )

    def test_no_runtime_network_calls(self) -> None:
        """The page must not talk to a backend. It has none by design."""
        for api in ("fetch(", "XMLHttpRequest", "WebSocket(", "EventSource(", "navigator.sendBeacon"):
            with self.subTest(api=api):
                self.assertNotIn(api, self.src)

    # -- 4. nothing uploads --------------------------------------------------

    def test_no_form_or_upload_path(self) -> None:
        self.assertNotIn("<form", self.src.lower())
        self.assertNotIn("FormData", self.src)
        self.assertNotIn("enctype", self.src.lower())

    def test_json_is_read_locally(self) -> None:
        """The scores.json loader is a local FileReader, not an upload."""
        self.assertIn("FileReader", self.src)
        self.assertIn('type="file"', self.src)

    # -- 5. visitor JSON cannot inject markup --------------------------------

    def test_severity_is_clamped_not_interpolated_raw(self) -> None:
        """severity reaches a class attribute; a raw value there breaks out of it."""
        self.assertNotIn("sev s${f.severity}", self.src)
        self.assertIn("sev s${sevN(f.severity)}", self.src)

    def test_sigma_and_priority_are_escaped(self) -> None:
        self.assertNotIn("${f.sigma}", self.src)
        self.assertNotIn("${f.priority}", self.src)

    def test_fmt_is_numeric_safe(self) -> None:
        """The subtle one: String.prototype.toLocaleString returns crafted input
        unchanged, so the old fmt() was itself an injection path into innerHTML."""
        self.assertNotIn('const fmt = n => n==null ? "–" : n.toLocaleString("en-CA");', self.src)
        self.assertIn("Number.isFinite(v)", self.src)

    def test_no_unescaped_finding_field_reaches_innerhtml(self) -> None:
        """Backstop: every ${f.<field>} must be wrapped in a sanitiser.

        Catches a future edit that adds a new raw field, which is exactly how the
        original three got in.
        """
        raw = [
            m.group(0)
            for m in re.finditer(r"\$\{f\.[A-Za-z_][A-Za-z0-9_]*\}", self.src)
        ]
        self.assertEqual([], raw, f"unsanitised finding fields reach the DOM: {raw}")

    # -- 6. change boundary --------------------------------------------------

    def test_page_lives_in_its_own_directory(self) -> None:
        self.assertTrue(PAGE.is_file())
        siblings = sorted(p.name for p in PAGE.parent.iterdir())
        self.assertEqual(["index.html"], siblings, "the /xray/ route ships one file")

    def test_route_stays_unlisted(self) -> None:
        """Award routing: deliberate demo access, no sitemap entry until decided."""
        sitemap = (REPO / "sitemap.xml").read_text(encoding="utf-8")
        self.assertNotIn("/xray", sitemap)

    def test_unlisted_also_means_unindexed(self) -> None:
        """Sitemap omission is not a fence. robots.txt says Allow: /, so a
        crawler reaching this URL by any other route may index it. The site
        already pairs the two everywhere else -- /governor/, /voice/ and
        404.html all carry the tag -- and /xray/ was the exception.

        Parsed, not grepped. A regex over raw source cannot tell an ACTIVE tag
        from one someone commented out, and a test that passes on an inert tag
        is worse than no test: it reports a protection that is not there.
        chatgpt-codex-desktop caught exactly that in the first version of this
        assertion, reproducing a Copilot finding.
        """
        for rel in ("xray/index.html", "governor/index.html", "voice/index.html", "404.html"):
            text = (REPO / rel).read_text(encoding="utf-8")
            self.assertTrue(
                _declines_indexing(text),
                f"{rel} must carry an active <meta name=robots content=...noindex> tag",
            )

    def test_the_noindex_assertion_cannot_be_fooled_by_a_comment(self) -> None:
        """The guard on the guard. If this ever fails, the check above has
        stopped proving anything and every page it covers is unprotected."""
        live = '<html><head><meta name="robots" content="noindex"></head></html>'
        self_closing = '<html><head><meta name="robots" content="noindex"/></head></html>'
        commented = '<html><head><!-- <meta name="robots" content="noindex"> --></head></html>'
        absent = "<html><head><title>x</title></head></html>"
        wrong_value = '<html><head><meta name="robots" content="index,follow"></head></html>'
        body_only = '<html><head><title>x</title></head><body><meta name="robots" content="noindex"></body></html>'
        template_only = ('<html><head><title>x</title></head><body><template>'
                         '<meta name="robots" content="noindex"></template></body></html>')
        self.assertTrue(_declines_indexing(live))
        self.assertTrue(_declines_indexing(self_closing), "a self-closing tag is still a tag")
        self.assertFalse(_declines_indexing(commented), "a commented-out tag protects nothing")
        self.assertFalse(_declines_indexing(absent))
        self.assertFalse(_declines_indexing(wrong_value))
        self.assertFalse(_declines_indexing(body_only), "robots in <body> is ignored by crawlers")
        self.assertFalse(_declines_indexing(template_only), "template content is inert until cloned")

    # -- helper --------------------------------------------------------------

    def _live_object(self) -> dict[str, str]:
        match = re.search(r"const LIVE = \{(.*?)\};", self.src, re.S)
        self.assertIsNotNone(match, "the LIVE sample object should still exist")
        body = match.group(1)
        return {
            k: v.strip().strip('"')
            for k, v in re.findall(r"(\w+)\s*:\s*([^,}]+)", body)
        }


if __name__ == "__main__":
    unittest.main()
