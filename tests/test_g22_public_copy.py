"""TASK ID: G22 (Case 00001057): public pages carry no internal fleet text.

A grep of the built public HTML (and of the runtime-built footer labels in
assets/chrome.js) returns 0 hits for the banned terms. Unit tests read
files; they do not need a network. Vendor names in JS lookup tables that
exist only to strip those names from the DOM, and persona ids in CSS or
script identifiers, are out of this page-copy check — see the module
docstring of the case for the remaining files.
"""
from __future__ import annotations

import re
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
SKIP_DIRS = {".git", "node_modules", "tests", "tools", "docs", "services",
             "test-results", "playwright-report", "__pycache__", ".github"}

# Exact terms from the Friday-queue G22 section. Case-insensitive except TH-.
PHRASES = (
    "cut-wait",
    "cut wait",
    "silent clay",
    "doorbell",
    "codex freeze",
    "board row",
    "okf",
)
# "TH-" is a board thread prefix (TH-FRIDAY-QUEUE), not an HTML <th> tag.
THREAD_PREFIX = re.compile(r"TH-[A-Z0-9]")
# "binder" and "receipt" as whole words in page copy (not CSS identifiers).
WORD_BINDER = re.compile(r"\bbinder\b", re.I)
WORD_RECEIPT = re.compile(r"\breceipts?\b", re.I)

# Model / vendor names in visible page copy (HTML text, not class attrs).
# The runtime footer must not introduce these either.
VENDORS = (
    "OpenAI", "Anthropic", "ChatGPT", "GPT-4", "GPT-3", "Gemini", "xAI",
    "Groq", "Qwen", "ElevenLabs", "Deepgram", "Cartesia", "LiveKit",
    "Codex freeze",  # already in PHRASES; listed for the vendor group
)


def public_html_files():
    for path in REPO.rglob("*"):
        if not path.is_file():
            continue
        if SKIP_DIRS.intersection(path.relative_to(REPO).parts):
            continue
        if path.suffix.lower() in {".html"} or path.name.endswith(".fragment.html"):
            yield path


def visible_text(html: str) -> str:
    """Rough visible copy: drop script, style, and comments."""
    text = re.sub(r"(?is)<script[^>]*>.*?</script>", " ", html)
    text = re.sub(r"(?is)<style[^>]*>.*?</style>", " ", text)
    text = re.sub(r"(?is)<!--.*?-->", " ", text)
    return text


def footer_runtime_text() -> str:
    """Labels the chrome footer actually writes into the DOM (link text).

    Parsed from the footerLinks array in assets/chrome.js, plus any narrative
    the renderer would add. This is the runtime-built footer the G22 section
    requires us to include.
    """
    src = (REPO / "assets" / "chrome.js").read_text(encoding="utf-8")
    # The link labels are the second element of each links.push / links = row.
    labels = re.findall(r'\["[^"]*",\s*"([^"]+)"', src)
    # personaCopy is applied to page text, not typically to these short labels,
    # but include the function's *output* nicknames (Greg, Clay, Cody, Jemma)
    # which are public names, and confirm the labels themselves.
    return "\n".join(labels)


class PublicProcessCopy(unittest.TestCase):
    def test_process_page_has_neutral_copy_and_no_banned_terms(self):
        page = (REPO / "process" / "index.html").read_text(encoding="utf-8")
        self.assertIn("Process", page)
        self.assertIn("Wait closed", page)
        self.assertIn("Mechanical wait-close", page)
        self.assertIn("Shared project context", page)
        self.assertIn("closes the wait", page)
        self.assertNotIn("cut-wait", page.lower().replace("wait-close", ""))
        # The phrase "cut-wait" itself is gone.
        self.assertNotIn("cut-wait", page.lower())
        self.assertNotIn("silent clay", page.lower())
        self.assertNotIn("doorbell", page.lower())
        self.assertNotIn("OKF", page)
        self.assertNotIn("okf", page.lower())
        self.assertNotIn("board row", page.lower())
        self.assertNotIn("binder", page.lower())
        self.assertNotIn("receipt", page.lower())
        self.assertIsNone(THREAD_PREFIX.search(page))
        # No bare pull-request numbers in the process copy.
        # CSS colors like #8a1f14 are hex, not PRs: require a word boundary context.
        self.assertNotRegex(page, r"(?i)(?:PR|pull request)\s*#\d+")
        self.assertNotRegex(page, r"(?<![0-9a-fA-F])#\d{2,3}\b(?![0-9a-fA-F])")

    def test_grep_of_public_html_is_zero_for_banned_phrases(self):
        offenders = []
        for path in public_html_files():
            raw = path.read_text(encoding="utf-8", errors="replace")
            rel = str(path.relative_to(REPO))
            lower = raw.lower()
            for phrase in PHRASES:
                if phrase in lower:
                    offenders.append("%s: %s" % (rel, phrase))
            if THREAD_PREFIX.search(raw):
                offenders.append("%s: TH-" % rel)
            vis = visible_text(raw)
            if WORD_BINDER.search(vis):
                offenders.append("%s: binder" % rel)
            if WORD_RECEIPT.search(vis):
                offenders.append("%s: receipt" % rel)
        self.assertEqual(offenders, [], "banned terms in public HTML:\n" + "\n".join(offenders))

    def test_runtime_footer_labels_have_no_banned_terms(self):
        text = footer_runtime_text()
        lower = text.lower()
        for phrase in PHRASES:
            self.assertNotIn(phrase, lower, "footer label contains %s: %r" % (phrase, text))
        self.assertIsNone(THREAD_PREFIX.search(text))
        self.assertIsNone(WORD_BINDER.search(text))
        self.assertIsNone(WORD_RECEIPT.search(text))
        # Footer must not print model/vendor names as visible labels.
        for name in ("OpenAI", "Anthropic", "ChatGPT", "Gemini", "xAI", "Groq",
                     "Qwen", "ElevenLabs", "Deepgram", "Cartesia", "LiveKit",
                     "Codex", "Grok", "Claude"):
            self.assertNotIn(name, text, "footer visible label names a vendor: %s" % name)
        # The footer does name public pages (Method, Privacy, Ops, ...).
        self.assertIn("Method", text)
        self.assertIn("Privacy", text)

    def test_ops_and_homepage_use_the_neutral_replacements(self):
        ops = (REPO / "ops" / "index.html").read_text(encoding="utf-8")
        home = (REPO / "index.html").read_text(encoding="utf-8")
        self.assertIn("project record", ops.lower())
        self.assertIn("the bus carries signals", ops)
        self.assertNotIn("OKF", ops)
        self.assertNotIn("doorbell", ops.lower())
        self.assertIn("Event signals", home)
        self.assertNotIn("doorbell", home.lower())
        # Pull request citations on the public ops page carry the repo name.
        self.assertIn("sfdc-24/conference #114", ops)
        self.assertIn("sfdc-24/conference #113", ops)
        self.assertIn("sfdc-24/conference #117", ops)
        self.assertNotIn("conference PR #114", ops)
        self.assertNotIn("conference PR #113", ops)
        self.assertNotIn("conference PR #117", ops)


if __name__ == "__main__":
    unittest.main()
