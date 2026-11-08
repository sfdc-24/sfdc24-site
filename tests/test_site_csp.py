"""Every page carries a Content-Security-Policy meta tag that allows what the
page loads, and nothing the check cannot account for.

The policies are built in tools/site_csp.py. This test fails when a page has
no tag, when a tag drifts from that file, when a script comes before the tag,
or when the page (or a script, style, fragment or service config it loads)
names an origin its policy does not allow. tests/csp_pages.spec.cjs loads the
same pages in Chromium and fails on any violation the browser reports.
"""

from __future__ import annotations

import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


site_csp = _load("site_csp", ROOT / "tools" / "site_csp.py")
publisher = _load("prototype_publisher_for_csp", ROOT / "tools" / "prototype_publisher.py")


class SiteCspTest(unittest.TestCase):
    def test_every_page_has_a_policy_that_allows_what_it_loads(self) -> None:
        problems = site_csp.check_all()
        self.assertEqual([], problems, "\n".join(problems))

    def test_the_page_list_is_read_from_the_repository(self) -> None:
        pages = site_csp.site_pages()
        self.assertGreaterEqual(len(pages), 30)
        for page in ("index.html", "conference/index.html", "guest/index.html", "ops/index.html"):
            self.assertIn(page, pages)
        self.assertFalse(any(p.endswith(".fragment.html") for p in pages))

    def test_the_publisher_inserts_the_same_prototype_policy(self) -> None:
        self.assertEqual(site_csp.prototype_policy(), publisher.PROTOTYPE_CSP)

    def test_conference_keeps_its_hashed_inline_script(self) -> None:
        policy = site_csp.policy_for("conference/index.html")
        script_src = site_csp.parse_policy(policy)["script-src"]
        self.assertNotIn("'unsafe-inline'", script_src)
        self.assertTrue(any(s.startswith("'sha256-") for s in script_src))
        self.assertIn("form-action 'none'", policy)

    def test_only_ops_allows_eval(self) -> None:
        for page in site_csp.site_pages():
            script_src = site_csp.parse_policy(site_csp.policy_for(page)).get("script-src", [])
            self.assertEqual(page == "ops/index.html", "'unsafe-eval'" in script_src, page)

    def test_the_ask_pages_allow_the_apps_script_redirect(self) -> None:
        for page in ("index.html", "voice/index.html", "stream/index.html"):
            script_src = site_csp.parse_policy(site_csp.policy_for(page))["script-src"]
            self.assertIn("https://script.google.com", script_src, page)
            self.assertIn("https://script.googleusercontent.com", script_src, page)


class SourceMatchingTest(unittest.TestCase):
    def test_host_path_scheme_and_wildcard(self) -> None:
        allows = site_csp.source_allows
        self.assertTrue(allows("https://fonts.googleapis.com", "https://fonts.googleapis.com/css2?family=X"))
        self.assertFalse(allows("https://fonts.googleapis.com", "https://fonts.gstatic.com/a.woff2"))
        exact = "https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.min.js"
        self.assertTrue(allows(exact, exact))
        self.assertFalse(allows(exact, "https://cdn.jsdelivr.net/npm/mermaid@11.17.2/dist/mermaid.min.js"))
        self.assertTrue(allows("wss://*.livekit.cloud", "wss://project.livekit.cloud/rtc"))
        self.assertTrue(allows("https://*.livekit.cloud", "https://project.region.production.livekit.cloud/settings/regions"))
        self.assertFalse(allows("wss://*.livekit.cloud", "wss://livekit.cloud.example/rtc"))
        self.assertTrue(allows("https://relay.example", "wss://relay.example/v1/stream"))
        self.assertFalse(allows("https://relay.example", "http://relay.example/"))
        self.assertTrue(allows("data:", "data:image/png;base64,AA"))
        self.assertFalse(allows("'self'", "https://www.sfdc24.com/"))


