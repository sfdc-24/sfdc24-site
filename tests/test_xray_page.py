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


# Void elements: a trailing slash on these is meaningless but harmless. On any
# OTHER element HTML5 ignores the slash entirely, so "<template/>" OPENS a
# template and does not close it. HTMLParser's default handle_startendtag calls
# starttag then endtag, which is why "<template/>" used to cancel itself out.
# HTML5 permits exactly these inside <head>. ANY other start tag, and any
# non-whitespace text outside a raw-text element, implicitly closes the head --
# the browser moves what follows into <body>, where a robots directive does
# nothing. Stating it as a CLOSED SET rather than a list of known-bad tags is
# the point: an element nobody here has thought of fails closed instead of
# silently passing, which is how div, p, h1 and stray text got through the
# previous four versions of this guard.
_HEAD_CONTENT = frozenset({
    "base", "basefont", "bgsound", "link", "meta",
    "noscript", "script", "style", "template", "title",
})

# Text inside these is character data, not head content, so it must not be
# mistaken for the stray text that closes a head.
_RAW_TEXT = frozenset({"title", "style", "script", "noscript"})

# These end tags also take the parser out of the head. </br> is the odd one:
# HTML5 rewrites it to <br>, which is not head content, so it pops the head too.
_ENDS_HEAD = frozenset({"head", "body", "html", "br"})

_VOID = frozenset({
    "area", "base", "br", "col", "embed", "hr", "img", "input",
    "link", "meta", "param", "source", "track", "wbr",
})


class _RobotsFinder(HTMLParser):
    """Finds an EFFECTIVE <meta name="robots"> that declines indexing.

    The claim being tested is narrow and worth stating exactly: *a browser
    parsing this file would honour a robots directive that declines indexing.*
    Anything weaker certifies pages that are not protected.

    Every rule below exists because a specific evasion passed an earlier
    version. In order, they were: a commented-out tag (raw regex), a tag in
    <body> or <template> (no context tracking), a self-closing <template/>
    (default startendtag handling cancelled the depth), <body> implicitly
    closing <head>, a second literal <head> reopening the state, and duplicate
    attributes resolving last-wins in a dict but first-wins in HTML.

    The head state is deliberately MONOTONIC -- before, inside, done -- because
    a document has exactly one effective head. Anything after it, however it is
    spelled, is not in the head.
    """

    _BEFORE, _INSIDE, _DONE = 0, 1, 2

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.declines = False
        self._head = self._BEFORE
        self._template_depth = 0
        self._rawtext_depth = 0

    # HTML5 ignores a trailing slash on non-void elements, so "<template/>" is a
    # start tag with no matching end. Never let it decrement the depth.
    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.handle_starttag(tag, attrs)
        if tag.lower() in _VOID:
            return  # void elements have no end tag to report

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        name = tag.lower()
        if name == "head":
            if self._head == self._BEFORE:
                self._head = self._INSIDE
            return  # a second <head> never reopens the state
        # BEFORE is monotonic too. HTML5 opens AND CLOSES an implied head at the
        # first body token, so a literal <head> appearing after one is ignored
        # and everything in it lands in <body>. Only <html>, comments and
        # whitespace may precede an explicit head without ending the chance of
        # one. Raised by chatgpt-codex-desktop-01a073ed against 90edc04.
        if self._head == self._BEFORE and name != "html":
            self._head = self._DONE
            return
        if name == "body":
            self._head = self._DONE  # <body> implicitly closes <head>
            return
        if name == "template":
            self._template_depth += 1
            return
        if name in _RAW_TEXT:
            self._rawtext_depth += 1
        # Anything not permitted in the head closes it, right here.
        if (self._head == self._INSIDE and not self._template_depth
                and name not in _HEAD_CONTENT):
            self._head = self._DONE
        if (name != "meta" or self._head != self._INSIDE
                or self._template_depth or self._rawtext_depth):
            return
        a = _first_wins(attrs)
        if a.get("name", "").strip().lower() != "robots":
            return
        tokens = {t.strip().lower() for t in a.get("content", "").split(",")}
        if "noindex" in tokens or "none" in tokens:
            self.declines = True

    def handle_endtag(self, tag: str) -> None:
        name = tag.lower()
        if name in _ENDS_HEAD:
            self._head = self._DONE
            if name in _RAW_TEXT and self._rawtext_depth:
                self._rawtext_depth -= 1
            return
        if name == "template" and self._template_depth:
            self._template_depth -= 1
        elif name in _RAW_TEXT and self._rawtext_depth:
            self._rawtext_depth -= 1

    def handle_data(self, data: str) -> None:
        # Non-whitespace text in the head closes it, unless it is the content of
        # a raw-text element like <title> or a template's inert content.
        if not data.strip():
            return
        if self._head == self._BEFORE:
            self._head = self._DONE  # text before any head implies one, already closed
        elif (self._head == self._INSIDE and not self._template_depth
                and not self._rawtext_depth):
            self._head = self._DONE


