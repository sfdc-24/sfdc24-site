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
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
PAGE = REPO / "xray" / "index.html"


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
        404.html all carry the tag -- and /xray/ was the exception."""
        self.assertRegex(
            self.src,
            r'<meta\s+name="robots"\s+content="[^"]*noindex',
            "an unlisted page must also decline indexing",
        )
        for sibling in ("governor/index.html", "voice/index.html", "404.html"):
            text = (REPO / sibling).read_text(encoding="utf-8")
            self.assertRegex(
                text,
                r'<meta\s+name="robots"\s+content="[^"]*noindex',
                f"{sibling} sets the convention this page follows; if it changed, revisit both",
            )

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