class CheckerCatchesTest(unittest.TestCase):
    """The checker on a throwaway tree: each broken page is reported."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self._saved = site_csp.ROOT
        site_csp.ROOT = self.root

    def tearDown(self) -> None:
        site_csp.ROOT = self._saved
        self._tmp.cleanup()

    def page(self, head: str, body: str = "", files: dict[str, str] | None = None) -> str:
        for rel, text in (files or {}).items():
            path = self.root / rel
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text, encoding="utf-8")
        (self.root / "x").mkdir(exist_ok=True)
        (self.root / "x" / "index.html").write_text(
            f"<!doctype html><html><head><meta charset=\"utf-8\">{head}</head><body>{body}</body></html>",
            encoding="utf-8",
        )
        return "x/index.html"

    def meta(self) -> str:
        return site_csp.meta_tag("x/index.html")

    def test_a_page_without_a_policy(self) -> None:
        problems = site_csp.check_page(self.page("<title>x</title>"))
        self.assertEqual(["x/index.html: no Content-Security-Policy meta tag"], problems)

    def test_the_baseline_page_is_clean(self) -> None:
        self.assertEqual([], site_csp.check_page(self.page(self.meta(), '<script src="/a.js"></script>', {"a.js": "fetch('/data/x.json')"})))

    def test_a_third_party_script_tag(self) -> None:
        problems = site_csp.check_page(self.page(self.meta(), '<script src="https://cdn.example/x.js"></script>'))
        self.assertTrue(any("script-src does not allow https://cdn.example/x.js" in p for p in problems), problems)

    def test_a_fetch_in_a_loaded_script_and_one_it_loads(self) -> None:
        files = {
            "a.js": 'var s=document.createElement("script"); s.src="/b.js";',
            "b.js": 'fetch("https://api.example/v1/thing")',
        }
        problems = site_csp.check_page(self.page(self.meta(), '<script src="/a.js"></script>', files))
        self.assertTrue(any("connect-src does not allow https://api.example/v1/thing (from b.js)" in p for p in problems), problems)

    def test_a_websocket_and_a_service_url_in_config(self) -> None:
        files = {
            "a.js": 'fetch("/data/join.json"); new WebSocket("wss://media.example/rtc");',
            "data/join.json": '{"serviceUrl": "https://join.example"}',
        }
        problems = site_csp.check_page(self.page(self.meta(), '<script src="/a.js"></script>', files))
        self.assertTrue(any("connect-src does not allow wss://media.example/rtc" in p for p in problems), problems)
        self.assertTrue(any("connect-src does not allow https://join.example" in p for p in problems), problems)

    def test_fonts_iframes_and_forms(self) -> None:
        body = (
            '<iframe src="https://frame.example/"></iframe>'
            '<form action="https://post.example/lead" method="post"></form>'
        )
        head = self.meta() + '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=X">'
        problems = site_csp.check_page(self.page(head, body))
        joined = "\n".join(problems)
        self.assertIn("style-src does not allow https://fonts.googleapis.com/css2?family=X", joined)
        self.assertIn("frame-src does not allow https://frame.example/", joined)
        self.assertIn("form-action does not allow https://post.example/lead", joined)

    def test_a_script_before_the_policy(self) -> None:
        problems = site_csp.check_page(self.page("<script>1</script>" + self.meta()))
        self.assertIn("x/index.html: a script comes before the Content-Security-Policy meta tag", problems)

    def test_frame_ancestors_in_a_meta_tag(self) -> None:
        head = '<meta http-equiv="Content-Security-Policy" content="default-src \'self\'; frame-ancestors \'none\'; object-src \'none\'; base-uri \'self\'; form-action \'none\'">'
        problems = site_csp.check_page(self.page(head))
        self.assertTrue(any("frame-ancestors" in p for p in problems), problems)

    def test_write_inserts_after_charset_and_is_idempotent(self) -> None:
        text = '<!doctype html>\r\n<html><head>\r\n<meta charset="utf-8">\r\n<title>x</title><script>1</script></head></html>'
        once = site_csp.with_meta("x/index.html", text)
        self.assertEqual(once, site_csp.with_meta("x/index.html", once))
        self.assertLess(once.index("Content-Security-Policy"), once.index("<script>"))
        self.assertGreater(once.index("Content-Security-Policy"), once.index("charset"))
        self.assertIn('<meta charset="utf-8">\r\n<meta http-equiv="Content-Security-Policy"', once)


if __name__ == "__main__":
    unittest.main()