def _first_wins(attrs: list[tuple[str, str | None]]) -> dict[str, str]:
    """HTML resolves duplicate attributes FIRST-wins; a dict comprehension is
    last-wins. `<meta name="description" name="robots">` is a description tag to
    a browser and was a robots tag to the old code."""
    out: dict[str, str] = {}
    for key, value in attrs:
        k = key.lower()
        if k not in out:
            out[k] = value or ""
    return out


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
        # The template must be inside HEAD. With it in <body> the in_head check
        # rejects the fixture before template_depth is ever consulted, so the
        # template guard goes untested and could be deleted with the suite still
        # green. Proved by mutation: removing template_depth enforcement left
        # 18/18 passing. Caught by chatgpt-codex-desktop-01a073ed on PR #13.
        template_in_head = ('<html><head><title>x</title><template>'
                            '<meta name="robots" content="noindex"></template></head></html>')
        template_in_body = ('<html><head><title>x</title></head><body><template>'
                            '<meta name="robots" content="noindex"></template></body></html>')
        self.assertTrue(_declines_indexing(live))
        self.assertTrue(_declines_indexing(self_closing), "a self-closing tag is still a tag")
        self.assertFalse(_declines_indexing(commented), "a commented-out tag protects nothing")
        self.assertFalse(_declines_indexing(absent))
        self.assertFalse(_declines_indexing(wrong_value))
        self.assertFalse(_declines_indexing(body_only), "robots in <body> is ignored by crawlers")
        self.assertFalse(
            _declines_indexing(template_in_head),
            "template content is inert until cloned - this is the fixture that "
            "actually exercises template_depth, because in_head is true here",
        )
        self.assertFalse(_declines_indexing(template_in_body), "and not in body either")

    def test_html5_evasions_do_not_certify_an_ineffective_directive(self) -> None:
        """Four ways to write a directive a browser will NOT honour. Every one
        of them passed an earlier version of this parser, so every one is
        pinned. Raised by chatgpt-codex-desktop against head 5ba945f, with
        parse5 tree comparison; all four reproduced here before the fix."""
        evasions = {
            "self-closing template does not close it": (
                '<html><head><title>x</title><template/>'
                '<meta name="robots" content="noindex"></head></html>'
            ),
            "<body> implicitly closes <head>": (
                '<html><head><title>x</title><body>'
                '<meta name="robots" content="noindex"></body></html>'
            ),
            "a second <head> does not reopen the head": (
                '<html><head><title>x</title></head><body><head>'
                '<meta name="robots" content="noindex"></head></body></html>'
            ),
            "duplicate attributes are first-wins in HTML": (
                '<html><head><meta name="description" name="robots" '
                'content="index,follow" content="noindex"></head></html>'
            ),
        }
        for why, html in evasions.items():
            with self.subTest(why):
                self.assertFalse(
                    _declines_indexing(html),
                    f"a browser would not honour this, so the test must not certify it: {why}",
                )

        # The mirror image: these ARE effective and must still pass, so the
        # rules above cannot be satisfied by rejecting everything.
        effective = {
            "plain": '<html><head><meta name="robots" content="noindex"></head></html>',
            "void self-closing meta": '<html><head><meta name="robots" content="noindex"/></head></html>',
            "content=none": '<html><head><meta name="robots" content="none"></head></html>',
            "after a closed template": (
                '<html><head><template><b>x</b></template>'
                '<meta name="robots" content="noindex"></head></html>'
            ),
        }
        for why, html in effective.items():
            with self.subTest(why):
                self.assertTrue(_declines_indexing(html), f"this one is real and must pass: {why}")

    def test_content_not_permitted_in_head_closes_it(self) -> None:
        """HTML5 closes <head> implicitly at the first thing that does not
        belong there, and moves the rest into <body> where a robots directive is
        inert. Raised by chatgpt-codex-desktop against 7670019 with headless
        Chrome and parse5 trees; div, p, h1 and stray text all reproduced.

        The rule is a CLOSED SET of permitted head content, not a list of
        known-bad tags -- so an element nobody has thought of fails closed. The
        marquee case is there to prove that, and is the difference between this
        version and the four before it."""
        closes_head = {
            "div": '<html><head><title>x</title><div><meta name="robots" content="noindex"></head></html>',
            "p": '<html><head><title>x</title><p><meta name="robots" content="noindex"></head></html>',
            "h1": '<html><head><title>x</title><h1><meta name="robots" content="noindex"></head></html>',
            "stray text": '<html><head><title>x</title>hello<meta name="robots" content="noindex"></head></html>',
            "an element we never enumerated": (
                '<html><head><title>x</title><marquee>'
                '<meta name="robots" content="noindex"></head></html>'
            ),
        }
        for why, html in closes_head.items():
            with self.subTest(why):
                self.assertFalse(
                    _declines_indexing(html),
                    f"a browser puts this meta in <body>, where it does nothing: {why}",
                )

        # Legitimate head content must NOT close the head, or the rule above
        # would be satisfiable by rejecting every real page.
        stays_in_head = {
            "after a title with text": (
                '<html><head><title>Some Title Text</title>'
                '<meta name="robots" content="noindex"></head></html>'
            ),
            "after link and style": (
                '<html><head><link rel="x"><style>body{color:red}</style>'
                '<meta name="robots" content="noindex"></head></html>'
            ),
            "after a script with code": (
                '<html><head><script>var a=1;</script>'
                '<meta name="robots" content="noindex"></head></html>'
            ),
        }
        for why, html in stays_in_head.items():
            with self.subTest(why):
                self.assertTrue(_declines_indexing(html), f"this is valid head content: {why}")

    def test_raw_text_and_end_tags_also_take_us_out_of_the_head(self) -> None:
        """Two more exit routes, raised by chatgpt-codex-desktop-01a073ed with
        parse5 trees against head 7670019.

        A <meta> inside <noscript> creates no element at all when scripting is
        enabled -- the content is text. And </body>, </html> and </br> each pop
        the head; </br> because HTML5 rewrites it to <br>, which is not head
        content."""
        ineffective = {
            "meta inside noscript is text, not an element": (
                '<html><head><noscript>'
                '<meta name="robots" content="noindex"></noscript></head></html>'
            ),
            "</body> pops the head": (
                '<html><head><title>x</title></body>'
                '<meta name="robots" content="noindex"></head></html>'
            ),
            "</html> pops the head": (
                '<html><head><title>x</title></html>'
                '<meta name="robots" content="noindex"></head></html>'
            ),
            "</br> is rewritten to <br> and pops the head": (
                '<html><head><title>x</title></br>'
                '<meta name="robots" content="noindex"></head></html>'
            ),
            "textarea is not head content": (
                '<html><head><title>x</title><textarea>'
                '<meta name="robots" content="noindex"></head></html>'
            ),
        }
        for why, html in ineffective.items():
            with self.subTest(why):
                self.assertFalse(_declines_indexing(html), f"a browser honours nothing here: {why}")

        # Positive controls, so none of the above can be satisfied by a parser
        # that simply gives up.
        effective = {
            "after a CLOSED noscript": (
                '<html><head><noscript><link rel="x"></noscript>'
                '<meta name="robots" content="noindex"></head></html>'
            ),
            "after a comment": '<html><head><!-- c --><meta name="robots" content="noindex"></head></html>',
            "after whitespace": '<html><head>\n  <meta name="robots" content="noindex"></head></html>',
        }
        for why, html in effective.items():
            with self.subTest(why):
                self.assertTrue(_declines_indexing(html), f"still effective: {why}")

    def test_a_head_cannot_open_after_the_document_body_has_begun(self) -> None:
        """The last exit route: HTML5 opens AND CLOSES an implied <head> at the
        first body token, so a literal <head> written afterwards is ignored and
        its contents land in <body>.

        This is why BEFORE is monotonic as well as INSIDE. Raised by
        chatgpt-codex-desktop-01a073ed against head 90edc04 with parse5 trees;
        all four reproduced here first."""
        too_late = {
            "div before the head": '<html><div><head><meta name="robots" content="noindex"></head></html>',
            "p before the head": '<html><p><head><meta name="robots" content="noindex"></head></html>',
            "frameset before the head": '<html><frameset><head><meta name="robots" content="noindex"></head></html>',
            "text before the head": '<html>hello<head><meta name="robots" content="noindex"></head></html>',
        }
        for why, html in too_late.items():
            with self.subTest(why):
                self.assertFalse(
                    _declines_indexing(html),
                    f"an implied head already closed, so this meta is in the body: {why}",
                )

        # Non-implying tokens may precede an explicit head. Without these the
        # rule above would reject the real page, which begins with a doctype.
        still_fine = {
            "comment before the head": '<html><!-- c --><head><meta name="robots" content="noindex"></head></html>',
            "whitespace before the head": '<html>\n  <head><meta name="robots" content="noindex"></head></html>',
            "no <html> wrapper at all": '<head><meta name="robots" content="noindex"></head>',
            "a doctype first, as every real page has": (
                '<!doctype html><html><head><meta name="robots" content="noindex"></head></html>'
            ),
        }
        for why, html in still_fine.items():
            with self.subTest(why):
                self.assertTrue(_declines_indexing(html), f"this must still count: {why}")

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
